// A fixed palette assigned deterministically from each speaker's label (a
// stable hash), not from render/appearance order - so a speaker keeps the
// same color across re-renders, edits, reopening from History, and in the
// exported .xlsx cue sheet (xlsxExport.ts uses this same module).
const PALETTE = [
  "#2DD4BF", // teal
  "#F472B6", // pink
  "#FBBF24", // amber
  "#4ADE80", // green
  "#818CF8", // indigo
  "#FB923C", // orange
];

// Dark navy - stays readable as text set on any of the bright PALETTE fills
// above, on-screen.
export const SPEAKER_BADGE_TEXT = "16162A";

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function colorForSpeaker(speaker: string): string {
  return PALETTE[hashString(speaker) % PALETTE.length];
}

// A pastel tint of the same hue colorForSpeaker returns for this speaker -
// used as a full xlsx row fill (cue-sheet style, like the reference sheet),
// where a solid vivid color behind ordinary black cell text would be too
// loud. The vivid PALETTE value is for small in-app elements (avatar chips)
// sized to carry white/dark text directly on them. Returns a bare 6-hex-digit
// RGB string (no "#", no alpha) - callers needing an xlsx ARGB fill prepend
// their own alpha byte (usually "FF").
export function pastelForSpeaker(speaker: string): string {
  const hex = colorForSpeaker(speaker).replace("#", "");
  const channel = (offset: number) => parseInt(hex.slice(offset, offset + 2), 16);
  const lighten = (c: number) => Math.round(c + (255 - c) * 0.72);
  return [channel(0), channel(2), channel(4)]
    .map((c) => lighten(c).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

export function initials(speaker: string): string {
  const parts = speaker.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
