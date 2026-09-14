import ExcelJS from "exceljs";
import type { Utterance } from "../types";
import { pastelForSpeaker } from "./speakerColor";

export function formatTimecode(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Cue-sheet style export (ROLE | LINE | NOTES | TIMING, each speaker's row
// tinted a distinct color) matching the professional subtitling/dubbing cue
// sheet format the app is meant to produce, not a generic document.
export async function exportToXlsx(utterances: Utterance[], title: string): Promise<Blob> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Transcript");

  sheet.columns = [
    { key: "role", width: 20 },
    { key: "line", width: 70 },
    { key: "notes", width: 24 },
    { key: "timing", width: 16 },
  ];

  const titleRow = sheet.addRow([title]);
  sheet.mergeCells(titleRow.number, 1, titleRow.number, 4);
  titleRow.getCell(1).font = { name: "Arial", size: 14, color: { argb: "FF666666" } };

  const headerRow = sheet.addRow(["ROLE", "LINE", "NOTES", "TIMING"]);
  headerRow.eachCell((cell) => {
    cell.font = { name: "Arial", size: 12, bold: true };
  });

  for (const u of utterances) {
    const row = sheet.addRow([
      u.speaker,
      u.text,
      u.note ?? "",
      `${formatTimecode(u.start)} – ${formatTimecode(u.end)}`,
    ]);
    const fill: ExcelJS.Fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: `FF${pastelForSpeaker(u.speaker)}` },
    };
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = fill;
      cell.font = { name: "Arial", size: 11 };
      cell.alignment = { vertical: "top", wrapText: true };
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}
