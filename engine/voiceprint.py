import os
import sqlite3

import numpy as np
from resemblyzer import VoiceEncoder, preprocess_wav

from pathutils import to_ascii_safe_copy

MATCH_THRESHOLD = 0.80

_encoder: VoiceEncoder | None = None


def _get_encoder() -> VoiceEncoder:
    global _encoder
    if _encoder is None:
        _encoder = VoiceEncoder()
    return _encoder


def _connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS speakers ("
        "name TEXT PRIMARY KEY, "
        "embedding BLOB NOT NULL)"
    )
    return conn


def embed_wav_array(wav: np.ndarray) -> np.ndarray:
    return _get_encoder().embed_utterance(wav)


def embed_audio_file(path: str) -> np.ndarray:
    # Same non-ASCII-path guard as engine/transcribe.py's main flow - this is
    # reached from the rename/enroll flow too (via enroll() below), which had
    # no protection of its own even though it hits the same ffmpeg/whisper
    # Windows path-encoding limitation.
    safe_path, cleanup_path = to_ascii_safe_copy(path)
    try:
        return embed_wav_array(preprocess_wav(safe_path))
    finally:
        if cleanup_path and os.path.exists(cleanup_path):
            os.remove(cleanup_path)


def enroll(audio_path: str, name: str, db_path: str, emit) -> str:
    emit({"type": "status", "pct": 50, "message": f"Enrolling {name}..."})
    embedding = embed_audio_file(audio_path)
    conn = _connect(db_path)
    conn.execute(
        "INSERT OR REPLACE INTO speakers (name, embedding) VALUES (?, ?)",
        (name, embedding.astype(np.float32).tobytes()),
    )
    conn.commit()
    conn.close()
    return name


def match(embedding: np.ndarray, db_path: str) -> str | None:
    conn = _connect(db_path)
    rows = conn.execute("SELECT name, embedding FROM speakers").fetchall()
    conn.close()

    best_name, best_score = None, MATCH_THRESHOLD
    for name, blob in rows:
        known = np.frombuffer(blob, dtype=np.float32)
        score = float(
            np.dot(embedding, known) / (np.linalg.norm(embedding) * np.linalg.norm(known))
        )
        if score > best_score:
            best_name, best_score = name, score
    return best_name
