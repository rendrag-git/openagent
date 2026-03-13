import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../../../.openclaw/hooks/openagent-dispatch/handler.ts";

describe("e2e: openagent-dispatch hook", () => {
  it("dispatches an execute task and returns structured result", async () => {
    let sentEnvelope: Record<string, unknown> | null = null;

    const mockSend = async (env: Record<string, unknown>) => {
      sentEnvelope = env;
    };

    const envelope = {
      id: "env_test_1",
      from: "pm",
      to: "dev",
      intent: "TASK_REQUEST",
      threadId: "thread_test_1",
      payload: {
        engine: "openagent",
        worker: "plan",
        task: "List the files in the current directory. Keep answer under 50 words.",
        cwd: process.cwd(),
      },
    };

    const handled = await handle(envelope, mockSend);

    assert.equal(handled, true, "hook should handle openagent requests");
    assert.ok(sentEnvelope, "should have sent a response envelope");
    assert.equal(sentEnvelope!.intent, "TASK_RESULT");
    assert.equal(sentEnvelope!.to, "pm");

    const payload = sentEnvelope!.payload as Record<string, unknown>;
    assert.equal(typeof payload.success, "boolean");
    assert.equal(typeof payload.output, "string");
    assert.ok((payload.output as string).length > 0);

    console.log("E2E result:", {
      success: payload.success,
      stopReason: payload.stopReason,
      outputLength: (payload.output as string).length,
    });
  });

  it("ignores non-openagent envelopes", async () => {
    const envelope = {
      id: "env_test_2",
      from: "pm",
      to: "dev",
      intent: "TASK_REQUEST",
      threadId: "thread_test_2",
      payload: { task: "Do something with legacy" },
    };

    const handled = await handle(envelope, async () => {});
    assert.equal(handled, false, "should not handle legacy requests");
  });
});
