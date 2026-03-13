import fs from "node:fs/promises";
import path from "node:path";
import type { ParkedSession } from "./types.ts";

const DEFAULT_PARKED_DIR = path.join(
  process.env.HOME ?? "/home/ubuntu",
  ".openclaw",
  "openagent",
  "parked",
);

export async function parkSession(
  session: ParkedSession,
  dir: string = DEFAULT_PARKED_DIR,
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${session.sessionId}.json`);
  await fs.writeFile(filePath, JSON.stringify(session, null, 2));
}

export async function loadParkedSession(
  sessionId: string,
  dir: string = DEFAULT_PARKED_DIR,
): Promise<ParkedSession | null> {
  const filePath = path.join(dir, `${sessionId}.json`);
  try {
    const data = await fs.readFile(filePath, "utf-8");
    return JSON.parse(data) as ParkedSession;
  } catch {
    return null;
  }
}

export async function removeParkedSession(
  sessionId: string,
  dir: string = DEFAULT_PARKED_DIR,
): Promise<void> {
  const filePath = path.join(dir, `${sessionId}.json`);
  try {
    await fs.unlink(filePath);
  } catch {
    // already removed, ignore
  }
}

export async function listParkedSessions(
  dir: string = DEFAULT_PARKED_DIR,
): Promise<ParkedSession[]> {
  try {
    const files = await fs.readdir(dir);
    const sessions: ParkedSession[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const data = await fs.readFile(path.join(dir, file), "utf-8");
      sessions.push(JSON.parse(data) as ParkedSession);
    }
    return sessions;
  } catch {
    return [];
  }
}
