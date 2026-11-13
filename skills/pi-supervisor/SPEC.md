# Spec

- This Spec is the **main source of truth** for pi-supervisor.
- Any contradiction between the Spec and the code, or between the Spec and SKILL.md, is resolved in favor of the Spec.
- An agent can only modify the Spec when the user asks.
- An entry never references another entry by its number.
- Every Spec entry must be numbered. The only unnumbered part of the spec is this preamble.
- Spec entries should be as short as possible.
- Spec entries must not contain implementation details.

## 1. Structure

- **1. Project.** A single project — the root or a sub-project — is the unit that owns a task and a state; it can contain **multiple runs** over its life. Contains .pi-supervisor folder.
- **2. Infrastructure folder.** .pi-supervisor folder in a project.
- **3. Subproject.** A project within the parent project. Subfolder with Infrastructure folder, subproject in its structure the same as parent project. Can be copied outside of the parent folder and run independently.
- **4. Project tree.** A root project plus nested sub-projects (sub-folders).
- **5. Run.** A unit of work within a project. A run **owns a deadline** and contains **one or more pi sessions** over its life.
- **6. Monitor.** Main script and other scripts that it is using to do its job together are called a **Monitor**. Monitor supervision is deterministic and fast, it catches the easy stalls: thinking loops, exact message repetition, premature stopping. It does mechanical retry of the request when the model server times out. The Monitor is the fast reflex.
- **7. Sub-run.** A run *in a sub-project*, launched — by request through the monitor — by a run in the parent project. A sub-project is a container, not 1:1 with a run: the same session can request any number of runs in the same sub-project.
- **8. Session.** The run's conversation with the model. Transcript is on disk and survives crashes and reboots. A session is finalized (process exits) and can be resumed.
- **9. Worker.** The agent that does all the actual work — the run's working session.
- **10. Judge.** A throwaway LLM judgment, is invoked periodically to make decisions about current run. 

## 2. Launch — one primitive, two triggers

- **1. Launch script** - shell script that launches runs.
- **2.** The **only** primitive is **starting a run in a project**.
- **3.** A **human** does it directly with a launch script. Running launch script in a project always starts a **new** run (or attaches terminal to a live run) — a dead run is never re-opened as the same run; its on-disk state is read by the new run, not resumed.
- **4.** A **run** requests it for a sub-project (a spawn request to the monitor), which performs the launch. Downward only; unlimited; recursive (a sub-run can request its own sub-runs).
- **5.** A **new run of a run's own project** is human-only — a run can never cause the next run of its own project.

## 3. Run

- **1.** A run works under its deadline. The run **ends** when it completes its task, its deadline is reached (its process is killed at hard timeout), the process dies, or the Judge decides to stop the run — there is **no automatic continuation**; a new run picks up from the on-disk state.

## 4. Judge

- **1.** Judge is the **generalist**: it views how the Worker is doing, catches what the script can't (inexact/semantic loops, problems with the supervisor itself). The Judge is the slow and heavy judgment, compared to the Monitor.
- **2.** Judge is **invoked periodically** (period defined by a parameter of a Launch Script).
- **3.** One judge invocation is called a **cycle**.
- **4.** Judge **looks at Worker's transcript** to make its decision.
- **5.** Judge makes a verdict:
    - OK (continue)
    - Nudge/steer (send message to Worker)
    - Distill (start new session)
    - Stop (end run)
- **6.** Judge writes **Final Report** when the run ends. Monitor then acts on the verdict. Exception: parent run's deadline is hit.

## 5. Tree dynamics

- **1.** Only **one active project** at a time. By default it is root project, where Launch Script was called.
- **2.** Worker can request **sub-run** in a subproject through the Monitor.
- **3.** A run (its session) **launches nothing** — it writes requests.
- **4.** Exactly **one active run** across the whole tree at a time.
- **5. Handoff** - moment when sub-run becomes active.
- **6. Reentry** - moment when parent run becomes active again.
- **7.** Parent project has a **pointer** which tracks what project is currently active - the project itself or one of its subprojects.
- **8.** If sub-run is started in a subproject, that subproject becomes the active project and the pointer in the parent project is **updated**.
- **9.** If a run is started in a project which has active pointer to one of its subprojects, pointer is **reset to the project**, and Worker is **notified** about that subproject was an active project.
- **10.** If **deadline** is hit in the parent project when active project is a subproject, there is no reentry and no final report in a subproject, Judge of the parent project writes final report and parent run ends.

## 6. Session lifecycle (within a run)

- **1. Re-entry (sub-run hand-back):** the sub-run's Worker finishes → its Judge writes the final report → the Monitor activates the original session (resumes it) and sends a message into it (the sub-run's final report) → the run continues from its own context.
- **2. Resume gate:** every resume (re-entry) is gated on the session's size — if the session file is above **~50–60% of the model's context window**, do **not** resume — distill instead.
- **3. Distill:** when the resume gate trips or the Judge verdicts the context rotted, the run's session is **replaced by a fresh one** carrying a distilled brief of the state (same run, same deadline). The Monitor's automatic context-overflow distill is the last resort.
- **4.** Sessions are always **finalized** (process exits, transcript on disk); continuing = re-activating by resume, never a kept-alive process.

