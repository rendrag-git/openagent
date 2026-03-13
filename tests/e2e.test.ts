import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import handler from "../../../.openclaw/hooks/openagent-dispatch/handler.ts";

function makeEvent(content: string): any {
  return {
    type: "message",
    action: "received",
    sessionKey: "agent:dev:main",
    timestamp: new Date(),
    messages: [] as string[],
    context: {
      from: "agent:pm:main",
      content,
      channelId: "discord",
      conversationId: "channel:0000000000000000000",
    },
  };
}

const DEBUG_LOG = "/home/ubuntu/.openclaw/logs/openagent-dispatch-debug.log";

describe("e2e: openagent-dispatch hook", () => {
  it("dispatches a plan task and logs completion", async () => {
    const task = "List the files in the current directory. Keep answer under 50 words.";
    const fence = JSON.stringify({
      engine: "openagent",
      worker: "plan",
      task,
      cwd: process.cwd(),
    }, null, 2);

    // Clear debug log to isolate this run
    try { fs.writeFileSync(DEBUG_LOG, ""); } catch {}

    const event = makeEvent(`Run this:\n\`\`\`openagent\n${fence}\n\`\`\``);
    await handler(event);

    assert.equal(event.context.__oc_blocked, true, "should block raw message");

    // Verify completion via debug log (postToDiscord fails on fake channel, but the phase completed)
    const log = fs.readFileSync(DEBUG_LOG, "utf-8");
    assert.ok(log.includes('"phase":"fence-matched"'), "should log fence match");
    assert.ok(log.includes('"phase":"complete"'), "should log completion");
    assert.ok(log.includes('"success":true'), "should succeed");
  });

  it("ignores messages without openagent fence", async () => {
    const event = makeEvent("Hey dev, can you help with something?");
    await handler(event);

    assert.equal(event.context.__oc_blocked, undefined, "should not block");
    assert.equal(event.messages.length, 0, "should not push any messages");
  });

  it("ignores fences with wrong engine", async () => {
    const fence = JSON.stringify({ engine: "legacy", task: "do something" });
    const event = makeEvent(`\`\`\`openagent\n${fence}\n\`\`\``);
    await handler(event);

    assert.equal(event.context.__oc_blocked, undefined, "should not block");
    assert.equal(event.messages.length, 0, "should not push any messages");
  });
});
