# Plan Feedback Transport Matrix

**Goal:** Define the transport contract for plan-phase feedback so `openagent` planning can follow the `superpowers:brainstorming` and `superpowers:writing-plans` workflows without collapsing every interaction into `AskUserQuestion -> bulletin -> synthesize`.

**Architecture:** Use a two-layer model. The control plane is durable state in the openagent job directory plus optional envelope events. The conversation plane uses the best available transport per interaction type: directed agent sessions for single-owner decisions, nested subagents for delegated work, bulletin board for advisory fanout, and Discord thread/buttons for human gates.

## Design Rules

1. Bulletin is advisory transport, not the default transport.
2. `sessions_send` is follow-up transport, not session-establishment transport.
3. `sessions_spawn(thread=true, mode="session")` establishes stable directed conversations.
4. Human gates live in the PDCA Discord thread.
5. Every external interaction must have a resumable durable handle:
   - PM/specialist: `sessionKey`
   - bulletin: `bulletinId`
   - human: thread message id or component payload id
   - reviewer: `runId` + `childSessionKey`
6. The job directory is the source of truth for in-flight state.

## Runtime Assumptions

### `sessions_spawn`

- Always non-blocking.
- Returns `childSessionKey` immediately.
- Stable for follow-up because the orchestrator minted the session.
- Best for starting PM or specialist conversations.
- Best for delegated work items like spec review.

### `sessions_send`

- Only reliable when targeting:
  - a `childSessionKey` created earlier by the orchestrator, or
  - a canonical persistent session key that is explicitly trusted by policy.
- Not appropriate as a discovery primitive.
- Best used only after a session binding exists in job state.

### Nested subagents

- Good for delegated work products.
- Poor fit for approval loops because announce is best-effort and semantically "work completed", not "decision pending".

### Bulletin

- Good for advisory multi-agent consultation.
- Wrong fit for single-owner plan approvals.

### Discord thread

- Highest-stability transport for human gates.
- Also the audit surface and visibility anchor.

## Recommended Transport Selection

