use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

// Holds the OS pid of whichever engine process is currently running, if any
// - just the pid (not the Child/CommandChild itself) so cancel_job doesn't
// need to fight the spawning thread/task over ownership of the process
// handle it's already using for stdin/stdout/wait. Only one job runs at a
// time today (matches the current single-job UI); a future queued/parallel
// jobs feature would need this to become a map, not a single slot.
struct RunningJob(Mutex<Option<u32>>);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Utterance {
    pub speaker: String,
    pub text: String,
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum JobEvent {
    Status { pct: u32, message: String },
    Utterances { pct: u32, data: Vec<Utterance> },
    Enrolled { name: String },
    Error { message: String },
}

// Dev-mode: spawns the engine straight out of engine/venv via the system
// Python interpreter, so editing engine/*.py doesn't require a PyInstaller
// rebuild to test. Release builds use the PyInstaller-bundled sidecar binary
// instead (see run_sidecar_job) since engine/venv isn't shipped.
fn dev_engine_command() -> Command {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let engine_dir = manifest_dir.join("..").join("engine");
    // venv's internal layout differs by OS: Windows uses Scripts/python.exe,
    // macOS/Linux use bin/python.
    let python = if cfg!(windows) {
        engine_dir.join("venv").join("Scripts").join("python.exe")
    } else {
        engine_dir.join("venv").join("bin").join("python")
    };
    let script = engine_dir.join("main.py");

    let mut cmd = Command::new(python);
    cmd.arg(script);
    cmd
}

fn spawn_job(app: AppHandle, job_json: String) {
    if cfg!(debug_assertions) {
        spawn_dev_job(app, job_json);
    } else {
        tauri::async_runtime::spawn(run_sidecar_job(app, job_json));
    }
}

fn spawn_dev_job(app: AppHandle, job_json: String) {
    std::thread::spawn(move || {
        let mut child = match dev_engine_command()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(err) => {
                let _ = app.emit(
                    "job-event",
                    JobEvent::Error {
                        message: format!("Failed to start engine: {err}"),
                    },
                );
                return;
            }
        };

        *app.state::<RunningJob>().0.lock().unwrap() = Some(child.id());

        if let Some(mut stdin) = child.stdin.take() {
            let _ = writeln!(stdin, "{job_json}");
        }

        // Drain stderr on its own thread, concurrently with stdout below.
        // engine/main.py deliberately redirects sys.stdout to stderr (so
        // third-party logging can't corrupt the JSON-lines stdout protocol),
        // which means stderr can carry a real volume of output. Reading it
        // only after stdout reaches EOF (as this used to) risks a deadlock:
        // once the OS pipe buffer fills, the child blocks writing to stderr
        // while nothing is draining it, so it never closes stdout either.
        let stderr_handle = child.stderr.take().map(|mut stderr| {
            std::thread::spawn(move || {
                let mut buf = String::new();
                let _ = stderr.read_to_string(&mut buf);
                buf
            })
        });

        if let Some(stdout) = child.stdout.take() {
            let reader = BufReader::new(stdout);
            for line_result in reader.lines() {
                let line = match line_result {
                    Ok(line) => line,
                    // Invalid UTF-8 on one line (e.g. stray injected bytes)
                    // is recoverable - skip just that line. map_while(
                    // Result::ok) used to treat this as end-of-stream and
                    // stop reading entirely; a bare filter_map would instead
                    // risk looping forever if the error were persistent
                    // (clippy flags exactly this), so only skip the
                    // specifically-recoverable case and stop on anything else.
                    Err(err) if err.kind() == std::io::ErrorKind::InvalidData => {
                        let _ = app.emit(
                            "job-event",
                            JobEvent::Error {
                                message: format!("Skipped non-UTF8 engine output line: {err}"),
                            },
                        );
                        continue;
                    }
                    Err(_) => break,
                };
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                match serde_json::from_str::<JobEvent>(line) {
                    Ok(event) => {
                        let _ = app.emit("job-event", event);
                    }
                    Err(err) => {
                        let _ = app.emit(
                            "job-event",
                            JobEvent::Error {
                                message: format!("Malformed engine output ({err}): {line}"),
                            },
                        );
                    }
                }
            }
        }

        let stderr_output = stderr_handle.and_then(|h| h.join().ok()).unwrap_or_default();

        match child.wait() {
            Ok(status) if !status.success() => {
                let _ = app.emit(
                    "job-event",
                    JobEvent::Error {
                        message: format!(
                            "Engine exited with {status}{}{}",
                            if stderr_output.is_empty() { "" } else { "\n" },
                            stderr_output
                        ),
                    },
                );
            }
            Err(err) => {
                let _ = app.emit(
                    "job-event",
                    JobEvent::Error {
                        message: format!("Engine process wait failed: {err}"),
                    },
                );
            }
            _ => {}
        }

        *app.state::<RunningJob>().0.lock().unwrap() = None;
    });
}

