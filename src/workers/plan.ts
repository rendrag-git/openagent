import type { PlanRequest, TaskResult } from "../types.ts";
import { PROFILES } from "../profiles.ts";
import { runSession } from "../run-session.ts";

export async function plan(request: PlanRequest): Promise<TaskResult> {
  return runSession({
    prompt: request.task,
    cwd: request.cwd,
    profile: PROFILES.plan,
    overrides: request.overrides,
    context: request.context,
    onQuestion: request.onQuestion,
    onProgress: request.onProgress,
    includeDiff: request.includeDiff,
    canUseTool: request.canUseTool,
  });
}
