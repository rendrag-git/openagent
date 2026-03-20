# OpenAgent Conversation Visibility Gate

Date: 2026-03-20
Branch: `main`
Related docs:
- `docs/plans/2026-03-13-openagent-sdk-integration-design.md`
- `docs/plans/2026-03-13-orchestrator-rewrite.md`
- `docs/plans/2026-03-16-plan-feedback-implementation-plan.md`

## Goal

Define the minimum visibility and proof requirements needed to call the rewritten OpenAgent-through-ACP path ready for orchestrator use on real issues.

## Context

OpenAgent is our integration of Anthropic's Agent SDK into OpenClaw so the delegated conversation can be handled by an agent instead of a human operator.

The ownership split should stay clean:

- orchestrator owns issue workflow semantics and decides whether to delegate to OpenAgent
- OpenAgent owns the delegated agent run and its conversation state
- `openagent-acp` is a transport adapter that exposes OpenAgent through ACP/OpenClaw session primitives
- OpenClaw core remains generic session infrastructure

The current system has already proved some upstream pieces:

- a real issue can cross the merged `orchestra-intake` gate and create an orchestrator job
- orchestrator can hand work into the OpenAgent ACP path
- the delegated run can reach a parked decision/feedback state

What is not yet acceptable as "ready" is visibility. Today, understanding the delegated run still requires piecing together sidecar state, job-local artifacts, and SDK internals.

## Readiness Gate

OpenAgent is not ready until one real handed-off issue can be followed end-to-end with full durable conversation visibility through the normal session surface.

Acceptance criteria:

1. Orchestrator linkage is explicit.
   The orchestrator job must point to the exact OpenAgent session key and runtime session identifier used for the delegated run.

2. The delegated prompt is visible.
   The prompt handed from orchestrator into OpenAgent must be inspectable without reading sidecar-only state files.

3. The OpenAgent conversation is visible.
   Every meaningful OpenAgent conversation turn for the delegated run must be inspectable through the normal session path, not hidden only in `~/.claude` internals or transient adapter logs.

4. Parked questions and answers are visible.
   If the OpenAgent run parks for PM or human feedback, the question, ownership, transport, answer, and resume event must all be inspectable from the same durable trail.

5. Session materialization uses the normal session surface.
   Routed delegated conversations should materialize into `~/.openclaw/agents/*/sessions` rather than requiring direct inspection of sidecar-local job state to find the live conversation.

6. Resume is proven.
   A real parked delegated run must resume from a real answer and continue the same run, rather than requiring manual replay or opaque out-of-band recovery.

7. Completion is visible.
   The final delegated outcome returned back to orchestrator must be inspectable and attributable to the same OpenAgent run.

8. One real issue proves the whole path.
   The gate is not met by synthetic-only tests. One real handed-off issue must exercise handoff, delegated conversation, park/resume if needed, and completion.

## Non-Goals

- moving issue workflow semantics into OpenAgent
- treating `openagent-acp` as the owner of orchestration policy
- requiring OpenClaw core changes unless a generic session primitive is actually missing
- declaring the outer issue writeback loop solved if only the delegated conversation is proven

## Verification Procedure

Use one real actionable issue that orchestrator decides to delegate to OpenAgent.

Required proof:

1. Capture the orchestrator job id and OpenAgent session id/session key at handoff time.
2. Inspect the delegated prompt in the normal session surface.
3. Follow the full delegated conversation as the agent works.
4. If the run parks, inspect the parked question, provide a real answer, and verify the same run resumes.
5. Inspect the final result handed back to orchestrator.
6. Confirm the investigation does not depend on sidecar-only files or SDK internals to reconstruct what happened.

## Open Questions

- What is the canonical place to expose OpenAgent turn history so it is visible through the normal session surface?
- Which identifiers should be treated as the stable cross-system linkage: orchestrator job id, ACP session key, SDK session id, or all three?
- Which parts of the current parked-session trail are temporary debugging artifacts that should disappear once the visibility path is complete?
