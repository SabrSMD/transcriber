import os
import shutil
import tempfile
import uuid


def to_ascii_safe_copy(path: str) -> tuple[str, str | None]:
    """ffmpeg/whisper can silently fail on non-ASCII (e.g. Cyrillic) paths on
    Windows; copy to a throwaway ASCII-only temp path first."""
    if path.isascii():
        return path, None
    ext = os.path.splitext(path)[1]
    tmp_path = os.path.join(tempfile.gettempdir(), f"vt_{uuid.uuid4().hex}{ext}")
    shutil.copyfile(path, tmp_path)
    return tmp_path, tmp_path
