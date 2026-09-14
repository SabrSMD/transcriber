import { useEffect, useRef } from "react";

// CSS `field-sizing: content` (styles.css) handles auto-grow in modern
// Chromium. This JS fallback re-measures scrollHeight on every change so
// older WebView2 builds without field-sizing support still auto-grow.
const SUPPORTS_FIELD_SIZING =
  typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content");

interface Props {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  // Lets a caller (e.g. a "split line at cursor" action) reach the
  // underlying textarea element directly - for reading selectionStart, not
  // for anything this component itself needs.
  inputRef?: (el: HTMLTextAreaElement | null) => void;
}

export function AutoResizeTextarea({ value, onChange, className, inputRef }: Props) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const resize = () => {
    const el = ref.current;
    if (!el || SUPPORTS_FIELD_SIZING) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  useEffect(resize, [value]);

  return (
    <textarea
      ref={(el) => {
        ref.current = el;
        inputRef?.(el);
      }}
      className={className}
      value={value}
      onChange={(e) => {
        onChange(e.target.value);
        resize();
      }}
      rows={1}
    />
  );
}
