import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRunConfig, runSession } from "../src/run-session.ts";
import { PROFILES } from "../src/profiles.ts";
import { ParkSession } from "../src/session.ts";

describe("buildRunConfig", () => {
  it("builds config for execute worker", () => {
    const config = buildRunConfig({
      prompt: "Add pagination",
      cwd: "/home/ubuntu/projects/test",
      profile: PROFILES.execute,
    });

    assert.equal(config.prompt, "Add pagination");
    assert.equal(config.options.cwd, "/home/ubuntu/projects/test");
    assert.ok(config.options.allowedTools!.includes("Edit"));
    assert.ok(config.options.allowedTools!.includes("Agent"));
    assert.equal(config.options.permissionMode, "acceptEdits");
  });

  it("prepends context to prompt", () => {
    const config = buildRunConfig({
      prompt: "Fix the bug",
      cwd: "/tmp",
      profile: PROFILES.act,
      context: "The auth middleware throws on empty tokens.",
    });

    assert.ok(config.prompt.includes("Context:"));
    assert.ok(config.prompt.includes("auth middleware"));
    assert.ok(config.prompt.includes("Fix the bug"));
  });

  it("applies overrides", () => {
    const config = buildRunConfig({
      prompt: "test",
      cwd: "/tmp",
      profile: PROFILES.check,
      overrides: { maxTurns: 100 },
    });

    assert.equal(config.options.maxTurns, 100);
  });

  it("works without a profile (raw session)", () => {
    const config = buildRunConfig({
      prompt: "Do something custom",
      cwd: "/tmp",
      tools: ["Read", "Bash"],
      systemPrompt: "Custom prompt",
    });

    assert.equal(config.prompt, "Do something custom");
    assert.deepEqual(config.options.allowedTools, ["Read", "Bash"]);
  });
});

describe("runSession parking", () => {
  it("interrupts the query and rethrows ParkSession with the SDK session id", async () => {
    let interrupted = 0;
    const question = {
      id: "q_1",
      text: "Choose an approach",
      timestamp: "2026-03-17T00:00:00.000Z",
      answered: false,
    };

    await assert.rejects(
      runSession(
        {
          prompt: "test parking",
          cwd: "/tmp",
          canUseTool: async () => {
            throw new ParkSession(question);
          },
        },
        {
          queryFactory: (config) => ({
            async interrupt() {
              interrupted += 1;
            },
            async *[Symbol.asyncIterator]() {
              yield {
                type: "system",
                subtype: "init",
                session_id: "sess_parked_123",
              };
              await (config.options as Record<string, unknown>).canUseTool?.(
                "AskUserQuestion",
                { questions: [{ question: "Choose?" }] },
                { signal: new AbortController().signal, toolUseID: "tool_1" },
              );
              yield {
                type: "result",
                subtype: "error_during_execution",
                result: "",
                stop_reason: "tool_use",
                session_id: "sess_parked_123",
              };
            },
          }) as any,
        },
      ),
      (err: unknown) =>
        err instanceof ParkSession &&
        err.sessionId === "sess_parked_123" &&
        err.question.id === question.id,
    );

    assert.equal(interrupted, 1);
  });
});
