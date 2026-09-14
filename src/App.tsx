import { useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Combine,
  Download,
  FileAudio2,
  History as HistoryIcon,
  ListChecks,
  Pause,
  Pencil,
  Play,
  Scissors,
  Search,
  Settings as SettingsIcon,
  StickyNote,
  Trash2,
  UploadCloud,
  Users,
  X,
  XCircle,
} from "lucide-react";
import { AutoResizeTextarea } from "./components/AutoResizeTextarea";
import {
  cancelJob,
  deleteSpeakerGlobal,
  enrollSpeaker,
  listSpeakers,
  renameSpeakerGlobal,
  transcribeVideo,
} from "./lib/ipc";
import { exportToXlsx, formatTimecode } from "./lib/xlsxExport";
import { exportToSrt, exportToVtt } from "./lib/subtitleExport";
import { deleteTranscript, listHistory, loadTranscript, saveTranscript } from "./lib/history";
import { getSettings, saveSettings } from "./lib/store";
import { SPEAKER_BADGE_TEXT, colorForSpeaker, initials } from "./lib/speakerColor";
import type {
  HistoryItem,
  JobEvent,
  LanguageCode,
  ModelName,
  Settings,
  TranscribeJob,
  Utterance,
} from "./types";
import { LANGUAGES } from "./lib/languages";

type View = "transcribe" | "jobs" | "history" | "speakers" | "settings";

const MODELS: ModelName[] = ["small", "medium", "large-v2"];
const BADGE_TEXT = `#${SPEAKER_BADGE_TEXT}`;

function fileNameFromPath(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

type ExportFormat = "xlsx" | "srt" | "vtt";

const EXPORT_FORMAT_LABEL: Record<ExportFormat, string> = {
  xlsx: "Excel cue sheet (.xlsx)",
  srt: "Subtitles (.srt)",
  vtt: "Subtitles (.vtt)",
};

async function buildExport(
  format: ExportFormat,
  utterances: Utterance[],
  audioPath: string
): Promise<{ blob: Blob; filterName: string; extension: string }> {
  switch (format) {
    case "xlsx":
      return {
        blob: await exportToXlsx(utterances, fileNameFromPath(audioPath)),
        filterName: "Excel Workbook",
        extension: "xlsx",
      };
    case "srt":
      return { blob: exportToSrt(utterances), filterName: "SubRip Subtitles", extension: "srt" };
    case "vtt":
      return { blob: exportToVtt(utterances), filterName: "WebVTT Subtitles", extension: "vtt" };
  }
}

// Math.max(...arr) spreads every element as an argument - throws RangeError
// once arr is large enough (a long/finely-segmented recording can produce
// thousands of utterances), and returns -Infinity on an empty array.
function maxEnd(utterances: Utterance[]): number {
  return utterances.reduce((max, u) => (u.end > max ? u.end : max), 0);
}

interface Turn {
  speaker: string;
  items: { utterance: Utterance; index: number }[];
}

// Consecutive utterances from the same speaker render as one visual block
// (one avatar, one name) instead of repeating both on every line.
function groupIntoTurns(utterances: Utterance[]): Turn[] {
  const turns: Turn[] = [];
  for (let index = 0; index < utterances.length; index++) {
    const u = utterances[index];
    const last = turns[turns.length - 1];
    if (last && last.speaker === u.speaker) {
      last.items.push({ utterance: u, index });
    } else {
      turns.push({ speaker: u.speaker, items: [{ utterance: u, index }] });
    }
  }
  return turns;
}

// Which utterance is "currently playing" - the one whose [start, end) window
// contains currentTime - or null when nothing matches (a gap between lines,
// or playback not started).
function activeUtteranceIndex(utterances: Utterance[], currentTime: number): number | null {
  for (let i = 0; i < utterances.length; i++) {
    if (currentTime >= utterances[i].start && currentTime < utterances[i].end) return i;
  }
  return null;
}

// Owns a hidden <video> element used purely for audio playback (a plain
// <audio> tag doesn't reliably decode the video-container formats this app
// also accepts, like mp4/mkv/mov/avi) and exposes play/pause/seek. `src` is
// an absolute local file path (or null when no playable file is known, e.g.
// an older History entry saved before audioPath existed) - convertFileSrc
// turns it into a URL the webview's asset protocol will actually serve.
function useAudioPlayer(src: string | null) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [unavailable, setUnavailable] = useState(!src);

  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setUnavailable(!src);
  }, [src]);

  function seek(time: number) {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = time;
  }

  function seekAndPlay(time: number) {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = time;
    void el.play();
  }

  function togglePlay() {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  }

  const videoElement = src ? (
    <video
      ref={videoRef}
      src={convertFileSrc(src)}
      style={{ display: "none" }}
      onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime ?? 0)}
      onDurationChange={() => setDuration(videoRef.current?.duration ?? 0)}
      onPlay={() => setPlaying(true)}
      onPause={() => setPlaying(false)}
      onError={() => setUnavailable(true)}
    />
  ) : null;

  return { videoElement, playing, currentTime, duration, unavailable, seek, seekAndPlay, togglePlay };
}

