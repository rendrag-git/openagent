import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  parkSession,
  loadParkedSession,
  removeParkedSession,
  listParkedSessions,
} from "../src/feedback.ts";
import type { ParkedSession } from "../src/types.ts";

const TEST_DIR = "/tmp/openagent-test-parked";

describe("feedback", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("parks a session to disk", async () => {
    const parked: ParkedSession = {
      sessionId: "sess_123",
      question: {
        id: "q_1",
        text: "Which DB adapter?",
        timestamp: "2026-03-13T12:00:00Z",
        answered: false,
      },
      originalFrom: "pm",
      threadId: "thread_abc",
      taskContext: { cwd: "/home/ubuntu/projects/test" },
      createdAt: "2026-03-13T12:00:00Z",
    };

    await parkSession(parked, TEST_DIR);

    const filePath = path.join(TEST_DIR, "sess_123.json");
    assert.ok(fs.existsSync(filePath));
  });

  it("loads a parked session from disk", async () => {
    const parked: ParkedSession = {
      sessionId: "sess_456",
      question: {
        id: "q_2",
        text: "REST or GraphQL?",
        timestamp: "2026-03-13T12:00:00Z",
        answered: false,
      },
      originalFrom: "dev",
      threadId: "thread_def",
      taskContext: { cwd: "/tmp" },
      createdAt: "2026-03-13T12:00:00Z",
    };

    await parkSession(parked, TEST_DIR);
    const loaded = await loadParkedSession("sess_456", TEST_DIR);

    assert.ok(loaded);
    assert.equal(loaded!.question.text, "REST or GraphQL?");
    assert.equal(loaded!.originalFrom, "dev");
  });

  it("returns null for unknown session", async () => {
    const loaded = await loadParkedSession("nonexistent", TEST_DIR);
    assert.equal(loaded, null);
  });

  it("removes a parked session", async () => {
    const parked: ParkedSession = {
      sessionId: "sess_789",
      question: {
        id: "q_3",
        text: "test",
        timestamp: "2026-03-13T12:00:00Z",
        answered: false,
      },
      originalFrom: "pm",
      threadId: "thread_ghi",
      taskContext: { cwd: "/tmp" },
      createdAt: "2026-03-13T12:00:00Z",
    };

    await parkSession(parked, TEST_DIR);
    await removeParkedSession("sess_789", TEST_DIR);

    const filePath = path.join(TEST_DIR, "sess_789.json");
    assert.ok(!fs.existsSync(filePath));
  });

  it("lists all parked sessions", async () => {
    for (const id of ["sess_a", "sess_b", "sess_c"]) {
      await parkSession(
        {
          sessionId: id,
          question: { id: "q", text: "q", timestamp: "", answered: false },
          originalFrom: "pm",
          threadId: "t",
          taskContext: { cwd: "/tmp" },
          createdAt: "",
        },
        TEST_DIR,
      );
    }

    const sessions = await listParkedSessions(TEST_DIR);
    assert.equal(sessions.length, 3);
  });
});
