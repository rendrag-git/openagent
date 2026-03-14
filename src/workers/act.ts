import type { ActRequest, TaskResult } from "../types.ts";
import { PROFILES } from "../profiles.ts";
import { runSession } from "../run-session.ts";

export async function act(request: ActRequest): Promise<TaskResult> {
  return runSession({
    prompt: request.issues,
    cwd: request.cwd,
    profile: PROFILES.act,
    overrides: request.overrides,
    context: request.context,
    onQuestion: request.onQuestion,
    onProgress: request.onProgress,
    includeDiff: request.includeDiff ?? true,  // act defaults to including diff
    canUseTool: request.canUseTool,
  });
}
