import { randomUUID } from "node:crypto";
import type {
  InteractionKind,
  InteractionResumeConfig,
  InteractionRouting,
  InteractionTimeouts,
  PlanActor,
  PlanInteraction,
  PlanWorkflowStatus,
  RoutingTransport,
} from "./plan-feedback.ts";
import { createInteraction } from "./plan-feedback.ts";

const STRUCTURED_PREFIX = "OPENAGENT_PLAN_INTERACTION:";

interface AskUserQuestionInput {
  questions?: Array<{ question?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface PlanInteractionEnvelope {
  kind: InteractionKind;
  title?: string;
  prompt?: string;
  owner?: PlanActor;
  routing?: Partial<InteractionRouting>;
  options?: Array<{ id: string; label: string; summary?: string }>;
  recommendedOptionId?: string | null;
  resume?: Partial<InteractionResumeConfig>;
  timeouts?: Partial<InteractionTimeouts>;
  currentStep?: {
    kind: string;
    label: string;
  };
}

interface NormalizedInteractionPolicy {
  owner: PlanActor;
  transport: RoutingTransport;
  targetAgentId: string | null;
}

export interface ParsedPlanInteraction {
  interaction: PlanInteraction;
  currentStep: {
    kind: string;
    label: string;
  };
  rawQuestion: string;
}

function parseQuestionText(text: string): PlanInteractionEnvelope | null {
  const trimmed = text.trim();
  const payload = trimmed.startsWith(STRUCTURED_PREFIX)
    ? trimmed.slice(STRUCTURED_PREFIX.length).trim()
    : trimmed;

  if (!payload.startsWith("{")) {
    return null;
  }

  try {
    const parsed = JSON.parse(payload) as PlanInteractionEnvelope;
    return parsed?.kind ? parsed : null;
  } catch {
    return null;
  }
}

function defaultOwner(kind: InteractionKind): PlanActor {
  switch (kind) {
    case "spec_user_review":
      return { kind: "human", id: "user" };
    case "clarify_advisory":
      return { kind: "system", id: "advisory" };
    default:
      return { kind: "agent", id: "pm" };
  }
}

function normalizeInteractionPolicy(
  kind: InteractionKind,
  requestedOwner: PlanActor | undefined,
  requestedTargetAgentId: string | null | undefined,
): NormalizedInteractionPolicy {
  switch (kind) {
    case "clarify_advisory":
      return {
        owner: { kind: "system", id: "advisory" },
        transport: "bulletin",
        targetAgentId: "advisory",
      };
    case "clarify_product":
      return {
        owner: { kind: "agent", id: "pm" },
        transport: "direct_session",
        targetAgentId: "pm",
      };
    case "approach_decision":
      return {
        owner: { kind: "agent", id: "pm" },
        transport: "direct_session",
        targetAgentId: "pm",
      };
    case "clarify_specialist": {
      const owner = requestedOwner?.kind === "agent"
        ? requestedOwner
        : defaultOwner(kind);
      return {
        owner,
        transport: "direct_session",
        targetAgentId: requestedTargetAgentId ?? owner.id,
      };
    }
    case "design_section_review": {
      if (requestedOwner?.kind === "human") {
        return {
          owner: requestedOwner,
          transport: "discord_thread",
          targetAgentId: null,
        };
      }
      const owner = requestedOwner?.kind === "agent"
        ? requestedOwner
        : defaultOwner(kind);
      return {
        owner,
        transport: "direct_session",
        targetAgentId: requestedTargetAgentId ?? owner.id,
      };
    }
    case "spec_user_review":
      return {
        owner: { kind: "human", id: "user" },
        transport: "discord_thread",
        targetAgentId: null,
      };
  }
}

function defaultTimeouts(kind: InteractionKind): InteractionTimeouts {
  switch (kind) {
    case "clarify_product":
    case "clarify_specialist":
      return { softSeconds: 900, hardSeconds: 3600 };
    case "clarify_advisory":
      return { softSeconds: 180, hardSeconds: 600 };
    case "spec_user_review":
      return { softSeconds: 86400, hardSeconds: 172800 };
    default:
      return { softSeconds: 1800, hardSeconds: 3600 };
  }
}

function defaultTitle(kind: InteractionKind): string {
  switch (kind) {
    case "clarify_product":
      return "Clarify product requirement";
    case "clarify_specialist":
      return "Clarify specialist question";
    case "clarify_advisory":
      return "Request advisory input";
    case "approach_decision":
      return "Choose implementation approach";
    case "design_section_review":
      return "Review design section";
    case "spec_user_review":
      return "Review plan spec";
  }
}

function defaultStep(kind: InteractionKind): { kind: string; label: string } {
  switch (kind) {
    case "clarify_product":
      return { kind: "clarify_product", label: "Awaiting PM clarification" };
    case "clarify_specialist":
      return { kind: "clarify_specialist", label: "Awaiting specialist clarification" };
    case "clarify_advisory":
      return { kind: "clarify_advisory", label: "Awaiting advisory input" };
    case "approach_decision":
      return { kind: "approach_decision", label: "Awaiting PM approach decision" };
    case "design_section_review":
      return { kind: "design_section_review", label: "Awaiting design section review" };
    case "spec_user_review":
      return { kind: "spec_user_review", label: "Awaiting user spec review" };
  }
}

export function getWorkflowStatusForInteraction(
  kind: InteractionKind,
  owner: PlanActor,
): PlanWorkflowStatus {
  switch (kind) {
    case "clarify_product":
      return "awaiting_pm_clarification";
    case "clarify_specialist":
      return "awaiting_specialist_clarification";
    case "clarify_advisory":
      return "awaiting_advisory_bulletin";
    case "approach_decision":
      return "awaiting_pm_approach_decision";
    case "design_section_review":
      return owner.kind === "human"
        ? "awaiting_human_design_escalation"
        : "awaiting_pm_design_section_review";
    case "spec_user_review":
      return "awaiting_user_spec_review";
  }
}

export function parseStructuredPlanInteraction(
  input: AskUserQuestionInput,
  jobId: string,
): ParsedPlanInteraction | null {
  const questions = input.questions ?? [];
  const firstQuestion = questions.find((question) => typeof question?.question === "string");
  const rawQuestion = firstQuestion?.question?.trim();
  if (!rawQuestion) return null;

  const envelope = parseQuestionText(rawQuestion);
  if (!envelope) return null;

  const normalizedPolicy = normalizeInteractionPolicy(
    envelope.kind,
    envelope.owner,
    envelope.routing?.targetAgentId,
  );
  const owner = normalizedPolicy.owner;
  const routing: InteractionRouting = {
    transport: normalizedPolicy.transport,
    targetAgentId: normalizedPolicy.targetAgentId ?? (owner.kind === "agent" ? owner.id : null),
    sessionBindingId: envelope.routing?.sessionBindingId ?? null,
    threadId: envelope.routing?.threadId ?? null,
    bulletinId: envelope.routing?.bulletinId ?? null,
    discordMessageId: envelope.routing?.discordMessageId ?? null,
  };
  const timeouts = {
    ...defaultTimeouts(envelope.kind),
    ...(envelope.timeouts ?? {}),
  };
  const resume: InteractionResumeConfig = {
    mode: envelope.resume?.mode ?? "sdk_resume",
    target: envelope.resume?.target ?? "openagent.plan",
    sdkSessionId: envelope.resume?.sdkSessionId ?? null,
    answerTemplate: envelope.resume?.answerTemplate,
    fallback: envelope.resume?.fallback,
  };

  const interaction = createInteraction(jobId, {
    interactionId: `pi_${randomUUID()}`,
    kind: envelope.kind,
    status: "awaiting_response",
    owner,
    routing,
    request: {
      title: envelope.title ?? defaultTitle(envelope.kind),
      prompt: envelope.prompt,
      options: envelope.options,
      recommendedOptionId: envelope.recommendedOptionId ?? null,
    },
    response: null,
    resolution: null,
    resume,
    timeouts,
  });

  return {
    interaction,
    currentStep: envelope.currentStep ?? defaultStep(envelope.kind),
    rawQuestion,
  };
}

export function formatPlanInteractionInstruction(exampleTransport: string = "direct_session"): string {
  return (
    "For planning feedback loops, AskUserQuestion should carry a structured JSON envelope in the first question string. " +
    `Prefix it with ${STRUCTURED_PREFIX} and include kind, title, prompt, owner, routing, currentStep, and any options. ` +
    `Use direct_session for clarify_product, clarify_specialist, approach_decision, and PM design_section_review. ` +
    `Use bulletin only for clarify_advisory. Use discord_thread for human review or explicit human design escalation. ` +
    `Do not use bulletin for single-owner approvals or product decisions. Example preferred transport: ${exampleTransport}.`
  );
}
