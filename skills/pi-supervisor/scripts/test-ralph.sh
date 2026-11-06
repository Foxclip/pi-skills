#!/usr/bin/env bash
# test-ralph.sh — end-to-end suite for ralph.sh + ralph-monitor.mjs (v0.20.0).
# Self-contained: builds a sandbox (stub launch.mjs + stub pi models), runs
# every case, prints PASS/FAIL lines, exits non-zero on any failure.
# NO real child agents are launched (launch.mjs is stubbed in the sandbox).
# Note: a foreground `ralph.sh` blocks while it monitors — cases that launch
# run it backgrounded and assert on its log, then stop it via the pointer.
set -u
# Sanitize the inherited environment: this suite must work even when run FROM
# INSIDE a supervised window (a child inherits PI_SUP_CHILD, PI_SUP_RUN_DIR,
# PI_SUP_PROJECT, PI_SUP_NODE, ...). Each case below sets exactly what it needs.
unset PI_SUP_RUN_DIR PI_SUP_CHILD PI_SUP_CHILD_USER PI_SUP_PROJECT PI_SUP_NODE \
      PI_PROTECT_USER PI_SUP_PROTECT_USER DEADLINE
# Kernel protection (v0.26.0) is covered by test-protect.mjs (it creates real
# users + sudoers state); the ralph-level suites run unprotected.
export PI_SUP_NO_PROTECT=1
SELF="$(readlink -f "$0")"
SKILL="$(cd "$(dirname "$SELF")" && pwd)"
S=$SKILL
T=$(mktemp -d /tmp/ralph-suite.XXXXXX)
trap 'pkill -f "sleep 600" 2>/dev/null; true' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
mkproj() { mkdir -p "$1"; echo "# Test task" > "$1/TASK.md"; }
stoprun() { (cd "$1" && PATH="$T/sandbox/scripts:$PATH" ralph.sh stop); pkill -f "sleep 600" 2>/dev/null; true; }

# ---- sandbox: sandboxed scripts dir (stub launch) + stub pi models ----------
mkdir -p $T/sandbox/scripts
cp "$S"/ralph.sh "$S"/ralph-monitor.mjs "$S"/launch.mjs "$S"/stop.mjs $T/sandbox/scripts/
cp -r "$S"/lib $T/sandbox/scripts/
cat > $T/sandbox/scripts/launch.mjs <<'EOF'
import fs from "fs"; import path from "path"; import { spawn } from "child_process";
const a = process.argv.slice(2);
const out = a[a.indexOf("--out-dir") + 1];
fs.writeFileSync(path.join(out, "launch-args.txt"), a.join(" ") + "\n");
const s = spawn("sleep", [600], { detached: true, stdio: "ignore" }); s.unref();
const st = { v:2, at:new Date().toISOString(), status:"running", exitReason:null, guardPid:s.pid, childPid:s.pid, attempt:1, rewinds:0, toolCalls:0, lastTool:null, lastToolStartedAt:null, elapsedMs:0, deadlineIso:new Date(Date.now()+3600e3).toISOString() };
fs.writeFileSync(path.join(out, "pi-child-status.json"), JSON.stringify(st));
console.log(JSON.stringify({ launched: true }));
EOF
cat > $T/pi-OK <<'EOF'
#!/usr/bin/env bash
echo "DECISION: OK"
EOF
cat > $T/pi-STOP <<'EOF'
#!/usr/bin/env bash
echo "DECISION: STOP: e2e-stop-case"
EOF
cat > $T/pi-REPORT <<'EOF'
#!/usr/bin/env bash
cat <<'REP'
# Final report — E2E stub
## What was requested
run the e2e case
## What was done
stub wrote this report
## Outcome
done
## Remaining
none
REP
EOF
chmod +x $T/pi-OK $T/pi-STOP $T/pi-REPORT
DEADLINE=$(( $(date +%s) + 3600 ))

# ---- A: no TASK.md → exit 1 -------------------------------------------------
mkdir -p $T/noTask && cd $T/noTask
PATH="$T/sandbox/scripts:$PATH" PI=$T/pi-OK DEADLINE=$DEADLINE ralph.sh > $T/A.log 2>&1
[ $? -eq 1 ] && grep -q "TASK.md" $T/A.log && ok "A: no TASK.md → exit 1 with message" || bad "A: $(cat $T/A.log)"

# ---- B: --help → exit 2 -----------------------------------------------------
PATH="$T/sandbox/scripts:$PATH" ralph.sh --help > $T/B.log 2>&1
[ $? -eq 0 ] && grep -q "ralph.sh" $T/B.log && grep -q "stop" $T/B.log \
  && ok "B: --help → exit 0 with usage" || bad "B: $(head -3 $T/B.log)"

# ---- C: launch + one judgment cycle (monitor sleeps 30s pre-check first) -----
mkproj $T/projC && cd $T/projC
PATH="$T/sandbox/scripts:$PATH" PI=$T/pi-OK DEADLINE=$DEADLINE ralph.sh > $T/C.log 2>&1 &
CPID=$!; sleep 35
RD=$T/projC/.pi-supervisor/runs/run1
[ -f $RD/pi-child-status.json ] && [ -f $T/projC/.pi-supervisor/ralph-run-dir ] \
  && ok "C: run dir + guard status + pointer created" || bad "C: run dir/status/pointer"
