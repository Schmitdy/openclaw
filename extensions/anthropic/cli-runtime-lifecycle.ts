import type { ClaudeCliSession, ClaudeCliTurn } from "./cli-runtime-types.js";

export function observeLifecycle(observe: () => void): void {
  try {
    observe();
  } catch {
    /* Diagnostics never change the turn. */
  }
}
export function observeTurnUse(session: ClaudeCliSession, turn: ClaudeCliTurn) {
  if (turn.useObserved) {
    return;
  }
  turn.useObserved = true;
  // Inputs that never reached native are not turn-use evidence.
  if (!session.startObserved) {
    return;
  }
  const values = new Set([...session.initConversations, ...turn.conversations]);
  const value = values.size === 1 ? values.values().next().value : undefined;
  const conversation = !session.hasInputLifecycle
    ? { state: "lifecycle-unsupported" as const }
    : values.size > 1
      ? { state: "ambiguous" as const }
      : value
        ? { state: "grounded" as const, value }
        : { state: "unobserved" as const };
  observeLifecycle(() =>
    turn.context.processLifecycle?.turnUsed({
      generation: session.handle.generation,
      inputUuid: turn.inputUuid,
      inputAcknowledged: turn.inputStarted,
      conversation,
      reused: turn.reused,
      ...(value && conversation.state === "grounded"
        ? { matchesRequestedSessionId: value === turn.context.sessionId }
        : {}),
    }),
  );
}
