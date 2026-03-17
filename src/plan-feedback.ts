import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const PLAN_FEEDBACK_SCHEMA_VERSION = "2026-03-16.plan-feedback.v1";

export type PlannerSessionStatus =
  | "active"
  | "parked"
  | "resuming"
  | "completed"
  | "failed";

export type PlannerResumeStrategy =
  | "inline_wait"
  | "sdk_resume"
  | "rerun_with_feedback";

export type PlanWorkflowStatus =
  | "idle"
  | "running_planner"
  | "routing_interaction"
  | "awaiting_pm_clarification"
  | "awaiting_specialist_clarification"
  | "awaiting_advisory_bulletin"
  | "awaiting_pm_approach_decision"
  | "awaiting_pm_design_section_review"
  | "awaiting_human_design_escalation"
  | "writing_spec"
  | "awaiting_spec_review"
  | "processing_spec_review"
  | "awaiting_user_spec_review"
  | "writing_implementation_plan"
  | "plan_complete"
  | "failed";

export type ReviewStatus =
  | "not_started"
  | "requested"
  | "issues_found"
  | "approved";

export type UserReviewStatus =
  | "not_started"
  | "requested"
  | "changes_requested"
  | "approved";

export type ImplementationPlanStatus =
  | "not_started"
  | "in_progress"
  | "written";

export type InteractionKind =
  | "clarify_product"
  | "clarify_specialist"
  | "clarify_advisory"
  | "approach_decision"
  | "design_section_review"
  | "spec_user_review";

export type InteractionStatus =
  | "draft"
  | "requested"
  | "routed"
  | "awaiting_response"
  | "response_recorded"
  | "resolved"
  | "timed_out"
  | "escalated"
  | "closed";

export type RoutingTransport =
  | "direct_session"
  | "bulletin"
  | "discord_thread"
  | "subagent_review"
  | "internal";

export type SessionBindingTransport = "sessions_spawn" | "sessions_send";

export type SessionBindingStatus = "active" | "stale" | "invalidated" | "closed";

export type SessionStability =
  | "owned_child_session"
  | "canonical_session"
  | "ad_hoc_session";

export type EventActorKind = "system" | "orchestrator" | "agent" | "human";

export type EventOwnerKind = "agent" | "human" | "system";

export type PlanEventType =
  | "plan.run.started"
  | "plan.run.completed"
  | "plan.completed"
  | "plan.interaction.requested"
  | "plan.interaction.routed"
  | "plan.interaction.response.recorded"
  | "plan.interaction.resolved"
  | "plan.interaction.closed"
  | "plan.interaction.timed_out"
  | "plan.interaction.escalated"
  | "plan.session.bound"
  | "plan.session.rebound"
  | "plan.session.invalidated"
  | "plan.session.parked"
  | "plan.session.resumed"
  | "plan.session.resume_failed"
  | "plan.spec.written"
  | "plan.spec.review.requested"
  | "plan.spec.review.completed"
  | "plan.spec.user_review.requested"
  | "plan.spec.user_review.completed"
  | "plan.implementation_plan.written";

export interface PlanActor {
  kind: EventOwnerKind;
  id: string;
}

export interface PlannerState {
  mode: string;
  sdkSessionId: string | null;
  sdkSessionStatus: PlannerSessionStatus;
  resumeStrategy: PlannerResumeStrategy;
  lastPlannerResultPath: string | null;
}

export interface PlanStep {
  kind: string;
  label: string;
}

export interface PlanSpecState {
  path: string | null;
  commitSha: string | null;
  reviewStatus: ReviewStatus;
  userReviewStatus: UserReviewStatus;
}

export interface ImplementationPlanState {
  path: string | null;
  status: ImplementationPlanStatus;
}

export interface PlanCounters {
  clarificationsResolved: number;
  designSectionsApproved: number;
  specReviewRounds: number;
}

