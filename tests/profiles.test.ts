import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PROFILES, getProfile } from "../src/profiles.ts";

describe("profiles", () => {
  it("exports all four PDCA profiles", () => {
    assert.ok(PROFILES.plan);
    assert.ok(PROFILES.execute);
    assert.ok(PROFILES.check);
    assert.ok(PROFILES.act);
  });

  it("plan profile excludes Edit", () => {
    assert.ok(!PROFILES.plan.allowedTools.includes("Edit"));
  });

  it("plan profile includes Agent", () => {
    assert.ok(PROFILES.plan.allowedTools.includes("Agent"));
  });

  it("execute profile includes Edit, Write, Bash, Agent", () => {
    for (const tool of ["Edit", "Write", "Bash", "Agent"]) {
      assert.ok(
        PROFILES.execute.allowedTools.includes(tool),
        `execute missing ${tool}`
      );
    }
  });

  it("check profile excludes Edit and Write", () => {
    assert.ok(!PROFILES.check.allowedTools.includes("Edit"));
    assert.ok(!PROFILES.check.allowedTools.includes("Write"));
  });

  it("plan profile uses plan permission mode", () => {
    assert.equal(PROFILES.plan.permissionMode, "plan");
  });

  it("execute and act profiles use acceptEdits permission mode", () => {
    for (const name of ["execute", "act"]) {
      assert.equal(
        PROFILES[name].permissionMode,
        "acceptEdits",
        `${name} should use acceptEdits`
      );
    }
  });

  it("check profile uses plan permission mode", () => {
    assert.equal(PROFILES.check.permissionMode, "plan");
  });

  it("all profiles include question routing in system prompt", () => {
    for (const [name, profile] of Object.entries(PROFILES)) {
      assert.ok(
        profile.systemPromptAppend.includes("uncertain"),
        `${name} missing question routing instruction`
      );
    }
  });

  it("all profiles set settingSources to project", () => {
    for (const [name, profile] of Object.entries(PROFILES)) {
      assert.deepEqual(
        profile.settingSources,
        ["project"],
        `${name} should load project settings`
      );
    }
  });

  it("getProfile returns profile by name", () => {
    assert.deepEqual(getProfile("plan"), PROFILES.plan);
  });

  it("getProfile returns undefined for unknown name", () => {
    assert.equal(getProfile("unknown"), undefined);
  });

  it("plan profile has no denyTools (worktree is the sandbox)", () => {
    assert.equal(PROFILES.plan.denyTools, undefined);
  });

  it("check profile has denyTools", () => {
    assert.ok(PROFILES.check.denyTools?.includes("Write"));
    assert.ok(PROFILES.check.denyTools?.includes("Edit"));
  });

  it("execute profile has no denyTools", () => {
    assert.equal(PROFILES.execute.denyTools, undefined);
  });
});
