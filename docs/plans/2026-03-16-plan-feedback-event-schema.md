# Plan Feedback Event Schema

**Goal:** Define the durable JSON contract for plan-phase interactions between the planner, orchestrator, specialist agents, reviewer subagents, bulletin board, and human gates.

**Architecture:** Use append-only events plus materialized state. The canonical source of truth for a job is the job directory under `~/.openclaw/openagent/jobs/<jobId>/`. Every transport-specific interaction resolves into the same durable schema so the orchestrator can recover after restarts and resume planning deterministically.

## Schema Version

All persisted plan-feedback artifacts use:

```json
{
  "schemaVersion": "2026-03-16.plan-feedback.v1"
}
```

If the contract changes incompatibly, bump the version string and migrate state explicitly.

## Job Directory Layout

```text
~/.openclaw/openagent/jobs/<jobId>/
  plan-state.json
  sessions.json
  events/
    0001-plan.run.started.json
    0002-plan.interaction.requested.json
    ...
  interactions/
    pi_<id>.json
  design-sections/
    section-01.json
    section-02.json
  approaches/
    approach-01.json
  spec-review/
    round-01.json
    round-02.json
```

## Canonical Event Envelope

Every event persisted under `events/` uses this envelope:

```json
{
  "schemaVersion": "2026-03-16.plan-feedback.v1",
  "eventId": "evt_01jxyz...",
  "eventType": "plan.interaction.requested",
  "jobId": "2026-03-16-add-routing",
  "phase": "plan",
  "createdAt": "2026-03-16T18:05:10.000Z",
  "actor": {
    "kind": "planner",
    "id": "openagent.plan"
  },
  "correlationId": "pi_01jxyz...",
  "causationId": "evt_01jxyw...",
  "payload": {}
}
```

### Envelope Fields

| Field | Meaning |
|---|---|
| `schemaVersion` | Contract version for all persisted artifacts |
| `eventId` | Unique id for this event |
| `eventType` | Fully-qualified event name |
| `jobId` | PDCA job id |
| `phase` | Always `plan` for this contract |
| `createdAt` | ISO timestamp |
| `actor.kind` | `planner`, `orchestrator`, `agent`, `reviewer`, `bulletin`, `human`, or `system` |
| `actor.id` | Concrete actor identifier |
| `correlationId` | Usually the `interactionId`, `reviewId`, or logical work item id |
| `causationId` | Prior event that directly caused this event, if any |
| `payload` | Event-specific body |

## Materialized State Files

### `plan-state.json`

This is the current snapshot the orchestrator uses for recovery and routing.

```json
{
  "schemaVersion": "2026-03-16.plan-feedback.v1",
  "jobId": "2026-03-16-add-routing",
  "phase": "plan",
  "status": "awaiting_pm_design_section_review",
  "planner": {
    "mode": "brainstorming",
    "sdkSessionId": "sess_01jxyz...",
    "sdkSessionStatus": "parked",
    "resumeStrategy": "sdk_resume",
    "lastPlannerResultPath": "plan.json"
  },
  "activeInteractionId": "pi_01jxyz...",
  "activeOwner": {
    "kind": "agent",
    "id": "pm"
  },
  "currentStep": {
    "kind": "design_section_review",
    "label": "Architecture section"
  },
  "spec": {
    "path": null,
    "commitSha": null,
    "reviewStatus": "not_started",
    "userReviewStatus": "not_started"
  },
  "implementationPlan": {
    "path": null,
    "status": "not_started"
  },
  "counters": {
    "clarificationsResolved": 0,
    "designSectionsApproved": 0,
    "specReviewRounds": 0
  },
  "updatedAt": "2026-03-16T18:05:10.000Z"
}
```

### Planner Session Fields

| Field | Meaning |
|---|---|
| `planner.sdkSessionId` | Anthropic Agent SDK session id for the current planner run |
| `planner.sdkSessionStatus` | `active`, `parked`, `resuming`, `completed`, or `failed` |
| `planner.resumeStrategy` | `inline_wait`, `sdk_resume`, or `rerun_with_feedback` |
| `planner.lastPlannerResultPath` | Last planner result envelope written to disk |

