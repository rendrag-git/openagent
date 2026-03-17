import { randomUUID } from "node:crypto";
import { ParkSession } from "./session.ts";

interface AskUserQuestionInput {
  questions?: Array<{ question?: string }>;
}

export function formatParkedQuestionOutput(workerName: string, questionText: string): string {
  const label = workerName.length > 0
    ? `${workerName.charAt(0).toUpperCase()}${workerName.slice(1)}`
    : "Worker";
  return `${label} parked for feedback: ${questionText}`;
}

function firstQuestionText(input: AskUserQuestionInput): string | null {
  const questions = input.questions ?? [];
  const firstQuestion = questions.find((question) => typeof question?.question === "string");
  return firstQuestion?.question?.trim() ?? null;
}

export function createOrchestratorQuestionHandler(workerName: string, jobDir?: string) {
  return async (input: AskUserQuestionInput): Promise<string[]> => {
    if (!jobDir) {
      throw new Error(`${workerName} worker requires a job directory to route AskUserQuestion through the orchestrator.`);
    }

    const rawQuestion = firstQuestionText(input);
    if (!rawQuestion) {
      throw new Error(`${workerName} worker AskUserQuestion must include at least one non-empty question.`);
    }

    throw new ParkSession(
      {
        id: `q_${randomUUID()}`,
        text: rawQuestion,
        timestamp: new Date().toISOString(),
        answered: false,
      },
      "",
      {
        kind: "worker_clarification",
        worker: workerName,
      },
    );
  };
}
