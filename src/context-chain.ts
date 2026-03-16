import fs from "node:fs";
import path from "node:path";
import type { TaskResult } from "./types.ts";

export interface PhaseEnvelope {
  task: string;
  context: string | null;
  feedback: string | null;
  result: TaskResult;
}

const CHAIN: Record<string, string[]> = {
  execute: ["plan"],
  check: ["plan", "execute"],
  act: ["check"],
};

function isPhaseEnvelope(value: unknown): value is PhaseEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.task === "string" && typeof candidate.result === "object" && candidate.result !== null;
}

function readPhaseFile(jobDir: string, phase: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(jobDir, `${phase}.json`), "utf-8"));
}

export function loadPhaseEnvelope(jobDir: string, phase: string): PhaseEnvelope | null {
  try {
    const data = readPhaseFile(jobDir, phase);
    if (isPhaseEnvelope(data)) {
      return data;
    }
  } catch {
    return null;
  }

  return null;
}

export function loadPhaseOutput(jobDir: string, phase: string): string | undefined {
  try {
    const data = readPhaseFile(jobDir, phase);
    if (isPhaseEnvelope(data)) {
      return data.result.output;
    }

    const legacy = data as Record<string, unknown>;
    if (typeof legacy.output === "string") {
      return legacy.output;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function loadContext(jobDir: string, worker: string): string | undefined {
  if (!jobDir) return undefined;

  const phases = CHAIN[worker];
  if (!phases) return undefined;

  const parts: string[] = [];

  let originalTask: string | undefined;
  if (!phases.includes("plan")) {
    const planEnvelope = loadPhaseEnvelope(jobDir, "plan");
    if (planEnvelope) {
      originalTask = planEnvelope.task;
    }
  }

  for (const phase of phases) {
    let data: unknown;
    try {
      data = readPhaseFile(jobDir, phase);
    } catch {
      continue;
    }

    if (isPhaseEnvelope(data)) {
      if (!originalTask && phase === "plan") {
        originalTask = data.task;
      }
      parts.push(`--- ${phase} phase output ---\n${data.result.output}`);
      if (data.feedback) {
        parts.push(`--- ${phase} phase feedback ---\n${data.feedback}`);
      }
      continue;
    }

    const legacy = data as Record<string, unknown>;
    if (typeof legacy.output === "string") {
      parts.push(`--- ${phase} phase output ---\n${legacy.output}`);
    }
  }

  if (parts.length === 0) return undefined;

  if (originalTask) {
    parts.unshift(`--- original task ---\n${originalTask}`);
  }

  return parts.join("\n\n");
}

export function buildFeedbackContext(
  workerName: string,
  priorOutput: string | undefined,
  feedback: string,
): string {
  const parts: string[] = [];
  if (priorOutput) {
    parts.push(`--- previous ${workerName} output ---\n${priorOutput}`);
  }
  parts.push(`--- revision feedback ---\n${feedback}`);
  parts.push("Revise your output based on the feedback above. Keep what works, fix what was called out.");
  return parts.join("\n\n");
}

export function createPhaseEnvelope(
  task: string,
  context: string | undefined,
  feedback: string | undefined,
  result: TaskResult,
): PhaseEnvelope {
  return {
    task,
    context: context ?? null,
    feedback: feedback ?? null,
    result,
  };
}
