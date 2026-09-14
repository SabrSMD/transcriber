import json
import os
import sys
import traceback

# Save the real stdout before anything else touches it, then point sys.stdout
# at stderr for the rest of the process. whisperx/faster-whisper/torch pull in
# libraries that build their own logging.StreamHandler(sys.stdout) lazily
# (not just at import time, and not through the root logger, so
# logging.basicConfig(..., force=True) alone doesn't catch them) - anything
# that resolves sys.stdout from here on gets redirected to stderr instead,
# keeping the real stdout pipe reserved for our own JSON-lines events.
_real_stdout = sys.stdout
sys.stdout = sys.stderr

# Rust always writes the job JSON as genuine UTF-8 (serde_json never escapes
# non-ASCII), but Python's sys.stdin decodes it using the OS locale's default
# encoding unless told otherwise - on this machine that's not UTF-8, so a
# Cyrillic (etc.) file path in the job JSON got silently mis-decoded into
# mojibake before json.loads ever saw it, then failed with a "file not
# found" error for a path that never actually existed. Force UTF-8
# regardless of locale, before main() reads anything.
sys.stdin.reconfigure(encoding="utf-8")

# Must run before importing anything that shells out to ffmpeg: when this
# script is bundled by PyInstaller, Tauri places the ffmpeg sidecar next to
# this executable, not on the system PATH.
_base_dir = os.path.dirname(
    os.path.abspath(sys.executable if getattr(sys, "frozen", False) else __file__)
)
os.environ["PATH"] = _base_dir + os.pathsep + os.environ.get("PATH", "")

# whisperx's alignment step needs NLTK's punkt_tab data (see transcribe.py's
# _ensure_punkt_tab fallback). Ship it instead of relying on a runtime
# download, which fails outright behind proxies NLTK can't SSRF-validate.
# PyInstaller's --add-data extracts bundled files to a private temp dir at
# sys._MEIPASS (NOT next to the exe, unlike the ffmpeg sidecar above) - so
# frozen and dev mode need different base paths here.
if getattr(sys, "frozen", False):
    _nltk_data_dir = os.path.join(sys._MEIPASS, "nltk_data")
else:
    _nltk_data_dir = os.path.join(_base_dir, "nltk_data")
os.environ["NLTK_DATA"] = _nltk_data_dir

import transcribe  # noqa: E402
import voiceprint  # noqa: E402


def emit(event: dict) -> None:
    # ensure_ascii=True (the default) is deliberate: it \uXXXX-escapes
    # non-ASCII text so the JSON line is always plain ASCII on the wire,
    # regardless of the console's codepage. The UI/.xlsx decode it back to
    # proper Cyrillic (etc.) fine - do not "fix" this to ensure_ascii=False.
    _real_stdout.write(json.dumps(event) + "\n")
    _real_stdout.flush()


BOM = chr(0xFEFF)


def main() -> None:
    line = sys.stdin.readline().lstrip(BOM)
    job = json.loads(line)
    mode = job.get("mode")

    try:
        if mode == "transcribe":
            utterances = transcribe.run(job, emit)
            emit({"type": "utterances", "pct": 100, "data": utterances})
        elif mode == "enroll":
            name = voiceprint.enroll(job["audio"], job["name"], job["db_path"], emit)
            emit({"type": "enrolled", "name": name})
        else:
            raise ValueError(f"Unknown mode: {mode!r}")
    except Exception:
        emit({"type": "error", "message": traceback.format_exc()})


if __name__ == "__main__":
    main()
