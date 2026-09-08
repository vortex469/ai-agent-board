# Scribe History

## Seed Context

- Project: ai-agent-board.
- Scribe owns decisions, orchestration logs, session logs, memory hygiene, and cross-agent history updates.
- User: Copilot.

## Learnings

- Append-only files use the union merge driver in `.gitattributes`.
- Scribe must stage only files written in the current session, never broad-stage `.squad/`.
- **Exact `## Members` format is critical after roster restructuring:** The Members section header and table format must match exactly across downstream scripts and validation. Inconsistency causes silent failures in role detection. After any roster changes, validate that the section has the header `## Members` followed by a properly formatted table row for each agent.

## 2026-09-08 — Cross-group dependencies and synchronization gates

Asked: Add stable-ID dependencies across Workbench groups, authoritative eligibility and repository integration gates, automatic reevaluation, dependency controls, and regression coverage.

Completed: Runtime implementation adds strict successful-completion checks, a shared admission mutex, repeated checks before worktree/session creation, pending legacy group queues, and warnings when running tasks lose a satisfied prerequisite. Git gating verifies prerequisite result ancestry into the expected base, any existing dependent branch, and the pinned input commit. Ordered tasks now pin current integrated base HEAD while preserving predecessor lineage. API/persistence and client work are coordinated separately by the parent and frontend agents.

Validation evidence: Server build and git diff whitespace check passed for the runtime batch. Eight focused runtime tests pass, covering same/cross/multiple dependencies, missing/blocked states, reset, pre-worktree rejection, queue reevaluation, admission serialization, unverifiable repository results, and running-task warnings. Exact combined rerun: `node --import tsx/esm --test --experimental-test-isolation=none packages/server/tests/cross-group-dependencies.test.ts packages/server/tests/group-baseline.test.ts` produced 8 passed / 12 failed; all twelve failures reported `spawnSync git EPERM` during repository fixture creation. No test skip was introduced. This record does not claim the complete required gate passed.

Hostile review: Corrected stale pinned baseline selection, duplicate admission handling, queue wakeup loss, dispatch after queue stop during awaited eligibility reads, and completion callback error handling. Added regression assertions for external changes integrated after an immediate predecessor and an existing stale pinned baseline.

Open issues: Git-backed runtime validation remains blocked in this agent's sandbox execution context. Parent owns complete integration validation, browser evidence, and final completion assessment.

Runtime follow-up: Independent persistence review identified queue-slot reservation outside the admission mutex. Eligibility, refreshed task lookup, queue-state checks, reservation, and checked launch now execute under the same mutex. A regression test verifies that a concurrent prerequisite reset cannot reserve or launch the dependent. Ten focused non-Git tests passed, including legacy reconfiguration. The parent reports its standalone runner can execute Git fixtures, so the subprocess restriction above is specific to the runtime agent context and is not a project-wide validation blocker; final aggregate evidence belongs to the parent.

Further review corrections: Replaced stopped-task TTL admission filtering with per-run epochs so immediate retry works and late callbacks from an aborted run cannot settle the new run. Moved ordered-baseline preparation inside admission locking and included implicit ordered predecessors in every dependency gate and cycle traversal. Focused stop/retry, late failure, implicit reset, and implicit cross-group cycle tests passed; server build and whitespace checks passed. Browser recovery failures were traced to existing fixtures requesting nonexistent `GET /api/tasks/:id`; those fixtures now read children from the valid group endpoint. Browser rerun is delegated to the frontend validation owner.

Parent final validation: All 288 server tests and 15 client tests passed. Fresh server/client builds passed. The complete browser suite passed 228 tests with 2 preexisting integration skips and no failures, including concurrent cross-group synchronization, baseline ancestry, roadmap/task persistence, group recovery, worktree lifecycle, and portrait/landscape interactions. git diff --check passed. Hostile review passed after closing implicit-order/cycle races, pending-stop and immediate-retry races, missing-group deletion broadcasts, stale baseline selection, and unintended continuation of non-full-roadmap tasks.

Open issues at handoff: The aggregate gate wrapper encounters sandbox subprocess/socket restrictions. Running its Hermes component with the selected /usr/bin/python3 interpreter fails all three setup methods because socket.socket is denied with PermissionError (Errno 1); the interpreter itself is available. No test was skipped or socket restriction bypassed. Application server/client/browser validation passed independently; the full aggregate gate is not claimed as passing.
