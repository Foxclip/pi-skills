#!/usr/bin/env bash
# test-ralph.sh — end-to-end suite for ralph.sh + ralph-monitor.mjs (v0.20.0).
# Self-contained: builds a sandbox (stub launch.mjs + stub pi models), runs
# every case, prints PASS/FAIL lines, exits non-zero on any failure.
# NO real child agents are launched (launch.mjs is stubbed in the sandbox).
# Note: a foreground `ralph.sh` blocks while it monitors — cases that launch
# run it backgrounded and assert on its log, then stop it via the pointer.
set -u
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

echo ""
echo "=== $PASS passed, $FAIL failed (sandbox: $T) ==="
pkill -f "sleep 600" 2>/dev/null
rm -rf $T
exit $(( FAIL > 0 ? 1 : 0 ))
