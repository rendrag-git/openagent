// PDCA Workers
export { plan } from "./workers/plan.ts";
export { execute } from "./workers/execute.ts";
export { check } from "./workers/check.ts";
export { act } from "./workers/act.ts";

// Raw session primitive
export { runSession as createSession } from "./run-session.ts";

// Resume a parked session
export { resume } from "./resume.ts";

// Core classes and utilities
export { ParkSession } from "./session.ts";

// Types
export type {
  TaskResult,
  TaskContext,
  PlanRequest,
  ExecuteRequest,
  CheckRequest,
  ActRequest,
  SessionRequest,
  Question,
  FileChange,
  ProgressEvent,
  WorkerProfile,
  ParkedSession,
} from "./types.ts";

// canUseTool callback factory
export { createCanUseTool } from "./can-use-tool.ts";
export type { CanUseToolOptions } from "./can-use-tool.ts";

// Profiles
export { PROFILES, getProfile } from "./profiles.ts";

// Feedback (parking)
export {
  parkSession,
  loadParkedSession,
  removeParkedSession,
  listParkedSessions,
} from "./feedback.ts";

// Plan feedback control plane
export {
  PLAN_FEEDBACK_SCHEMA_VERSION,
  appendPlanEvent,
  createInteraction,
  createPlanEvent,
  createPlanState,
  createDispatchArtifact,
  createSessionBindingsFile,
  ensurePlanFeedbackDirs,
  getPlanFeedbackPaths,
  initializePlanFeedbackJob,
  listDispatchArtifacts,
  listInteractions,
  listOpenInteractions,
  listPlanEvents,
  loadDispatchArtifact,
  loadInteraction,
  loadPlanState,
  loadSessionBindings,
  saveDispatchArtifact,
  saveInteraction,
  savePlanState,
  saveSessionBindings,
  upsertSessionBinding,
} from "./plan-feedback.ts";
export type {
  DispatchArtifact,
  DispatchStatus,
  EventActorKind,
  ImplementationPlanState,
  InteractionKind,
  InteractionOption,
  InteractionRequestPayload,
  InteractionResolutionPayload,
  InteractionResponsePayload,
  InteractionResumeConfig,
  InteractionResumeFallback,
  InteractionRouting,
  InteractionStatus,
  InteractionTimeouts,
  PlanActor,
  PlanCounters,
  PlanEvent,
  PlanEventType,
  PlanFeedbackPaths,
  PlanInteraction,
  PlanSpecState,
  PlanState,
  PlanStep,
  PlanWorkflowStatus,
  PlannerResumeStrategy,
  PlannerSessionStatus,
  PlannerState,
  ReviewStatus,
  RoutingTransport,
  SessionBinding,
  SessionBindingStatus,
  SessionBindingTransport,
  SessionBindingsFile,
  SessionStability,
  UserReviewStatus,
} from "./plan-feedback.ts";

export {
  formatPlanInteractionInstruction,
  getWorkflowStatusForInteraction,
  parseStructuredPlanInteraction,
} from "./plan-feedback-interactions.ts";
export type { ParsedPlanInteraction } from "./plan-feedback-interactions.ts";

export {
  completeInteractionResolution,
  markResumeFailure,
  recordInteractionAnswer,
} from "./plan-feedback-resume.ts";
export type { RecordedInteractionAnswer } from "./plan-feedback-resume.ts";

export { routePlanInteraction } from "./plan-feedback-routing.ts";
export type {
  DispatchAction,
  RouteInteractionOptions,
  RoutedInteractionResult,
} from "./plan-feedback-routing.ts";

export { dispatchPlanInteraction } from "./plan-feedback-dispatch.ts";

// ACP-facing runtime adapter
export { createOpenAgentRuntimeAdapter } from "./acp-runtime.ts";
export type {
  OpenAgentRuntimeAdapter,
  OpenAgentRuntimeAdapterDeps,
  OpenAgentRuntimeHandle,
  OpenAgentRuntimeLinkage,
  OpenAgentRuntimeResumeInput,
  OpenAgentRuntimeSessionStatus,
  OpenAgentRuntimeTurnInput,
  OpenAgentRuntimeTurnResult,
  OpenAgentWorkerName,
} from "./acp-runtime.ts";
