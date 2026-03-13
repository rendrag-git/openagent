import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
    },
  };
}

describe("e2e: openagent-dispatch hook", () => {
  it("dispatches a plan task and pushes result message", async () => {
    const task = "List the files in the current directory. Keep answer under 50 words.";
    const fence = JSON.stringify({
      engine: "openagent",
      worker: "plan",
      task,
      cwd: process.cwd(),
    }, null, 2);

    const event = makeEvent(`Run this:\n\`\`\`openagent\n${fence}\n\`\`\``);
    await handler(event);

    assert.equal(event.context.__oc_blocked, true, "should block raw message");
    assert.ok(event.messages.length > 0, "should push a result message");
    const msg = event.messages[0] as string;
    assert.ok(msg.includes("openagent plan"), "message should mention worker");
    assert.ok(msg.length > 20, "message should have content");

    console.log("E2E result message:", msg.slice(0, 200));
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
