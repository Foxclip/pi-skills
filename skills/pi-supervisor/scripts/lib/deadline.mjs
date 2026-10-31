// lib/deadline.mjs — deadline/timeout sizing, the single source of truth.
//
// Extracted from launch.mjs in v0.16.0: the exact sizing that `launch.mjs
// --deadline` uses, shared by campaign.mjs (per-run deadline sizing). launch.mjs
// behavior is unchanged (covered by test-deadline-stop.mjs D1–D5).
//
// Model: the guard's total real time is --timeout + --finalize (the finalize
// window opens at the hard wall clock, see guard.mjs), so sizing a budget to a
// wall-clock deadline must reserve the finalize minutes here.
export function fmtLocal(d) {
  const p = (n) => String(n).padStart(2, "0");
  let tz = "local";
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "local"; } catch { /* keep default */ }
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} (${tz})`;
}

// Parse a wall-clock deadline. Accepts ISO (2026-10-28T10:00Z, local or with
// offset) or a local wall clock ("2026-10-28 10:00", "10:00" = today).
// Returns { ok: true, ts: Date, label: string } or { ok: false, why: string }.
export function parseDeadline(s) {
  const str = String(s ?? "").trim();
  if (!str) return { ok: false, why: "empty deadline" };
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}T/.test(str)) { // ISO — local, Z, or explicit offset
    const d = new Date(str);
    return Number.isFinite(d.getTime())
      ? { ok: true, ts: d, label: fmtLocal(d) }
      : { ok: false, why: `cannot parse deadline "${s}" (ISO form did not parse)` };
  }
  if (/^\d{10,13}$/.test(str)) { // v0.17.0: epoch seconds (10) or milliseconds (13)
    const ms = str.length === 13 ? Number(str) : Number(str) * 1000;
    const d = new Date(ms);
    return Number.isFinite(d.getTime())
      ? { ok: true, ts: d, label: `${fmtLocal(d)} [epoch ${str}]` }
      : { ok: false, why: `cannot parse deadline "${s}" (epoch did not parse)` };
  }
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) { // local YYYY-MM-DD[ HH:MM[:SS]]
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      m[4] !== undefined ? Number(m[4]) : 0,
      m[5] !== undefined ? Number(m[5]) : 0,
      m[6] !== undefined ? Number(m[6]) : 0);
    return Number.isFinite(d.getTime()) ? { ok: true, ts: d, label: fmtLocal(d) } : { ok: false, why: `cannot parse deadline "${s}"` };
  }
  m = str.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) { // HH:MM[:SS] today, local
    const t = new Date();
    const d = new Date(t.getFullYear(), t.getMonth(), t.getDate(),
      Number(m[1]), Number(m[2]), m[3] !== undefined ? Number(m[3]) : 0);
    return Number.isFinite(d.getTime()) ? { ok: true, ts: d, label: fmtLocal(d) } : { ok: false, why: `cannot parse deadline "${s}"` };
  }
  return { ok: false, why: `cannot parse deadline "${s}" — use ISO (2026-10-28T10:00Z) or a local wall clock ("2026-10-28 10:00", "10:00")` };
}

// Size a guard --timeout so its finalization window ends AT the deadline:
// timeout = floor((deadline − now)/min) − finalizeMin.
// Returns { ok: true, timeoutMin, finalizeMin, hardStopAt, hardStopAtLocal,
//           finalizeAt, finalizeAtLocal } or
//          { ok: false, why: "… leaves no work time: …" } (why is a phrase —
// callers prefix their own flag/context).
export function sizeDeadline({ ts, finalizeMin = 10, now = new Date() }) {
  const nowMs = now.getTime();
  const timeoutMin = Math.floor((ts.getTime() - nowMs) / 60000) - finalizeMin;
  if (timeoutMin < 1) {
    return {
      ok: false,
      why: `leaves no work time: only ${Math.max(0, Math.round((ts.getTime() - nowMs) / 60000))}min until it, and ${finalizeMin}min is reserved for finalization — pass a later deadline or a smaller --finalize`,
    };
  }
  const hardStop = new Date(nowMs + timeoutMin * 60000);
  const finalizeAt = new Date(nowMs + (timeoutMin + finalizeMin) * 60000);
  return {
    ok: true,
    timeoutMin,
    finalizeMin,
    hardStopAt: hardStop.toISOString(),
    hardStopAtLocal: fmtLocal(hardStop),
    finalizeAt: finalizeAt.toISOString(),
    finalizeAtLocal: fmtLocal(finalizeAt),
  };
}
