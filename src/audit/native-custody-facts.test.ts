import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createAuditEventWriter } from "./audit-event-writer.js";
import { createAuditEventRecorder } from "./audit-recorder.js";
import { recordExecutionDecisionFactInDatabase } from "./execution-decision-facts.js";
import { receipt } from "./execution-decision-facts.test-support.js";
import { parseExecutionDecisionWork } from "./execution-decision-work.js";
import {
  configureExecutionIdentityAdmissionSink,
  createExecutionIdentityAdmissionToken,
  enqueueExecutionIdentityContextAtAdmission,
} from "./execution-identity-admission.js";
import {
  configureNativeCustodyFactSink,
  parseNativeCustodyFactWork,
  recordNativeCustodyEvent,
  type NativeCustodyFactWork,
} from "./native-custody-facts.js";
import { readNativeCustodyFactsInDatabase } from "./native-custody-read.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

function work(id = "native-fact"): NativeCustodyFactWork {
  let captured: NativeCustodyFactWork | undefined;
  const clear = configureNativeCustodyFactSink((value) => {
    captured = value;
    return true;
  });
  try {
    recordNativeCustodyEvent({
      token: createExecutionIdentityAdmissionToken("custody-run", {
        contextId: "custody-context",
        executionId: "custody-execution",
      }),
      receiptId: id,
      owner: "cli-process",
      family: "cli-launch",
      operation: "launch",
      outcome: "allowed",
      reasonCode: "cli_process_started",
      recordRef: "cli-launch:generation",
      refs: {
        resource: { namespace: "cli-invocation", value: "a".repeat(64) },
        target: { namespace: "provider-conversation", value: "native-private-session" },
      },
    });
  } finally {
    clear();
  }
  if (!captured) {
    throw new Error("Expected native producer work");
  }
  return captured;
}

it("reserves native ownership at both generic entry points and rejects other native owners", () => {
  const native = work();
  expect(() => parseExecutionDecisionWork(native)).toThrow("reserved writer");
  expect(() =>
    parseNativeCustodyFactWork({
      ...native,
      receipt: { ...native.receipt, source: { ...native.receipt.source, owner: "model-routing" } },
    }),
  ).toThrow();
  const generic = receipt("forged");
  const options = { env: { OPENCLAW_STATE_DIR: dirs.make("native-reserved-") } };
  const database = openOpenClawStateDatabase(options);
  expect(() =>
    recordExecutionDecisionFactInDatabase(
      {
        ...generic,
        source: { ...generic.source, owner: "cli-process" },
      },
      { ...options, database },
    ),
  ).toThrow("reserved writer");
  expect(() =>
    parseNativeCustodyFactWork({
      ...native,
      refs: { resource: { namespace: "cli-invocation", value: "/private/secret command" } },
    }),
  ).toThrow();
  expect(() =>
    parseNativeCustodyFactWork({
      ...native,
      receipt: {
        ...native.receipt,
        action: { ...native.receipt.action, summary: "x".repeat(16 * 1024) },
      },
    }),
  ).toThrow();
});

it("uses the effective gate and FIFO privacy projection, then reads retained facts with collection off", async () => {
  const stateDir = dirs.make("native-custody-");
  const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
  const errors: string[] = [];
  const writer = createAuditEventWriter({
    scheduler: createTestGatewayScheduler(),
    stateDir,
    onError: (e) => errors.push(e),
  });
  await writer.ready;
  const native = work();
  const clear = configureExecutionIdentityAdmissionSink(writer.recordExecutionIdentity);
  try {
    expect(
      enqueueExecutionIdentityContextAtAdmission(
        {
          runId: native.token.runId,
          agentId: "main",
          ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
          runtime: { kind: "embedded" },
        },
        { enabled: true, token: native.token, runtimeInstanceId: "custody-runtime" },
      )?.accepted,
    ).toBe(true);
  } finally {
    clear();
  }
  let cfg: OpenClawConfig = {};
  const recorder = createAuditEventRecorder({
    scheduler: createTestGatewayScheduler(),
    getConfig: () => cfg,
    writer,
  });
  for (const audit of [
    undefined,
    { enabled: true },
    { executionIdentity: false },
    { enabled: false, executionIdentity: true },
  ]) {
    cfg = { logging: { audit } };
    expect(recorder.recordNativeCustodyFact(native)).toBe(false);
  }
  cfg = { logging: { audit: { executionIdentity: true } } };
  expect(recorder.recordNativeCustodyFact(native)).toBe(true);
  expect(
    recorder.recordNativeCustodyFact({
      ...native,
      receipt: { ...native.receipt, receiptId: "second" },
    }),
  ).toBe(true);
  cfg = { logging: { audit: { enabled: false, executionIdentity: false } } };
  await writer.stop();
  expect(errors).toEqual([]);
  const db = openOpenClawStateDatabase(options).db;
  const query = {
    contextId: native.token.contextId,
    executionId: native.token.executionId,
    limit: 1,
    now: Date.now(),
  };
  const first = readNativeCustodyFactsInDatabase(db, query);
  expect(first.entries).toHaveLength(1);
  expect(first.nextCursor).toMatch(/^\d+:\d+$/u);
  expect(first.entries[0]).toMatchObject({
    producer: "cli-process",
    resourceRef: expect.stringMatching(/^hmac-sha256:v1:/u),
    targetRef: expect.stringMatching(/^hmac-sha256:v1:/u),
  });
  const second = readNativeCustodyFactsInDatabase(db, { ...query, cursor: first.nextCursor });
  expect(second.entries).toHaveLength(1);
  expect(second.entries[0]?.receiptId).not.toBe(first.entries[0]?.receiptId);
  expect(second.nextCursor).toBeUndefined();
  expect(
    readNativeCustodyFactsInDatabase(db, { ...query, executionId: "other-execution" }).entries,
  ).toEqual([]);
  expect(() => readNativeCustodyFactsInDatabase(db, { ...query, cursor: "00:1" })).toThrow(
    "cursor",
  );
  expect(() => readNativeCustodyFactsInDatabase(db, { ...query, cursor: "1:9999999" })).toThrow(
    "retained",
  );
  const persisted = JSON.stringify(
    db.prepare("SELECT receipt_json FROM execution_decision_facts").all(),
  );
  expect(persisted).not.toContain("native-private-session");
  expect(persisted).not.toContain("a".repeat(64));
  expect(JSON.stringify(first)).not.toContain("native-private-session");
});

it("shares the sink and reserved receipt brand across separately loaded module copies", async () => {
  const native = work("reloaded-native");
  const received: NativeCustodyFactWork[] = [];
  const clear = configureNativeCustodyFactSink((value) => {
    received.push(value);
    return true;
  });
  const brand = await import("./native-custody-brand.js");
  const marked = {};
  brand.markNativeCustodyReceipt(marked);
  try {
    vi.resetModules();
    const reloaded = await import("./native-custody-facts.js");
    const reloadedBrand = await import("./native-custody-brand.js");
    reloaded.recordNativeCustodyFact(native);
    expect(received).toEqual([native]);
    expect(reloadedBrand.isNativeCustodyReceipt(marked)).toBe(true);
  } finally {
    clear();
  }
});