[ -f $RD/TASK.md ] && grep -q "Test task" $RD/TASK.md \
  && ok "C: task file copied into the run dir (v0.25.16)" || bad "C: TASK.md missing from run dir"
grep -q "cycle=1" $RD/ralph-monitor.log 2>/dev/null && grep -q "decision=OK" $RD/ralph-monitor.log \
  && ok "C: monitor ran cycle 1 with decision=OK" || bad "C: monitor log $(tail -2 $RD/ralph-monitor.log 2>/dev/null)"
kill $CPID 2>/dev/null; pkill -f "sleep 600" 2>/dev/null; true

# ---- D: attach while live → no second child; stop via pointer ----------------
mkproj $T/projD && cd $T/projD
PATH="$T/sandbox/scripts:$PATH" PI=$T/pi-OK DEADLINE=$DEADLINE ralph.sh > $T/D1.log 2>&1 &
sleep 4
PATH="$T/sandbox/scripts:$PATH" PI=$T/pi-OK ralph.sh > $T/D2.log 2>&1 &
sleep 3
grep -qi "attached run" $T/D2.log && ok "D: attach to live run (no second child)" || bad "D: $(head -8 $T/D2.log)"
[ "$(ls -d $T/projD/.pi-supervisor/runs/run* 2>/dev/null | wc -l)" -eq 1 ] \
  && ok "D: exactly one run dir after attach" || bad "D: extra run dirs"
stoprun $T/projD > $T/D3b.log 2>&1
grep -q "preserved" $T/D3b.log && ok "D: stop via pointer → stopped + preserved (pointer kept by design for post-mortem)" || bad "D: stop ($(cat $T/D3b.log))"
# the monitors (D1/D2) notice the dead child at their next 30s pre-check and
# harvest on exit — don't wait for that race: harvest explicitly (idempotent)
cd $T/projD && PATH="$T/sandbox/scripts:$PATH" ralph.sh --harvest $T/projD/.pi-supervisor/runs/run1 > /dev/null 2>&1
[ -f $T/projD/.pi-supervisor/runs/run1/RUN-REPORT.md ] && [ -f $T/projD/.pi-supervisor/runs/INDEX.json ] \
  && ok "D: stopped run harvested (RUN-REPORT + INDEX)" || bad "D: harvest artifacts"

# ---- E: --deadline / --child-model / --parent-model flags --------------------
mkproj $T/projE && cd $T/projE
DL=$(( $(date +%s) + 600 ))
PATH="$T/sandbox/scripts:$PATH" PI=$T/pi-OK \
  ralph.sh --deadline $DL --child-model cm-e2e --parent-model pm-e2e > $T/E.log 2>&1 &
sleep 4
grep -q "deadline.*$(date -d @"$DL" '+%Y-%m-%d %H:%M')" $T/E.log \
  && ok "E: --deadline flag parsed" || bad "E: $(head -8 $T/E.log)"
grep -q "child=cm-e2e" $T/E.log && grep -q "parent=pm-e2e" $T/E.log \
  && ok "E: --child-model/--parent-model flags parsed" || bad "E: model flags"
grep -q -- "--model cm-e2e" $T/projE/.pi-supervisor/runs/run1/launch-args.txt 2>/dev/null \
  && ok "E: flags reached launch.mjs (--model cm-e2e)" || bad "E: launch-args ($(cat $T/projE/.pi-supervisor/runs/run1/launch-args.txt 2>/dev/null))"
stoprun $T/projE

# ---- F: --flag=value form (regression: the missing-shift spin) ----------------
mkproj $T/projF && cd $T/projF
DLF=$(( $(date +%s) + 600 ))
PATH="$T/sandbox/scripts:$PATH" PI=$T/pi-OK \
  ralph.sh --deadline=$DLF --child-model=fv-e2e > $T/F.log 2>&1 &
sleep 4
grep -q "child=fv-e2e" $T/F.log && ok "F: --flag=value form parsed (no hang — a spin would print nothing)" || bad "F: $(cat $T/F.log | head -8)"
stoprun $T/projF

# ---- L: --runtime flag — relative deadline (v0.25.0) ---------------------------
mkproj $T/projL && cd $T/projL
T0=$(date +%s)
PATH="$T/sandbox/scripts:$PATH" PI=$T/pi-OK ralph.sh --runtime 90m > $T/L.log 2>&1 &
sleep 4
LARGS=$T/projL/.pi-supervisor/runs/run1/launch-args.txt
LDL=$(grep -o -- '--deadline [0-9]*' "$LARGS" 2>/dev/null | awk '{print $2}')
DR=$(( LDL - T0 ))
[ -n "$LDL" ] && [ "$DR" -ge 5340 ] && [ "$DR" -le 5460 ] \
  && ok "L: --runtime 90m → launch deadline ≈ now+5400s (got +$DR s)" \
  || bad "L: launch-args $(cat "$LARGS" 2>/dev/null) (want deadline ≈ now+5400)"
grep -q "deadline" $T/L.log && ok "L: banner shows the runtime-derived deadline" || bad "L: $(head -8 $T/L.log)"
stoprun $T/projL

