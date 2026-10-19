# Bug-hunt brief — run N of <job name>

<!-- Fill every section before launching. The child gets ZERO context from
     your conversation — this file is its entire world. Pass it via
     --task-file. Grow VERIFIED FACTS / Ruled-out after every run. -->

## Goal
<One sentence: what is broken, in which app/area, and what "fixed" means.
Quote the original bug report verbatim if you have one.>

## Acceptance (machine-checkable)
- <exact command/script + expected output. The child must be able to run it
  without help.>
- Broken baseline captured: <artifact path + what it shows, e.g.
  "BROKEN_SCREENSHOT.png — 38 solid blocks in the text bars">

## VERIFIED FACTS — do NOT re-derive
<!-- One line per fact: the fact, how it was verified, artifact path.
     This list is the compounding asset — every run must grow it.
     "Stage X is clean" counts and stays listed. -->
- <fact (verified by <method>; evidence: <path>)>

## Ruled out (with evidence)
- <approach/hypothesis — why ruled out, 1 line + evidence path>

## Current hypothesis (ranked)
1. <hypothesis — the cheap test that confirms/refutes it (target <30 min)>
2. <hypothesis — test>

## Evidence locations (on disk)
- <path — what it is (dump/screenshot/script/report)>

## Plan for this run (prioritized, one change at a time)
1. <step>
2. <step>
3. <step>

## Invariants
- Every command must finish in <60 s — the host kills at the limit; pass
  explicit tool timeouts for builds and long work. Never let a command be killed.
- Max 3 attempts per approach; no cosmetic re-runs of a failing command; when
  an approach is exhausted, log the dead end (with the evidence line) in
  STATUS.md and move on.
- No new dependencies. Do not use acp_delegate.
- <host safety-net rules if they apply: script files instead of one-liners,
  literal paths for scripts AND executables, no rm -rf, …>
- Update STATUS.md at every milestone — the transcript is NOT storage.
- Instrumentation inventory: <list any debug code in the worktree>. Revert all
  of it before finishing; only the fix survives.
- <safety-net/CC notes specific to this host, if any>

## Deliverables
1. FIX_REPORT.md: root cause(s), the fix (file + hunk), **per-fix regression
   proof** (revert-only-that-hunk reproduces the symptom), acceptance output
   before/after, screenshot/artifact paths.
2. Clean worktree: `git status` clean in every repo/submodule (fixes committed
   or explicitly left with a reason in the report).
3. STATUS.md = DONE (or the exact remaining state).

## Deadline
<HH:MM local> — hard (wall clock for this run). At ~90% of the budget: stop
new work, write the partial report. A partial, honest report beats silence.

## Old transcripts
<!-- If earlier runs exist: their session file paths. -->
<paths> — grep them if you need a detail; NEVER load them into context.
