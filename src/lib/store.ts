import { LazyStore } from "@tauri-apps/plugin-store";
import type { Settings } from "../types";

const DEFAULT_SETTINGS: Settings = {
  hfToken: "",
  model: "small",
  language: "",
  theme: "dark",
};

const store = new LazyStore("settings.json");

export async function getSettings(): Promise<Settings> {
  const saved = await store.get<Settings>("settings");
  return { ...DEFAULT_SETTINGS, ...saved };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await store.set("settings", settings);
  await store.save();
}