`sdk_resume` is the preferred strategy for long-lived or asynchronous approval loops. `rerun_with_feedback` remains available as a fallback when native session resume is not available or has already been invalidated.

### `sessions.json`

Stores stable directed-session bindings for the current job.

```json
{
  "schemaVersion": "2026-03-16.plan-feedback.v1",
  "jobId": "2026-03-16-add-routing",
  "bindings": {
    "pm": {
      "bindingId": "sb_pm_01jxyz",
      "ownerId": "pm",
      "transport": "sessions_spawn",
      "sessionKey": "agent:pm:subagent:1234-5678",
      "threadId": "channel:1473797645154910382:thread:abc",
      "createdAt": "2026-03-16T18:07:00.000Z",
      "lastUsedAt": "2026-03-16T18:11:00.000Z",
      "status": "active",
      "stability": "owned_child_session"
    }
  }
}
```

### `interactions/<interactionId>.json`

Stores the durable state of a single plan interaction.

```json
{
  "schemaVersion": "2026-03-16.plan-feedback.v1",
  "interactionId": "pi_01jxyz...",
  "jobId": "2026-03-16-add-routing",
  "phase": "plan",
  "kind": "approach_decision",
  "status": "awaiting_response",
  "owner": {
    "kind": "agent",
    "id": "pm"
  },
  "routing": {
    "transport": "direct_session",
    "targetAgentId": "pm",
    "sessionBindingId": "sb_pm_01jxyz",
    "threadId": "channel:1473797645154910382:thread:abc",
    "bulletinId": null,
    "discordMessageId": null
  },
  "request": {
    "title": "Choose implementation approach",
    "prompt": "Select one of these approaches for the planner to continue.",
    "options": [
      { "id": "a", "label": "Thin router", "summary": "..." },
      { "id": "b", "label": "Interaction dispatcher", "summary": "..." },
      { "id": "c", "label": "Embedded router", "summary": "..." }
    ],
    "recommendedOptionId": "b"
  },
  "response": null,
  "resolution": null,
  "resume": {
    "mode": "sdk_resume",
    "target": "openagent.plan",
    "sdkSessionId": "sess_01jxyz...",
    "answerTemplate": "Approach decision: {{decision}}. Rationale: {{rationale}}",
    "fallback": {
      "mode": "rerun_with_feedback",
      "feedbackTemplate": "Approach decision: {{decision}}. Rationale: {{rationale}}"
    }
  },
  "timeouts": {
    "softSeconds": 1800,
    "hardSeconds": 3600
  },
  "createdAt": "2026-03-16T18:05:10.000Z",
  "updatedAt": "2026-03-16T18:05:10.000Z"
}
```

## Interaction Kinds

Valid `interaction.kind` values:

- `clarify_product`
- `clarify_specialist`
- `clarify_advisory`
- `approach_decision`
- `design_section_review`
- `design_section_escalation`
- `spec_review_request`
- `spec_user_review`

Valid `interaction.status` values:

- `requested`
- `routed`
- `awaiting_response`
- `response_recorded`
- `resolved`
- `timed_out`
- `escalated`
- `cancelled`

## Request Payload Shapes

### Clarification Request

```json
{
  "title": "Clarify data ownership",
  "prompt": "Should this feature treat archived records as visible in search results?",
  "questionType": "single_question",
  "expects": {
    "kind": "text_or_enum",
    "options": ["yes", "no", "depends"]
  },
  "contextSummary": "Planner is defining search behavior for archived records."
}
```

### Approach Decision Request

```json
{
  "title": "Choose approach",
  "prompt": "Pick one approach for the planner to continue with.",
  "options": [
    {
      "id": "a",
      "label": "Minimal patch",
      "summary": "Keep current bulletin path and add routing branches."
    },
    {
      "id": "b",
      "label": "Interaction dispatcher",
      "summary": "Add explicit event kinds and transport routing."
    }
  ],
  "recommendedOptionId": "b"
}
```

### Design Section Review Request

```json
{
  "title": "Review design section: Architecture",
  "sectionKey": "architecture",
  "sectionOrder": 1,
  "content": "The planner proposes an orchestrator-owned interaction router...",
  "approvalPrompt": "Approve, revise, or escalate this section."
}
```

