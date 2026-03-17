import type { TaskResult } from "./types.ts";

export interface NarratedPlanApprovalViolation {
  kind: "design_section_review" | "spec_user_review";
  message: string;
}

export function detectNarratedPlanApproval(output: string): NarratedPlanApprovalViolation | null {
  const normalized = output.toLowerCase();

  const isAwaitingApproval =
    normalized.includes("awaiting your approval")
    || normalized.includes("awaiting approval")
    || normalized.includes("approval or revision feedback");

  if (!isAwaitingApproval) {
    return null;
  }

  if (normalized.includes("section 1") || normalized.includes("section 2") || normalized.includes("before proceeding to section")) {
    return {
      kind: "design_section_review",
      message: "Planner requested section approval in prose instead of emitting a structured design_section_review interaction.",
    };
  }

  if (normalized.includes("review the spec") || normalized.includes("review the written spec")) {
    return {
      kind: "spec_user_review",
      message: "Planner requested spec review in prose instead of emitting a structured spec_user_review interaction.",
    };
  }

  return {
    kind: "design_section_review",
    message: "Planner requested approval in prose instead of emitting a structured plan interaction.",
  };
}

export function applyPlanOutputGuards(
  result: TaskResult,
  hasOpenInteraction: boolean,
): TaskResult {
  if (!result.success || result.stopReason !== "end_turn" || hasOpenInteraction) {
    return result;
  }

  const violation = detectNarratedPlanApproval(result.output);
  if (!violation) {
    return result;
  }

  return {
    ...result,
    success: false,
    stopReason: "error",
    output:
      `${violation.message} Use AskUserQuestion with a structured ${violation.kind} envelope instead of narrative approval text.\n\n` +
      `Original output:\n${result.output}`,
  };
}
