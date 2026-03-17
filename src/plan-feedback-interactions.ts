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

type EnvelopeOwner =
  | PlanActor
  | "PM"
  | "pm"
  | "user"
  | "human"
  | "advisory"
  | string;

type EnvelopeRouting =
  | Partial<InteractionRouting>
  | RoutingTransport
  | string;

type EnvelopeOption =
  | { id?: string; label?: string; summary?: string }
  | string;

interface PlanInteractionEnvelope {
  kind: InteractionKind;
  title?: string;
  prompt?: string;
  owner?: EnvelopeOwner;
  routing?: EnvelopeRouting;
  options?: EnvelopeOption[];
  recommendedOptionId?: string | null;
  resume?: Partial<InteractionResumeConfig>;
  timeouts?: Partial<InteractionTimeouts>;
  currentStep?: { kind?: string; label?: string } | string;
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

  const jsonPayload = extractFirstJSONObject(payload);
  if (!jsonPayload) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonPayload) as PlanInteractionEnvelope;
    return parsed?.kind ? parsed : null;
  } catch {
    return null;
  }
}

function extractFirstJSONObject(text: string): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }

    if (ch === "{") {
      depth += 1;
      continue;
    }

    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(0, i + 1);
      }
    }
  }

  return null;
}

function normalizeActor(owner: EnvelopeOwner | undefined, kind: InteractionKind): PlanActor | undefined {
  if (!owner) {
    return undefined;
  }

  if (typeof owner === "object" && owner !== null && "kind" in owner && "id" in owner) {
    const actor = owner as Partial<PlanActor>;
    if (
      (actor.kind === "agent" || actor.kind === "human" || actor.kind === "system")
      && typeof actor.id === "string"
    ) {
      return { kind: actor.kind, id: actor.id };
    }
  }

  const normalized = String(owner).trim().toLowerCase();
  if (normalized === "pm") {
    return { kind: "agent", id: "pm" };
  }
  if (normalized === "human" || normalized === "user") {
    return { kind: "human", id: "user" };
  }
  if (normalized === "advisory") {
    return { kind: "system", id: "advisory" };
  }

  return kind === "spec_user_review"
    ? { kind: "human", id: normalized || "user" }
    : { kind: "agent", id: normalized };
}

function normalizeRouting(
  routing: EnvelopeRouting | undefined,
): Partial<InteractionRouting> {
  if (!routing) {
    return {};
  }

  if (typeof routing === "string") {
    return { transport: routing as RoutingTransport };
  }

  return routing;
}

function normalizeOptions(options: EnvelopeOption[] | undefined) {
  if (!options) {
    return undefined;
  }

  return options.map((option, index) => {
    if (typeof option === "string") {
      return {
        id: option.trim().toLowerCase() || `option-${index + 1}`,
        label: option,
      };
    }

    const label = option.label ?? option.id ?? `Option ${index + 1}`;
    const normalizedId = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const resolvedId = option.id ?? normalizedId;
    return {
      id: resolvedId || `option-${index + 1}`,
      label,
      ...(option.summary ? { summary: option.summary } : {}),
    };
  });
}

function normalizeCurrentStep(
  kind: InteractionKind,
  currentStep: PlanInteractionEnvelope["currentStep"],
): { kind: string; label: string } | undefined {
  if (!currentStep) {
    return undefined;
  }

  if (typeof currentStep === "string") {
    return { kind: defaultStep(kind).kind, label: currentStep };
  }

  if (typeof currentStep.kind === "string" && typeof currentStep.label === "string") {
    return { kind: currentStep.kind, label: currentStep.label };
  }

  if (typeof currentStep.label === "string") {
    return { kind: defaultStep(kind).kind, label: currentStep.label };
  }

  return undefined;
}

export function hasStructuredPlanInteractionPrefix(input: AskUserQuestionInput): boolean {
  const questions = input.questions ?? [];
  const firstQuestion = questions.find((question) => typeof question?.question === "string");
  return firstQuestion?.question?.trim().startsWith(STRUCTURED_PREFIX) ?? false;
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
    normalizeActor(envelope.owner, envelope.kind),
    normalizeRouting(envelope.routing).targetAgentId,
  );
  const owner = normalizedPolicy.owner;
  const requestedRouting = normalizeRouting(envelope.routing);
  const routing: InteractionRouting = {
    transport: normalizedPolicy.transport,
    targetAgentId: normalizedPolicy.targetAgentId ?? (owner.kind === "agent" ? owner.id : null),
    sessionBindingId: requestedRouting.sessionBindingId ?? null,
    threadId: requestedRouting.threadId ?? null,
    bulletinId: requestedRouting.bulletinId ?? null,
    discordMessageId: requestedRouting.discordMessageId ?? null,
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
      options: normalizeOptions(envelope.options),
      recommendedOptionId: envelope.recommendedOptionId ?? null,
    },
    response: null,
    resolution: null,
    resume,
    timeouts,
  });

  return {
    interaction,
    currentStep: normalizeCurrentStep(envelope.kind, envelope.currentStep) ?? defaultStep(envelope.kind),
    rawQuestion,
  };
}

export function formatPlanInteractionInstruction(exampleTransport: string = "direct_session"): string {
  return (
    "For planning feedback loops, AskUserQuestion should carry a structured JSON envelope in the first question string. " +
    `The first question string must be ONLY the prefixed JSON envelope. Prefix it with ${STRUCTURED_PREFIX}. ` +
    "Do not add prose before or after it. " +
    "Use exact shapes: " +
    '"owner":{"kind":"agent","id":"pm"}, ' +
    '"routing":{"transport":"direct_session","targetAgentId":"pm"}, ' +
    '"currentStep":{"kind":"approach_decision","label":"Awaiting PM approach decision"}, ' +
    '"options":[{"id":"a","label":"Option A","summary":"..."}]. ' +
    `Use direct_session for clarify_product, clarify_specialist, approach_decision, and PM design_section_review. ` +
    'After an approach is approved, every design section approval gate must use AskUserQuestion with kind "design_section_review". ' +
    'Never write "awaiting your approval" or "before proceeding to Section X" in normal output. If approval is needed, emit the structured interaction and stop. ' +
    `Use bulletin only for clarify_advisory. Use discord_thread for human review or explicit human design escalation. ` +
    `Do not use bulletin for single-owner approvals or product decisions. Example preferred transport: ${exampleTransport}.`
  );
}