export interface PlanState {
  schemaVersion: typeof PLAN_FEEDBACK_SCHEMA_VERSION;
  jobId: string;
  phase: "plan";
  status: PlanWorkflowStatus;
  planner: PlannerState;
  activeInteractionId: string | null;
  activeOwner: PlanActor | null;
  currentStep: PlanStep | null;
  spec: PlanSpecState;
  implementationPlan: ImplementationPlanState;
  counters: PlanCounters;
  updatedAt: string;
}

export interface SessionBinding {
  bindingId: string;
  ownerId: string;
  transport: SessionBindingTransport;
  sessionKey: string;
  threadId: string | null;
  createdAt: string;
  lastUsedAt: string;
  status: SessionBindingStatus;
  stability: SessionStability;
}

export interface SessionBindingsFile {
  schemaVersion: typeof PLAN_FEEDBACK_SCHEMA_VERSION;
  jobId: string;
  bindings: Record<string, SessionBinding>;
}

export interface InteractionOption {
  id: string;
  label: string;
  summary?: string;
}

export interface InteractionRequestPayload {
  title: string;
  prompt?: string;
  options?: InteractionOption[];
  recommendedOptionId?: string | null;
  [key: string]: unknown;
}

export interface InteractionResponsePayload {
  receivedAt: string;
  source: PlanActor;
  transport: RoutingTransport;
  raw: string;
  parsed?: Record<string, unknown>;
}

export interface InteractionResolutionPayload {
  resolvedAt: string;
  plannerFeedback: string;
  nextAction: string;
  resumePayload?: Record<string, unknown>;
}

export interface InteractionResumeFallback {
  mode: "rerun_with_feedback";
  feedbackTemplate: string;
}

export interface InteractionResumeConfig {
  mode: PlannerResumeStrategy;
  target: string;
  sdkSessionId?: string | null;
  answerTemplate?: string;
  fallback?: InteractionResumeFallback;
}

export interface InteractionRouting {
  transport: RoutingTransport;
  targetAgentId?: string | null;
  sessionBindingId?: string | null;
  threadId?: string | null;
  bulletinId?: string | null;
  discordMessageId?: string | null;
}

export interface InteractionTimeouts {
  softSeconds: number;
  hardSeconds: number;
}

export interface PlanInteraction {
  schemaVersion: typeof PLAN_FEEDBACK_SCHEMA_VERSION;
  interactionId: string;
  jobId: string;
  phase: "plan";
  kind: InteractionKind;
  status: InteractionStatus;
  owner: PlanActor;
  routing: InteractionRouting;
  request: InteractionRequestPayload;
  response: InteractionResponsePayload | null;
  resolution: InteractionResolutionPayload | null;
  resume: InteractionResumeConfig;
  timeouts: InteractionTimeouts;
  createdAt: string;
  updatedAt: string;
}

export interface PlanEvent<TPayload = Record<string, unknown>> {
  schemaVersion: typeof PLAN_FEEDBACK_SCHEMA_VERSION;
  eventId: string;
  eventType: PlanEventType;
  jobId: string;
  phase: "plan";
  createdAt: string;
  actor: {
    kind: EventActorKind;
    id: string;
  };
  correlationId?: string | null;
  causationId?: string | null;
  payload: TPayload;
}

export interface PlanFeedbackPaths {
  planState: string;
  sessions: string;
  eventsDir: string;
  interactionsDir: string;
  dispatchesDir: string;
  designSectionsDir: string;
  approachesDir: string;
  specReviewDir: string;
}

export type DispatchStatus =
  | "pending"
  | "sent"
  | "awaiting_external_response"
  | "failed";

