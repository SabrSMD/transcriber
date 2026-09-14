export interface Utterance {
  speaker: string;
  text: string;
  start: number;
  end: number;
  // Manual annotation the user adds in-app (e.g. "(interrupting)",
  // "off-screen") - never set by the engine, only ever edited here and
  // carried into the exported .xlsx's NOTES column.
  note?: string;
}

export type JobEvent =
  | { type: "status"; pct: number; message: string }
  | { type: "utterances"; pct: number; data: Utterance[] }
  | { type: "enrolled"; name: string }
  | { type: "error"; message: string };

export type ModelName = "small" | "medium" | "large-v2";
export type ThemeMode = "dark" | "light";

// "" means auto-detect; any other value is an ISO 639-1 code from
// src/lib/languages.ts (only languages whisperx has an alignment model for).
export type LanguageCode = string;

export interface Settings {
  hfToken: string;
  model: ModelName;
  language: LanguageCode;
  theme: ThemeMode;
}

export interface HistoryItem {
  id: string;
  fileName: string;
  audioPath: string;
  createdAt: string;
  speakerCount: number;
  durationSeconds: number;
  utterances: Utterance[];
}

// A queued/running/finished transcription job. Lives in App-level state (not
// on disk) so it survives switching tabs - the actual result, once done, is
// what gets saved to History; the Job entry itself is just the queue/
// progress bookkeeping around that.
export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface TranscribeJob {
  id: string;
  audioPath: string;
  fileName: string;
  model: ModelName;
  language: LanguageCode;
  status: JobStatus;
  progress: { pct: number; message: string } | null;
  seenStages: number[];
  error: string | null;
  createdAt: string;
}
