import os
from contextlib import contextmanager

import nltk
import numpy as np
import torch
import whisperx
from huggingface_hub.utils import tqdm as HfTqdm
from pyannote.audio import Pipeline
from resemblyzer import preprocess_wav

import voiceprint
from pathutils import to_ascii_safe_copy


@contextmanager
def _relay_hf_download_progress(emit, pct: int, label: str):
    """While active, patches huggingface_hub's own tqdm subclass so file-
    download progress (e.g. a multi-GB model on first use of a given size)
    is relayed as a live percentage in the status message - instead of
    vanishing into stderr, indistinguishable from the app just being stuck.
    `pct` stays fixed at the pipeline stage's own threshold throughout (only
    the message text carries the live percentage), so the frontend's stepper
    stays correctly parked on this stage rather than needing pct values it
    doesn't recognize.

    huggingface_hub's snapshot_download (what faster_whisper's model
    download and Pipeline.from_pretrained both use under the hood) runs an
    OUTER "N files fetched" tqdm bar (via tqdm.contrib.concurrent.thread_map)
    at the same time as each individual file's own byte-level download bar,
    across up to 8 worker threads - all instances of this same patched
    class. Without filtering, the small-integer "files fetched" total
    interleaves with (and swamps) the real multi-hundred-MB byte total,
    making the reported percentage effectively meaningless. Only bars with
    a large total are a real byte-progress download, not a file counter."""
    MIN_BYTES_TOTAL = 10 * 1024 * 1024  # 10MB - well above any file-count total
    original_update = HfTqdm.update

    def patched_update(self, n=1):
        result = original_update(self, n)
        if self.total and self.total > MIN_BYTES_TOTAL:
            frac = min(self.n / self.total, 1.0)
            emit({"type": "status", "pct": pct, "message": f"{label} {int(frac * 100)}%"})
        return result

    HfTqdm.update = patched_update
    try:
        yield
    finally:
        HfTqdm.update = original_update

# whisperx's alignment step needs NLTK's punkt_tab sentence tokenizer. The
# bundled PyInstaller build ships this data and sets NLTK_DATA (see the build
# pipeline); in dev mode (and as a last-resort fallback in the bundled build
# if the offline copy is ever missing), fetch it on first use instead of
# crashing every transcription (handoff lesson: NLTK punkt_tab is fragile
# behind proxies/SSRF protection - this keeps things working when it isn't).
def _ensure_punkt_tab() -> None:
    try:
        nltk.data.find("tokenizers/punkt_tab")
    except LookupError:
        nltk.download("punkt_tab", quiet=True)

# The old whisperx.DiarizationPipeline wrapper was removed upstream; use the
# pyannote community pipeline directly instead. Note: it's
# "speaker-diarization-community-1", NOT "segmentation-community-1" (404s).
DIARIZATION_MODEL = "pyannote/speaker-diarization-community-1"

SAMPLE_RATE = 16000  # whisperx.load_audio always resamples to this