export interface DispatchArtifact {
  schemaVersion: typeof PLAN_FEEDBACK_SCHEMA_VERSION;
  dispatchId: string;
  jobId: string;
  interactionId: string;
  transport: RoutingTransport;
  action: string;
  status: DispatchStatus;
  target: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function now(): string {
  return new Date().toISOString();
}

function safeTimestamp(isoTimestamp: string): string {
  return isoTimestamp.replace(/[-:.]/g, "").replace("T", "T").replace("Z", "Z");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function getPlanFeedbackPaths(jobDir: string): PlanFeedbackPaths {
  return {
    planState: path.join(jobDir, "plan-state.json"),
    sessions: path.join(jobDir, "sessions.json"),
    eventsDir: path.join(jobDir, "events"),
    interactionsDir: path.join(jobDir, "interactions"),
    dispatchesDir: path.join(jobDir, "dispatches"),
    designSectionsDir: path.join(jobDir, "design-sections"),
    approachesDir: path.join(jobDir, "approaches"),
    specReviewDir: path.join(jobDir, "spec-review"),
  };
}

export async function ensurePlanFeedbackDirs(jobDir: string): Promise<PlanFeedbackPaths> {
  const paths = getPlanFeedbackPaths(jobDir);
  await Promise.all([
    fs.mkdir(paths.eventsDir, { recursive: true }),
    fs.mkdir(paths.interactionsDir, { recursive: true }),
    fs.mkdir(paths.dispatchesDir, { recursive: true }),
    fs.mkdir(paths.designSectionsDir, { recursive: true }),
    fs.mkdir(paths.approachesDir, { recursive: true }),
    fs.mkdir(paths.specReviewDir, { recursive: true }),
  ]);
  return paths;
}

export function createPlanState(
  jobId: string,
  overrides: Partial<Omit<PlanState, "schemaVersion" | "jobId" | "phase" | "planner" | "spec" | "implementationPlan" | "counters" | "updatedAt">> & {
    planner?: Partial<PlannerState>;
    spec?: Partial<PlanSpecState>;
    implementationPlan?: Partial<ImplementationPlanState>;
    counters?: Partial<PlanCounters>;
  } = {},
): PlanState {
  const timestamp = now();
  return {
    schemaVersion: PLAN_FEEDBACK_SCHEMA_VERSION,
    jobId,
    phase: "plan",
    status: overrides.status ?? "idle",
    planner: {
      mode: overrides.planner?.mode ?? "brainstorming",
      sdkSessionId: overrides.planner?.sdkSessionId ?? null,
      sdkSessionStatus: overrides.planner?.sdkSessionStatus ?? "active",
      resumeStrategy: overrides.planner?.resumeStrategy ?? "sdk_resume",
      lastPlannerResultPath: overrides.planner?.lastPlannerResultPath ?? null,
    },
    activeInteractionId: overrides.activeInteractionId ?? null,
    activeOwner: overrides.activeOwner ?? null,
    currentStep: overrides.currentStep ?? null,
    spec: {
      path: overrides.spec?.path ?? null,
      commitSha: overrides.spec?.commitSha ?? null,
      reviewStatus: overrides.spec?.reviewStatus ?? "not_started",
      userReviewStatus: overrides.spec?.userReviewStatus ?? "not_started",
    },
    implementationPlan: {
      path: overrides.implementationPlan?.path ?? null,
      status: overrides.implementationPlan?.status ?? "not_started",
    },
    counters: {
      clarificationsResolved: overrides.counters?.clarificationsResolved ?? 0,
      designSectionsApproved: overrides.counters?.designSectionsApproved ?? 0,
      specReviewRounds: overrides.counters?.specReviewRounds ?? 0,
    },
    updatedAt: timestamp,
  };
}

export async function loadPlanState(jobDir: string): Promise<PlanState | null> {
  return readJson<PlanState>(getPlanFeedbackPaths(jobDir).planState);
}

export async function savePlanState(jobDir: string, state: PlanState): Promise<void> {
  await ensurePlanFeedbackDirs(jobDir);
  await writeJson(getPlanFeedbackPaths(jobDir).planState, {
    ...state,
    schemaVersion: PLAN_FEEDBACK_SCHEMA_VERSION,
    updatedAt: state.updatedAt ?? now(),
  });
}

export async function initializePlanFeedbackJob(
  jobDir: string,
  jobId: string,
  overrides: Parameters<typeof createPlanState>[1] = {},
): Promise<PlanState> {
  await ensurePlanFeedbackDirs(jobDir);

  const existingState = await loadPlanState(jobDir);
  if (existingState) {
    return existingState;
  }

  const state = createPlanState(jobId, overrides);
  await savePlanState(jobDir, state);
  await saveSessionBindings(jobDir, createSessionBindingsFile(jobId));
  return state;
}

export function createSessionBindingsFile(jobId: string): SessionBindingsFile {
  return {
    schemaVersion: PLAN_FEEDBACK_SCHEMA_VERSION,
    jobId,
    bindings: {},
  };
}

export async function loadSessionBindings(jobDir: string): Promise<SessionBindingsFile | null> {
  return readJson<SessionBindingsFile>(getPlanFeedbackPaths(jobDir).sessions);
}

export async function saveSessionBindings(
  jobDir: string,
  file: SessionBindingsFile,
): Promise<void> {
  await ensurePlanFeedbackDirs(jobDir);
  await writeJson(getPlanFeedbackPaths(jobDir).sessions, {
    ...file,
    schemaVersion: PLAN_FEEDBACK_SCHEMA_VERSION,
  });
}

export async function upsertSessionBinding(
  jobDir: string,
  jobId: string,
  binding: SessionBinding,
): Promise<SessionBindingsFile> {
  const current = (await loadSessionBindings(jobDir)) ?? createSessionBindingsFile(jobId);
  current.bindings[binding.ownerId] = binding;
  await saveSessionBindings(jobDir, current);
  return current;
}

export function createInteraction(
  jobId: string,
  input: Omit<PlanInteraction, "schemaVersion" | "jobId" | "phase" | "createdAt" | "updatedAt"> &
    Partial<Pick<PlanInteraction, "createdAt" | "updatedAt">>,
): PlanInteraction {
  const timestamp = input.createdAt ?? now();
  return {
    ...input,
    schemaVersion: PLAN_FEEDBACK_SCHEMA_VERSION,
    jobId,
    phase: "plan",
    createdAt: timestamp,
    updatedAt: input.updatedAt ?? timestamp,
  };
}

export async function saveInteraction(
  jobDir: string,
  interaction: PlanInteraction,
): Promise<void> {
  await ensurePlanFeedbackDirs(jobDir);
  const filePath = path.join(
    getPlanFeedbackPaths(jobDir).interactionsDir,
    `${interaction.interactionId}.json`,
  );
  await writeJson(filePath, {
    ...interaction,
    schemaVersion: PLAN_FEEDBACK_SCHEMA_VERSION,
    updatedAt: interaction.updatedAt ?? now(),
  });
}

export async function loadInteraction(
  jobDir: string,
  interactionId: string,
): Promise<PlanInteraction | null> {
  return readJson<PlanInteraction>(
    path.join(getPlanFeedbackPaths(jobDir).interactionsDir, `${interactionId}.json`),
  );
}

export async function listInteractions(jobDir: string): Promise<PlanInteraction[]> {
  const { interactionsDir } = getPlanFeedbackPaths(jobDir);
  try {
    const entries = await fs.readdir(interactionsDir);
    const items = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => readJson<PlanInteraction>(path.join(interactionsDir, entry))),
    );
    return items
      .filter((item): item is PlanInteraction => Boolean(item))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch {
    return [];
  }
}

export async function listOpenInteractions(jobDir: string): Promise<PlanInteraction[]> {
  const openStatuses = new Set<InteractionStatus>([
    "requested",
    "routed",
    "awaiting_response",
    "response_recorded",
    "timed_out",
    "escalated",
  ]);
  const interactions = await listInteractions(jobDir);
  return interactions.filter((interaction) => openStatuses.has(interaction.status));
}

export function createPlanEvent<TPayload>(
  jobId: string,
  eventType: PlanEventType,
  payload: TPayload,
  options: Partial<Omit<PlanEvent<TPayload>, "schemaVersion" | "jobId" | "phase" | "eventType" | "payload">> = {},
): PlanEvent<TPayload> {
  return {
    schemaVersion: PLAN_FEEDBACK_SCHEMA_VERSION,
    eventId: options.eventId ?? `pe_${randomUUID()}`,
    eventType,
    jobId,
    phase: "plan",
    createdAt: options.createdAt ?? now(),
    actor: options.actor ?? { kind: "orchestrator", id: "openagent" },
    correlationId: options.correlationId ?? null,
    causationId: options.causationId ?? null,
    payload,
  };
}

export async function appendPlanEvent<TPayload>(
  jobDir: string,
  event: PlanEvent<TPayload>,
): Promise<string> {
  await ensurePlanFeedbackDirs(jobDir);
  const fileName = `${safeTimestamp(event.createdAt)}-${event.eventId}-${event.eventType}.json`;
  const filePath = path.join(getPlanFeedbackPaths(jobDir).eventsDir, fileName);
  await writeJson(filePath, {
    ...event,
    schemaVersion: PLAN_FEEDBACK_SCHEMA_VERSION,
  });
  return filePath;
}

export async function listPlanEvents(jobDir: string): Promise<Array<PlanEvent<unknown>>> {
  const { eventsDir } = getPlanFeedbackPaths(jobDir);
  try {
    const entries = await fs.readdir(eventsDir);
    const events = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => readJson<PlanEvent<unknown>>(path.join(eventsDir, entry))),
    );
    return events
      .filter((event): event is PlanEvent<unknown> => Boolean(event))
      .sort((a, b) => {
        const timeOrder = a.createdAt.localeCompare(b.createdAt);
        return timeOrder !== 0 ? timeOrder : a.eventId.localeCompare(b.eventId);
      });
  } catch {
    return [];
  }
}