### Spec User Review Request

```json
{
  "title": "Review written spec",
  "specPath": "docs/superpowers/specs/2026-03-16-routing-design.md",
  "commitSha": "abc1234",
  "prompt": "Please review the written spec before the planner transitions to writing-plans."
}
```

## Response Payload Shapes

All responses recorded in `interaction.response` use:

```json
{
  "receivedAt": "2026-03-16T18:20:00.000Z",
  "source": {
    "kind": "agent",
    "id": "pm"
  },
  "transport": "direct_session",
  "raw": "Approve option b. Keep bulletin only for advisory traffic.",
  "parsed": {}
}
```

### Parsed Approach Decision

```json
{
  "decision": "approve",
  "selectedOptionId": "b",
  "rationale": "This gives the cleanest long-term contract.",
  "needsHuman": false
}
```

### Parsed Design Section Review

```json
{
  "decision": "revise",
  "revisionNotes": "Separate PM approval transport from specialist clarifications.",
  "needsHuman": false
}
```

### Parsed Escalation Response

```json
{
  "decision": "escalate",
  "reason": "PM is uncertain about ownership and wants human confirmation.",
  "needsHuman": true
}
```

## Resolution Payload Shape

`interaction.resolution` is the normalized planner-facing answer.

```json
{
  "resolvedAt": "2026-03-16T18:21:00.000Z",
  "status": "resolved",
  "plannerFeedback": "PM approved approach b. Keep bulletin for advisory-only questions.",
  "nextAction": "resume_planner",
  "resumePayload": {
    "mode": "sdk_resume",
    "sdkSessionId": "sess_01jxyz...",
    "answer": "PM approved approach b. Keep bulletin for advisory-only questions.",
    "fallback": {
      "mode": "rerun_with_feedback",
      "feedback": "PM approved approach b. Keep bulletin for advisory-only questions."
    }
  }
}
```

## Event Types

These are the canonical event types for the contract.

### Lifecycle

- `plan.run.started`
- `plan.run.completed`
- `plan.completed`

### Interaction lifecycle

- `plan.interaction.requested`
- `plan.interaction.routed`
- `plan.interaction.response.recorded`
- `plan.interaction.resolved`
- `plan.interaction.timed_out`
- `plan.interaction.escalated`

### Session bindings

- `plan.session.bound`
- `plan.session.rebound`
- `plan.session.invalidated`
- `plan.session.parked`
- `plan.session.resumed`
- `plan.session.resume_failed`

### Spec lifecycle

- `plan.spec.written`
- `plan.spec.review.requested`
- `plan.spec.review.completed`
- `plan.spec.user_review.requested`
- `plan.spec.user_review.completed`
- `plan.implementation_plan.written`

## Event Payloads

### `plan.interaction.requested`

```json
{
  "interaction": {
    "interactionId": "pi_01jxyz...",
    "kind": "approach_decision",
    "owner": { "kind": "agent", "id": "pm" },
    "request": {
      "title": "Choose approach",
      "options": [
        { "id": "a", "label": "..." },
        { "id": "b", "label": "..." }
      ],
      "recommendedOptionId": "b"
    },
    "resume": {
      "mode": "sdk_resume",
      "sdkSessionId": "sess_01jxyz...",
      "fallback": {
        "mode": "rerun_with_feedback"
      }
    }
  }
}
```

### `plan.interaction.routed`

```json
{
  "interactionId": "pi_01jxyz...",
  "routing": {
    "transport": "direct_session",
    "targetAgentId": "pm",
    "sessionBindingId": "sb_pm_01jxyz",
    "threadId": "channel:1473797645154910382:thread:abc"
  }
}
```

### `plan.interaction.response.recorded`

```json
{
  "interactionId": "pi_01jxyz...",
  "response": {
    "receivedAt": "2026-03-16T18:20:00.000Z",
    "source": { "kind": "agent", "id": "pm" },
    "transport": "direct_session",
    "raw": "Approve option b",
    "parsed": {
      "decision": "approve",
      "selectedOptionId": "b"
    }
  }
}
```

### `plan.interaction.resolved`

