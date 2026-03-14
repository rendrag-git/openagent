import type { CheckRequest, TaskResult } from "../types.ts";
import { PROFILES } from "../profiles.ts";
import { runSession } from "../run-session.ts";

export async function check(request: CheckRequest): Promise<TaskResult> {
  const prompt = request.plan
    ? `Plan:\n${request.plan}\n\nVerify:\n${request.task}`
    : request.task;

  return runSession({
    prompt,
    cwd: request.cwd,
    profile: PROFILES.check,
    overrides: request.overrides,
    context: request.context,
    onQuestion: request.onQuestion,
    onProgress: request.onProgress,
    includeDiff: false,  // check doesn't produce diffs
    canUseTool: request.canUseTool,
  });
}