export function createDispatchArtifact(
  jobId: string,
  input: Omit<DispatchArtifact, "schemaVersion" | "jobId" | "createdAt" | "updatedAt"> &
    Partial<Pick<DispatchArtifact, "createdAt" | "updatedAt">>,
): DispatchArtifact {
  const timestamp = input.createdAt ?? now();
  return {
    ...input,
    schemaVersion: PLAN_FEEDBACK_SCHEMA_VERSION,
    jobId,
    createdAt: timestamp,
    updatedAt: input.updatedAt ?? timestamp,
  };
}

export async function saveDispatchArtifact(
  jobDir: string,
  artifact: DispatchArtifact,
): Promise<void> {
  await ensurePlanFeedbackDirs(jobDir);
  const filePath = path.join(
    getPlanFeedbackPaths(jobDir).dispatchesDir,
    `${artifact.dispatchId}.json`,
  );
  await writeJson(filePath, {
    ...artifact,
    schemaVersion: PLAN_FEEDBACK_SCHEMA_VERSION,
    updatedAt: artifact.updatedAt ?? now(),
  });
}

export async function loadDispatchArtifact(
  jobDir: string,
  dispatchId: string,
): Promise<DispatchArtifact | null> {
  return readJson<DispatchArtifact>(
    path.join(getPlanFeedbackPaths(jobDir).dispatchesDir, `${dispatchId}.json`),
  );
}

export async function listDispatchArtifacts(jobDir: string): Promise<DispatchArtifact[]> {
  const { dispatchesDir } = getPlanFeedbackPaths(jobDir);
  try {
    const entries = await fs.readdir(dispatchesDir);
    const items = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => readJson<DispatchArtifact>(path.join(dispatchesDir, entry))),
    );
    return items
      .filter((item): item is DispatchArtifact => Boolean(item))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch {
    return [];
  }
}