## 7. Process lifetime

- **1.** A run is **owned by the terminal that launched it** and **dies with that terminal**. The owning terminal follows the active run down the tree; other terminals may attach read-only — their death is irrelevant to the run.
- **2.** When the owning terminal dies (close, kill, reboot), the run and its **whole owned tree** — active and paused, across sub-projects — is torn down. No orphaned processes.
- **3.** A run leaves no orphaned processes.
- **4.** The monitor leaves its run only for the hand-off to a sub-run and the hand-back on re-entry. It never follows a new launch.
- **5.** Whatever spawns supervisor processes kills all of them on every exit path — and never its own shell while doing so.
- **6. Ctrl-C** in any attached terminal stops all running processes.

## 8. Terminal output

### 1 Terminal
- **1. The view, not the record.** The terminal is the human's live view of the run: derived from the on-disk state.
- **2. Append-only; the terminal is for humans, the files for machines.** One line at a time — no redraw, no in-place updates, no cursor control; the output can be piped, tailed, or scrolled back. Color only when the terminal supports it. The terminal's format is free to change for readability; the machine contract lives in the files, not the terminal.
- **3. Read-only.** The display never drives: nothing the terminal shows can change the run, and the only thing a terminal does to the run is **Ctrl-C**. 
- **4. Shared.** Any number of terminals may attach; each shows the same view of the active run, and the death of any of them is irrelevant.

### 2 Events
- **1. Run start banner.** At the start of a run, a context banner: project, run, deadline, Worker and Judge models, Judge cycle time. Similar banner is shown on Handoff, showing information about the run being launched.
- **2. Phase change.** Line in the beginning of big phases, like start of the Worker, Judge cycle or Final Report.
- **3. Agent messages.** Every **Worker message** is printed to the terminal (without thinking and tool call contents). In messages with tool calls, **name of the tool** is shown. One line **per quiet minute** (dim). Same for judge.
- **4. Idling.** One (dim) line **per quiet minute** (no events), showing what is going right now.
- **5. Handoff and Reentry.** On handoff, a run start banner. On reentry, only a message line.
- **6. Final Report.** The Final Report, printed to the terminal when the run ends. The sections are the following:
    - What was requested
    - What was done
    - Outcome
    - Remaining

### 3 Misc
- **1. Timestamp.** Every line (except for banner and  agent message lines) has a timestamp at the beginning with [HH:mm:ss] format.
- **2. Local time.** All displayed time is **local time**, never ISO: ISO-8601 (UTC) appears only in the files, not the terminal. This applies only to Monitor messages, agent messages allowed to have anything.
- **3. Message manipulation.** Text of any agent messages displayed in the terminal **must not be manipulated or replaced** unless specifically required by the Spec.
- **4. Implementation details.** Spec vocabulary should be preferred to the implementation vocabulary. Monitor messages should not use words specific to implementation details unless absolutely necessary. Judge's prompt should advise against using implementation vocabulary.
- **5. Symbols.** After time, every non-banner line should have symbol signifying type of the line:
    - Dot for messages.
    - Ellipsis for quiet lines ("Worker running").
    - Arrow for Handoff/Reentry.
    - Exclamation mark for warnings.
    - Red cross for errors.

## 9. Durability

- **1.** Everything important is on disk and resumable: transcripts, state, reports, the tree.
- **2.** The **on-disk state** survives a reboot, so a fresh run can pick up from it. The live run does not: a reboot kills the owning terminal's process and the run ends.

## 10. Security — isolation the kernel enforces, not the prompt

- **1. Two trust domains.** The **trusted** side is the human and the deterministic supervisor. The **untrusted** side is every LLM process — the Worker and the Judge. Only the trusted side is privileged; both LLM processes run unprivileged.
- **2. Privilege separation.** Every LLM process runs as a dedicated **unprivileged OS user**, separated from the host by the kernel. It **cannot escalate** — it holds no privilege by default.
- **3. Ground-truth protection.** A run's on-disk state is the ground truth, and it is protected *from the model that is producing it*: the model's write access to the project cannot move or delete the run tree that holds its transcripts and state.
- **4. Least privilege, per run.** Access is granted to what the run needs (its project, its run tree, its own sessions) and nothing more; it is scoped to the run and revocable, not standing.
- **5. Escalation is an explicit, logged exception.** The model has no path to grow its own privilege. The only way a run gains privilege is a human opting it in, which deliberately **voids** the isolation for that run, is flagged at launch, and is auditable in the transcript. A run can never extend its own deadline or grant itself access.
- **6. Auditability.** Everything a run does is recorded on disk (transcripts, logs) and survives the run; the untrusted side is reviewable after the fact.
- **7. Scope of the guarantee.** The isolation holds only where the kernel provides it (the protected default on a Linux host). In the opt-out, or on a host without the mechanism, there is **no** privilege separation — a run is only as safe as its prompt — and that is the operator's explicit choice. File/privilege isolation does not cover the network: the model can still reach the endpoints it needs.
