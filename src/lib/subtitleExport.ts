import type { Utterance } from "../types";

function pad(n: number, width: number): string {
  return n.toString().padStart(width, "0");
}

// HH:MM:SS,mmm - SRT's comma-separated milliseconds.
function srtTimecode(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

// HH:MM:SS.mmm - WebVTT's dot-separated milliseconds; otherwise identical.
function vttTimecode(seconds: number): string {
  return srtTimecode(seconds).replace(",", ".");
}

// One cue per utterance (not merged into speaker "turns" like the in-app
// view) - subtitles need to stay on screen only as long as the line
// actually takes to say, and each utterance already has its own natural
// start/end from the engine.
export function exportToSrt(utterances: Utterance[]): Blob {
  const lines: string[] = [];
  utterances.forEach((u, i) => {
    lines.push(String(i + 1));
    lines.push(`${srtTimecode(u.start)} --> ${srtTimecode(u.end)}`);
    lines.push(`${u.speaker}: ${u.text}`);
    lines.push("");
  });
  return new Blob([lines.join("\n")], { type: "text/plain" });
}

export function exportToVtt(utterances: Utterance[]): Blob {
  const lines: string[] = ["WEBVTT", ""];
  utterances.forEach((u) => {
    lines.push(`${vttTimecode(u.start)} --> ${vttTimecode(u.end)}`);
    lines.push(`${u.speaker}: ${u.text}`);
    lines.push("");
  });
  return new Blob([lines.join("\n")], { type: "text/vtt" });
}
