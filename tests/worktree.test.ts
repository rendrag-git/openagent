import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { cleanupWorktree, createWorktree } from "../src/worktree.ts";

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

let repoDir = "";

describe("worktree", () => {
  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagent-worktree-test-"));
    runGit(repoDir, ["init"]);
    runGit(repoDir, ["config", "user.name", "Test User"]);
    runGit(repoDir, ["config", "user.email", "test@example.com"]);

    fs.writeFileSync(path.join(repoDir, "tracked.txt"), "before\n");
    runGit(repoDir, ["add", "tracked.txt"]);
    runGit(repoDir, ["commit", "-m", "initial"]);
  });

  afterEach(() => {
    try {
      runGit(repoDir, ["worktree", "prune"]);
    } catch {}
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("creates check worktrees from a snapshot of uncommitted changes", () => {
    fs.writeFileSync(path.join(repoDir, "tracked.txt"), "after\n");
    fs.writeFileSync(path.join(repoDir, "untracked.txt"), "new file\n");

    const worktreePath = createWorktree(repoDir, "check", "snapshot-test");

    try {
      assert.equal(
        fs.readFileSync(path.join(worktreePath, "tracked.txt"), "utf-8"),
        "after\n",
      );
      assert.equal(
        fs.readFileSync(path.join(worktreePath, "untracked.txt"), "utf-8"),
        "new file\n",
      );
      assert.equal(
        runGit(worktreePath, ["status", "--short"]),
        "",
      );
    } finally {
      cleanupWorktree(worktreePath, repoDir, "check");
    }
  });
});