```json
{
  "interactionId": "pi_01jxyz...",
  "resolution": {
    "resolvedAt": "2026-03-16T18:21:00.000Z",
    "plannerFeedback": "PM approved option b.",
    "nextAction": "resume_planner",
    "resumePayload": {
      "mode": "sdk_resume",
      "sdkSessionId": "sess_01jxyz...",
      "answer": "PM approved option b.",
      "fallback": {
        "mode": "rerun_with_feedback",
        "feedback": "PM approved option b."
      }
    }
  }
}
```

### `plan.session.bound`

```json
{
  "binding": {
    "bindingId": "sb_pm_01jxyz",
    "ownerId": "pm",
    "transport": "sessions_spawn",
    "sessionKey": "agent:pm:subagent:1234-5678",
    "threadId": "channel:1473797645154910382:thread:abc",
    "stability": "owned_child_session"
  }
}
```

### `plan.session.parked`

```json
{
  "planner": {
    "sdkSessionId": "sess_01jxyz...",
    "sdkSessionStatus": "parked",
    "resumeStrategy": "sdk_resume"
  },
  "interactionId": "pi_01jxyz..."
}
```

### `plan.session.resumed`

```json
{
  "planner": {
    "sdkSessionId": "sess_01jxyz...",
    "sdkSessionStatus": "resuming",
    "resumeStrategy": "sdk_resume"
  },
  "interactionId": "pi_01jxyz...",
  "resumePayload": {
    "mode": "sdk_resume",
    "answer": "PM approved option b."
  }
}
```

### `plan.session.resume_failed`

```json
{
  "planner": {
    "sdkSessionId": "sess_01jxyz...",
    "sdkSessionStatus": "failed",
    "resumeStrategy": "sdk_resume"
  },
  "interactionId": "pi_01jxyz...",
  "error": {
    "message": "Session not found",
    "fallbackApplied": true,
    "fallbackMode": "rerun_with_feedback"
  }
}
```

### `plan.spec.review.completed`

```json
{
  "reviewId": "sr_01jxyz...",
  "round": 2,
  "status": "issues_found",
  "childSessionKey": "agent:reviewer:subagent:abcd",
  "findingsPath": "spec-review/round-02.json",
  "summary": "Reviewer flagged missing escalation semantics for PM uncertainty."
}
```

## Review State Shape

`spec-review/<round>.json`:

```json
{
  "schemaVersion": "2026-03-16.plan-feedback.v1",
  "reviewId": "sr_01jxyz...",
  "jobId": "2026-03-16-add-routing",
  "round": 2,
  "reviewer": {
    "agentId": "spec-reviewer",
    "runId": "run_123",
    "childSessionKey": "agent:spec-reviewer:subagent:abcd"
  },
  "status": "issues_found",
  "summary": "Reviewer flagged missing escalation semantics for PM uncertainty.",
  "findings": [
    {
      "id": "finding_01",
      "severity": "medium",
      "title": "Missing PM uncertainty path",
      "details": "Design section review does not specify the human escalation rule."
    }
  ],
  "createdAt": "2026-03-16T18:30:00.000Z",
  "completedAt": "2026-03-16T18:34:00.000Z"
}
```

## Recovery Rules

On restart, the orchestrator should:

1. Load `plan-state.json`.
2. Load `sessions.json`.
3. Scan `interactions/` for any item with status:
   - `awaiting_response`
   - `response_recorded`
   - `escalated`
4. Reconcile against the last event in `events/`.
5. Resume routing or planner execution from the materialized state, not from transport guesswork.

If `planner.resumeStrategy === "sdk_resume"` and `planner.sdkSessionStatus === "parked"`, the orchestrator should attempt native SDK session resume first. If resume fails, it may fall back to `rerun_with_feedback` only if the active interaction's `resume.fallback` contract is present.

## Contract Summary

This schema makes the planner/orchestrator contract explicit:

- the planner emits structured interaction requests
- the orchestrator routes by owner and transport
- all transport outcomes normalize into durable `response` and `resolution` payloads
- planner resume always happens from `resolution.resumePayload`
- native Anthropic session resume is the preferred path for asynchronous gates
- rerun-with-feedback is an explicit fallback path, not an implicit default

Once this contract is stable, transport-specific implementation becomes mechanical.
