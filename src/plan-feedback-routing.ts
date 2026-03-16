import { randomUUID } from "node:crypto";
import {
  appendPlanEvent,
  createPlanEvent,
  loadInteraction,
  loadSessionBindings,
  saveInteraction,
  type PlanInteraction,
  type RoutingTransport,
  type SessionBinding,
  type SessionStability,
  upsertSessionBinding,
} from "./plan-feedback.ts";

function now(): string {
  return new Date().toISOString();
}

export type DispatchAction =
  | "establish_direct_session"
  | "send_direct_session"
  | "create_bulletin"
  | "post_discord_gate"
  | "spawn_reviewer"
  | "resolve_internal";

export interface RouteInteractionOptions {
  threadId?: string;
  bulletinId?: string;
  discordMessageId?: string;
  bindSession?: {
    ownerId: string;
    sessionKey: string;
    threadId?: string | null;
    transport?: "sessions_spawn" | "sessions_send";
    stability?: SessionStability;
  };
}

export interface RoutedInteractionResult {
  interaction: PlanInteraction;
  action: DispatchAction;
  transport: RoutingTransport;
  target: string;
}

function defaultAction(transport: RoutingTransport, hasBinding: boolean): DispatchAction {
  switch (transport) {
    case "direct_session":
      return hasBinding ? "send_direct_session" : "establish_direct_session";
    case "bulletin":
      return "create_bulletin";
    case "discord_thread":
      return "post_discord_gate";
    case "subagent_review":
      return "spawn_reviewer";
    case "internal":
      return "resolve_internal";
  }
}

function defaultTarget(interaction: PlanInteraction): string {
  if (interaction.routing.targetAgentId) return interaction.routing.targetAgentId;
  if (interaction.owner.kind === "human") return interaction.owner.id;
  if (interaction.owner.kind === "system") return interaction.owner.id;
  return "unknown";
}

function makeBindingId(ownerId: string): string {
  return `sb_${ownerId}_${randomUUID()}`;
}

export async function routePlanInteraction(
  jobDir: string,
  interactionId: string,
  options: RouteInteractionOptions = {},
): Promise<RoutedInteractionResult> {
  const interaction = await loadInteraction(jobDir, interactionId);
  if (!interaction) {
    throw new Error(`Unknown interaction: ${interactionId}`);
  }

  const timestamp = now();
  const sessions = await loadSessionBindings(jobDir);
  let binding = interaction.routing.targetAgentId
    ? sessions?.bindings[interaction.routing.targetAgentId] ?? null
    : null;

  if (options.bindSession) {
    const boundAt = options.bindSession.threadId ?? options.threadId ?? null;
    const newBinding: SessionBinding = {
      bindingId: makeBindingId(options.bindSession.ownerId),
      ownerId: options.bindSession.ownerId,
      transport: options.bindSession.transport ?? "sessions_spawn",
      sessionKey: options.bindSession.sessionKey,
      threadId: boundAt,
      createdAt: timestamp,
      lastUsedAt: timestamp,
      status: "active",
      stability: options.bindSession.stability ?? "owned_child_session",
    };
    await upsertSessionBinding(jobDir, interaction.jobId, newBinding);
    binding = newBinding;

    await appendPlanEvent(
      jobDir,
      createPlanEvent(interaction.jobId, "plan.session.bound", {
        binding: {
          bindingId: newBinding.bindingId,
          ownerId: newBinding.ownerId,
          transport: newBinding.transport,
          sessionKey: newBinding.sessionKey,
          threadId: newBinding.threadId,
          stability: newBinding.stability,
        },
      }),
    );
  } else if (binding) {
    binding.lastUsedAt = timestamp;
    await upsertSessionBinding(jobDir, interaction.jobId, binding);

    await appendPlanEvent(
      jobDir,
      createPlanEvent(interaction.jobId, "plan.session.rebound", {
        binding: {
          bindingId: binding.bindingId,
          ownerId: binding.ownerId,
          transport: binding.transport,
          sessionKey: binding.sessionKey,
          threadId: binding.threadId,
          stability: binding.stability,
        },
      }),
    );
  }

  if (interaction.routing.transport === "direct_session") {
    if (!interaction.routing.targetAgentId && interaction.owner.kind === "agent") {
      interaction.routing.targetAgentId = interaction.owner.id;
    }
    if (binding) {
      interaction.routing.sessionBindingId = binding.bindingId;
      interaction.routing.threadId = binding.threadId ?? interaction.routing.threadId ?? options.threadId ?? null;
    } else if (options.threadId) {
      interaction.routing.threadId = options.threadId;
    }
  } else if (interaction.routing.transport === "bulletin") {
    interaction.routing.bulletinId =
      interaction.routing.bulletinId ?? options.bulletinId ?? `blt-${interaction.jobId}-${interaction.interactionId}`;
  } else if (interaction.routing.transport === "discord_thread") {
    interaction.routing.threadId = interaction.routing.threadId ?? options.threadId ?? null;
    interaction.routing.discordMessageId =
      interaction.routing.discordMessageId ?? options.discordMessageId ?? null;
  } else if (interaction.routing.transport === "subagent_review") {
    interaction.routing.targetAgentId = interaction.routing.targetAgentId ?? "spec-reviewer";
  }

  interaction.status = "awaiting_response";
  interaction.updatedAt = timestamp;
  await saveInteraction(jobDir, interaction);

  const action = defaultAction(interaction.routing.transport, Boolean(binding));
  const target = defaultTarget(interaction);

  await appendPlanEvent(
    jobDir,
    createPlanEvent(interaction.jobId, "plan.interaction.routed", {
      interactionId: interaction.interactionId,
      routing: interaction.routing,
      action,
      target,
    }),
  );

  return {
    interaction,
    action,
    transport: interaction.routing.transport,
    target,
  };
}