# ---- L2: bad --runtime value → exit 2 with a message ----------------------------
mkdir -p $T/noTask2 && cd $T/noTask2
PATH="$T/sandbox/scripts:$PATH" ralph.sh --runtime abc > $T/L2.log 2>&1
RC=$?
[ "$RC" -eq 2 ] && grep -q "bad --runtime" $T/L2.log \
  && ok "L2: bad --runtime → exit 2 with message" || bad "L2: rc=$RC $(cat $T/L2.log)"

# ---- L3: --deadline AND --runtime → warning, absolute wins -----------------------
# (run in a dir WITHOUT TASK.md, so the expected exit is 1 — after the warning)
PATH="$T/sandbox/scripts:$PATH" ralph.sh --deadline $DEADLINE --runtime 90m > $T/L3.log 2>&1
RC=$?
[ "$RC" -eq 1 ] && grep -q "both --deadline and --runtime" $T/L3.log \
  && ok "L3: both flags → warning + --deadline wins (then exit 1: no TASK.md here)" || bad "L3: rc=$RC $(cat $T/L3.log)"

# ---- M: --child-thinking flag → forwarded to launch.mjs (v0.25.13) ------------
mkproj $T/projM && cd $T/projM
PATH="$T/sandbox/scripts:$PATH" PI=$T/pi-OK \
  ralph.sh --runtime 10m --child-thinking off > $T/M.log 2>&1 &
sleep 4
MARGS=$T/projM/.pi-supervisor/runs/run1/launch-args.txt
grep -q -- "--thinking off" "$MARGS" 2>/dev/null \
  && ok "M: --child-thinking off reached launch.mjs" || bad "M: launch-args ($(cat "$MARGS" 2>/dev/null))"
grep -q "think: off" $T/M.log && ok "M: banner shows the thinking level" || bad "M: banner ($(grep -m1 'models' $T/M.log))"
stoprun $T/projM

# ---- N: rc=127 (bash lost the monitor's status) → resolved from monitor-exit.json (v0.25.14)
# the resolver is EXTRACTED from the shipped ralph.sh so the test tracks real code
NDEF=$(sed -n '/^resolve_monitor_rc() {/,/^}/p' "$S/ralph.sh")
[ -n "$NDEF" ] && ok "N: resolve_monitor_rc present in ralph.sh" || bad "N: resolver missing from ralph.sh"
rlog() { :; }   # v0.25.15: the resolver now rlogs its decision — stub for the suite shell
eval "$NDEF"
mkdir -p $T/projN
printf '{"at":"t","code":0}\n' > $T/projN/monitor-exit.json
HARVEST_TARGET=$T/projN; rc=127; resolve_monitor_rc
[ "$rc" -eq 0 ] && ok "N: rc=127 + monitor-exit.json code=0 → rc=0 (a completed run prints ✓)" || bad "N: rc=$rc (want 0)"
rm -f $T/projN/monitor-exit.json
HARVEST_TARGET=$T/projN; rc=127; resolve_monitor_rc
[ "$rc" -eq 127 ] && ok "N: rc=127 + no file → rc stays 127 (a real failure stays red)" || bad "N: rc=$rc (want 127)"
printf '{"at":"t","code":4}\n' > $T/projN/monitor-exit.json
HARVEST_TARGET=$T/projN; rc=4; resolve_monitor_rc
[ "$rc" -eq 4 ] && ok "N: rc=4 untouched (only the lost-status 127 is resolved)" || bad "N: rc=$rc (want 4)"

# ---- G: stale child → exit 2 -------------------------------------------------
mkproj $T/projG
SD=$T/projG/.pi-supervisor/runs/run1; mkdir -p $SD
OLD=$(date -u -d '-2 hours' +%Y-%m-%dT%H:%M:%SZ)
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo '{"l":"x"}' > $T/stale.jsonl
cat > $SD/pi-child-status.json <<EOF
{"v":2,"at":"$OLD","status":"running","exitReason":null,"guardPid":99999,"childPid":99998,"attempt":1,"rewinds":0,"toolCalls":0,"lastTool":"bash","lastActivityAt":"$OLD","elapsedMs":0,"deadlineIso":"$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)","sessionFile":"$T/stale.jsonl"}
EOF
cd $T/projG
PATH="$T/sandbox/scripts:$PATH" PI=$T/pi-OK ralph.sh $SD > $T/G.log 2>&1
RC=$?
[ "$RC" -eq 2 ] && ok "G: stale child → exit 2" || bad "G: rc=$RC $(tail -2 $T/G.log)"

# ---- H: v0.20.0 — child completed → FINAL-REPORT.md + exit 0 ------------------
mkproj $T/projH
SD=$T/projH/.pi-supervisor/runs/run1; mkdir -p $SD
echo "done" > $T/projH/STATUS.md
cat > $SD/pi-child-status.json <<EOF
{"v":2,"at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","status":"completed","exitReason":"completed","guardPid":99997,"childPid":99996,"attempt":1,"rewinds":0,"toolCalls":5,"elapsedMs":1000,"deadlineIso":"$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)"}
EOF
cd $T/projH
PATH="$T/sandbox/scripts:$PATH" PI=$T/pi-REPORT ralph.sh $SD > $T/H.log 2>&1
RC=$?
[ "$RC" -eq 0 ] && [ -f $SD/FINAL-REPORT.md ] && grep -q "E2E stub" $SD/FINAL-REPORT.md \
  && ok "H: completed → FINAL-REPORT.md written, exit 0" || bad "H: rc=$RC $(tail -3 $T/H.log)"
