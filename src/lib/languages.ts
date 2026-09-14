import type { LanguageCode } from "../types";

// Every language whisperx ships a word-alignment model for (its
// DEFAULT_ALIGN_MODELS_TORCH + DEFAULT_ALIGN_MODELS_HF tables), each paired
// with a human-readable name. Picking a language from this list guarantees
// alignment works - it's the manual-override counterpart to the "no
// alignment model for detected language" fallback in transcribe.py, which
// only kicks in on a bad auto-detection.
export const LANGUAGES: { code: LanguageCode; name: string }[] = [
  { code: "en", name: "English" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "es", name: "Spanish" },
  { code: "it", name: "Italian" },
  { code: "ja", name: "Japanese" },
  { code: "zh", name: "Chinese" },
  { code: "nl", name: "Dutch" },
  { code: "uk", name: "Ukrainian" },
  { code: "pt", name: "Portuguese" },
  { code: "ar", name: "Arabic" },
  { code: "cs", name: "Czech" },
  { code: "ru", name: "Russian" },
  { code: "pl", name: "Polish" },
  { code: "hu", name: "Hungarian" },
  { code: "fi", name: "Finnish" },
  { code: "fa", name: "Persian" },
  { code: "el", name: "Greek" },
  { code: "tr", name: "Turkish" },
  { code: "da", name: "Danish" },
  { code: "he", name: "Hebrew" },
  { code: "vi", name: "Vietnamese" },
  { code: "ko", name: "Korean" },
  { code: "ur", name: "Urdu" },
  { code: "te", name: "Telugu" },
  { code: "hi", name: "Hindi" },
  { code: "ca", name: "Catalan" },
  { code: "ml", name: "Malayalam" },
  { code: "no", name: "Norwegian" },
  { code: "nn", name: "Norwegian Nynorsk" },
  { code: "sk", name: "Slovak" },
  { code: "sl", name: "Slovenian" },
  { code: "hr", name: "Croatian" },
  { code: "ro", name: "Romanian" },
  { code: "eu", name: "Basque" },
  { code: "gl", name: "Galician" },
  { code: "ka", name: "Georgian" },
  { code: "lv", name: "Latvian" },
  { code: "tl", name: "Tagalog" },
  { code: "sv", name: "Swedish" },
  { code: "id", name: "Indonesian" },
];