def run(job: dict, emit) -> list[dict]:
    audio_path = job["audio"]
    hf_token = job.get("hf_token")
    model_name = job.get("model", "small")
    db_path = job.get("db_path")
    language_override = job.get("language") or None
    device = "cpu"

    safe_path, cleanup_path = to_ascii_safe_copy(audio_path)
    try:
        emit({"type": "status", "pct": 5, "message": "Loading audio..."})
        audio = whisperx.load_audio(safe_path)

        # Split into two stages - whisperx.load_model() downloads the model
        # from Hugging Face on first use of a given size (medium ~1.5GB,
        # large-v2 ~3GB) and that download can take a long time or stall on
        # a slow/unstable connection. Lumping it into "Transcribing..." (as
        # this used to) makes a stalled download indistinguishable from the
        # UI just looking stuck, with zero indication a multi-gigabyte
        # transfer is what's actually happening.
        emit({"type": "status", "pct": 10, "message": f"Loading {model_name} model..."})
        with _relay_hf_download_progress(emit, 10, f"Downloading {model_name} model..."):
            model = whisperx.load_model(model_name, device, compute_type="int8")

        emit({"type": "status", "pct": 20, "message": "Transcribing..."})
        result = model.transcribe(audio, batch_size=8, language=language_override)
        # A manual override is always honored as-is (it's picked from the list
        # of languages whisperx actually has an alignment model for, so it
        # never needs the no-alignment-model fallback below). Otherwise fall
        # back to whatever Whisper auto-detected.
        language = language_override or result.get("language", "en")

        emit({"type": "status", "pct": 45, "message": f"Aligning ({language})..."})
        _ensure_punkt_tab()
        # whisperx doesn't ship a word-alignment model for every language it
        # can transcribe (e.g. Khmer) - and Whisper's own language
        # auto-detection can occasionally misdetect a clip's language,
        # landing on one with no alignment model even when the audio is
        # actually a well-supported language. Either way, alignment only
        # refines word-level timestamps; a segment's own start/end from the
        # transcription step above are still perfectly usable, so degrade to
        # those instead of failing the whole job over a missing model for a
        # language that may not even be the real one.
        try:
            align_model, align_metadata = whisperx.load_align_model(
                language_code=language, device=device
            )
        except ValueError:
            align_model = None

        if align_model is not None:
            result = whisperx.align(
                result["segments"],
                align_model,
                align_metadata,
                audio,
                device,
                return_char_alignments=False,
            )
        else:
            emit(
                {
                    "type": "status",
                    "pct": 45,
                    "message": f"No alignment model for '{language}' - using unrefined timestamps...",
                }
            )

        emit({"type": "status", "pct": 65, "message": "Detecting speakers..."})
        with _relay_hf_download_progress(emit, 65, "Downloading diarization model..."):
            diarize_pipeline = Pipeline.from_pretrained(DIARIZATION_MODEL, token=hf_token)
        # Pass the waveform whisperx already loaded instead of the file path -
        # pyannote's own path-based loader requires torchcodec, which (unlike
        # whisperx's librosa/audioread fallback) has no fallback and hard-
        # fails with "torchcodec is not available" when it isn't working.
        # This also avoids decoding the same file twice.
        waveform = torch.from_numpy(audio).unsqueeze(0)
        diarize_output = diarize_pipeline({"waveform": waveform, "sample_rate": SAMPLE_RATE})
        # The community-1 pipeline returns a DiarizeOutput dataclass, not a
        # plain pyannote Annotation - .exclusive_speaker_diarization has no
        # overlapping turns, which fits _assign_speakers' simple "first turn
        # whose [start, end] contains this segment's midpoint" matching much
        # better than the raw (possibly-overlapping) speaker_diarization.
        diarization = diarize_output.exclusive_speaker_diarization

        emit({"type": "status", "pct": 80, "message": "Assigning speakers..."})
        utterances = _assign_speakers(result["segments"], diarization)

        if db_path:
            emit({"type": "status", "pct": 92, "message": "Matching known voices..."})
            _apply_voiceprints(utterances, audio, db_path)

        return utterances
    finally:
        if cleanup_path and os.path.exists(cleanup_path):
            os.remove(cleanup_path)


def _assign_speakers(segments: list[dict], diarization) -> list[dict]:
    utterances = []
    for seg in segments:
        start, end = float(seg["start"]), float(seg["end"])
        mid = (start + end) / 2
        # "Unassigned", not e.g. "Speaker 1" - pyannote's real turn labels
        # look like "SPEAKER_00", so a fake "Speaker 1" for a segment outside
        # every diarized turn (silence gaps, overlap) used to look like a
        # genuine extra speaker instead of the gap it actually is.
        label = "Unassigned"
        for turn, _, turn_label in diarization.itertracks(yield_label=True):
            if turn.start <= mid <= turn.end:
                label = turn_label
                break
        utterances.append(
            {"speaker": label, "text": seg["text"].strip(), "start": start, "end": end}
        )
    return utterances


def _apply_voiceprints(utterances: list[dict], audio: np.ndarray, db_path: str) -> None:
    """Re-embed each diarized speaker's longest turn and rename its label to a
    known enrolled speaker when the voiceprint matches (voiceprint.MATCH_THRESHOLD)."""
    by_label: dict[str, tuple[float, np.ndarray]] = {}
    for u in utterances:
        duration = u["end"] - u["start"]
        if u["speaker"] not in by_label or duration > by_label[u["speaker"]][0]:
            start_sample = max(0, int(u["start"] * SAMPLE_RATE))
            end_sample = min(len(audio), int(u["end"] * SAMPLE_RATE))
            by_label[u["speaker"]] = (duration, audio[start_sample:end_sample])

    rename: dict[str, str] = {}
    for label, (_, wav_slice) in by_label.items():
        if wav_slice.size < SAMPLE_RATE // 2:  # under 0.5s is too short to embed reliably
            continue
        wav = preprocess_wav(wav_slice, source_sr=SAMPLE_RATE)
        embedding = voiceprint.embed_wav_array(wav)
        known_name = voiceprint.match(embedding, db_path)
        if known_name:
            rename[label] = known_name

    for u in utterances:
        if u["speaker"] in rename:
            u["speaker"] = rename[u["speaker"]]