grep -q "final report" $T/H.log && ok "H: ralph.sh printed the final report to the terminal" || bad "H: report not printed"
grep -q '"code":0' $SD/monitor-exit.json 2>/dev/null && ok "H: monitor-exit.json records the monitor's own code=0 (v0.25.14)" || bad "H: monitor-exit.json missing: $(cat $SD/monitor-exit.json 2>/dev/null)"

# ---- O: v0.25.15 — ralph.log: the wrapper's own on-disk record -------------
# case H's attach run went through the full tail (monitor launch, wait,
# on_exit + harvest), so ralph.log must carry the whole lifecycle — this is
# what was missing on 2026-11-02 (the `exit 127` run left nothing on disk)
RL=$SD/ralph.log
grep -q "ralph.sh start" $RL 2>/dev/null && grep -q "monitor launched (mon_pid=" $RL 2>/dev/null \
  && ok "O: ralph.log has start + monitor launched (mon_pid)" || bad "O: ralph.log start/launch missing: $(head -5 $RL 2>/dev/null)"
grep -qE "monitor wait rc=0 \(mon_pid=[0-9]+, waited [0-9]+s\)" $RL 2>/dev/null \
  && ok "O: ralph.log has wait bookends (rc + waited Ns)" || bad "O: ralph.log wait line: $(grep 'monitor wait' $RL 2>/dev/null)"
grep -q "exit rc=0 interrupted=0" $RL 2>/dev/null && grep -q "final: .*done · exit 0" $RL 2>/dev/null \
  && ok "O: ralph.log has exit + final lines" || bad "O: ralph.log exit/final: $(tail -3 $RL 2>/dev/null)"

# ---- I: v0.20.0 — parent STOP → FINAL-REPORT.md + exit 4 ----------------------
# (30s pre-check sleep first — status is fresh so pre-checks pass, then the
#  STOP-stub judgment fires)
mkproj $T/projI
SD=$T/projI/.pi-supervisor/runs/run1; mkdir -p $SD
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > $SD/pi-child-status.json <<EOF
{"v":2,"at":"$NOW","status":"running","exitReason":null,"guardPid":99995,"childPid":99994,"attempt":1,"rewinds":0,"toolCalls":0,"lastTool":null,"lastActivityAt":"$NOW","elapsedMs":0,"deadlineIso":"$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)"}
EOF
cd $T/projI
PATH="$T/sandbox/scripts:$PATH" PI=$T/pi-STOP ralph.sh $SD > $T/I.log 2>&1
RC=$?
[ "$RC" -eq 4 ] && [ -f $SD/FINAL-REPORT.md ] \
  && ok "I: parent STOP → FINAL-REPORT.md, exit 4" || bad "I: rc=$RC $(tail -3 $T/I.log)"
grep -q "decision=STOP" $SD/ralph-monitor.log 2>/dev/null && ok "I: decision=STOP logged" || bad "I: reason not in log"

# ---- J: v0.20.0 — RUN-REPORT.md embeds the final report -----------------------
cd $T/projH
PATH="$T/sandbox/scripts:$PATH" ralph.sh --harvest $T/projH/.pi-supervisor/runs/run1 > $T/J.log 2>&1
grep -q "## Final report (written by the parent)" $T/projH/.pi-supervisor/runs/run1/RUN-REPORT.md \
  && grep -q "stub wrote this report" $T/projH/.pi-supervisor/runs/run1/RUN-REPORT.md \
  && ok "J: RUN-REPORT.md embeds FINAL-REPORT.md" || bad "J: $(tail -2 $T/J.log)"

# ---- K: terminal timestamps local; log files keep ISO UTC ---------------------
# v0.24.0: every terminal line is glyphed — `ralph: child launched` became `· child launched`
grep -qE '^\[[0-9]{2}:[0-9]{2}:[0-9]{2}\] · child launched' $T/C.log \
  && ok "K: terminal timestamps short local [HH:MM:SS] + glyphed lines" || bad "K: $(grep 'child launched' $T/C.log | head -1)"
grep -qE '^\[[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}\.[0-9]{3}Z\] cycle=' $T/projC/.pi-supervisor/runs/run1/ralph-monitor.log 2>/dev/null \
  && ok "K: ralph-monitor.log keeps ISO UTC" || bad "K: log file format"

# ---- S: v0.26.0 sub-runs — the PI_SUP_CHILD gate + the spawn API --------------
# S1: a CHILD session (PI_SUP_CHILD set in env — launch.mjs always does for
# children) may never launch: zero-arg mode must refuse BEFORE launch.mjs.
mkdir -p $T/projS1 && cd $T/projS1
echo "# task" > TASK.md
PATH="$T/sandbox/scripts:$PATH" PI=$T/pi-OK DEADLINE=$DEADLINE PI_SUP_CHILD=1 ralph.sh > $T/S1.log 2>&1
RC=$?
[ "$RC" -eq 1 ] && grep -q "unauthorized" $T/S1.log && [ ! -d .pi-supervisor ] \
  && ok "S1: PI_SUP_CHILD=1 → zero-arg launch denied (exit 1, no run dir)" \
  || bad "S1: rc=$RC $(head -3 $T/S1.log)"

