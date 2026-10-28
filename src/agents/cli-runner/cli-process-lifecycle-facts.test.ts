import { afterEach, expect, it } from "vitest";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import {
  configureNativeCustodyFactSink,
  parseNativeCustodyFactWork,
  type NativeCustodyFactWork,
} from "../../audit/native-custody-facts.js";
import { createCliProcessLifecycleFacts } from "./cli-process-lifecycle-facts.js";

let clear: (() => void) | undefined;
afterEach(() => clear?.());
const started = {
  generation: "native-generation",
  mode: "warm" as const,
  argvFacts: { toolsEmpty: true },
  observation: {
    outcome: "started" as const,
    commandPid: 123,
    anchorPid: 122,
    spawnPath: "posix-relay" as const,
    observedBy: "anchor-command-spawned" as const,
    hostObservedAtMs: 10,
    sentInvocationDigest: "a".repeat(64),
    spawnedInvocationDigest: "b".repeat(64),
  },
};

it("attributes late retirement to the launch token, rejects duplicate/late use, and ignores writer refusal", () => {
  const facts: NativeCustodyFactWork[] = [];
  clear = configureNativeCustodyFactSink((work) => {
    facts.push(parseNativeCustodyFactWork(work));
    return false;
  });
  const token = createExecutionIdentityAdmissionToken("run-launch");
  const owner = createCliProcessLifecycleFacts({
    token,
    availability: { native: [], openClaw: [] },
    inheritedPolicyFacts: { hardDenyAll: true },
  });
  owner.observer.processStarted(started);
  owner.observer.processStarted(started);
  const use = {
    generation: started.generation,
    inputUuid: "input-uuid",
    inputAcknowledged: true,
    conversation: { state: "grounded" as const, value: "native-conversation" },
    reused: false,
  };
  owner.observer.turnUsed(use);
  owner.settle();
  owner.observer.turnUsed(use);
  owner.observer.processStarted({ ...started, generation: "late-generation" });
  for (let i = 0; i < 2; i++) {
    owner.observer.retireRequested({
      generation: started.generation,
      reason: "idle",
      mode: "warm",
    });
  }
  for (let i = 0; i < 2; i++) {
    owner.observer.exitSettled({ generation: started.generation, outcome: "exit-confirmed" });
  }
  expect(facts.map((f) => f.receipt.action.operation)).toEqual([
    "launch",
    "use",
    "retire-requested",
    "exit-confirmed",
  ]);
  expect(facts.every((f) => f.token.executionId === token.executionId)).toBe(true);
  expect(facts[0]?.receipt.missingEvidence).toContain("os_start_time");
  expect(facts[1]?.receipt.action.summary).toContain('"hardDenyAll":true');
  expect(facts[1]?.receipt.action.summary).toContain('"zeroAvailability":true');
});

it.each(["spawn-error-before-confirmation", "start-unknown"] as const)(
  "keeps %s distinct and never invents a physical start",
  (outcome) => {
    const facts: NativeCustodyFactWork[] = [];
    clear = configureNativeCustodyFactSink((work) => {
      facts.push(parseNativeCustodyFactWork(work));
      return true;
    });
    const owner = createCliProcessLifecycleFacts({
      token: createExecutionIdentityAdmissionToken("failed-launch"),
    });
    owner.observer.processStarted({
      ...started,
      observation: { outcome, spawnPath: "direct", hostObservedAtMs: 10 },
    });
    expect(facts[0]?.receipt.decision.outcome).toBe(
      outcome === "start-unknown" ? "unknown" : "not-applicable",
    );
    expect(facts[0]?.refs).toBeUndefined();
  },
);

it("does not write without admission or when a diagnostic sink throws", () => {
  let calls = 0;
  clear = configureNativeCustodyFactSink(() => {
    calls++;
    throw new Error("synthetic observer fault");
  });
  createCliProcessLifecycleFacts({}).observer.processStarted(started);
  expect(calls).toBe(0);
  expect(() =>
    createCliProcessLifecycleFacts({
      token: createExecutionIdentityAdmissionToken("run"),
    }).observer.processStarted(started),
  ).not.toThrow();
  expect(calls).toBe(1);
});

it("records native MCP capture rotation after the launching execution settles", () => {
  const facts: NativeCustodyFactWork[] = [];
  clear = configureNativeCustodyFactSink((work) => {
    facts.push(parseNativeCustodyFactWork(work));
    return true;
  });
  const owner = createCliProcessLifecycleFacts({
    token: createExecutionIdentityAdmissionToken("rotation-launch"),
  });
  owner.observer.processStarted(started);
  owner.settle();
  owner.observer.retireRequested({
    generation: started.generation,
    reason: "mcp-capture-rotation",
    mode: "warm",
  });
  expect(facts.at(-1)?.receipt.decision.reasonCode).toBe("cli_retire_mcp-capture-rotation");
});

it("projects only fixed argv booleans and session enums into the diagnostic summary", () => {
  const facts: NativeCustodyFactWork[] = [];
  clear = configureNativeCustodyFactSink((work) => {
    facts.push(work);
    return true;
  });
  createCliProcessLifecycleFacts({
    token: createExecutionIdentityAdmissionToken("argv-projection"),
  }).observer.processStarted({
    ...started,
    argvFacts: {
      toolsEmpty: true,
      noChrome: "synthetic-private-value",
      sessionFlag: "synthetic-session",
      arbitrary: "synthetic-private-value",
    },
  });
  expect(JSON.parse(facts[0]!.receipt.action.summary!)).toMatchObject({ toolsEmpty: true });
  expect(facts[0]!.receipt.action.summary).not.toContain("synthetic-");
  expect(facts[0]!.receipt.action.summary).not.toContain("noChrome");
});
