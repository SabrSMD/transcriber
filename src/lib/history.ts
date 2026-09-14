import {
  BaseDirectory,
  mkdir,
  readDir,
  readTextFile,
  remove,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import type { HistoryItem } from "../types";

const HISTORY_DIR = "history";

async function ensureHistoryDir(): Promise<void> {
  await mkdir(HISTORY_DIR, { baseDir: BaseDirectory.AppData, recursive: true });
}

export async function saveTranscript(item: HistoryItem): Promise<void> {
  await ensureHistoryDir();
  await writeTextFile(`${HISTORY_DIR}/${item.id}.json`, JSON.stringify(item), {
    baseDir: BaseDirectory.AppData,
  });
}

export async function listHistory(): Promise<HistoryItem[]> {
  await ensureHistoryDir();
  const entries = await readDir(HISTORY_DIR, { baseDir: BaseDirectory.AppData });
  const items: HistoryItem[] = [];
  for (const entry of entries) {
    if (!entry.name?.endsWith(".json")) continue;
    const text = await readTextFile(`${HISTORY_DIR}/${entry.name}`, {
      baseDir: BaseDirectory.AppData,
    });
    items.push(JSON.parse(text) as HistoryItem);
  }
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function loadTranscript(id: string): Promise<HistoryItem> {
  const text = await readTextFile(`${HISTORY_DIR}/${id}.json`, {
    baseDir: BaseDirectory.AppData,
  });
  return JSON.parse(text) as HistoryItem;
}

export async function deleteTranscript(id: string): Promise<void> {
  await remove(`${HISTORY_DIR}/${id}.json`, { baseDir: BaseDirectory.AppData });
}
