import type { CliBackendExecuteContext } from "openclaw/plugin-sdk/cli-backend";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ClaudeCliTurn } from "./cli-runtime-types.js";

export function createUserInput(
  context: CliBackendExecuteContext,
  text: string,
  uuid: string,
  hostGenerated = false,
) {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    uuid,
    // Claude saves synthetic input as a meta row: the model reads it, history never shows it.
    ...(hostGenerated ? { isSynthetic: true } : {}),
    ...(context.sessionId ? { session_id: context.sessionId } : {}),
  };
}

export function rejectInjectedInputs(turn: ClaudeCliTurn, error: Error) {
  for (const input of turn.injectedInputs.values()) {
    input.started.reject(error);
  }
}

export function privateInputHolds(turn: ClaudeCliTurn): boolean {
  try {
    turn.context.assertPrivateInputCurrent?.();
    return true;
  } catch {
    return false;
  }
}

export function carriesTurnContext(request: Record<string, unknown>, response: unknown): boolean {
  return (
    request.callback_id === "UserPromptSubmit" &&
    isRecord(response) &&
    isRecord(response.hookSpecificOutput) &&
    response.hookSpecificOutput.additionalContext !== undefined
  );
}

export function resolvePromptContext(turn: ClaudeCliTurn, prompt: unknown) {
  if (turn.promptInputUuid !== turn.inputUuid) {
    return turn.injectedInputs.get(turn.promptInputUuid)?.promptContext;
  }
  // Some native versions submit hooks before the started receipt. Match only the
  // first pass; subsequent passes belong to that UUID even when text is rewritten.
  const injected = [...turn.injectedInputs].find(([, input]) => input.text === prompt);
  if (!injected) {
    return turn.context.promptContext;
  }
  turn.promptInputUuid = injected[0];
  return injected[1].promptContext;
}
