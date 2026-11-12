# Spec

- This Spec is the **main source of truth** for pi-supervisor.
- Any contradiction between the Spec and the code, or between the Spec and any other part of this SKILL.md, is resolved in favor of the Spec.
- An agent can only modify the Spec when the user asks.
- An entry never references another entry by its number.
- Every Spec entry must be numbered. The only unnumbered part of the spec is this preamble.
- Spec entries should be as short as possible.
- Spec entries must not contain implementation details.

## 1. Structure
- **1.1 Project.** A single project — the root or a sub-project — is the unit that owns a task and a state; it can contain **multiple runs** over its life. Contains .pi-supervisor folder.
- **1.2 Infrastructure folder.** .pi-supervisor folder in a project.
- **1.3 Subproject.** A project within the parent project. Subfolder with Infrastructure folder, subproject in its structure the same as parent project. Can be copied outside of the parent folder and run independently.
- **1.4 Project tree.** A root project plus nested sub-projects (sub-folders).
- **1.5 Run.** A unit of work within a project. A run **owns a deadline** and contains **one or more pi sessions** over its life.
- **1.6 Monitor.** Main script and other scripts that it is using to do its job together are called a **Monitor**. Monitor supervision is deterministic and fast, it catches the easy stalls: thinking loops, exact message repetition, premature stopping. It does mechanical retry of the request when the model server times out. The Monitor is the fast reflex.
- **1.7 Sub-run.** A run *in a sub-project*, launched — by request through the monitor — by a run in the parent project. A sub-project is a container, not 1:1 with a run: the same session can request any number of runs in the same sub-project.
- **1.8 Session.** The run's conversation with the model. Transcript on disk; the process is disposable. A session is finalized (process exits) and can be resumed.
- **1.9 Worker.** The agent that does all the actual work — the run's working session.
- **1.10 Judge.** A throwaway LLM judgment, run fresh each cycle — the generalist: views how the Worker is doing, catches what the script can't (inexact/semantic loops, problems with the supervisor itself) and makes the verdict — distill (start new session), continue, nudge/steer, stop, and the final report when work ends. The Judge is the slow and heavy judgment, compared to the Monitor. The Judge is re-run fresh each cycle with all memory on disk, so a dead model kills one cycle, not the supervision.

## 2. Launch — one primitive, two triggers
- **2.1 Launch script** - ralph.sh.
- **2.2** The **only** primitive is **starting a run in a project**.
- **2.3** A **human** does it directly with a launch script. Running launch script in a project always starts a **new** run — a dead run is never re-opened as the same run; its on-disk state is read by the new run, not resumed.
- **2.4** A **run** requests it for a sub-project (a spawn request to the monitor), which performs the launch. Downward only; unlimited; recursive (a sub-run can request its own sub-runs).
- **2.5** A **new run of a run's own project** is human-only — a run can never cause the next run of its own project.

## 3. Worker rules
- **3.1** A run (its session) **launches nothing** — it writes requests.
- **3.2** A run works under its deadline. The run **ends** when its goal is met, its deadline is reached (its process is killed at hard timeout), or the process dies — there is **no automatic continuation**; a new run picks up from the on-disk state.

## 4. Tree dynamics
- **4.1** Only **one active project** at a time. By default it is root project, where ralph.sh was called.
- **4.2** Worker can request **sub-run** in a subproject through the Monitor.
- **4.3** Exactly **one active run** across the whole tree at a time.
- **4.4 Handoff** - moment when sub-run becomes active.
- **4.5 Reentry** - moment when parent run becomes active again.
- **4.6** Parent project has a **pointer** which tracks what project is currently active - the project itself or one of its subprojects.
- **4.7** If sub-run is started in a subproject, that subproject becomes the active project and the pointer in the parent project is **updated**.
- **4.8** If a run is started in a project which has active pointer to one of its subprojects, pointer is **reset to the project**, and Worker is **notified** about that subproject was an active project.
- **4.9** If **deadline** is hit when active project is a subproject, that subproject remains active project, there is no reentry and no final report in a subproject, Judge of the root project writes final report and that's it.

## 5. Session lifecycle (within a run)
- **5.1 Re-entry (sub-run hand-back):** the sub-run's Worker finishes → its Judge writes the final report → the Monitor activates the original session (resumes it) and sends a message into it (the sub-run's final report + spawn decision) → the run continues from its own context.
- **5.2 Resume gate:** every resume (re-entry) is gated on the session's size — if the session file is above **~50–60% of the model's context window**, do **not** resume — distill instead.
- **5.3 Distill:** when the resume gate trips or the Judge verdicts the context rotted, the run's session is **replaced by a fresh one** carrying a distilled brief of the state (same run, same deadline). The Monitor's automatic context-overflow distill is the last resort.
- **5.4** Sessions are always **finalized** (process exits, transcript on disk); continuing = re-activating by resume, never a kept-alive process.

