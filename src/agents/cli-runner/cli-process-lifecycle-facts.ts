import { createHash } from "node:crypto";
import type { ExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { recordNativeCustodyEvent } from "../../audit/native-custody-facts.js";
import type { OwnedStdioCommandStart } from "../../process/owned-stdio.js";

// Bundled host-internal diagnostics. The public CLI capability still owns reuse and authority.
export type CliProcessLifecycleObserver = {
  processStarted(input: {
    generation: string;
    observation: OwnedStdioCommandStart;
    argvFacts: Record<string, boolean | string>;
    mode: "warm" | "one-shot";
  }): void;
  processInitialized(input: { generation: string; conversation: string }): void;
  turnUsed(input: {
    generation: string;
    inputUuid: string;
    inputAcknowledged: boolean;
    conversation:
      | { state: "grounded"; value: string }
      | { state: "unobserved" | "ambiguous" | "lifecycle-unsupported" };
    matchesRequestedSessionId?: boolean;
    reused: boolean;
  }): void;
  retireRequested(input: {
    generation: string;
    reason: "idle" | "abort" | "restart" | "error" | "mcp-capture-rotation";
    mode: "warm" | "one-shot";
  }): void;
  exitSettled(input: {
    generation: string;
    outcome: "exit-confirmed" | "exit-unconfirmed" | "retired-without-observed-start";
  }): void;
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Holds immutable diagnostic data, never a live session, grant, or authority assertion. */
export function createCliProcessLifecycleFacts(input: {
  token?: ExecutionIdentityAdmissionToken;
  availability?: { native: readonly string[]; openClaw: readonly string[] };
  inheritedPolicyFacts?: { hardDenyAll: boolean | "not-resolved" };
}): { observer: CliProcessLifecycleObserver; settle(): void } {
  const token = input.token ? { ...input.token } : undefined;
  const native = input.availability ? input.availability.native.toSorted() : undefined;
  const openClaw = input.availability ? input.availability.openClaw.toSorted() : undefined;
  const hardDenyAll = input.inheritedPolicyFacts?.hardDenyAll ?? "not-resolved";
  const zeroAvailability =
    native !== undefined && openClaw !== undefined && native.length === 0 && openClaw.length === 0;
  const policyRefs =
    native && openClaw
      ? [`cli-native-tools:${digest(native)}`, `cli-openclaw-tools:${digest(openClaw)}`]
      : [];
  const generations = new Map<
    string,
    { requested: boolean; exited: boolean; initialized: boolean }
  >();
  let settled = false;
  const safe =
    <T>(observe: (value: T) => void) =>
    (value: T) => {
      if (!token) {
        return;
      }
      try {
        observe(value);
      } catch {
        /* Diagnostic loss cannot alter native execution. */
      }
    };
  const event = (
    generation: string,
    facts: Omit<Parameters<typeof recordNativeCustodyEvent>[0], "token" | "owner" | "recordRef">,
  ) =>
    recordNativeCustodyEvent({
      token,
      owner: "cli-process",
      recordRef: `cli-launch:${generation}`,
      ...facts,
    });
  const id = (prefix: string, generation: string, ...parts: string[]) =>
    `${prefix}:${digest([token?.contextId, token?.executionId, generation, ...parts])}`;
  const observer: CliProcessLifecycleObserver = {
    processStarted: safe<Parameters<CliProcessLifecycleObserver["processStarted"]>[0]>((i) => {
      if (settled || generations.has(i.generation)) {
        return;
      }
      generations.set(i.generation, { requested: false, exited: false, initialized: false });
      const o = i.observation;
      const missingEvidence = ["os_start_time"];
      const refs = [...policyRefs];
      const summary = {
        ...Object.fromEntries(
          [
            "settingSourcesEmpty",
            "toolsFlagPresent",
            "toolsEmpty",
            "allowedToolsPresent",
            "strictMcpConfig",
            "disallowedHasMcpWildcard",
            "disableSlashCommands",
            "noChrome",
            "restrictedSettingsExact",
          ].flatMap((key) =>
            typeof i.argvFacts[key] === "boolean" ? [[key, i.argvFacts[key]]] : [],
          ),
        ),
        ...(["resume", "session-id", "none"].includes(String(i.argvFacts.sessionFlag))
          ? { sessionFlag: i.argvFacts.sessionFlag }
          : {}),
        mode: i.mode,
        hostRequestedAvailability: true,
        nativeCount: native?.length ?? "unobserved",
        openClawCount: openClaw?.length ?? "unobserved",
        zeroAvailability,
      };
      if (o.outcome === "started") {
        refs.push(
          `cli-start:${o.commandPid}:${o.anchorPid ?? "unknown"}:${o.spawnPath}:${o.observedBy}:${o.hostObservedAtMs}`,
        );
      }
      if (o.outcome === "started" && o.anchorObservedAtMs !== undefined) {
        refs.push(`cli-anchor-observed:${o.anchorObservedAtMs}`);
      }
      if (o.outcome === "started" && o.spawnedInvocationDigest) {
        refs.push(`cli-spawned-invocation:${o.spawnedInvocationDigest}`);
      } else {
        missingEvidence.push("spawned_invocation_unobserved");
      }
      let text = JSON.stringify({ ...summary, native, openClaw });
      if (text.length > 512) {
        text = JSON.stringify(summary);
        missingEvidence.push("availability_names_truncated");
      }
      event(i.generation, {
        receiptId: id("cli-launch", i.generation),
        family: "cli-launch",
        operation: "launch",
        outcome:
          o.outcome === "started"
            ? "allowed"
            : o.outcome === "start-unknown"
              ? "unknown"
              : "not-applicable",
        reasonCode:
          o.outcome === "started"
            ? "cli_process_started"
            : o.outcome === "start-unknown"
              ? "cli_start_unknown"
              : "cli_spawn_error_before_confirmation",
        summary: text,
        policyRefs: refs,
        missingEvidence,
        ...(o.outcome === "started"
          ? { refs: { resource: { namespace: "cli-invocation", value: o.sentInvocationDigest } } }
          : {}),
      });
    }),
    processInitialized: safe<Parameters<CliProcessLifecycleObserver["processInitialized"]>[0]>(
      (i) => {
        const generation = generations.get(i.generation);
        if (settled || !generation || generation.initialized) {
          return;
        }
        generation.initialized = true;
        event(i.generation, {
          receiptId: id("cli-init", i.generation),
          family: "cli-use",
          operation: "cli-process-init",
          outcome: "allowed",
          reasonCode: "cli_process_initialized",
          refs: { target: { namespace: "provider-conversation", value: i.conversation } },
        });
      },
    ),
    turnUsed: safe<Parameters<CliProcessLifecycleObserver["turnUsed"]>[0]>((i) => {
      if (settled) {
        return;
      }
      const grounded = i.conversation.state === "grounded";
      event(i.generation, {
        receiptId: id("cli-use", i.generation, i.inputUuid),
        family: "cli-use",
        operation: "use",
        actionId: `cli-input:${i.inputUuid}`,
        outcome: grounded ? "allowed" : "unknown",
        reasonCode: i.reused ? "cli_session_reused" : "cli_session_new",
        policyRefs,
        summary: JSON.stringify({
          hardDenyAll,
          zeroAvailability,
          inputAcknowledged: i.inputAcknowledged,
          ...(i.matchesRequestedSessionId !== undefined
            ? { matchesRequestedSessionId: i.matchesRequestedSessionId }
            : {}),
        }),
        missingEvidence: [
          ...(!grounded ? [`provider_conversation_${i.conversation.state}`] : []),
          ...(!i.inputAcknowledged ? ["native_input_acknowledgement"] : []),
        ],
        ...(i.conversation.state === "grounded"
          ? {
              refs: { target: { namespace: "provider-conversation", value: i.conversation.value } },
            }
          : {}),
      });
    }),
    retireRequested: safe<Parameters<CliProcessLifecycleObserver["retireRequested"]>[0]>((i) => {
      let generation = generations.get(i.generation);
      // A session that never reached the physical owner may still retire during this execution.
      if (!generation && !settled) {
        generation = { requested: false, exited: false, initialized: false };
        generations.set(i.generation, generation);
      }
      if (!generation || generation.requested) {
        return;
      }
      generation.requested = true;
      event(i.generation, {
        receiptId: `cli-retire:${i.generation}:requested`,
        family: "cli-retire",
        operation: "retire-requested",
        outcome: "allowed",
        reasonCode: `cli_retire_${i.reason}`,
        summary: `mode=${i.mode}`,
      });
    }),
    exitSettled: safe<Parameters<CliProcessLifecycleObserver["exitSettled"]>[0]>((i) => {
      const generation = generations.get(i.generation);
      if (!generation || generation.exited) {
        return;
      }
      generation.exited = true;
      event(i.generation, {
        receiptId: `cli-retire:${i.generation}:exit`,
        family: "cli-retire",
        operation: i.outcome,
        outcome: i.outcome === "exit-confirmed" ? "allowed" : "unknown",
        reasonCode: i.outcome.replaceAll("-", "_"),
      });
    }),
  };
  return {
    observer,
    settle: () => {
      settled = true;
    },
  };
}