# S2: spawn outside a window (no PI_SUP_RUN_DIR) → exit 1, clear message
cd $T/projS1
PATH="$T/sandbox/scripts:$PATH" ralph.sh spawn --name sub-a --task TASK.md > $T/S2.log 2>&1
RC=$?
[ "$RC" -eq 1 ] && grep -q "not inside a supervised window" $T/S2.log \
  && ok "S2: spawn without PI_SUP_RUN_DIR → exit 1" || bad "S2: rc=$RC $(head -3 $T/S2.log)"

# S3: spawn inside a window → exit 0 + a well-formed request file
SRD=$T/projS1/.pi-supervisor/runs/run1; mkdir -p $SRD
echo "# Sub-project task" > $T/spawn-task.md
PATH="$T/sandbox/scripts:$PATH" PI_SUP_RUN_DIR=$SRD ralph.sh spawn --name sub-a \
  --task $T/spawn-task.md --runtime 90 --reason "split the work" > $T/S3.log 2>&1
RC=$?
[ "$RC" -eq 0 ] && [ -f $SRD/spawn-request.json ] \
  && ok "S3: spawn → exit 0 + spawn-request.json" || bad "S3: rc=$RC $(head -3 $T/S3.log)"
S3JSON=$(cat $SRD/spawn-request.json 2>/dev/null)
echo "$S3JSON" | node -e '
const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
const okJ = r.kind === "spawn" && r.node === "sub-a"
  && r.task === process.argv[1] && r.runtime_min === 90 && r.deadline === null
  && r.reason === "split the work" && /Z$/.test(r.at);
process.exit(okJ ? 0 : 1);' "$T/spawn-task.md" \
  && ok "S3: request JSON fields (kind/node/task/runtime_min/deadline/reason/at)" \
  || bad "S3: bad JSON: $S3JSON"

# S4: --deadline passthrough + = form + relative task path resolved against $PWD
cd $T
PATH="$T/sandbox/scripts:$PATH" PI_SUP_RUN_DIR=$SRD ralph.sh spawn \
  --name=sub-b --task=spawn-task.md --deadline="2026-12-01T00:00:00Z" > $T/S4.log 2>&1
RC=$?
S4JSON=$(cat $SRD/spawn-request.json 2>/dev/null)
[ "$RC" -eq 0 ] && echo "$S4JSON" | grep -q '"node": "sub-b"' \
  && echo "$S4JSON" | grep -q "\"deadline\": \"2026-12-01T00:00:00Z\"" \
  && echo "$S4JSON" | grep -q "\"task\": \"$T/spawn-task.md\"" \
  && echo "$S4JSON" | grep -q '"runtime_min": null' \
  && ok "S4: = form + --deadline passthrough + relative task → abs" \
  || bad "S4: rc=$RC $S4JSON"

# S5: bad node names → exit 2 (run-N collision; spaces)
cd $T/projS1
PATH="$T/sandbox/scripts:$PATH" PI_SUP_RUN_DIR=$SRD ralph.sh spawn --name run-5 --task $T/spawn-task.md > $T/S5a.log 2>&1
RC1=$?
PATH="$T/sandbox/scripts:$PATH" PI_SUP_RUN_DIR=$SRD ralph.sh spawn --name "bad name" --task $T/spawn-task.md > $T/S5b.log 2>&1
RC2=$?
[ "$RC1" -eq 2 ] && [ "$RC2" -eq 2 ] && grep -q "collides" $T/S5a.log && grep -q "bad node name" $T/S5b.log \
  && ok "S5: bad node names rejected (run-N collision, spaces)" \
  || bad "S5: rc1=$RC1 rc2=$RC2 $(head -2 $T/S5a.log) $(head -2 $T/S5b.log)"

# S6: missing / empty task file → exit 2; missing required flags → exit 2
PATH="$T/sandbox/scripts:$PATH" PI_SUP_RUN_DIR=$SRD ralph.sh spawn --name sub-c --task $T/nope.md > $T/S6a.log 2>&1
RC1=$?
: > $T/empty-task.md
PATH="$T/sandbox/scripts:$PATH" PI_SUP_RUN_DIR=$SRD ralph.sh spawn --name sub-c --task $T/empty-task.md > $T/S6b.log 2>&1
RC2=$?
PATH="$T/sandbox/scripts:$PATH" PI_SUP_RUN_DIR=$SRD ralph.sh spawn > $T/S6c.log 2>&1
RC3=$?
[ "$RC1" -eq 2 ] && [ "$RC2" -eq 2 ] && [ "$RC3" -eq 2 ] && grep -q "task file not found" $T/S6a.log && grep -q "task file is empty" $T/S6b.log \
  && ok "S6: missing/empty task + missing flags → exit 2" \
  || bad "S6: rc1=$RC1 rc2=$RC2 rc3=$RC3"

# S7: spawn --help → exit 0 even outside a window (help is not a spawn)
PATH="$T/sandbox/scripts:$PATH" ralph.sh spawn --help > $T/S7.log 2>&1
RC=$?
[ "$RC" -eq 0 ] && grep -q "request a sub-run" $T/S7.log && grep -q "NEVER launches" $T/S7.log \
  && ok "S7: spawn --help works outside a window" || bad "S7: rc=$RC $(head -3 $T/S7.log)"

