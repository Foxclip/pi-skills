# Goal

- Goal is fixing problems in pi-supervisor.
- Problems are:
    1. Bugs
    2. Spec deviations (Spec is in SPEC.md file)

# Previous attempts

- Look at prevoius sessions in this folder. They might contain previous attemps to do this.

# Procedure

- Run bpftrace before starting a run to get information about crashes and SIGTERM signals.
- Start new runs in /home/foxclip/Projects/TestProject2 by running EXACTLY this command: `ralph.sh --task TASK-sub.md --runtime 30m`.
- Observe what the run outputs.
- In case of unexpected crashes, observe bpftrace output.
- If there are problems, make changes to pi-supervisor to try to fix that problem.
- Use polling loop that can early return to wait for runs. Don't use `goal_wait` to wait for runs.
- After significant changes to pi-supervisor, verify your session transcript for hallucinated user messages and commit changes.

# Phases

## Streak phase

- Attemt doing a streak of clean runs. This is the Streak phase.
- After each run that ended without obvious problems, verify Spec compliance entry-by-entry.
    - If possible, try to verify compliance to a specific Spec entry with tools, not just your judgement.

## Fix phase

- If there is a problem, you can make runs without full Spec compliance check. This is the Fix phase.
- After you fixed a problem that you found and a run ended without obvious problems, go to Streak phase.

# This file

- Do not edit.
- Do not commit.
- Do not delete.

# Stopping condition

- 10 consequtive runs ended with no problems.

