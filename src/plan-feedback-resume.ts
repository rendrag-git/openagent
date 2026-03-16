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

function parseAnswer(interaction: PlanInteraction, answer: string): Record<string, unknown> {
  const trimmed = answer.trim();
  const options = interaction.request.options ?? [];
  const normalized = trimmed.toLowerCase();

  const matchedOption = options.find((option) => {
    const optionId = option.id.toLowerCase();
    const optionLabel = option.label.toLowerCase();
    const idPattern = new RegExp(`(?:^|\\b)(?:option\\s+)?${optionId}(?:\\b|$)`, "i");
    const labelPattern = new RegExp(`(?:^|\\b)${optionLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\b|$)`, "i");
    return normalized === optionId || normalized === optionLabel || idPattern.test(trimmed) || labelPattern.test(trimmed);
  });

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
  interaction.status = "resolved";
  interaction.updatedAt = receivedAt;
  await saveInteraction(jobDir, interaction);

  await appendPlanEvent(
    jobDir,
    createPlanEvent(interaction.jobId, "plan.interaction.response.recorded", {
      interactionId,
      response,
    }),
  );

  await appendPlanEvent(
    jobDir,
    createPlanEvent(interaction.jobId, "plan.interaction.resolved", {
      interactionId,
      resolution,
    }),
  );

  const state = await loadPlanState(jobDir);
  if (state) {
    state.activeInteractionId = null;
    state.activeOwner = null;
    state.status = "running_planner";
    state.currentStep = {
      kind: "resume_planner",
      label: "Resuming planner with interaction feedback",
    };
    state.planner.sdkSessionStatus = "resuming";
    state.updatedAt = receivedAt;
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
        resumePayload: resolution.resumePayload,
      }),
    );
  }

  return {
    interaction,
    state,
    response,
    resolution,
  };
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
    state.status = "failed";
    state.planner.sdkSessionStatus = "failed";
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