# S8: zero-arg launch forwards --project/--node to launch.mjs (case C's args file)
grep -q -- "--project $T/projC --node (root)" $T/projC/.pi-supervisor/runs/run1/launch-args.txt 2>/dev/null \
  && ok "S8: launch.mjs got --project + --node (root)" \
  || bad "S8: $(cat $T/projC/.pi-supervisor/runs/run1/launch-args.txt 2>/dev/null)"

# S9: --help lists the spawn API
cd $T/projS1
PATH="$T/sandbox/scripts:$PATH" ralph.sh --help > $T/S9.log 2>&1
grep -q "ralph.sh spawn" $T/S9.log && ok "S9: --help documents spawn" || bad "S9: $(grep -c spawn $T/S9.log)"
grep -q -- "--sudo" $T/S9.log && ok "S9b: --help documents --sudo" || bad "S9b: --sudo missing from --help"

# S10: the monitor's parent-session wrapper ships EXECUTABLE (run27: it was 644 —
# every judgment spawn died at EACCES and the monitor was blind for the whole run)
[ -x "$T/sandbox/scripts/lib/pi-as-child.sh" ] && ok "S10: lib/pi-as-child.sh is executable" || bad "S10: lib/pi-as-child.sh missing or not executable (run27 regression)"

# S11: zero-arg re-run after a run that ended WITHOUT its chain step (the
# repair path, run27): the missing step() must run, AND its outcome must be
# read from chain-done.json's NESTED .outcome — status_field only reads
# top-level keys, so "no outcome recorded" is the regression signal.
# v0.30.1: the repaired halt is reported, NEVER a refusal — the launch
# principle (a human re-run always starts a new run) outranks the gate: the
# re-run proceeds to a FRESH allocation (run2), the halted root is unblocked
# (unblock: true), and `ralph.sh stop` on the new run records user intent
# (user-stop.json) so the chain step classifies it "stopped", not "blocked".
mkdir -p $T/projS11/.pi-supervisor/runs/run1
echo "# Test task" > $T/projS11/TASK.md
cat > $T/projS11/.pi-supervisor/active.json <<EOF
{"run_dir":"$T/projS11/.pi-supervisor/runs/run1","node":"(root)","guard_pid":999999,"window":null,"started_at":"2026-11-04T00:00:00.000Z","deadline":null}
EOF
cat > $T/projS11/.pi-supervisor/runs/run1/pi-child-status.json <<EOF
{"v":2,"at":"2026-11-04T00:00:01.000Z","status":"error","exitReason":"S11 test exit reason","guardPid":null,"childPid":null,"attempt":1,"rewinds":0,"toolCalls":0,"lastTool":null,"lastToolStartedAt":null,"elapsedMs":0,"deadlineIso":"2026-11-04T01:00:00.000Z"}
EOF
cd $T/projS11
PATH="$T/sandbox/scripts:$PATH" PI=$T/pi-OK ralph.sh > $T/S11.log 2>&1 &
sleep 6
grep -q "ended without its chain step" $T/S11.log \
  && ok "S11: missing chain step detected — repair step ran" || bad "S11: $(tail -3 $T/S11.log)"
[ -f $T/projS11/.pi-supervisor/runs/run1/chain-done.json ] \
  && grep -q '"next": "halted"' $T/projS11/.pi-supervisor/runs/run1/chain-done.json \
  && ok "S11: repair wrote chain-done.json (outcome halted)" \
  || bad "S11: chain-done $(cat $T/projS11/.pi-supervisor/runs/run1/chain-done.json 2>/dev/null)"
grep -q "last step: halted" $T/S11.log && ! grep -q "no outcome recorded" $T/S11.log \
  && ok "S11: outcome read from nested .outcome (not 'no outcome recorded')" \
  || bad "S11: $(grep -F 'halted before this launch' $T/S11.log || tail -3 $T/S11.log)"
# v0.30.1: no exit — the re-run proceeds to a fresh allocation
[ -f $T/projS11/.pi-supervisor/runs/run2/pi-child-status.json ] \
  && ok "S11: the re-run proceeded — run2 allocated + launched (no refusal)" \
  || bad "S11: run2 missing — gate exited before allocation? $(tail -5 $T/S11.log)"
grep -q "run2" $T/projS11/.pi-supervisor/active.json 2>/dev/null \
  && ok "S11: active.json re-pointed to run2" \
  || bad "S11: active.json: $(cat $T/projS11/.pi-supervisor/active.json 2>/dev/null)"
ST11=$(node -e 'try{console.log(require("./.pi-supervisor/node.json").state)}catch{console.log("?")}' 2>/dev/null)
[ "$ST11" = "active" ] && ok "S11: the halted root is unblocked by the fresh launch" || bad "S11: node state='$ST11' want active"
stoprun $T/projS11 > $T/S11.stop 2>&1
sleep 1
[ -f $T/projS11/.pi-supervisor/runs/run2/user-stop.json ] \
  && ok "S11: ralph.sh stop recorded user intent (user-stop.json)" \
  || bad "S11: no user-stop.json: $(ls $T/projS11/.pi-supervisor/runs/run2/ 2>/dev/null | tr '\n' ' ')"

