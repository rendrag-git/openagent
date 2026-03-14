import type { ExecuteRequest, TaskResult } from "../types.ts";
import { PROFILES } from "../profiles.ts";
import { runSession } from "../run-session.ts";

export async function execute(request: ExecuteRequest): Promise<TaskResult> {
  return runSession({
    prompt: request.plan,
    cwd: request.cwd,
    profile: PROFILES.execute,
    overrides: request.overrides,
    context: request.context,
    onQuestion: request.onQuestion,
    onProgress: request.onProgress,
    includeDiff: request.includeDiff ?? true,  // execute defaults to including diff
    canUseTool: request.canUseTool,
  });
}
