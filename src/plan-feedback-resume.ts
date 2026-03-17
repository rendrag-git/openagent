import {
  appendPlanEvent,
  createPlanEvent,
  loadInteraction,
  loadPlanState,
  saveInteraction,
  savePlanState,
  type InteractionResolutionPayload,
  type InteractionResponsePayload,
  type PlanActor,
  type PlanInteraction,
  type PlanState,
} from "./plan-feedback.ts";

function now(): string {
  return new Date().toISOString();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scoreOptionMatch(interaction: PlanInteraction, optionId: string, optionLabel: string, answer: string): number {
  const normalizedAnswer = answer.toLowerCase();
  const escapedId = escapeRegExp(optionId);
  const escapedLabel = escapeRegExp(optionLabel);

  let score = 0;

  if (optionLabel && new RegExp(`\\b${escapedLabel}\\b`, "i").test(normalizedAnswer)) {
    score = Math.max(score, 100);
  }

  if (new RegExp(`(?:option|approach|choice)\\s+${escapedId}(?:\\b|$)`, "i").test(normalizedAnswer)) {
    score = Math.max(score, 90);
  }

  if (optionId.length > 1 && new RegExp(`(?:^|\\b)${escapedId}(?:\\b|$)`, "i").test(normalizedAnswer)) {
    score = Math.max(score, 40);
  }

  if (normalizedAnswer === optionId || normalizedAnswer === optionLabel) {
    score = Math.max(score, 110);
  }

  return score;
}

function parseAnswer(interaction: PlanInteraction, answer: string): Record<string, unknown> {
  const trimmed = answer.trim();
  const options = interaction.request.options ?? [];
  const matches = options
    .map((option) => ({
      option,
      score: scoreOptionMatch(interaction, option.id.toLowerCase(), option.label.toLowerCase(), trimmed),
    }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score);

  const matchedOption = matches[0]?.option;

  if (matchedOption) {
    return {
      answer: trimmed,
      decision: "provided",
      selectedOptionId: matchedOption.id,
    };
  }

  return { answer: trimmed };
}

function renderTemplate(template: string | undefined, answer: string, parsed: Record<string, unknown>): string {
  const fallback = answer.trim();
  if (!template) return fallback;

  return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, key) => {
    const value = parsed[key];
    return value == null || value === "" ? fallback : String(value);
  });
}

export interface RecordedInteractionAnswer {
  interaction: PlanInteraction;
  state: PlanState | null;
  response: InteractionResponsePayload;
  resolution: InteractionResolutionPayload;
}

export async function recordInteractionAnswer(
  jobDir: string,
  interactionId: string,
  answer: string,
  source: PlanActor = { kind: "agent", id: "orchestrator" },
): Promise<RecordedInteractionAnswer> {
  const interaction = await loadInteraction(jobDir, interactionId);
  if (!interaction) {
    throw new Error(`Unknown interaction: ${interactionId}`);
  }

  const receivedAt = now();
  const parsed = parseAnswer(interaction, answer);
  const response: InteractionResponsePayload = {
    receivedAt,
    source,
    transport: interaction.routing.transport,
    raw: answer,
    parsed,
  };

  const resolution: InteractionResolutionPayload = {
    resolvedAt: receivedAt,
    plannerFeedback: renderTemplate(interaction.resume.answerTemplate, answer, parsed),
    nextAction: "resume_planner",
    resumePayload: {
      mode: interaction.resume.mode,
      sdkSessionId: interaction.resume.sdkSessionId,
      answer: renderTemplate(interaction.resume.answerTemplate, answer, parsed),
      fallback: interaction.resume.fallback
        ? {
            mode: interaction.resume.fallback.mode,
            feedback: renderTemplate(interaction.resume.fallback.feedbackTemplate, answer, parsed),
          }
        : undefined,
    },
  };

  interaction.response = response;
  interaction.resolution = resolution;
  interaction.status = "response_recorded";
  interaction.updatedAt = receivedAt;
  await saveInteraction(jobDir, interaction);

  await appendPlanEvent(
    jobDir,
    createPlanEvent(interaction.jobId, "plan.interaction.response.recorded", {
      interactionId,
      response,
    }),
  );

  const state = await loadPlanState(jobDir);
  if (state) {
    state.currentStep = {
      kind: "resume_planner",
      label: "Resuming planner with interaction feedback",
    };
    state.planner.sdkSessionStatus = "resuming";
    state.updatedAt = receivedAt;
    await savePlanState(jobDir, state);
  }

  return {
    interaction,
    state,
    response,
    resolution,
  };
}

export async function completeInteractionResolution(
  jobDir: string,
  interactionId: string,
): Promise<void> {
  const interaction = await loadInteraction(jobDir, interactionId);
  if (!interaction || !interaction.resolution) {
    throw new Error(`Interaction is not ready to resolve: ${interactionId}`);
  }

  const resolvedAt = now();
  interaction.status = "resolved";
  interaction.updatedAt = resolvedAt;
  await saveInteraction(jobDir, interaction);

  await appendPlanEvent(
    jobDir,
    createPlanEvent(interaction.jobId, "plan.interaction.resolved", {
      interactionId,
      resolution: interaction.resolution,
    }),
  );

  const state = await loadPlanState(jobDir);
  if (state) {
    state.activeInteractionId = null;
    state.activeOwner = null;
    state.status = "running_planner";
    state.currentStep = {
      kind: "resume_planner",
      label: "Planner resumed with interaction feedback",
    };
    state.updatedAt = resolvedAt;
    await savePlanState(jobDir, state);

    await appendPlanEvent(
      jobDir,
      createPlanEvent(interaction.jobId, "plan.session.resumed", {
        planner: {
          sdkSessionId: interaction.resume.sdkSessionId,
          sdkSessionStatus: "resuming",
          resumeStrategy: state.planner.resumeStrategy,
        },
        interactionId,
        resumePayload: interaction.resolution.resumePayload,
      }),
    );
  }
}

export async function markResumeFailure(
  jobDir: string,
  interactionId: string,
  error: Error,
  fallbackApplied: boolean,
  fallbackMode?: string,
): Promise<void> {
  const interaction = await loadInteraction(jobDir, interactionId);
  if (!interaction) return;

  const state = await loadPlanState(jobDir);
  if (state) {
    state.planner.sdkSessionStatus = "failed";
    state.currentStep = {
      kind: "resume_failed",
      label: "Planner resume failed; interaction remains retryable",
    };
    state.updatedAt = now();
    await savePlanState(jobDir, state);
  }

  await appendPlanEvent(
    jobDir,
    createPlanEvent(interaction.jobId, "plan.session.resume_failed", {
      planner: {
        sdkSessionId: interaction.resume.sdkSessionId,
        sdkSessionStatus: "failed",
        resumeStrategy: interaction.resume.mode,
      },
      interactionId,
      error: {
        message: error.message,
        fallbackApplied,
        fallbackMode,
      },
    }),
  );
}
