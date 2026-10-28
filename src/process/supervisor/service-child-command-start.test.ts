import { createHash } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  closeStub,
  mockWritableRelay,
  relayDefaults,
  relayPeer,
} from "./service-child-relay-host.fixture.test-support.js";
import { createServiceChildRelayAdapter } from "./service-child-relay-host.js";

// mock-isolation: preserve every child_process export except the synthetic native spawn.
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
afterEach(() => {
  mocks.spawn.mockReset();
  vi.restoreAllMocks();
});

it.each([false, true])(
  "reports command start once before readiness (observer throws=%s)",
  async (throws) => {
    const stub = mockWritableRelay((child) => mocks.spawn.mockReturnValue(child));
    const onCommandStart = vi.fn(() => {
      if (throws) {
        throw new Error("synthetic observer failure");
      }
    });
    const pending = createServiceChildRelayAdapter({
      ...relayDefaults,
      args: [""],
      onCommandStart,
    });
    const { emit } = relayPeer(stub);
    const { adapter, ready } = await pending;
    void ready.catch(() => {});
    try {
      emit({
        type: "command-spawned",
        commandPid: 1234,
        anchorPid: 1235,
        spawnedInvocationDigest: "a".repeat(64),
        anchorObservedAtMs: 123,
      });
      await nextTurn();
      expect(onCommandStart).toHaveBeenCalledExactlyOnceWith({
        outcome: "started",
        commandPid: 1234,
        anchorPid: 1235,
        spawnPath: "posix-relay",
        observedBy: "anchor-command-spawned",
        hostObservedAtMs: expect.any(Number),
        anchorObservedAtMs: 123,
        sentInvocationDigest: createHash("sha256")
          .update(JSON.stringify(["synthetic-command", ""]))
          .digest("hex"),
        spawnedInvocationDigest: "a".repeat(64),
      });
      emit({ type: "ready", commandPid: 1234, anchorPid: 1235 });
      await ready;
      expect(onCommandStart).toHaveBeenCalledTimes(1);
    } finally {
      emit({ type: "ready", commandPid: 1234, anchorPid: 1235 });
      closeStub(stub);
      adapter.dispose();
    }
  },
);

it("accepts an older anchor's ready as start evidence without inventing its invocation", async () => {
  const stub = mockWritableRelay((child) => mocks.spawn.mockReturnValue(child));
  const onCommandStart = vi.fn();
  const pending = createServiceChildRelayAdapter({ ...relayDefaults, onCommandStart });
  const { emit } = relayPeer(stub);
  const { adapter, ready } = await pending;
  try {
    emit({ type: "ready", commandPid: 1234, anchorPid: 1235 });
    await ready;
    expect(onCommandStart).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        outcome: "started",
        observedBy: "anchor-ready",
        commandPid: 1234,
      }),
    );
    expect(onCommandStart.mock.calls[0]?.[0]).not.toHaveProperty("spawnedInvocationDigest");
  } finally {
    closeStub(stub);
    adapter.dispose();
  }
});