# ---- v0.27.0: nested sub-project launch refusal + detached spawn refusal --------
# S12: a FRESH zero-arg launch inside a NESTED sub-project must refuse — its
# windows are launched by the parent tree's chain step (plan §5). No run dir.
mkdir -p $T/projS12/.pi-supervisor $T/projS12/auth/.pi-supervisor
echo "# root task" > $T/projS12/TASK.md
echo "# auth task" > $T/projS12/auth/TASK.md
cd $T/projS12/auth
PATH="$T/sandbox/scripts:$PATH" DEADLINE=$DEADLINE PI=$T/pi-OK ralph.sh > $T/S12.log 2>&1
RC=$?
[ "$RC" -eq 1 ] && grep -q "NESTED" $T/S12.log \
  && [ -z "$(ls -A .pi-supervisor/runs 2>/dev/null)" ] && [ ! -f .pi-supervisor/active.json ] \
  && ok "S12: nested sub-project → fresh launch refused (exit 1, no run dir)" \
  || bad "S12: rc=$RC $(head -5 $T/S12.log)"

# S13: spawn inside a DETACHED project (its own node.json says parent == null —
# the tree moved away, there is no parent to hand back to) → refused up front.
mkdir -p $T/projS13/.pi-supervisor/runs/run-1
echo '{"v":2,"name":"moved","path":"auth","parent":null,"state":"active","children":[]}' > $T/projS13/.pi-supervisor/node.json
echo "# detached task" > $T/projS13/TASK.md
echo "# sub task" > $T/spawn-task-S13.md
PATH="$T/sandbox/scripts:$PATH" PI_SUP_RUN_DIR=$T/projS13/.pi-supervisor/runs/run-1 ralph.sh spawn \
  --name sub-c --task $T/spawn-task-S13.md > $T/S13.log 2>&1
RC=$?
[ "$RC" -eq 1 ] && grep -q "DETACHED" $T/S13.log && [ ! -f $T/projS13/.pi-supervisor/runs/run-1/spawn-request.json ] \
  && ok "S13: spawn in a detached project → refused (exit 1, no request file)" \
  || bad "S13: rc=$RC $(head -5 $T/S13.log)"

# S14: spawn in a GENUINE standalone v2 ROOT (name "(root)", parent null —
# never had a parent) must NOT be refused — its own chain step is the handler.
# Regression guard: the detached refusal is keyed on non-root name, not just
# parent==null (e2e-2 2026-11-05: a real standalone root was refused).
mkdir -p $T/projS14/.pi-supervisor/runs/run-1
echo '{"v":2,"name":"(root)","path":"(root)","parent":null,"state":"active","children":[]}' > $T/projS14/.pi-supervisor/node.json
echo "# root task" > $T/projS14/TASK.md
echo "# sub task" > $T/spawn-task-S14.md
PATH="$T/sandbox/scripts:$PATH" PI_SUP_RUN_DIR=$T/projS14/.pi-supervisor/runs/run-1 ralph.sh spawn \
  --name beta --task $T/spawn-task-S14.md > $T/S14.log 2>&1
RC=$?
[ "$RC" -eq 0 ] && [ -f $T/projS14/.pi-supervisor/runs/run-1/spawn-request.json ] \
  && ok "S14: spawn in a standalone v2 root → allowed (request written)" \
  || bad "S14: rc=$RC $(head -5 $T/S14.log)"

# S15 (v0.29.2, run34): an infeasible budget (only 5min until the deadline, 10min
# reserved for finalization) → the receipt WARNS and still writes the request —
# the chain step stays the authority; the child can re-issue with a bigger budget.
mkdir -p $T/projS15/.pi-supervisor/runs/run-1
echo '{"v":2,"name":"(root)","path":"(root)","parent":null,"state":"active","children":[]}' > $T/projS15/.pi-supervisor/node.json
echo "# root task" > $T/projS15/TASK.md
echo "# sub task" > $T/spawn-task-S15.md
D15="$(date -u -d '+5 minutes' +%Y-%m-%dT%H:%M:%SZ)"   # supported formats: ISO|HH:MM|epoch
PATH="$T/sandbox/scripts:$PATH" PI_SUP_RUN_DIR=$T/projS15/.pi-supervisor/runs/run-1 ralph.sh spawn \
  --name slow --task $T/spawn-task-S15.md --deadline "$D15" --runtime 1 > $T/S15.log 2>&1
RC=$?
[ "$RC" -eq 0 ] && grep -q "spawn budget warning" $T/S15.log \
  && [ -f $T/projS15/.pi-supervisor/runs/run-1/spawn-request.json ] \
  && ok "S15: infeasible spawn → receipt WARNS, request still written" \
  || bad "S15: rc=$RC $(head -8 $T/S15.log)"
grep -q "leaves no work time" $T/S15.log && ok "S15b: warning names the sizing rule" || bad "S15b: $(head -8 $T/S15.log)"
[ ! -d $T/projS15/slow ] && ok "S15c: spawn side never creates the sub-project" || bad "S15c: sub dir exists"

# S16: a feasible budget → clean green receipt, no warning
mkdir -p $T/projS16/.pi-supervisor/runs/run-1
echo '{"v":2,"name":"(root)","path":"(root)","parent":null,"state":"active","children":[]}' > $T/projS16/.pi-supervisor/node.json
echo "# root task" > $T/projS16/TASK.md
echo "# sub task" > $T/spawn-task-S16.md
D16="$(date -u -d '+120 minutes' +%Y-%m-%dT%H:%M:%SZ)"
PATH="$T/sandbox/scripts:$PATH" PI_SUP_RUN_DIR=$T/projS16/.pi-supervisor/runs/run-1 ralph.sh spawn \
  --name fast --task $T/spawn-task-S16.md --deadline "$D16" --runtime 30 > $T/S16.log 2>&1