## 6. Process lifetime
- **6.1** A run is **owned by the terminal that launched it** and **dies with that terminal**. The owning terminal follows the active run down the tree; other terminals may attach read-only — their death is irrelevant to the run.
- **6.2** When the owning terminal dies (close, kill, reboot), the run and its **whole owned tree** — active and paused, across sub-projects — is torn down. No orphaned processes.
- **6.3** Every supervisor process belongs to the run that launched it and ends with it — a process outliving its run is a bug, not a race.
- **6.4** The monitor leaves its run only for the hand-off to a sub-run and the hand-back on re-entry. It never follows a new launch.
- **6.5** Whatever spawns supervisor processes kills all of them on every exit path — and never its own shell while doing so.
- **6.6 Ctrl-C** in any attached terminal stops all running processes.

## 7. Terminal output
- **7.1 The view, not the record.** The terminal is the human's live view of the run: derived from the on-disk state.
- **7.2 The view, not the conversation.** The terminal shows what is happening *now*, not what was said — the Worker's transcript is never streamed into it; the transcript is on disk.
- **7.3 Banner.** At start, a context banner: project, run, deadline, models.
- **7.4 Progress.** Worker progress lines — one **per every tool call**, one **per quiet minute**; derived from the Worker's status, not its output.
- **7.5 Judgment.** One Judge verdict per cycle: the last message of the Judge's turn.
- **7.6 Handoff and Reentry.** When the active run changes (a handoff to a sub-project, or a re-entry to the parent): a divider and tree banner, and the view re-points to the new run.
- **7.7 The end.** The final report, printed to the terminal when the run ends.
- **7.8 Local time.** All displayed time is **local time**, never ISO: each line carries a short local `[HH:MM:SS]`, and the deadline is shown as a local date and time. ISO-8601 (UTC) appears only in the files, not the terminal. This applies only to Monitor messages, not agent messages.
- **7.9 Message manipulation.** Text of any agent messages displayed in the terminal **must not be manipulated or replaced** unless specifically required by the Spec.
- **7.10 Append-only; the terminal is for humans, the files for machines.** One line at a time — no redraw, no in-place updates, no cursor control; the output can be piped, tailed, or scrolled back. Color only when the terminal is a TTY, stripped when `NO_COLOR` is set. The terminal's format is free to change for readability; the machine contract lives in the files, not the terminal.
- **7.11 Read-only.** The display never drives: nothing the terminal shows can change the run, and the only thing a terminal does to the run is **Ctrl-C**. 
- **7.12 Shared.** Any number of terminals may attach; each shows the same view of the active run, and the death of any of them is irrelevant.

## 8. Durability
- **8.1** Everything important is on disk and resumable: transcripts, state, reports, the tree.
- **8.2** The **on-disk state** survives a reboot, so a fresh run can pick up from it. The live run does not: a reboot kills the owning terminal's process and the run ends.

## 9. Security — isolation the kernel enforces, not the prompt

- **9.1 Two trust domains.** The **trusted** side is the human and the deterministic supervisor. The **untrusted** side is every LLM process — the Worker and the Judge. Only the trusted side is privileged; both LLM processes run unprivileged.
- **9.2 Privilege separation.** Every LLM process runs as a dedicated **unprivileged OS user**, separated from the host by the kernel. It **cannot escalate** — it holds no privilege by default.
- **9.3 Ground-truth protection.** A run's on-disk state is the ground truth, and it is protected *from the model that is producing it*: the model's write access to the project cannot move or delete the run tree that holds its transcripts and state.
- **9.4 Least privilege, per run.** Access is granted to what the run needs (its project, its run tree, its own sessions) and nothing more; it is scoped to the run and revocable, not standing.
- **9.5 Escalation is an explicit, logged exception.** The model has no path to grow its own privilege. The only way a run gains privilege is a human opting it in (`--sudo`), which deliberately **voids** the isolation for that run, is flagged at launch, and is auditable in the transcript. A run can never extend its own deadline or grant itself access.
- **9.6 Auditability.** Everything a run does is recorded on disk (transcripts, logs) and survives the run; the untrusted side is reviewable after the fact.
- **9.7 Scope of the guarantee.** The isolation holds only where the kernel provides it (the protected default on a Linux host). In the opt-out, or on a host without the mechanism, there is **no** privilege separation — a run is only as safe as its prompt — and that is the operator's explicit choice. File/privilege isolation does not cover the network: the model can still reach the endpoints it needs.
