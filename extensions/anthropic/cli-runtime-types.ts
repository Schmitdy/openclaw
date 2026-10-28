import type { PassThrough } from "node:stream";
import type {
  CliBackendExecuteContext,
  CliBackendLiveSessionCapability,
  CliBackendLiveSessionHandle,
} from "openclaw/plugin-sdk/cli-backend";
import type { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { ClaudeTransportArgFacts } from "./cli-runtime-args.js";
import type { createClaudeCliTransport } from "./cli-transport.js";
import type { createClaudeCliUserInputAuthorizer } from "./cli-user-input.js";

export type CliProcessLifecycleObserver = {
  processStarted(i: {
    generation: string;
    observation: import("openclaw/plugin-sdk/process-runtime").OwnedStdioCommandStart;
    argvFacts: ClaudeTransportArgFacts;
    mode: "warm" | "one-shot";
  }): void;
  processInitialized(i: { generation: string; conversation: string }): void;
  turnUsed(i: {
    generation: string;
    inputUuid: string;
    inputAcknowledged: boolean;
    conversation:
      | { state: "grounded"; value: string }
      | { state: "unobserved" | "ambiguous" | "lifecycle-unsupported" };
    matchesRequestedSessionId?: boolean;
    reused: boolean;
  }): void;
  retireRequested(i: {
    generation: string;
    reason: "idle" | "abort" | "restart" | "error" | "mcp-capture-rotation";
    mode: "warm" | "one-shot";
  }): void;
  exitSettled(i: {
    generation: string;
    outcome: "exit-confirmed" | "exit-unconfirmed" | "retired-without-observed-start";
  }): void;
};
export type ClaudeCliExecuteContext = CliBackendExecuteContext & {
  assertPrivateInputCurrent?: () => void;
  processLifecycle?: CliProcessLifecycleObserver;
};
export type ClaudeCliTurn = {
  context: ClaudeCliExecuteContext;
  controller: AbortController;
  userInput: ReturnType<typeof createClaudeCliUserInputAuthorizer>;
  events: PassThrough;
  inputUuid: string;
  /** Replayed user text is never a task receipt, even after its input lifecycle ends. */
  submittedInputUuids: Set<string>;
  inputStarted: boolean;
  reused: boolean;
  useObserved: boolean;
  conversations: Set<string>;
  promptSubmitted: boolean;
  /** Hook reruns carry no input UUID and may rewrite text; retain their native input owner. */
  promptInputUuid: string;
  sawTerminalResult: boolean;
  interrupted: boolean;
  foregroundTaskIds: Set<string>;
  foregroundBashToolUseIds: Set<string>;
  pendingBackgroundTaskIds: Set<string>;
  taskNotifications: Map<string, "queued" | "replayed">;
  /** Same-turn inputs written to native, keyed by UUID until their lifecycle completes. */
  injectedInputs: Map<
    string,
    {
      text: string;
      promptContext?: CliBackendExecuteContext["promptContext"];
      started: ReturnType<typeof createDeferred<void>>;
    }
  >;
  /**
   * A successful result withheld until every injected input has completed. It is
   * released as terminal on completion, or as interim when native opens another
   * turn for the input first.
   */
  heldResult?: Record<string, unknown>;
  error?: Error;
};
export type ClaudeCliSession = {
  handle: CliBackendLiveSessionHandle;
  capability?: CliBackendLiveSessionCapability;
  transport?: Awaited<ReturnType<typeof createClaudeCliTransport>>;
  transportStartup?: ReturnType<typeof createClaudeCliTransport>;
  currentTurn?: ClaudeCliTurn;
  idleTimer?: ReturnType<typeof setTimeout>;
  hasInputLifecycle: boolean;
  launchLifecycle?: CliProcessLifecycleObserver;
  startObserved: boolean;
  initConversations: Set<string>;
  closed: boolean;
  // Tasks outlive inputs; false marks subagent work with no parent-stream query.
  taskOwners: Map<string, string | false>;
  // Native notification results identify task runs rather than task IDs.
  taskRuns: Map<string, string>;
  // Running Agent/Workflow tasks and subagent-owned work, with their launching task.
  runningDescendants: Map<string, string | undefined>;
};
