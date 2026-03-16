import { execFileSync } from "node:child_process";
import {
  createDispatchArtifact,
  loadInteraction,
  saveDispatchArtifact,
  saveInteraction,
  type DispatchArtifact,
  type PlanInteraction,
} from "./plan-feedback.ts";

interface DispatchDependencies {
  classifyQuestion: (task: string, routingJson: string) => Promise<{ routeKey: string }>;
  loadRoutingTable: () => Record<string, unknown>;
  bulletinPostCli?: string;
}

function now(): string {
  return new Date().toISOString();
}

function buildInteractionPrompt(interaction: PlanInteraction): string {
  const prompt = interaction.request.prompt?.trim();
  if (prompt) return prompt;
  return interaction.request.title;
}

function buildDispatchTarget(interaction: PlanInteraction): string {
  if (interaction.routing.targetAgentId) return interaction.routing.targetAgentId;
  return interaction.owner.id;
}

async function createBulletinDispatch(
  jobDir: string,
  interaction: PlanInteraction,
  deps: DispatchDependencies,
): Promise<DispatchArtifact> {
  const routingTable = deps.loadRoutingTable();
  const promptText = buildInteractionPrompt(interaction);
  const routeResult = await deps.classifyQuestion(promptText, JSON.stringify(routingTable));
  const routes = (routingTable as any).routes ?? {};
  const alwaysSubscribe = (routingTable as any).alwaysSubscribe ?? [];
  const subscribers = [...new Set([...(routes[routeResult.routeKey] ?? routes.default ?? ["dev"]), ...alwaysSubscribe])];
  const bulletinId = interaction.routing.bulletinId ?? `blt-${interaction.jobId}-${interaction.interactionId}`;
  const topic = `openagent: ${interaction.request.title.slice(0, 60)}`;
  const body = [
    "**Question from openagent**",
    `**Phase:** plan`,
    "",
    "---",
    "",
    interaction.request.title,
    "",
    promptText,
    "",
    "---",
    "",
    "Respond with your recommendation. Use bulletin_respond with align/partial/oppose.",
  ].join("\n");

  let status: DispatchArtifact["status"] = "pending";
  let errorMessage: string | null = null;

  if (deps.bulletinPostCli) {
    try {
      execFileSync(
        deps.bulletinPostCli,
        [
          "--topic", topic,
          "--body", body,
          "--subscribers", subscribers.join(","),
          "--protocol", "advisory",
          "--id", bulletinId,
          "--timeout", "3",
        ],
        { encoding: "utf-8", timeout: 10000 },
      );
      status = "awaiting_external_response";
    } catch (error) {
      status = "failed";
      errorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  interaction.routing.bulletinId = bulletinId;
  interaction.updatedAt = now();
  await saveInteraction(jobDir, interaction);

  const artifact = createDispatchArtifact(interaction.jobId, {
    dispatchId: `pd_${interaction.interactionId}`,
    interactionId: interaction.interactionId,
    transport: "bulletin",
    action: "create_bulletin",
    status,
    target: subscribers.join(","),
    payload: {
      bulletinId,
      topic,
      body,
      subscribers,
      routeKey: routeResult.routeKey,
      errorMessage,
    },
  });

  await saveDispatchArtifact(jobDir, artifact);

  return artifact;
}

async function createHandoffDispatch(
  jobDir: string,
  interaction: PlanInteraction,
  action: string,
): Promise<DispatchArtifact> {
  const artifact = createDispatchArtifact(interaction.jobId, {
    dispatchId: `pd_${interaction.interactionId}`,
    interactionId: interaction.interactionId,
    transport: interaction.routing.transport,
    action,
    status: "pending",
    target: buildDispatchTarget(interaction),
    payload: {
      title: interaction.request.title,
      prompt: interaction.request.prompt ?? null,
      options: interaction.request.options ?? [],
      recommendedOptionId: interaction.request.recommendedOptionId ?? null,
      routing: interaction.routing,
    },
  });

  await saveDispatchArtifact(jobDir, artifact);

  return artifact;
}

export async function dispatchPlanInteraction(
  jobDir: string,
  interactionId: string,
  deps: DispatchDependencies,
  actionOverride?: string,
): Promise<DispatchArtifact> {
  const interaction = await loadInteraction(jobDir, interactionId);
  if (!interaction) {
    throw new Error(`Unknown interaction: ${interactionId}`);
  }

  switch (interaction.routing.transport) {
    case "bulletin":
      return createBulletinDispatch(jobDir, interaction, deps);
    case "direct_session":
      return createHandoffDispatch(jobDir, interaction, actionOverride ?? "dispatch_direct_session");
    case "discord_thread":
      return createHandoffDispatch(jobDir, interaction, actionOverride ?? "dispatch_discord_gate");
    case "subagent_review":
      return createHandoffDispatch(jobDir, interaction, actionOverride ?? "dispatch_subagent_review");
    case "internal":
      return createHandoffDispatch(jobDir, interaction, actionOverride ?? "resolve_internal");
  }
}