// Release-mode: spawns the PyInstaller-bundled sidecar via the shell plugin,
// which resolves the current platform's target-triple-suffixed binary
// (src-tauri/binaries/engine-<target-triple>[.exe]) declared under
// `bundle.externalBin` in tauri.conf.json.
async fn run_sidecar_job(app: AppHandle, job_json: String) {
    let sidecar = match app.shell().sidecar("engine") {
        Ok(cmd) => cmd,
        Err(err) => {
            let _ = app.emit(
                "job-event",
                JobEvent::Error {
                    message: format!("Failed to locate engine sidecar: {err}"),
                },
            );
            return;
        }
    };

    let (mut rx, mut child) = match sidecar.spawn() {
        Ok(pair) => pair,
        Err(err) => {
            let _ = app.emit(
                "job-event",
                JobEvent::Error {
                    message: format!("Failed to start engine: {err}"),
                },
            );
            return;
        }
    };

    *app.state::<RunningJob>().0.lock().unwrap() = Some(child.pid());

    if let Err(err) = child.write(format!("{job_json}\n").as_bytes()) {
        let _ = app.emit(
            "job-event",
            JobEvent::Error {
                message: format!("Failed to write job to engine stdin: {err}"),
            },
        );
        return;
    }

    let mut stdout_buf = String::new();
    let mut stderr_buf = String::new();

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                stdout_buf.push_str(&String::from_utf8_lossy(&bytes));
                while let Some(pos) = stdout_buf.find('\n') {
                    let line = stdout_buf[..pos].trim().to_string();
                    stdout_buf.drain(..=pos);
                    if line.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<JobEvent>(&line) {
                        Ok(ev) => {
                            let _ = app.emit("job-event", ev);
                        }
                        Err(err) => {
                            let _ = app.emit(
                                "job-event",
                                JobEvent::Error {
                                    message: format!("Malformed engine output ({err}): {line}"),
                                },
                            );
                        }
                    }
                }
            }
            CommandEvent::Stderr(bytes) => {
                stderr_buf.push_str(&String::from_utf8_lossy(&bytes));
            }
            CommandEvent::Error(err) => {
                let _ = app.emit("job-event", JobEvent::Error { message: err });
            }
            CommandEvent::Terminated(payload) => {
                if payload.code != Some(0) {
                    // Match spawn_dev_job's wording (ExitStatus's Display
                    // prints "exit code: N") so dev and release builds don't
                    // show users differently-formatted crash messages.
                    let code_desc = match payload.code {
                        Some(code) => format!("exit code: {code}"),
                        None => "terminated by signal".to_string(),
                    };
                    let _ = app.emit(
                        "job-event",
                        JobEvent::Error {
                            message: format!(
                                "Engine exited with {code_desc}{}{}",
                                if stderr_buf.is_empty() { "" } else { "\n" },
                                stderr_buf
                            ),
                        },
                    );
                }
                break;
            }
            _ => {}
        }
    }

    *app.state::<RunningJob>().0.lock().unwrap() = None;
}

#[tauri::command]
fn run_transcribe(
    app: AppHandle,
    audio: String,
    hf_token: String,
    model: String,
    db_path: String,
    language: String,
) {
    let job = serde_json::json!({
        "mode": "transcribe",
        "audio": audio,
        "hf_token": hf_token,
        "model": model,
        "db_path": db_path,
        "language": language,
    });
    spawn_job(app, job.to_string());
}

#[tauri::command]
fn run_enroll(app: AppHandle, audio: String, name: String, db_path: String) {
    let job = serde_json::json!({
        "mode": "enroll",
        "audio": audio,
        "name": name,
        "db_path": db_path,
    });
    spawn_job(app, job.to_string());
}

#[tauri::command]
fn save_export_dialog(
    app: AppHandle,
    default_name: String,
    filter_name: String,
    extension: String,
) -> Option<String> {
    app.dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter(&filter_name, &[&extension])
        .blocking_save_file()
        .map(|path| path.to_string())
}

#[tauri::command]
fn write_binary_file(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(path, data).map_err(|err| err.to_string())
}