function PlayerBar({
  playing,
  currentTime,
  duration,
  unavailable,
  onTogglePlay,
  onSeek,
}: {
  playing: boolean;
  currentTime: number;
  duration: number;
  unavailable: boolean;
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
}) {
  if (unavailable) {
    return (
      <div className="player-bar player-bar-unavailable">Original media file not found - playback unavailable.</div>
    );
  }
  return (
    <div className="player-bar">
      <button className="icon-btn" onClick={onTogglePlay} title={playing ? "Pause" : "Play"}>
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <span className="player-time">{formatTimecode(currentTime)}</span>
      <input
        type="range"
        className="player-seek"
        min={0}
        max={duration || 0}
        step={0.1}
        value={currentTime}
        onChange={(e) => onSeek(Number(e.target.value))}
      />
      <span className="player-time">{formatTimecode(duration)}</span>
    </div>
  );
}

// Shared between TranscribeTab's live result view and HistoryTab's read-only
// view - editable=false (History) hides the rename/reassign affordances and
// renders plain text instead of a textarea; onSeek (from useAudioPlayer, when
// a source file is available) makes each line's timestamp clickable.
function TranscriptView({
  turns,
  speakers,
  editable,
  search = "",
  activeIndex = null,
  onSeek,
  onTextChange,
  onOpenRename,
  reassignIndex = null,
  onOpenReassign,
  onReassignPick,
  onCloseReassign,
  onSplit,
  onMergeDown,
  onDeleteLine,
  onNoteChange,
}: {
  turns: Turn[];
  speakers: string[];
  editable: boolean;
  search?: string;
  activeIndex?: number | null;
  onSeek?: (start: number) => void;
  onTextChange?: (index: number, text: string) => void;
  onOpenRename?: (speaker: string) => void;
  reassignIndex?: number | null;
  onOpenReassign?: (index: number) => void;
  onReassignPick?: (index: number, speaker: string) => void;
  onCloseReassign?: () => void;
  onSplit?: (index: number, cursorPos: number) => void;
  onMergeDown?: (index: number) => void;
  onDeleteLine?: (index: number) => void;
  onNoteChange?: (index: number, note: string) => void;
}) {
  const q = search.trim().toLowerCase();
  // Keyed by utterance index, read at split-click time (see onMouseDown
  // below) - not React state, since it's just a way to reach the DOM node.
  const textareaRefs = useRef<Record<number, HTMLTextAreaElement | null>>({});

  return (
    <div className="transcript-list">
      {turns.map((turn, ti) => (
        <div className="turn" key={ti}>
          {editable ? (
            <button
              className="turn-avatar"
              style={{ background: colorForSpeaker(turn.speaker), color: BADGE_TEXT }}
              onClick={() => onOpenRename?.(turn.speaker)}
              title="Rename speaker"
            >
              {initials(turn.speaker)}
            </button>
          ) : (
            <div
              className="turn-avatar"
              style={{ background: colorForSpeaker(turn.speaker), color: BADGE_TEXT, cursor: "default" }}
            >
              {initials(turn.speaker)}
            </div>
          )}
          <div className="turn-body">
            {turn.items.map(({ utterance: u, index }, li) => {
              const matches =
                q.length > 0 &&
                (u.text.toLowerCase().includes(q) || u.speaker.toLowerCase().includes(q));
              const dimmed = q.length > 0 && !matches;
              const active = activeIndex === index;
              const isLastOverall = ti === turns.length - 1 && li === turn.items.length - 1;
              const hasNote = u.note !== undefined;
              return (
                <div
                  className={`turn-line ${dimmed ? "turn-line-dimmed" : ""} ${active ? "turn-line-active" : ""}`}
                  key={index}
                >
                  <div className="turn-line-head">
                    {editable && (
                      <button
                        className="line-dot"
                        style={{ background: colorForSpeaker(turn.speaker) }}
                        onClick={() => onOpenReassign?.(index)}
                        title="Move this line to another speaker"
                      />
                    )}
                    {li === 0 &&
                      (editable ? (
                        <button
                          className="turn-speaker-name"
                          style={{ color: colorForSpeaker(turn.speaker) }}
                          onClick={() => onOpenRename?.(turn.speaker)}
                        >
                          {turn.speaker} <Pencil size={11} />
                        </button>
                      ) : (
                        <span className="turn-speaker-name" style={{ color: colorForSpeaker(turn.speaker) }}>
                          {turn.speaker}
                        </span>
                      ))}
                    <span
                      className={`turn-time ${onSeek ? "clickable" : ""}`}
                      onClick={onSeek ? () => onSeek(u.start) : undefined}
                      title={onSeek ? "Play from here" : undefined}
                    >
                      {formatTimecode(u.start)} – {formatTimecode(u.end)}
                    </span>
                    {editable && (
                      <div className="line-actions">
                        {!hasNote && (
                          <button
                            className="line-action"
                            onClick={() => onNoteChange?.(index, "")}
                            title="Add a note"
                          >
                            <StickyNote size={12} />
                          </button>
                        )}
                        <button
                          className="line-action"
                          onMouseDown={(e) => {
                            // preventDefault keeps the textarea focused so its
                            // selectionStart survives the click.
                            e.preventDefault();
                            const el = textareaRefs.current[index];
                            const pos = el?.selectionStart ?? u.text.length;
                            onSplit?.(index, pos);
                          }}
                          title="Split at cursor"
                        >
                          <Scissors size={12} />
                        </button>
                        {!isLastOverall && (
                          <button
                            className="line-action"
                            onClick={() => onMergeDown?.(index)}
                            title="Merge with next line"
                          >
                            <Combine size={12} />
                          </button>
                        )}
                        <button
                          className="line-action"
                          onClick={() => onDeleteLine?.(index)}
                          title="Delete this line"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    )}
                    {reassignIndex === index && onReassignPick && onCloseReassign && (
                      <ReassignPopover
                        speakers={speakers}
                        current={turn.speaker}
                        onPick={(s) => onReassignPick(index, s)}
                        onClose={onCloseReassign}
                      />
                    )}
                  </div>
                  {editable && onTextChange ? (
                    <AutoResizeTextarea
                      className="turn-text"
                      value={u.text}
                      onChange={(text) => onTextChange(index, text)}
                      inputRef={(el) => {
                        textareaRefs.current[index] = el;
                      }}
                    />
                  ) : (
                    <div className="turn-text" style={{ cursor: "default" }}>
                      {u.text}
                    </div>
                  )}
                  {editable && hasNote && (
                    <input
                      className="note-input"
                      value={u.note ?? ""}
                      placeholder="Note (e.g. off-screen, interrupting)..."
                      onChange={(e) => onNoteChange?.(index, e.target.value)}
                    />
                  )}
                  {!editable && u.note && <div className="note-input note-readonly">{u.note}</div>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<View>("transcribe");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [dbPath, setDbPath] = useState<string>("");
  // Reopening a History item is treated as equivalent to having just
  // finished transcribing it - it's handed to TranscribeTab, which seeds its
  // state from it and lands directly in the same fully-editable/exportable
  // result view, instead of History having its own separate read-only copy
  // of that view (which is what used to make past transcriptions
  // uneditable/unexportable once you navigated away from them).
  const [openHistoryItem, setOpenHistoryItem] = useState<HistoryItem | null>(null);
  // The job queue lives here, not inside TranscribeTab, specifically so it
  // survives switching tabs - TranscribeTab used to own progress/listener
  // state locally, so navigating away while a job ran unmounted it, leaked
  // the "job-event" listener (never torn down), and orphaned the still-
  // running engine process with no way to see its progress or cancel it.
  // One job runs at a time (matches the single RunningJob pid the Rust side
  // tracks); others wait as "queued" - see the scheduling effect below.
  const [jobs, setJobs] = useState<TranscribeJob[]>([]);
  const jobUnlistenRef = useRef<(() => void) | undefined>(undefined);
  const startingJobRef = useRef<string | null>(null);

  function openHistoryItemInTranscribeTab(item: HistoryItem) {
    setOpenHistoryItem(item);
    setView("transcribe");
  }

  function enqueueJobs(paths: string[], model: ModelName, language: LanguageCode) {
    const newJobs: TranscribeJob[] = paths.map((audioPath) => ({
      id: crypto.randomUUID(),
      audioPath,
      fileName: fileNameFromPath(audioPath),
      model,
      language,
      status: "queued",
      progress: null,
      seenStages: [],
      error: null,
      createdAt: new Date().toISOString(),
    }));
    setJobs((prev) => [...prev, ...newJobs]);
    setView("jobs");
  }

  function updateJob(id: string, patch: Partial<TranscribeJob>) {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)));
  }

  async function cancelJobById(id: string) {
    const job = jobs.find((j) => j.id === id);
    if (!job) return;
    if (job.status === "running") {
      jobUnlistenRef.current?.();
      jobUnlistenRef.current = undefined;
      await cancelJob();
    }
    if (job.status === "queued" || job.status === "running") {
      updateJob(id, { status: "cancelled" });
    }
  }

  async function openJobResult(job: TranscribeJob) {
    const item = await loadTranscript(job.id);
    openHistoryItemInTranscribeTab(item);
  }

  // Advances the queue: if nothing is running and something is queued,
  // start it. Runs after every jobs-state change (a job finishing clears
  // "running", letting the next "queued" one start).
  useEffect(() => {
    if (!settings) return;
    if (jobs.some((j) => j.status === "running")) return;
    const next = jobs.find((j) => j.status === "queued");
    if (!next) return;
    // React StrictMode (dev only) re-invokes this effect's setup twice using
    // the same render's closure, before the setJobs below is reflected in a
    // new render - without this ref guard (mutated synchronously, unlike
    // batched state) that would start the same job with two concurrent
    // transcribeVideo calls fighting over the single RunningJob pid slot.
    if (startingJobRef.current === next.id) return;
    startingJobRef.current = next.id;

    updateJob(next.id, { status: "running", progress: { pct: 0, message: "Starting..." } });
    void transcribeVideo(
      next.audioPath,
      { hfToken: settings.hfToken, model: next.model, dbPath, language: next.language },
      async (event: JobEvent) => {
        if (event.type === "status") {
          setJobs((prev) =>
            prev.map((j) =>
              j.id === next.id
                ? {
                    ...j,
                    progress: { pct: event.pct, message: event.message },
                    seenStages: j.seenStages.includes(event.pct)
                      ? j.seenStages
                      : [...j.seenStages, event.pct],
                  }
                : j
            )
          );
        } else if (event.type === "utterances") {
          jobUnlistenRef.current?.();
          jobUnlistenRef.current = undefined;
          if (event.data.length === 0) {
            updateJob(next.id, { status: "error", error: "No speech was detected in this file." });
            return;
          }
          const item: HistoryItem = {
            id: next.id,
            fileName: next.fileName,
            audioPath: next.audioPath,
            createdAt: next.createdAt,
            speakerCount: new Set(event.data.map((u) => u.speaker)).size,
            durationSeconds: maxEnd(event.data),
            utterances: event.data,
          };
          await saveTranscript(item);
          updateJob(next.id, { status: "done", progress: { pct: 100, message: "Done" } });
        } else if (event.type === "error") {
          jobUnlistenRef.current?.();
          jobUnlistenRef.current = undefined;
          updateJob(next.id, { status: "error", error: event.message });
        }
      }
    ).then((fn) => {
      jobUnlistenRef.current = fn;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, settings, dbPath]);

  useEffect(() => {
    getSettings().then(setSettings);
    appDataDir()
      .then((dir) => join(dir, "speakers.db"))
      .then(setDbPath);
  }, []);

  async function handleSettingsChange(next: Settings) {
    setSettings(next);
    await saveSettings(next);
  }

  if (!settings) return null;

  const activeJobCount = jobs.filter((j) => j.status === "queued" || j.status === "running").length;

  return (
    <div className="app" data-theme={settings.theme}>
      <div className="sidebar">
        <div className="sidebar-brand">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--accent)"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 6h16M4 12h10M4 18h13" />
            <circle cx="19" cy="18" r="2.4" />
          </svg>
          Transcriber
        </div>
        <nav className="sidebar-nav">
          <button
            className={`sidebar-item ${view === "transcribe" ? "active" : ""}`}
            onClick={() => setView("transcribe")}
          >
            <FileAudio2 size={16} /> New Transcription
          </button>
          <button
            className={`sidebar-item ${view === "jobs" ? "active" : ""}`}
            onClick={() => setView("jobs")}
          >
            <ListChecks size={16} /> Jobs
            {activeJobCount > 0 && <span className="sidebar-badge">{activeJobCount}</span>}
          </button>
          <button
            className={`sidebar-item ${view === "history" ? "active" : ""}`}
            onClick={() => setView("history")}
          >
            <HistoryIcon size={16} /> History
          </button>
          <button
            className={`sidebar-item ${view === "speakers" ? "active" : ""}`}
            onClick={() => setView("speakers")}
          >
            <Users size={16} /> Speakers
          </button>
          <button
            className={`sidebar-item ${view === "settings" ? "active" : ""}`}
            onClick={() => setView("settings")}
          >
            <SettingsIcon size={16} /> Settings
          </button>
        </nav>
        <div className="sidebar-spacer" />
      </div>
      <div className="main">
        {view === "transcribe" && (
          <TranscribeTab
            settings={settings}
            dbPath={dbPath}
            onSettingsChange={handleSettingsChange}
            initialItem={openHistoryItem}
            onInitialItemConsumed={() => setOpenHistoryItem(null)}
            onEnqueue={enqueueJobs}
          />
        )}
        {view === "jobs" && (
          <JobsTab jobs={jobs} onCancel={cancelJobById} onViewResult={openJobResult} />
        )}
        {view === "history" && <HistoryTab onOpenItem={openHistoryItemInTranscribeTab} />}
        {view === "speakers" && <SpeakersTab dbPath={dbPath} />}
        {view === "settings" && (
          <div className="main-content">
            <SettingsTab settings={settings} onChange={handleSettingsChange} />
          </div>
        )}
      </div>
    </div>
  );
}

function ReassignPopover({
  speakers,
  current,
  onPick,
  onClose,
}: {
  speakers: string[];
  current: string;
  onPick: (speaker: string) => void;
  onClose: () => void;
}) {
  const others = speakers.filter((s) => s !== current);
  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 15 }} onClick={onClose} />
      <div className="reassign-popover" onClick={(e) => e.stopPropagation()}>
        <div className="reassign-label">Move line to</div>
        {others.length === 0 && (
          <div className="reassign-label" style={{ paddingTop: 0 }}>
            No other speakers yet
          </div>
        )}
        {others.map((s) => (
          <div
            key={s}
            className="reassign-option"
            onClick={() => {
              onPick(s);
              onClose();
            }}
          >
            <span className="reassign-dot" style={{ background: colorForSpeaker(s) }} />
            {s}
          </div>
        ))}
      </div>
    </>
  );
}

function TranscribeTab({
  settings,
  dbPath,
  onSettingsChange,
  initialItem,
  onInitialItemConsumed,
  onEnqueue,
}: {
  settings: Settings;
  dbPath: string;
  onSettingsChange: (settings: Settings) => void;
  initialItem?: HistoryItem | null;
  onInitialItemConsumed?: () => void;
  onEnqueue: (paths: string[], model: ModelName, language: LanguageCode) => void;
}) {
  // Files picked/dropped but not yet queued - separate from `selectedFile`
  // below, which is the single source file behind whatever *already-
  // transcribed* item is currently open for editing. Once queued, progress
  // lives in App-level job state (see the Jobs tab), not here - this
  // component no longer runs a job itself, only starts one.
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [utterances, setUtterances] = useState<Utterance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [reassignIndex, setReassignIndex] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Called unconditionally here (not down in the result-view branch below) -
  // TranscribeTab has an early return before that point, and a hook can't
  // be called conditionally/after an early return.
  const player = useAudioPlayer(selectedFile);

  // Reopening a History item (or a just-finished job, via the Jobs tab's
  // "View" button) lands here fully seeded, as if it had just finished
  // transcribing - same editable/exportable result view, same persist-on-
  // edit (keyed by the same historyId, so edits overwrite the existing
  // entry rather than creating a new one).
  useEffect(() => {
    if (!initialItem) return;
    setSelectedFile(initialItem.audioPath);
    setUtterances(initialItem.utterances);
    setHistoryId(initialItem.id);
    setCreatedAt(initialItem.createdAt);
    setError(null);
    setSearch("");
    onInitialItemConsumed?.();
    // onInitialItemConsumed intentionally omitted: it's a fresh closure
    // every render (defined inline in App()), and including it would refire
    // this effect after every unrelated App() re-render, not just when a
    // genuinely new item is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialItem]);

  useEffect(() => {
    // `cancelled` guards against the same class of bug fixed elsewhere in
    // this file: onDragDropEvent's promise can still resolve after unmount
    // (fast tab-switching during the async IPC round-trip), in which case
    // assigning to `unlisten` here would be too late for the cleanup below
    // to see it, leaking the listener forever.
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over") {
          setDragging(true);
        } else if (event.payload.type === "drop") {
          setDragging(false);
          if (event.payload.paths.length > 0) setSelectedFiles(event.payload.paths);
        } else {
          setDragging(false);
        }
      })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  async function pickFile() {
    const paths = await open({
      multiple: true,
      filters: [
        {
          name: "Media",
          extensions: ["mp4", "mkv", "mov", "avi", "wav", "mp3", "m4a", "flac"],
        },
      ],
    });
    if (Array.isArray(paths)) setSelectedFiles(paths);
    else if (typeof paths === "string") setSelectedFiles([paths]);
  }

  function startQueue() {
    if (selectedFiles.length === 0) return;
    onEnqueue(selectedFiles, settings.model, settings.language);
    setSelectedFiles([]);
  }

  // Re-persists the in-progress transcript to History under the same id, so
  // text edits/renames/reassignments survive reopening from History instead
  // of only ever living in this component's state.
  async function persist(next: Utterance[]) {
    if (!historyId || !selectedFile || !createdAt) return;
    const item: HistoryItem = {
      id: historyId,
      fileName: fileNameFromPath(selectedFile),
      audioPath: selectedFile,
      createdAt,
      speakerCount: new Set(next.map((u) => u.speaker)).size,
      durationSeconds: maxEnd(next),
      utterances: next,
    };
    await saveTranscript(item);
  }

  function updateUtteranceText(index: number, text: string) {
    setUtterances((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      next[index] = { ...next[index], text };
      // Debounced: this fires on every keystroke, and persisting is a disk
      // write - wait for a pause in typing rather than writing on every char.
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => {
        void persist(next);
      }, 800);
      return next;
    });
  }

  function reassignLine(index: number, newSpeaker: string) {
    setUtterances((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      next[index] = { ...next[index], speaker: newSpeaker };
      void persist(next);
      return next;
    });
  }

  function updateNote(index: number, note: string) {
    setUtterances((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      next[index] = { ...next[index], note };
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => {
        void persist(next);
      }, 800);
      return next;
    });
  }

  // Splits one line into two at a character position in its text. There's no
  // word-level timing data in the JSON contract (only per-utterance start/
  // end), so the time split is an approximation: proportional to where the
  // cursor fell in the text, not the actual audio boundary.
  function splitLine(index: number, cursorPos: number) {
    setReassignIndex(null);
    setUtterances((prev) => {
      if (!prev) return prev;
      const u = prev[index];
      const clamped = Math.max(0, Math.min(cursorPos, u.text.length));
      if (clamped === 0 || clamped === u.text.length) return prev;
      const ratio = clamped / u.text.length;
      const mid = u.start + (u.end - u.start) * ratio;
      const first: Utterance = { ...u, text: u.text.slice(0, clamped).trim(), end: mid };
      const second: Utterance = { ...u, text: u.text.slice(clamped).trim(), start: mid, note: undefined };
      const next = [...prev.slice(0, index), first, second, ...prev.slice(index + 1)];
      void persist(next);
      return next;
    });
  }

  // Joins this line with the next one (regardless of speaker - if a
  // diarization boundary landed in a weird spot, not just a same-speaker
  // segmentation split). Keeps this line's speaker for the merged result.
  function mergeWithNext(index: number) {
    setReassignIndex(null);
    setUtterances((prev) => {
      if (!prev || index >= prev.length - 1) return prev;
      const a = prev[index];
      const b = prev[index + 1];
      const merged: Utterance = {
        speaker: a.speaker,
        text: `${a.text} ${b.text}`.trim(),
        start: a.start,
        end: b.end,
        note: [a.note, b.note].filter(Boolean).join(" / ") || undefined,
      };
      const next = [...prev.slice(0, index), merged, ...prev.slice(index + 2)];
      void persist(next);
      return next;
    });
  }

  function deleteLine(index: number) {
    if (!window.confirm("Delete this line? This can't be undone.")) return;
    setReassignIndex(null);
    setUtterances((prev) => {
      if (!prev) return prev;
      const next = prev.filter((_, i) => i !== index);
      void persist(next);
      return next;
    });
  }

  async function confirmRename(newName: string) {
    // `enrolling` blocks starting a second rename while one is still in
    // flight - without it, nothing stops a second confirmRename call from
    // registering another unscoped "job-event" listener before the first
    // one's enroll job finishes, so whichever job's terminal event fires
    // first gets picked up by both listeners and resolves the wrong one.
    if (!renameTarget || !selectedFile || !utterances || enrolling) return;
    const oldLabel = renameTarget;
    const candidates = utterances.filter((u) => u.speaker === oldLabel);
    const longest = candidates.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));

    setRenameTarget(null);
    setEnrolling(true);
    setError(null);
    let segmentPath: string | null = null;
    let enrolled = false;
    try {
      segmentPath = await invoke<string>("extract_audio_segment", {
        audio: selectedFile,
        start: longest.start,
        end: longest.end,
      });
      enrolled = await new Promise<boolean>((resolve) => {
        let unlisten: (() => void) | undefined;
        enrollSpeaker(segmentPath as string, newName, dbPath, (event) => {
          if (event.type === "enrolled") {
            unlisten?.();
            resolve(true);
          } else if (event.type === "error") {
            unlisten?.();
            setError(event.message);
            resolve(false);
          }
        }).then((fn) => {
          unlisten = fn;
        });
      });
    } catch (err) {
      setError(String(err));
    } finally {
      if (segmentPath) void invoke("delete_temp_file", { path: segmentPath });
      setEnrolling(false);
    }

    // Only apply the rename if the voiceprint was actually enrolled -
    // otherwise the UI would show a successful rename for a speaker whose
    // voice was never learned, and future recordings would never match them.
    if (!enrolled) return;

    setUtterances((prev) => {
      const next = prev?.map((u) => (u.speaker === oldLabel ? { ...u, speaker: newName } : u)) ?? prev;
      if (next) void persist(next);
      return next;
    });
  }

  async function exportAs(format: ExportFormat) {
    if (!utterances || !selectedFile) return;
    setExportMenuOpen(false);
    // Kept the try/catch this got when it was xlsx-only: any failure here (a
    // bad file, the save dialog, the file write) used to be a silent
    // unhandled promise rejection with zero feedback, indistinguishable from
    // the export button doing nothing.
    try {
      const { blob, filterName, extension } = await buildExport(format, utterances, selectedFile);
      const buffer = new Uint8Array(await blob.arrayBuffer());
      const savePath = await invoke<string | null>("save_export_dialog", {
        defaultName: `${fileNameFromPath(selectedFile).replace(/\.[^.]+$/, "")}.${extension}`,
        filterName,
        extension,
      });
      if (savePath) {
        await invoke("write_binary_file", { path: savePath, data: Array.from(buffer) });
      }
    } catch (err) {
      setError(`Failed to export .${format}: ${String(err)}`);
    }
  }

  function resetToStart() {
    setUtterances(null);
    setSelectedFile(null);
    setError(null);
    setSearch("");
    setHistoryId(null);
    setCreatedAt(null);
  }

  if (!utterances) {
    // Not viewing/editing an already-transcribed item - show the file-
    // picker/queue screen. (No "error" branch here anymore: `error` is now
    // only ever set by edit-time actions below - rename/export - which are
    // unreachable before `utterances` exists; job-start failures show up in
    // the Jobs tab instead, since starting a job no longer happens here.)
    return (
      <div className="dropzone-wrap">
        <div style={{ textAlign: "center" }}>
          <div className={`dropzone ${dragging ? "dragging" : ""}`} onClick={pickFile}>
            <UploadCloud size={32} />
            <div>
              {selectedFiles.length === 0
                ? "Drop video or audio files, or click to browse"
                : selectedFiles.length === 1
                  ? fileNameFromPath(selectedFiles[0])
                  : `${selectedFiles.length} files selected`}
            </div>
          </div>
          {selectedFiles.length > 0 && (
            <>
              <div className="model-picker">
                <span className="model-picker-label">Model</span>
                <div className="theme-toggle">
                  {MODELS.map((m) => (
                    <button
                      key={m}
                      className={settings.model === m ? "active" : ""}
                      onClick={() => onSettingsChange({ ...settings, model: m })}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
              <div className="model-picker">
                <span className="model-picker-label">Language</span>
                <select
                  className="settings-select language-picker-select"
                  value={settings.language}
                  onChange={(e) => onSettingsChange({ ...settings, language: e.target.value })}
                >
                  <option value="">Auto-detect</option>
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="dropzone-file">
                <button className="btn" onClick={startQueue}>
                  {selectedFiles.length > 1 ? `Queue ${selectedFiles.length} files` : "Transcribe"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // Result view - utterances is guaranteed non-null past this point.
  const allUtterances = utterances as Utterance[];
  const turns = groupIntoTurns(allUtterances);
  const speakers = Array.from(new Set(allUtterances.map((u) => u.speaker)));
  const totalSeconds = maxEnd(allUtterances);

  return (
    <>
      <div className="doc-header">
        <div>
          <div className="doc-title">{fileNameFromPath(selectedFile as string)}</div>
          <div className="doc-meta">
            <span>{speakers.length} speakers</span>
            <span className="doc-meta-sep">/</span>
            <span>{Math.round(totalSeconds / 60)} min</span>
          </div>
        </div>
        <div className="doc-actions">
          <div className={`search-box ${search ? "active" : ""}`}>
            <Search size={14} />
            <input
              placeholder="Search transcript"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                className="icon-btn"
                style={{ width: 20, height: 20, border: "none" }}
                onClick={() => setSearch("")}
              >
                <X size={12} />
              </button>
            )}
          </div>
          <div style={{ position: "relative" }}>
            <button
              className="icon-btn"
              onClick={() => setExportMenuOpen((v) => !v)}
              title="Export"
            >
              <Download size={16} />
            </button>
            {exportMenuOpen && (
              <>
                <div style={{ position: "fixed", inset: 0, zIndex: 15 }} onClick={() => setExportMenuOpen(false)} />
                <div className="reassign-popover" style={{ left: "auto", right: 0 }}>
                  <div className="reassign-label">Export as</div>
                  {(Object.keys(EXPORT_FORMAT_LABEL) as ExportFormat[]).map((format) => (
                    <div key={format} className="reassign-option" onClick={() => exportAs(format)}>
                      {EXPORT_FORMAT_LABEL[format]}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          <button className="btn secondary" onClick={resetToStart}>
            New transcription
          </button>
        </div>
      </div>
      {player.videoElement}
      <PlayerBar
        playing={player.playing}
        currentTime={player.currentTime}
        duration={player.duration}
        unavailable={player.unavailable}
        onTogglePlay={player.togglePlay}
        onSeek={player.seek}
      />
      {error && (
        <div className="error-banner" style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <span>{error}</span>
          <button
            className="icon-btn"
            style={{ width: 20, height: 20, border: "none", flexShrink: 0 }}
            onClick={() => setError(null)}
          >
            <X size={12} />
          </button>
        </div>
      )}
      <div className="main-content">
        <TranscriptView
          turns={turns}
          speakers={speakers}
          editable
          search={search}
          activeIndex={player.playing ? activeUtteranceIndex(allUtterances, player.currentTime) : null}
          onSeek={player.unavailable ? undefined : player.seekAndPlay}
          onTextChange={updateUtteranceText}
          onOpenRename={setRenameTarget}
          reassignIndex={reassignIndex}
          onOpenReassign={setReassignIndex}
          onReassignPick={reassignLine}
          onCloseReassign={() => setReassignIndex(null)}
          onSplit={splitLine}
          onMergeDown={mergeWithNext}
          onDeleteLine={deleteLine}
          onNoteChange={updateNote}
        />
      </div>

      {renameTarget && (
        <RenameModal
          currentLabel={renameTarget}
          saving={enrolling}
          onCancel={() => setRenameTarget(null)}
          onConfirm={confirmRename}
        />
      )}
    </>
  );
}

function RenameModal({
  currentLabel,
  saving,
  onCancel,
  onConfirm,
}: {
  currentLabel: string;
  saving: boolean;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState(currentLabel);
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Rename speaker</h3>
        <input
          className="settings-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <div className="modal-actions">
          <button className="btn secondary" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button className="btn" onClick={() => onConfirm(name)} disabled={!name.trim() || saving}>
            {saving ? "Enrolling voice..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

const JOB_STATUS_LABEL: Record<TranscribeJob["status"], string> = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  error: "Failed",
  cancelled: "Cancelled",
};

function JobsTab({
  jobs,
  onCancel,
  onViewResult,
}: {
  jobs: TranscribeJob[];
  onCancel: (id: string) => void;
  onViewResult: (job: TranscribeJob) => void;
}) {
  if (jobs.length === 0) {
    return (
      <div className="main-content">
        <div className="history-empty">No transcription jobs yet - start one from New Transcription.</div>
      </div>
    );
  }

  // Active jobs (running, then queued in queue order) first, then finished
  // ones most-recently-created first - keeps what needs attention on top
  // without the list reordering itself as jobs finish and drop out of "active".
  const active = jobs.filter((j) => j.status === "running" || j.status === "queued");
  const finished = jobs
    .filter((j) => j.status === "done" || j.status === "error" || j.status === "cancelled")
    .slice()
    .reverse();

  return (
    <div className="main-content">
      <div className="jobs-list">
        {[...active, ...finished].map((job) => (
          <JobRow key={job.id} job={job} onCancel={onCancel} onViewResult={onViewResult} />
        ))}
      </div>
    </div>
  );
}

function JobRow({
  job,
  onCancel,
  onViewResult,
}: {
  job: TranscribeJob;
  onCancel: (id: string) => void;
  onViewResult: (job: TranscribeJob) => void;
}) {
  return (
    <div className="job-row">
      <div className="job-row-main">
        <div className="job-row-top">
          <span className="job-row-name">{job.fileName}</span>
          <span className={`job-status job-status-${job.status}`}>{JOB_STATUS_LABEL[job.status]}</span>
          <span className="job-row-model">{job.model}</span>
        </div>
        {job.status === "running" && job.progress && (
          <>
            <div className="progress-bar">
              <div className="progress-bar-fill" style={{ width: `${job.progress.pct}%` }} />
            </div>
            <div className="job-row-message">{job.progress.message}</div>
          </>
        )}
        {job.status === "error" && job.error && <div className="job-row-error">{job.error}</div>}
      </div>
      <div className="job-row-actions">
        {(job.status === "running" || job.status === "queued") && (
          <button className="icon-btn" onClick={() => onCancel(job.id)} title="Cancel">
            <XCircle size={16} />
          </button>
        )}
        {job.status === "done" && (
          <button className="btn secondary" onClick={() => onViewResult(job)}>
            View
          </button>
        )}
      </div>
    </div>
  );
}

// The utterance whose text/speaker/note first matches the query, for a
// search-result preview snippet - or null if this item doesn't match at all
// (distinguishing "matched on filename only" from "matched inside the
// transcript" so the list can show why an item matched, not just that it did).
function firstMatch(item: HistoryItem, q: string): Utterance | null {
  return (
    item.utterances.find(
      (u) =>
        u.text.toLowerCase().includes(q) ||
        u.speaker.toLowerCase().includes(q) ||
        u.note?.toLowerCase().includes(q)
    ) ?? null
  );
}

function HistoryTab({ onOpenItem }: { onOpenItem: (item: HistoryItem) => void }) {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    listHistory().then(setItems);
  }, []);

  async function handleDelete(id: string) {
    await deleteTranscript(id);
    setItems((prev) => prev?.filter((i) => i.id !== id) ?? prev);
  }

  const q = search.trim().toLowerCase();
  const visible = !q
    ? items
    : items?.filter((item) => item.fileName.toLowerCase().includes(q) || firstMatch(item, q));

  return (
    <>
      <div className="doc-header">
        <div className="doc-title">History</div>
        <div className="doc-actions">
          <div className={`search-box ${q ? "active" : ""}`}>
            <Search size={14} />
            <input
              placeholder="Search all transcripts"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {q && (
              <button
                className="icon-btn"
                style={{ width: 20, height: 20, border: "none" }}
                onClick={() => setSearch("")}
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="main-content">
        <div className="history-list">
          {items?.length === 0 && <div className="history-empty">No transcripts yet.</div>}
          {q && visible?.length === 0 && (
            <div className="history-empty">No transcripts match "{search}".</div>
          )}
          {visible?.map((item) => {
            const speakerNames = Array.from(new Set(item.utterances.map((u) => u.speaker)));
            const match = q ? firstMatch(item, q) : null;
            return (
              <div className="history-item" key={item.id} onClick={() => onOpenItem(item)}>
                <div style={{ minWidth: 0 }}>
                  <div className="history-item-name">{item.fileName}</div>
                  <div className="history-item-meta">
                    {item.speakerCount} speakers · {Math.round(item.durationSeconds / 60)} min ·{" "}
                    {new Date(item.createdAt).toLocaleString()}
                  </div>
                  {match ? (
                    <div className="history-item-snippet">
                      <span style={{ color: colorForSpeaker(match.speaker), fontWeight: 600 }}>
                        {match.speaker}:
                      </span>{" "}
                      {match.text}
                    </div>
                  ) : (
                    <div className="history-item-speakers">
                      {speakerNames.map((s) => (
                        <span
                          key={s}
                          className="history-item-dot"
                          style={{ background: colorForSpeaker(s) }}
                          title={s}
                        />
                      ))}
                    </div>
                  )}
                </div>
                <button
                  className="btn danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(item.id);
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function SpeakersTab({ dbPath }: { dbPath: string }) {
  const [speakers, setSpeakers] = useState<string[] | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    if (!dbPath) return;
    listSpeakers(dbPath)
      .then(setSpeakers)
      .catch((err) => setError(String(err)));
  }

  useEffect(refresh, [dbPath]);

  async function handleDelete(name: string) {
    if (
      !window.confirm(
        `Delete the enrolled voice for "${name}"? Future recordings won't be recognized as them anymore.`
      )
    ) {
      return;
    }
    try {
      await deleteSpeakerGlobal(dbPath, name);
      refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleRename(oldName: string, newName: string) {
    setRenaming(null);
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) return;
    try {
      await renameSpeakerGlobal(dbPath, oldName, trimmed);
      refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="main-content">
      {error && (
        <div className="error-banner" style={{ display: "flex", justifyContent: "space-between", gap: 12, margin: "0 0 16px" }}>
          <span>{error}</span>
          <button className="icon-btn" style={{ width: 20, height: 20, border: "none" }} onClick={() => setError(null)}>
            <X size={12} />
          </button>
        </div>
      )}
      <div className="history-list">
        {speakers?.length === 0 && (
          <div className="history-empty">
            No enrolled voices yet - rename a speaker during or after a transcription to enroll them, so
            future recordings can recognize their voice automatically.
          </div>
        )}
        {speakers?.map((name) => (
          <div className="history-item" key={name} style={{ cursor: "default" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div
                className="turn-avatar"
                style={{ background: colorForSpeaker(name), color: BADGE_TEXT, cursor: "default" }}
              >
                {initials(name)}
              </div>
              <div className="history-item-name">{name}</div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="icon-btn" onClick={() => setRenaming(name)} title="Rename">
                <Pencil size={14} />
              </button>
              <button className="btn danger" onClick={() => handleDelete(name)} title="Delete">
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
      {renaming && (
        <RenameModal
          currentLabel={renaming}
          saving={false}
          onCancel={() => setRenaming(null)}
          onConfirm={(newName) => handleRename(renaming, newName)}
        />
      )}
    </div>
  );
}

function SettingsTab({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (settings: Settings) => void;
}) {
  return (
    <div>
      <div className="settings-card">
        <div className="settings-card-title">Hugging Face token</div>
        <div className="settings-card-hint">
          Needed once to download the speaker-diarization model. Stored locally, never sent
          anywhere else.
        </div>
        <input
          className="settings-input"
          type="password"
          value={settings.hfToken}
          onChange={(e) => onChange({ ...settings, hfToken: e.target.value })}
          placeholder="hf_..."
        />
      </div>
      <div className="settings-card">
        <div className="settings-card-title">Appearance</div>
        <div className="settings-card-hint">Switch between dark and light.</div>
        <div className="theme-toggle">
          <button
            className={settings.theme === "dark" ? "active" : ""}
            onClick={() => onChange({ ...settings, theme: "dark" })}
          >
            Dark
          </button>
          <button
            className={settings.theme === "light" ? "active" : ""}
            onClick={() => onChange({ ...settings, theme: "light" })}
          >
            Light
          </button>
        </div>
      </div>
    </div>
  );
}
