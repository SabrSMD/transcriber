import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { JobEvent } from "../types";

async function runJob(
  command: string,
  args: Record<string, unknown>,
  onEvent: (event: JobEvent) => void
): Promise<UnlistenFn> {
  const unlisten = await listen<JobEvent>("job-event", (e) => onEvent(e.payload));
  try {
    await invoke(command, args);
  } catch (err) {
    onEvent({ type: "error", message: String(err) });
  }
  return unlisten;
}

export function transcribeVideo(
  audioPath: string,
  options: { hfToken: string; model: string; dbPath: string; language: string },
  onEvent: (event: JobEvent) => void
): Promise<UnlistenFn> {
  return runJob(
    "run_transcribe",
    {
      audio: audioPath,
      hfToken: options.hfToken,
      model: options.model,
      dbPath: options.dbPath,
      language: options.language,
    },
    onEvent
  );
}

export function enrollSpeaker(
  audioPath: string,
  name: string,
  dbPath: string,
  onEvent: (event: JobEvent) => void
): Promise<UnlistenFn> {
  return runJob("run_enroll", { audio: audioPath, name, dbPath }, onEvent);
}

export function cancelJob(): Promise<void> {
  return invoke("cancel_job");
}

// Speaker management reads/writes speakers.db directly (Rust + bundled
// rusqlite) rather than through the engine - listing/renaming/deleting a
// few rows doesn't need to pay the cost of importing whisperx/torch/
// pyannote just to run a query.
export function listSpeakers(dbPath: string): Promise<string[]> {
  return invoke("list_speakers", { dbPath });
}

export function renameSpeakerGlobal(dbPath: string, oldName: string, newName: string): Promise<void> {
  return invoke("rename_speaker", { dbPath, oldName, newName });
}

export function deleteSpeakerGlobal(dbPath: string, name: string): Promise<void> {
  return invoke("delete_speaker", { dbPath, name });
}
