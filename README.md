# Transcriber

A fully local, offline desktop app that transcribes speech from video/audio
files, splits the transcript by speaker (diarization), recognizes recurring
speakers across sessions via voiceprint matching, and exports the result as an
Excel (.xlsx) cue sheet (ROLE / LINE / NOTES / TIMING, one row per speaker
turn, each speaker's rows tinted a distinct color).

Everything runs on-device. The only network use is downloading models from
Hugging Face on first run (you paste in your own HF token) and, for speaker
diarization, one-time authentication against a gated model repo.

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 18 + TypeScript + Vite |
| Desktop shell | Tauri v2 (Rust) |
| Engine | Python 3.11 (whisperx, pyannote.audio, resemblyzer) |
| Media | ffmpeg (bundled as a Tauri sidecar) |

The Rust shell spawns the Python engine as a subprocess, writes one JSON job
to its stdin, and reads newline-delimited JSON progress/result events from its
stdout (see `engine/main.py` for the exact contract).

## Installing

Download the installer for your platform from the
[Releases page](https://github.com/SabrSMD/transcriber/releases/latest).
None of the builds are code-signed yet (Windows) or notarized (macOS), so
each platform needs one extra step on first install - this doesn't mean
anything is actually wrong with the app, it's just what an unsigned binary
looks like to the OS.

**Windows** - before running the downloaded `.msi` or `.exe`, right-click it
→ **Properties** → check **Unblock** (bottom of the General tab) → OK. This
clears the "Mark of the Web" flag Windows stamps on anything downloaded via a
browser, which is what triggers the "Windows protected your PC" SmartScreen
warning. Skipping this step isn't harmful either - SmartScreen's warning has
a "More info" → "Run anyway" link, it just looks scarier than it needs to.

**macOS** - open the `.dmg` and drag `Transcriber.app` into `Applications`.
On first launch, don't double-click it - **right-click (Control-click) →
Open**, then click **Open** again in the confirmation dialog. This only
needs to be done once; double-clicking works normally after that. (If it
still refuses, run `xattr -cr /Applications/Transcriber.app` in Terminal.)

**Linux** - install the `.deb` with `sudo dpkg -i Transcriber_*.deb` (or
double-click it if your desktop's Software Center handles `.deb` installs).
If it complains about missing dependencies, run
`sudo apt --fix-broken install` afterward. No extra step needed to launch it
- Linux has no Gatekeeper/SmartScreen equivalent.

Once it's open on any platform, see [Hugging Face token & model
access](#hugging-face-token--model-access) below for the one-time setup
needed before you can transcribe anything.

## Prerequisites

The following is only relevant if you want to build the app from source
(contributing, or your platform/architecture isn't covered by the Releases
page - see [Building a packaged app](#building-a-packaged-app)).

- Node.js (LTS) and npm
- Rust (via rustup)
  - Windows also needs the MSVC linker (Visual Studio Build Tools, "Desktop
    development with C++" workload)
  - Linux also needs Tauri's usual native deps (webkit2gtk, appindicator,
    etc.) - see the `apt-get install` list in `.github/workflows/build.yml`'s
    `build-linux` job
- Python 3.11
- ffmpeg on PATH (for local dev; the packaged app bundles its own)

## Setup

```bash
npm install

cd engine
python -m venv venv
venv\Scripts\pip install -r requirements.txt   # Windows
# venv/bin/pip install -r requirements.txt     # macOS/Linux
```

Run the app in dev mode from the repo root:

```bash
npm run tauri dev
```

In dev mode, the Rust shell spawns the engine directly out of `engine/venv`
(`Scripts/python.exe` on Windows, `bin/python` on macOS/Linux - see
`dev_engine_command` in `src-tauri/src/lib.rs`) running `engine/main.py`.
The PyInstaller-bundled sidecar binary is only used in packaged builds.

## Building a packaged app

The CI workflow (`.github/workflows/build.yml`) is the source of truth for
each platform's exact build steps and target-triple sidecar naming - it
builds Windows (x86_64), macOS (Apple Silicon / aarch64 only - Intel Macs
aren't currently built), and Linux (x86_64) on every `v*` tag push. To build
locally, mirror the steps for your OS from that file. In short, for each
platform:

```bash
# From engine/, with the venv active - pip uninstall typing beforehand,
# since resemblyzer pulls in the obsolete `typing` PyPI package as a
# transitive dependency, which breaks PyInstaller:
pip uninstall -y typing

pyinstaller --onefile --name engine \
  --collect-all whisperx --collect-all pyannote.audio --collect-all pyannote.pipeline \
  --collect-all onnxruntime --collect-all resemblyzer \
  --copy-metadata pyannote.audio --copy-metadata transformers --copy-metadata torch \
  --copy-metadata huggingface_hub --copy-metadata torchcodec \
  --hidden-import pyannote.audio.pipelines.voice_activity_detection \
  --hidden-import pyannote.audio.pipelines.speaker_diarization \
  --add-data "nltk_data:nltk_data" \
  main.py
```

`--add-data`'s separator is OS-dependent: `nltk_data:nltk_data` on
macOS/Linux, `nltk_data;nltk_data` on Windows (PowerShell also needs `^` line
continuations instead of `\`, and `dist\engine.exe` instead of `dist/engine`).

`engine/nltk_data` (committed to the repo) bundles the NLTK punkt_tab data
whisperx's alignment step needs. Without `--add-data`, a packaged app tries
to download it at runtime, which fails outright on networks/proxies NLTK's
downloader can't SSRF-validate - see `engine/main.py`'s `NLTK_DATA` handling.

Then copy the built engine and your system's `ffmpeg` binary into
`src-tauri/binaries/` under the matching target-triple name (see
`tauri.conf.json`'s `externalBin`), and build the Tauri app from the repo
root:

| Platform | Sidecar names |
|---|---|
| Windows (x86_64) | `engine-x86_64-pc-windows-msvc.exe`, `ffmpeg-x86_64-pc-windows-msvc.exe` |
| macOS (Apple Silicon) | `engine-aarch64-apple-darwin`, `ffmpeg-aarch64-apple-darwin` |
| Linux (x86_64) | `engine-x86_64-unknown-linux-gnu`, `ffmpeg-x86_64-unknown-linux-gnu` |

```bash
npm run tauri build
```

Installers land under `src-tauri/target/release/bundle/`: `msi/` and `nsis/`
on Windows, `dmg/` on macOS, `deb/` on Linux. (AppImage is deliberately not
built - it downloads several hundred MB of extra packaging tooling at build
time, which ran the CI Linux runner out of disk space; `.deb` alone covers
Debian/Ubuntu-based distros fine.)

## Hugging Face token & model access

Speaker diarization uses the gated
[`pyannote/speaker-diarization-community-1`](https://huggingface.co/pyannote/speaker-diarization-community-1)
model. To use it you need to:

1. Accept that model's terms on huggingface.co (once, per HF account).
2. Generate a Hugging Face access token and paste it into the app's Settings
   tab (or the first-run prompt).

The token is stored locally via `tauri-plugin-store` and is never sent
anywhere except to huggingface.co to download models. If a token has ever
been shared in plaintext (chat, screenshots, etc.), revoke it on
huggingface.co and generate a new one.

## Privacy

Transcription, diarization, and voiceprint matching all run on-device.
Nothing about the audio/video content itself leaves your machine.
