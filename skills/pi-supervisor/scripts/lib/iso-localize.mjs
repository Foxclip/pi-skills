// v0.35.14 (Spec 7.8): ISO-8601 (UTC) belongs in FILES, not on the terminal.
// LLM-authored prose (the parent's final report, judgment reasoning) quotes the
// UTC timestamps it read from status files and reaches the terminal verbatim.
// This helper localizes such timestamps for DISPLAY ONLY — the files keep ISO.
//
// Display-only contract: files are never rewritten; the conversion happens at
// the two terminal print paths (ralph.sh final-report box, ralph-monitor.mjs
// tick detail/reasoning). Bare `HH:MM:SSZ` (no date, the form the LLMs
// actually write) is mapped onto the current UTC day — runs are bounded
// (~30 min) so the day is right except a cosmetic edge at the UTC midnight
// boundary, which is acceptable for display.
const p2 = (n) => String(n).padStart(2, "0");

export function localizeUtcInText(text, now = new Date()) {
  if (typeof text !== "string" || !text) return text;
  // full ISO with date: 2026-11-11T10:35:56.026Z (also ±HH:MM offsets)
  let out = text.replace(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/g,
    (m) => {
      const d = new Date(m);
      if (Number.isNaN(d.getTime())) return m;
      return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    }
  );
  // bare time + Z: 10:21:56Z → [local HH:MM:SS] on the current UTC day
  out = out.replace(/\b([01]\d|2[0-3]):[0-5]\d:[0-5]\dZ\b/g, (m) => {
    const [h, mi, s] = m.slice(0, 8).split(":").map(Number);
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, mi, s));
    return `[${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}]`;
  });
  return out;
}

// CLI (ralph.sh pipes report files through it): stdin → stdout, whole-buffer.
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let buf = "";
  process.stdin.on("data", (c) => (buf += c));
  process.stdin.on("end", () => process.stdout.write(localizeUtcInText(buf)));
}
