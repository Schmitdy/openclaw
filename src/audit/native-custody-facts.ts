/** Reserved, best-effort custody facts on the existing audit FIFO and table. */
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { recordExecutionDecisionFactInDatabase } from "./execution-decision-facts.js";
import {
  parseExecutionDecisionWorkPayload,
  projectExecutionDecisionWorkInDatabase,
} from "./execution-decision-work.js";
import type { ExecutionDecisionWork } from "./execution-decision-work.types.js";
import { markNativeCustodyReceipt } from "./native-custody-brand.js";

export type NativeCustodyFactWork = ExecutionDecisionWork;
type NativeCustodyFactSink = (work: NativeCustodyFactWork) => boolean;
const state = resolveGlobalSingleton<{ sink: NativeCustodyFactSink | undefined }>(
  Symbol.for("openclaw.nativeCustodyFactSink"),
  () => ({ sink: undefined }),
);

export function parseNativeCustodyFactWork(value: unknown): NativeCustodyFactWork {
  const work = parseExecutionDecisionWorkPayload(value);
  const owner = work.receipt.source.owner;
  const families =
    owner === "cli-process"
      ? ["cli-launch", "cli-use", "cli-retire"]
      : owner === "cron-standing-grant"
        ? ["cron-grant-consume", "cron-grant-initiate"]
        : [];
  if (
    !families.includes(work.receipt.action.family) ||
    work.refs?.representedSubject ||
    work.receipt.enforcement.coverageState !== "attribution-only" ||
    work.receipt.enforcement.grantRefs.length !== 0 ||
    work.receipt.enforcement.contextFieldsUsed.length !== 0
  ) {
    throw new Error("native custody work violates its reserved owner contract");
  }
  for (const [kind, ref] of [
    ["resource", work.refs?.resource],
    ["target", work.refs?.target],
  ] as const) {
    if (!ref) {
      continue;
    }
    const allowed =
      kind === "resource"
        ? ["cli-invocation", "cron-standing-grant"]
        : ["provider-conversation", "cron-operation-binding"];
    if (!allowed.includes(ref.namespace) || !/^[a-zA-Z0-9:_-]{1,256}$/u.test(ref.value)) {
      throw new Error("native custody ref violates its private contract");
    }
  }
  return work;
}

export function processNativeCustodyFactInDatabase(
  value: unknown,
  options: OpenClawStateDatabaseOptions & { database: OpenClawStateDatabase },
) {
  const receipt = projectExecutionDecisionWorkInDatabase(
    parseNativeCustodyFactWork(value),
    options,
  );
  markNativeCustodyReceipt(receipt);
  return recordExecutionDecisionFactInDatabase(receipt, options);
}

export function configureNativeCustodyFactSink(next: NativeCustodyFactSink): () => void {
  state.sink = next;
  return () => {
    if (state.sink === next) {
      state.sink = undefined;
    }
  };
}

/** Neither queue refusal nor a faulty diagnostic observer may alter native execution. */
export function recordNativeCustodyFact(work: NativeCustodyFactWork): void {
  try {
    state.sink?.(work);
  } catch {
    /* Best-effort evidence only. */
  }
}

/** Build the common envelope from an already admitted token, never from a run-id lookup. */
export function recordNativeCustodyEvent(input: {
  token: ExecutionDecisionWork["token"] | undefined;
  receiptId: string;
  owner: "cli-process" | "cron-standing-grant";
  family: string;
  operation: string;
  outcome: "allowed" | "denied" | "not-applicable" | "unknown";
  reasonCode: string;
  recordRef: string;
  actionId?: string;
  summary?: string;
  policyRefs?: string[];
  missingEvidence?: string[];
  refs?: ExecutionDecisionWork["refs"];
}): void {
  if (!input.token) {
    return;
  }
  try {
    recordNativeCustodyFact({
      workVersion: 1,
      token: { ...input.token },
      receipt: {
        schemaVersion: 1,
        receiptId: input.receiptId,
        occurredAt: Date.now(),
        ...(input.actionId ? { actionId: input.actionId } : {}),
        action: {
          family: input.family,
          operation: input.operation,
          ...(input.summary ? { summary: input.summary } : {}),
        },
        decision: { outcome: input.outcome, reasonCode: input.reasonCode },
        enforcement: {
          coverageState: "attribution-only",
          policyRefs: input.policyRefs ?? [],
          grantRefs: [],
          contextFieldsUsed: [],
        },
        source: {
          owner: input.owner,
          recordRef: input.recordRef,
          decisionBoundary: "native-custody",
        },
        missingEvidence: input.missingEvidence ?? [],
        remediation: [],
      },
      ...(input.refs ? { refs: input.refs } : {}),
    });
  } catch {
    /* Diagnostic envelope construction cannot affect native behavior. */
  }
}
