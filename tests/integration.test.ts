import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { plan } from "../src/index.ts";

describe("integration: live SDK", () => {
  it("plan worker returns structured result", async () => {
    const result = await plan({
      task: 'List the files in the current directory and describe what you see. Keep your answer under 100 words.',
      cwd: process.cwd(),
      overrides: { maxTurns: 5 },
    });

    assert.equal(typeof result.success, "boolean");
    assert.equal(typeof result.output, "string");
    assert.ok(result.output.length > 0, "output should not be empty");
    assert.equal(typeof result.sessionId, "string");
    assert.ok(
      ["end_turn", "max_turns", "error", "parked"].includes(result.stopReason),
      `unexpected stopReason: ${result.stopReason}`
    );
    assert.equal(typeof result.usage.durationMs, "number");
    assert.ok(result.usage.durationMs > 0, "durationMs should be positive");

    console.log("Integration test result:", {
      success: result.success,
      stopReason: result.stopReason,
      outputLength: result.output.length,
      durationMs: result.usage.durationMs,
    });
  });
});
