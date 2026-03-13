import type { TaskResult } from "./types.ts";
import { loadParkedSession, removeParkedSession } from "./feedback.ts";
import { runSession } from "./run-session.ts";

export async function resume(
  sessionId: string,
  answer: string,
): Promise<TaskResult> {
  const parked = await loadParkedSession(sessionId);

  const result = await runSession({
    prompt: answer,
    cwd: parked?.taskContext.cwd ?? process.cwd(),
    resume: sessionId,
    resumeAnswer: answer,
  });

  // Clean up parked state on successful resume
  await removeParkedSession(sessionId);

  return result;
}
