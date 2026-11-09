# Goal

- Goal is fixing problems in pi-supervisor.
- Problems are:
    1. Bugs
    2. Spec deviations

# Previous attempts

- Look at prevoius sessions in this folder. They might contain previous attemps to do this.

# Procedure

- Start new runs in /home/foxclip/Projects/TestProject2 by running EXACTLY this command: `ralph.sh --task TASK-sub.md --runtime 30m`.
- Observe what the run outputs.
- Use debugging tools to get information about crashes.
- If there are problems, make changes to pi-supervisor to try to fix that problem.
- Use polling loop that can early return to wait for runs. Don't use goal_wait to wait for runs.
- After significant changes to pi-supervisor, verify your session transcript for hallucinated user messages and commit changes.

# This file

- Do not edit.
- Do not commit.
- Do not delete.

# Stopping condition

- 10 consequtive runs ended with no problems.