// Cuts a mono 16kHz wav clip of one utterance's audio so it can be fed to the
// engine's `enroll` mode (voiceprint embedding) when the user renames a
// speaker - the full multi-speaker file would produce a useless embedding.
#[tauri::command]
fn extract_audio_segment(audio: String, start: f64, end: f64) -> Result<String, String> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| err.to_string())?
        .as_nanos();
    let out_path = std::env::temp_dir().join(format!("vt_seg_{nanos}.wav"));

    // ffmpeg can silently fail on non-ASCII (e.g. Cyrillic) input paths on
    // Windows - the same class of bug engine/transcribe.py's
    // _to_ascii_safe_copy works around for the main transcribe flow. This
    // command shells out to ffmpeg directly too, so it needs the same guard.
    let ascii_copy = if audio.is_ascii() {
        None
    } else {
        let ext = std::path::Path::new(&audio)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("tmp");
        let safe_path = std::env::temp_dir().join(format!("vt_src_{nanos}.{ext}"));
        std::fs::copy(&audio, &safe_path).map_err(|err| err.to_string())?;
        Some(safe_path)
    };
    let ffmpeg_input: &std::path::Path = ascii_copy
        .as_deref()
        .unwrap_or_else(|| std::path::Path::new(&audio));

    let status = Command::new("ffmpeg")
        .arg("-y")
        .arg("-i")
        .arg(ffmpeg_input)
        .args(["-ss", &start.to_string(), "-to", &end.to_string()])
        .args(["-ar", "16000", "-ac", "1"])
        .arg(&out_path)
        .status()
        .map_err(|err| err.to_string());

    if let Some(tmp) = &ascii_copy {
        let _ = std::fs::remove_file(tmp);
    }

    if !status?.success() {
        return Err("ffmpeg failed to extract audio segment".to_string());
    }
    Ok(out_path.to_string_lossy().to_string())
}

#[tauri::command]
fn delete_temp_file(path: String) {
    let _ = std::fs::remove_file(path);
}

// Reads/writes speakers.db directly (bundled rusqlite) instead of routing
// through the Python engine, which would pay the cost of importing
// whisperx/torch/pyannote (module-level imports in main.py/transcribe.py)
// just to list a few rows - engine/voiceprint.py's own sqlite3 connection
// still handles enrollment/matching during actual transcription.
const SPEAKERS_TABLE_SQL: &str =
    "CREATE TABLE IF NOT EXISTS speakers (name TEXT PRIMARY KEY, embedding BLOB NOT NULL)";

#[tauri::command]
fn list_speakers(db_path: String) -> Result<Vec<String>, String> {
    let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;
    conn.execute(SPEAKERS_TABLE_SQL, []).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT name FROM speakers ORDER BY name COLLATE NOCASE")
        .map_err(|e| e.to_string())?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(names)
}

#[tauri::command]
fn rename_speaker(db_path: String, old_name: String, new_name: String) -> Result<(), String> {
    let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;
    conn.execute(SPEAKERS_TABLE_SQL, []).map_err(|e| e.to_string())?;
    // `name` is the primary key, so renaming onto an existing name would
    // otherwise hit a uniqueness conflict - delete any row already sitting
    // at new_name first, so renaming "Ivan" -> "Ivan Petrov" (an existing
    // enrollment) reads as an intentional merge, not an error.
    conn.execute("DELETE FROM speakers WHERE name = ?1", rusqlite::params![new_name])
        .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE speakers SET name = ?1 WHERE name = ?2",
        rusqlite::params![new_name, old_name],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_speaker(db_path: String, name: String) -> Result<(), String> {
    let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;
    conn.execute(SPEAKERS_TABLE_SQL, []).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM speakers WHERE name = ?1", rusqlite::params![name])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// Kills whichever engine process is currently running (dev-mode python.exe
// or the release sidecar), by pid rather than by holding the Child/
// CommandChild handle itself - see RunningJob's doc comment. taskkill's /T
// kills the whole process tree, not just the immediate pid, in case the
// engine has spawned worker children of its own (e.g. a data-loading
// subprocess) that a plain kill of the parent wouldn't reach.
#[tauri::command]
fn cancel_job(state: tauri::State<RunningJob>) -> Result<(), String> {
    let pid = state.0.lock().unwrap().take();
    if let Some(pid) = pid {
        if cfg!(windows) {
            Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .status()
                .map_err(|err| err.to_string())?;
        } else {
            // Best-effort tree kill without an extra process-group-management
            // dependency: kill any direct children first (e.g. a data-loading
            // subprocess the engine spawned), then the engine process itself.
            let _ = Command::new("pkill")
                .args(["-9", "-P", &pid.to_string()])
                .status();
            Command::new("kill")
                .args(["-9", &pid.to_string()])
                .status()
                .map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(RunningJob(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            run_transcribe,
            run_enroll,
            save_export_dialog,
            write_binary_file,
            extract_audio_segment,
            delete_temp_file,
            cancel_job,
            list_speakers,
            rename_speaker,
            delete_speaker
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
