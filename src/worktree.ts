import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function runGit(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, ...extraEnv },
  }).trim();
}

function removeDirIfExists(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {}
}

function hasRegisteredWorktree(cwd: string, worktreePath: string): boolean {
  try {
    const output = runGit(cwd, ["worktree", "list", "--porcelain"]);
    return output.split("\n").some((line) => line === `worktree ${worktreePath}`);
  } catch {
    return false;
  }
}

function buildCommitEnv(extraEnv: Record<string, string> = {}): Record<string, string> {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "openagent",
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "openagent@local",
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "openagent",
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "openagent@local",
    ...extraEnv,
  };
}

export function createSnapshotCommit(cwd: string, label: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagent-index-"));
  const tempIndex = path.join(tempDir, "index");
  const headCommit = runGit(cwd, ["rev-parse", "HEAD"]);
  const env = { GIT_INDEX_FILE: tempIndex };

  try {
    runGit(cwd, ["read-tree", headCommit], env);
    runGit(cwd, ["add", "-A"], env);
    const tree = runGit(cwd, ["write-tree"], env);
    return execFileSync(
      "git",
      ["commit-tree", tree, "-p", headCommit],
      {
        cwd,
        encoding: "utf-8",
        env: buildCommitEnv(env),
        input: `${label}\n`,
      },
    ).trim();
  } finally {
    removeDirIfExists(tempDir);
  }
}

export function createWorktree(cwd: string, workerName: string, jobId: string): string {
  const worktreePath = `/tmp/openagent-${workerName}-${jobId}`;
  const ref = workerName === "check"
    ? createSnapshotCommit(cwd, `openagent ${workerName} snapshot for ${jobId}`)
    : "HEAD";

  if (hasRegisteredWorktree(cwd, worktreePath)) {
    try {
      runGit(cwd, ["worktree", "remove", worktreePath, "--force"]);
    } catch {}
  }

  removeDirIfExists(worktreePath);

  try {
    runGit(cwd, ["worktree", "prune"]);
  } catch {}

  try {
    runGit(cwd, ["worktree", "add", "--detach", worktreePath, ref]);
  } catch (err) {
    throw new Error(`Failed to create worktree for ${workerName}: ${err}`);
  }

  return worktreePath;
}

export function cleanupWorktree(worktreePath: string, realCwd: string, workerName: string): void {
  if (!worktreePath.startsWith("/tmp/openagent-")) return;

  if (workerName === "plan") {
    const planDir = path.join(worktreePath, "docs", "plans");
    const realPlanDir = path.join(realCwd, "docs", "plans");
    try {
      if (fs.existsSync(planDir)) {
        fs.mkdirSync(realPlanDir, { recursive: true });
        for (const file of fs.readdirSync(planDir)) {
          if (!file.endsWith(".md")) continue;
          const src = path.join(planDir, file);
          const dest = path.join(realPlanDir, file);
          const srcStat = fs.statSync(src);
          try {
            const destStat = fs.statSync(dest);
            if (srcStat.mtimeMs > destStat.mtimeMs) {
              fs.copyFileSync(src, dest);
            }
          } catch {
            fs.copyFileSync(src, dest);
          }
        }
      }
    } catch {}
  }

  try {
    runGit(realCwd, ["worktree", "remove", worktreePath, "--force"]);
  } catch {
    removeDirIfExists(worktreePath);
    try {
      runGit(realCwd, ["worktree", "prune"]);
    } catch {}
  }
}
