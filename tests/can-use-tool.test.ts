import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCanUseTool } from "../src/can-use-tool.ts";

describe("createCanUseTool", () => {
  it("allows tools in the allow list", async () => {
    const canUseTool = createCanUseTool({ allow: ["Read", "Glob"] });
    const result = await canUseTool("Read", { file_path: "/tmp/foo" }, { signal: new AbortController().signal, toolUseID: "t1" } as any);
    assert.equal(result.behavior, "allow");
  });

  it("denies tools in the deny list", async () => {
    const canUseTool = createCanUseTool({ deny: ["Write", "Edit"] });
    const result = await canUseTool("Write", { file_path: "src/foo.ts", content: "x" }, { signal: new AbortController().signal, toolUseID: "t2" } as any);
    assert.equal(result.behavior, "deny");
  });

  it("allows Write to docs/plans/*.md", async () => {
    const canUseTool = createCanUseTool({
      deny: ["Write", "Edit"],
      allowWritePaths: ["docs/plans/"],
    });
    const result = await canUseTool("Write", { file_path: "/home/ubuntu/projects/openagent/docs/plans/2026-03-13-design.md", content: "# Plan" }, { signal: new AbortController().signal, toolUseID: "t3" } as any);
    assert.equal(result.behavior, "allow");
  });

  it("denies Write to src/ even with allowWritePaths set", async () => {
    const canUseTool = createCanUseTool({
      deny: ["Write", "Edit"],
      allowWritePaths: ["docs/plans/"],
    });
    const result = await canUseTool("Write", { file_path: "/home/ubuntu/projects/openagent/src/foo.ts", content: "x" }, { signal: new AbortController().signal, toolUseID: "t4" } as any);
    assert.equal(result.behavior, "deny");
  });

  it("denies unlisted tools by default", async () => {
    const canUseTool = createCanUseTool({ allow: ["Read"] });
    const result = await canUseTool("SomeRandomTool", {}, { signal: new AbortController().signal, toolUseID: "t5" } as any);
    assert.equal(result.behavior, "deny");
  });

  it("intercepts AskUserQuestion when handler provided", async () => {
    let interceptedInput: any = null;

    const canUseTool = createCanUseTool({
      onAskUserQuestion: async (input) => {
        interceptedInput = input;
        return ["PostgreSQL"];
      },
    });

    const input = {
      questions: [{ question: "Which DB?", options: [{ label: "PostgreSQL" }, { label: "SQLite" }] }],
    };

    const result = await canUseTool("AskUserQuestion", input, { signal: new AbortController().signal, toolUseID: "t6" } as any);

    assert.equal(result.behavior, "allow");
    assert.ok(interceptedInput);
    assert.deepEqual((result as any).updatedInput.answers, ["PostgreSQL"]);
  });

  it("logs questions to array when logger provided", async () => {
    const questionLog: any[] = [];

    const canUseTool = createCanUseTool({
      onAskUserQuestion: async (input) => ["PostgreSQL"],
      questionLog,
    });

    await canUseTool("AskUserQuestion", {
      questions: [{ question: "Which DB?" }],
    }, { signal: new AbortController().signal, toolUseID: "t7" } as any);

    assert.equal(questionLog.length, 1);
    assert.equal(questionLog[0].question, "Which DB?");
    assert.deepEqual(questionLog[0].answers, ["PostgreSQL"]);
  });
});
