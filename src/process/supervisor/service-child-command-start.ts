import { createHash } from "node:crypto";
import type { ServiceChildAnchorMessage } from "./service-child-protocol.js";
import type { OwnedStdioCommandStart } from "./types.js";

export function digestCommandInvocation(command: string, args: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([command, ...args]))
    .digest("hex");
}

/** Observation is once-only and cannot change launch, readiness, or cleanup. */
export function createCommandStartObserver(
  onCommandStart?: (observation: OwnedStdioCommandStart) => void,
) {
  let observed = false;
  return (observation: OwnedStdioCommandStart) => {
    if (observed) {
      return;
    }
    observed = true;
    try {
      onCommandStart?.(observation);
    } catch {
      /* Diagnostic loss only. */
    }
  };
}

export function observeAnchorCommandStart(
  message: ServiceChildAnchorMessage,
  spawnPath: Extract<OwnedStdioCommandStart, { outcome: "started" }>["spawnPath"],
  sentInvocationDigest: string,
  observe: (observation: OwnedStdioCommandStart) => void,
): void {
  if (message.type === "command-spawned") {
    observe({
      outcome: "started",
      commandPid: message.commandPid,
      anchorPid: message.anchorPid,
      spawnPath,
      observedBy: "anchor-command-spawned",
      hostObservedAtMs: Date.now(),
      anchorObservedAtMs: message.anchorObservedAtMs,
      sentInvocationDigest,
      spawnedInvocationDigest: message.spawnedInvocationDigest,
    });
  } else if (message.type === "ready") {
    observe({
      outcome: "started",
      commandPid: message.commandPid,
      anchorPid: message.anchorPid,
      spawnPath,
      observedBy: "anchor-ready",
      hostObservedAtMs: Date.now(),
      sentInvocationDigest,
    });
  } else if (message.type === "startup-error") {
    observe(
      message.commandSpawned && message.commandPid !== undefined
        ? {
            outcome: "started",
            commandPid: message.commandPid,
            ...(message.anchorPid !== undefined ? { anchorPid: message.anchorPid } : {}),
            spawnPath,
            observedBy: "anchor-startup-error",
            hostObservedAtMs: Date.now(),
            sentInvocationDigest,
          }
        : { outcome: "spawn-error-before-confirmation", spawnPath, hostObservedAtMs: Date.now() },
    );
  }
}

export function observeUnknownCommandStart(
  observe: (observation: OwnedStdioCommandStart) => void,
  spawnPath: Extract<OwnedStdioCommandStart, { outcome: "start-unknown" }>["spawnPath"],
): void {
  observe({ outcome: "start-unknown", spawnPath, hostObservedAtMs: Date.now() });
}
