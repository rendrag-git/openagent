import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRunConfig } from "../src/run-session.ts";
import { PROFILES } from "../src/profiles.ts";

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
