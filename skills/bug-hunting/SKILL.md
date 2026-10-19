---
name: bug-hunting
description: Structured methodology for hard, long-running bug hunts (rendering/pipeline bugs, subtle state bugs, file-format defects, concurrency issues) — executed as supervised child sessions via the pi-supervisor skill. Use when a bug outlived a quick fix and needs a disciplined multi-run hunt: differential reproduction, stage-by-stage ground-truth diffing, broken baseline + per-fix regression proofs, a verified-facts ledger, machine-checkable acceptance, and a distill-don't-resume run loop.
---

# Bug hunting (supervised runs via pi-supervisor)

A process for **hard defects** — the kind that survive the first fix attempt:
rendering/pipeline bugs, subtle state bugs, file-format defects, concurrency
issues. It exists because the naive approach (one long session, keep digging)
burns hours and ends in a context-overflowed transcript with no result.

**Field case (2026-10-19, Box2D editor font rendering — "ui_font and fps_font
are all squares"):** 600+ minutes across three *appended* runs produced
evidence but no fix; a fourth run (resume of the 7 MB session) died on
context overflow; a **fresh** run with a self-contained brief found and proved
**three** root causes in 58 min / 131 tool calls / 0 interventions. The bugs:
a stale shader binding (framework), a rasterizer quirk on empty glyphs
(framework), and a corrupted font file (asset) — three different layers, which
is exactly why a stage-by-stage method beats intuition.

Every run uses the **pi-supervisor** skill (`scripts/guard.mjs`). This skill
defines **what to ask** and **how to structure the hunt**; pi-supervisor
defines how to launch, supervise, and monitor the child.

## The core idea: the hunt is a loop of fresh runs + one growing brief

The model's context window is the scarce resource. A resumed transcript grows
every run and dies once it approaches the window (the child emits **zero
events on the first prompt**, and forking copies the same transcript, so every
fork dies identically). Therefore:

1. **Every run starts from a fresh session** (except the first, which may
   resume an existing in-context session — check its size first: never resume
   a transcript above ~50–60% of the model's context window).
2. **The brief is the compounding asset.** Between runs you distill the
   child's report + STATUS.md + your audit findings into the brief —
   especially the **verified facts** list. A fresh run with a strong
   "do not re-derive" list converges ~10× faster than a resumed run (field
   case: 58 min vs 600+ min).
3. **Every run has a hard deadline** (`--timeout`) and a required report
   (`--expect-file`). A run that hits its deadline leaves a partial report,
   not a void (finalization window), and the partial report feeds the next
   brief.

```
P0 preflight → P1 differential repro → (P2 stage diff → P3 fix+proof)* 
   → P4 cleanup + parent acceptance audit
   (each phase = one or more supervised runs; brief grows after each)
```

## Phase 0 — Preflight (host side, before any run)

Cheap checks the child cannot do for you:

1. **Machine-checkable acceptance.** Write the acceptance check *first*, as a
   script/command with an expected output. For visual bugs: a pixel audit
   (e.g. count of solid connected components), not "looks right". The check
   must run without the host session (the child and the parent audit both
   run it).
2. **Capture the broken baseline NOW** — before any fix: the screenshot, the
   failing test output, the bad dump. Name it (`BROKEN_SCREENSHOT.png`).
   Without a baseline, a later "fixed" artifact is unverifiable.
3. **Inventory the worktree**: `git status` in every repo/submodule,
   instrumentation left by earlier attempts, evidence files from earlier
   sessions. List what exists — the first child run must not rediscover or
   re-carry stale debug code.
4. **Environment invariants** for the task text (see pi-supervisor's Task
   authoring): 60 s command kills, safety-net rules (script files, literal
   paths), whatever the host enforces.
5. **Budgets**: per-run `--timeout` (240–300 min is a good default on a local
   model) and a wall-clock expectation for the whole hunt.

## Phase 1 — Differential reproduction (first run's primary deliverable)

The deliverable of run 1 is **not the fix** — it is the **bisection**: which
layer is broken. Build the two things that make all later phases cheap:

1. **A minimal differential harness**: a small program that runs the
   *suspect path* (full stack) and a *known-good path* (raw/minimal) over the
   same input, with one toggle to isolate a layer. If the raw path works and
   the full path fails, the bug is in the layers between — and every later
   probe can run the harness instead of the whole app.
2. **Independent ground truth for file-level inputs.** If a bug smells like an
   asset (font, model, config, image), render/parse it with an *independent*
   tool (PIL/FreeType for fonts, a reference parser, a decoder) and compare.
   Cheapest possible test; it splits "the file is broken" from "the file is
   clean" before any pipeline work. (Field case: PIL proved one font clean and
   the other corrupted — the corrupted one was a whole root cause.)

Also in run 1: build, wire the acceptance script, capture the broken
baseline, and set up STATUS.md as the durable ledger.

## Phase 2 — Stage-by-stage ground-truth diff (pipeline bugs)

For any bug in a multi-stage pipeline (CPU data → GPU upload → vertex/UV →
uniforms → fragment → final surface; network → decode → transform → render →
file):

1. **Dump every stage** to disk (the child must be able to *see* each stage —
   texture dumps, buffer dumps, parsed structures, intermediate files).
2. **Diff each stage against ground truth** (the CPU-side value, the
   reference implementation's output, the independent tool's result).
3. **The first stage whose dump diverges is the bug.** Stages above it are
   *downstream corruption* — do not debug them. A stage is "clean" only if it
   was dumped AND diffed; "it looks right" is not evidence.

Instrumentation for dumps is disposable: the brief's invariants say it is
reverted before completion, and only the fix survives.

## Phase 3 — Fix with regression proof

1. **One change at a time.** One root cause per fix; rebuild; re-run the
   machine acceptance.
2. **Per-fix regression proof (non-negotiable for multi-cause bugs).** For
   each fix, **revert ONLY that hunk** and verify the corresponding symptom
   reproduces; restore and verify it is gone. "Everything looks fixed" is
   correlation; per-hunk regression is causality. (Field case: reverting only
   the shader-binding fix reproduced the squares while the other fixes stayed
   applied — that single test proved the main cause.)
3. If two hypotheses touch the same line, split the fix so each hunk maps to
   exactly one root cause.
4. Re-run the full acceptance (all baselines compared: broken → fixed, with
   the audit numbers, e.g. "38 solid blocks → 0").

## Phase 4 — Cleanup + parent acceptance audit

1. Revert all instrumentation (the brief enumerates the inventory up front;
   completion requires a clean `git status` in every repo).
2. Minimal diffs, one concern per commit, deliberate submodule-pointer bumps.
3. **Parent audit (run it every time — the manifest proves the model
   *stopped*, not that the job is done):** re-run the acceptance check
   yourself → inspect the artifacts yourself (not via the child's
   description) → generate your own fresh artifact from a clean state
   (new screenshot / fresh build) → inspect the committed diffs for
   minimality and leftover instrumentation → clean up supervisor artifacts.
   (Full 5-step list: pi-supervisor SKILL.md, "Parent acceptance audit".)

## The run loop (concrete)

From the project directory the child should work in:

```bash
node <pi-supervisor>/scripts/guard.mjs \
  --task-file brief-run-N.md \
  --expect-file FIX_REPORT.md \
  --out-dir /path/to/supervisor-artifacts \
  --timeout 300 --finalize 10 \
  --provider <p> --model <m>
```

- **Fresh session every run** (no `--session` from run 2 onward; run 1 may
  resume an in-context session if it is small).
- Monitor on a **20–30-minute cadence**: one blocking call per cycle
  (`sleep` + read `pi-child-status.json` + `tail` the progress log); the
  `[settle]` line tells you where the child is in one glance.
- After each run: read `pi-child-result.json` (manifest) → if not done,
  distill into the brief (grow VERIFIED FACTS and Ruled-out with evidence
  paths) → next run. After an **overflow pivot** (`exitReason:
  "stuck-overflow"`), run the relaunch command from the manifest instead.
- The child cannot manage supervisor files; the **parent** cleans
  `pi-child-*` artifacts (or the `--out-dir`) after each run.

## The brief (between runs)

Start from `brief-template.md` in this skill directory. Anatomy: goal →
machine acceptance + baseline → **VERIFIED FACTS marked "do not re-derive"** →
ruled-out (with evidence) → ranked hypotheses (each with a cheap
confirm/refute test) → evidence locations on disk → prioritized plan →
invariants → deliverables → deadline → "old transcripts: grep, never load".
The verified-facts list is the compounding asset — every run must grow it, and
a fact stays listed (with its evidence path) even when it is only "this stage
is clean".

## Field case (2026-10-19 — reusable numbers)

- 3 appended 300-min runs: built the evidence base (all stages dumped, all
  clean), transcript grew 2.9 MB → 7 MB, no fix.
- Resume of the 7 MB session: 3× first-prompt stall, stuck in ~18 min
  (context overflow; ACP reported 99%).
- Fresh run + 8.8 KB brief: **58 min, 131 tool calls, 0 interventions** —
  three root causes (stale subpixel shader binding; FT autohint collapse of
  empty glyphs; corrupted font file), each with a regression proof; tests
  118/118 + 194/194; pixel audit 38 solid blocks → 0; parent audit re-ran
  everything from a clean build.