RC=$?
[ "$RC" -eq 0 ] && grep -q "spawn request written" $T/S16.log \
  && ! grep -q "spawn budget warning" $T/S16.log \
  && ok "S16: feasible spawn → green receipt, no warning" \
  || bad "S16: rc=$RC $(head -8 $T/S16.log)"

# S17 (v0.29.3, run35): a re-run of an EXISTING tree with a FUTURE --deadline
# refreshes the root's PAST invariant via the S0 gate and unblocks it. run35
# froze exactly here: the gate used to call ensureRootNode only when node.json
# was missing, so the refresh was dead code on every re-run.
mkproj $T/projS17 && cd $T/projS17
mkdir -p .pi-supervisor/runs/run-1
PAST17=$(date -u -d '-2 hours' '+%Y-%m-%dT%H:%M:%SZ')
echo "{\"v\":2,\"name\":\"(root)\",\"path\":\"(root)\",\"parent\":null,\"state\":\"blocked\",\"children\":[],\"deadline\":\"$PAST17\"}" > .pi-supervisor/node.json
DL17=$(( $(date +%s) + 7200 ))
PATH="$T/sandbox/scripts:$PATH" PI=$T/pi-OK ralph.sh --deadline $DL17 > $T/S17.log 2>&1 &
sleep 4
ND17=$(node -e 'try{console.log(new Date(require("./.pi-supervisor/node.json").deadline).getTime()/1000)}catch{console.log("")}' 2>/dev/null)
[ -n "$ND17" ] && [ "$ND17" -ge $((DL17-5)) ] && [ "$ND17" -le $((DL17+5)) ] \
  && ok "S17: re-run with future --deadline refreshes the past invariant" \
  || bad "S17: node deadline='$ND17' want ≈$DL17 $(head -8 $T/S17.log)"
ST17=$(node -e 'try{console.log(require("./.pi-supervisor/node.json").state)}catch{console.log("?")}' 2>/dev/null)
[ "$ST17" = "active" ] && ok "S17: the refresh also unblocks the root (was blocked)" || bad "S17: state='$ST17'"
stoprun $T/projS17 > $T/S17.stop 2>&1

# S17b: a FUTURE invariant never moves — a launch deadline earlier than the
# existing one leaves the deadline untouched (v0.30.1: the fresh launch's
# unblock: true still flips the halted state — the invariant is the deadline,
# not the halt marker).
mkproj $T/projS17b && cd $T/projS17b
mkdir -p .pi-supervisor/runs/run-1
INV17B=$(date -u -d '+3 hours' '+%Y-%m-%dT%H:%M:%SZ')
echo "{\"v\":2,\"name\":\"(root)\",\"path\":\"(root)\",\"parent\":null,\"state\":\"blocked\",\"children\":[],\"deadline\":\"$INV17B\"}" > .pi-supervisor/node.json
DL17B=$(( $(date +%s) + 1800 ))
PATH="$T/sandbox/scripts:$PATH" PI=$T/pi-OK ralph.sh --deadline $DL17B > $T/S17b.log 2>&1 &
sleep 4
ND17B=$(node -e 'try{console.log(require("./.pi-supervisor/node.json").deadline)}catch{console.log("")}' 2>/dev/null)
[ "$ND17B" = "$INV17B" ] && ok "S17b: a future invariant is never moved by a launch" \
  || bad "S17b: invariant moved to '$ND17B' want '$INV17B'"
ST17B=$(node -e 'try{console.log(require("./.pi-supervisor/node.json").state)}catch{console.log("?")}' 2>/dev/null)
[ "$ST17B" = "active" ] && ok "S17b: the fresh launch still unblocks the halted root (v0.30.1)" \
  || bad "S17b: state='$ST17B' want active"
stoprun $T/projS17b > $T/S17b.stop 2>&1

# S17c: an HH:MM launch deadline is normalized to ISO before it touches
# node.json (the old gate stored the raw string — a bare 'HH:MM' invariant).
mkproj $T/projS17c && cd $T/projS17c
HH17C=$(date -d '+1 hour' '+%H:%M')
PATH="$T/sandbox/scripts:$PATH" PI=$T/pi-OK ralph.sh --deadline $HH17C > $T/S17c.log 2>&1 &
sleep 4
ND17C=$(node -e 'try{console.log(require("./.pi-supervisor/node.json").deadline || "")}catch{console.log("")}' 2>/dev/null)
case "$ND17C" in
  "") bad "S17c: no deadline in node.json $(head -8 $T/S17c.log)" ;;
  *T*) [ "$ND17C" != "$HH17C" ] && ok "S17c: HH:MM launch deadline stored as ISO ($ND17C)" || bad "S17c: raw HH:MM stored: '$ND17C'" ;;
  *) bad "S17c: non-ISO deadline stored: '$ND17C'" ;;
esac
stoprun $T/projS17c > $T/S17c.stop 2>&1

echo ""
echo "=== $PASS passed, $FAIL failed (sandbox: $T) ==="
pkill -f "sleep 600" 2>/dev/null
rm -rf $T
exit $(( FAIL > 0 ? 1 : 0 ))