| Event type | Owner | Preferred transport | Persistence | Timeout | Resume path | Session stability assumption |
|---|---|---|---|---|---|---|
| `plan.clarify.request.product` | PM | `sessions_spawn(thread=true, mode="session")` on first contact, then `sessions_send` | `plan-state.json`, `interactions/<id>.json`, PM `sessionKey`, thread id | Soft: 15m; escalate at 60m | PM reply arrives in spawned thread or via `sessions_send`; orchestrator records response and resumes planner | Stable only if orchestrator minted the PM session or has a verified canonical PM session key |
| `plan.clarify.request.specialist` | Specialist agent | `sessions_spawn(thread=true, mode="session")` on first contact, then `sessions_send` | `plan-state.json`, `interactions/<id>.json`, specialist `sessionKey`, thread id | Soft: 15m; escalate at 60m | Specialist reply recorded by orchestrator; planner resumes with resolved answer | Stable only if session was created by orchestrator or is canonical and verified |
| `plan.clarify.request.advisory` | Multi-agent advisory | Bulletin | `plan-state.json`, `interactions/<id>.json`, `bulletinId` | 3m to 10m | Bulletin closes or polling window ends; orchestrator synthesizes and resumes planner | No session stability assumption; bulletin id is the durable handle |
| `plan.approach.proposed` | PM | Directed PM session, never bulletin | `plan-state.json`, `approaches/<id>.json`, PM `sessionKey` | Soft: 30m; escalate to human after PM timeout | PM returns `approve`, `revise`, or `escalate`; orchestrator reruns or resumes planner | Requires stable PM conversation; `sessions_send` is valid only after session establishment |
| `plan.approach.decision` | Orchestrator | Internal control-plane update | `plan-state.json`, `interactions/<id>.json` | Immediate | Orchestrator invokes planner resume or rerun with decision payload | No session assumption |
| `plan.design.section.presented` | PM | Directed PM session | `plan-state.json`, `design-sections/<n>.json`, PM `sessionKey` | Soft: 30m per section | PM replies `approve`, `revise`, or `escalate`; orchestrator applies response and advances or reruns section | Requires stable PM conversation |
| `plan.design.section.escalation` | Human | Existing Discord PDCA thread + buttons/reply | `plan-state.json`, thread message id, `interactions/<id>.json` | Human-paced; remind at 24h | Human button/reply updates interaction record; orchestrator reruns or resumes planner | Thread id is the stable handle |
| `plan.spec.written` | Orchestrator | Internal state + thread notification | Spec path, commit sha, `plan-state.json` | Immediate | Dispatch spec review loop | No session assumption |
| `plan.spec.review.requested` | Reviewer subagent | Nested subagent run | `plan-state.json`, reviewer `runId`, `childSessionKey`, transcript path | 10m to 20m per round | Reviewer announce or `sessions_history` on child session yields findings; planner revises | Stable because orchestrator owns the spawned child and has the returned `childSessionKey` |
| `plan.spec.review.completed` | Orchestrator | Internal control-plane update | `spec-review/<round>.json`, `plan-state.json` | Immediate | If issues, rerun planner; if approved, advance to user review | No session assumption |
| `plan.spec.user_review.requested` | Human | Existing Discord PDCA thread + buttons/reply | Thread message id, `plan-state.json`, `interactions/<id>.json` | Human-paced; remind at 24h | Human approval/revision updates interaction record; orchestrator advances or reruns spec edits | Thread id is the stable handle |
| `plan.spec.user_review.completed` | Orchestrator | Internal control-plane update | `plan-state.json` | Immediate | Advance to `writing-plans` or rerun spec edits | No session assumption |
| `plan.write_plans.requested` | Planner | Internal skill transition in planner session | Result envelope, implementation plan path | Worker `maxTurns` bound | Planner writes implementation plan and returns phase artifact | No external transport required |
| `plan.completed` | Orchestrator | Thread summary + phase gate | Plan artifact path, state snapshot | Human-paced | Proceed to execute phase after approval | Thread id is the stable handle |

## Routing Policy

Use the transport matrix through an explicit routing layer, not a single question-routing table.

| Interaction class | Target | Transport |
|---|---|---|
| `clarify.product` | PM | directed session |
| `clarify.specialist` | domain specialist | directed session |
| `clarify.advisory` | multi-agent advisory group | bulletin |
| `approach_decision` | PM | directed session |
| `design_section_review` | PM | directed session |
| `design_section_escalation` | human | Discord thread |
| `spec_review` | reviewer subagent | nested subagent |
| `user_review_gate` | human | Discord thread |

## Failure Policy

### Directed session failures

If `sessions_send` fails:

1. Check `sessions.json` for the current binding.
2. If the binding is stale or missing, mint a fresh `sessions_spawn(thread=true, mode="session")`.
3. Re-send in the new session.
4. Update the binding in durable state.

### Bulletin timeout

If a bulletin times out:

1. Synthesize partial responses if any exist.
2. If synthesis is weak or empty, re-route to the single decision-maker:
   - PM for product/design ownership
   - human only for explicitly human-owned decisions

### Missing subagent announce

If a nested subagent finishes but no announce is delivered:

1. Recover via `sessions_history` using the persisted `childSessionKey`.
2. If transcript recovery fails, mark the interaction `unknown` and escalate.

## Recommended Default

The default stack for planning should be:

- Control plane: job-dir state plus envelope semantics
- Directed agent conversation: `sessions_spawn` first, `sessions_send` for follow-up
- Delegated work: nested subagent
- Advisory fanout: bulletin
- Human gate: Discord thread

This keeps approval loops directed, specialist questions targeted, and bulletin traffic limited to the cases where consensus or advisory synthesis is actually useful.
