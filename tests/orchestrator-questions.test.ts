import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createOrchestratorQuestionHandler,
  formatParkedQuestionOutput,
} from "../src/orchestrator-questions.ts";
import { ParkSession } from "../src/session.ts";

describe("orchestrator question handler", () => {
  it("parks execute questions for orchestrator routing when a job dir exists", async () => {
    const handler = createOrchestratorQuestionHandler("execute", "/tmp/job");

    await assert.rejects(
      handler({
        questions: [{ question: "Which environment should I deploy this to?" }],
      }),
      (err: unknown) =>
        err instanceof ParkSession &&
        err.question.text === "Which environment should I deploy this to?" &&
        typeof err.question.id === "string" &&
        err.question.id.startsWith("q_") &&
        err.metadata?.worker === "execute" &&
        err.metadata?.kind === "worker_clarification",
    );
  });

  it("fails closed when a non-plan worker asks without a job dir", async () => {
    const handler = createOrchestratorQuestionHandler("check");

    await assert.rejects(
      handler({
        questions: [{ question: "Should this preserve backward compatibility?" }],
      }),
      /check worker requires a job directory to route AskUserQuestion through the orchestrator\./,
    );
  });

  it("formats parked output with the worker name", () => {
    assert.equal(
      formatParkedQuestionOutput("execute", "Which environment should I deploy this to?"),
      "Execute parked for feedback: Which environment should I deploy this to?",
    );
  });
});
