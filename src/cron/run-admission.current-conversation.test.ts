import { afterEach, expect, it, vi } from "vitest";
import type { ScheduledToolPolicyContext } from "../agents/scheduled-tool-policy.js";
import { jsonResult } from "../agents/tools/common.js";
import { resolveMessageActionTurnAuthorization } from "../gateway/message-action-turn-capability.js";
import { runMessageAction } from "../infra/outbound/message-action-runner.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createDirectOutboundTestAdapter,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import { bindCronJobAdmittedRun, markCronJobActive, resetCronActiveJobs } from "./active-jobs.js";
import type { DeliveryTargetResolution } from "./isolated-agent/delivery-target.js";
import { prepareCronRunAdmission } from "./run-admission.js";
import type { CronDelivery } from "./types.js";

const requested: CronDelivery = {
  mode: "none",
  channel: "scheduled-reader",
  to: "room:current",
  accountId: "ops",
};
const resolved: DeliveryTargetResolution = {
  ok: true,
  mode: "explicit",
  channel: "scheduled-reader",
  to: "room:current",
  accountId: "ops",
};
const trusted: ScheduledToolPolicyContext = { version: 1, mode: "trusted" };

afterEach(() => {
  resetCronActiveJobs();
  resetPluginRuntimeStateForTest();
});

async function fixture(
  delivery: CronDelivery | undefined,
  resolution: DeliveryTargetResolution = resolved,
  policy = trusted,
) {
  const handleAction = vi.fn(async () => jsonResult({ messages: [] }));
  setActivePluginRegistry(
    createTestRegistry(
      ["scheduled-reader", "foreign-reader"].map((id) => ({
        pluginId: id,
        source: "synthetic-external",
        origin: "config" as const,
        plugin: {
          ...createChannelTestPluginBase({
            id,
            config: { listAccountIds: () => ["ops", "foreign"] },
          }),
          outbound: createDirectOutboundTestAdapter({ channel: id }),
          messaging: { targetResolver: { looksLikeId: () => true } },
          actions: {
            describeMessageTool: () => ({ actions: ["read"] }),
            providerOwnedReadGates: true,
            handleAction,
          },
        },
      })),
    ),
  );
  const jobId = "scheduled-read";
  const marker = markCronJobActive(jobId, { isMessageActionAuthorityCurrent: () => true });
  const controller = new AbortController();
  const owner = prepareCronRunAdmission({
    cfg: {},
    agentId: "main",
    runId: "scheduled-read-run",
    sessionKey: "cron:scheduled-read",
    jobId,
    toolsAllow: ["message"],
    scheduledToolPolicy: policy,
    deliveryAttemptFence: { beforeAttempt: async () => {}, assertCurrent: () => {} },
    messageDelivery: { requested: delivery, resolved: resolution },
  });
  bindCronJobAdmittedRun(
    marker,
    await owner.preparedRunAdmission.admit("embedded"),
    controller.signal,
  );
  const authorization = resolveMessageActionTurnAuthorization({
    token: owner.messageActionTurnCapability,
    agentId: "main",
    runId: "scheduled-read-run",
    sessionKey: "cron:scheduled-read",
  });
  expect(authorization).toBeDefined();
  const read = (params: Record<string, unknown> = {}) =>
    runMessageAction({
      cfg: {
        channels: { "scheduled-reader": { enabled: true }, "foreign-reader": { enabled: true } },
      },
      action: "read",
      params: { channel: "scheduled-reader", target: "room:current", accountId: "ops", ...params },
      messageActionAuthorization: authorization,
      conversationReadOrigin: "delegated",
    });
  return { read, handleAction, owner, controller };
}

it("reads the explicit admitted external route", async () => {
  const f = await fixture(requested);
  try {
    await expect(f.read()).resolves.toMatchObject({ action: "read", handledBy: "plugin" });
    expect(f.handleAction).toHaveBeenCalledOnce();
  } finally {
    f.owner.close();
  }
});

it.each([{ target: "room:foreign" }, { accountId: "foreign" }, { channel: "foreign-reader" }])(
  "denies foreign action selectors %j before the external handler",
  async (selectors) => {
    const f = await fixture(requested);
    try {
      await expect(f.read(selectors)).rejects.toThrow("exact current conversation");
      expect(f.handleAction).not.toHaveBeenCalled();
    } finally {
      f.owner.close();
    }
  },
);

it.each([
  { name: "missing delivery", delivery: undefined },
  { name: "missing provider", delivery: { ...requested, channel: undefined } },
  { name: "last provider", delivery: { ...requested, channel: "last" } },
  { name: "internal provider", delivery: { ...requested, channel: "webchat" } },
  { name: "missing target", delivery: { ...requested, to: " " } },
  { name: "missing account", delivery: { ...requested, accountId: undefined } },
  { name: "webhook", delivery: { ...requested, mode: "webhook" as const } },
  { name: "implicit resolution", resolution: { ...resolved, mode: "implicit" as const } },
  {
    name: "failed resolution",
    resolution: { ...resolved, ok: false as const, error: new Error("unresolved") },
  },
  { name: "provider mismatch", resolution: { ...resolved, channel: "foreign-reader" } },
  { name: "account mismatch", resolution: { ...resolved, accountId: "foreign" } },
])("denies $name before the external handler", async (scenario) => {
  const delivery = "delivery" in scenario ? scenario.delivery : requested;
  const f = await fixture(delivery, scenario.resolution);
  try {
    await expect(f.read()).rejects.toThrow("exact current conversation");
    expect(f.handleAction).not.toHaveBeenCalled();
  } finally {
    f.owner.close();
  }
});

it("retains account-created creator-origin restrictions for arbitrary explicit delivery", async () => {
  const f = await fixture(requested, resolved, {
    version: 1,
    mode: "account",
    ownerSessionKey: "agent:main:foreign-reader:group:origin",
    ownerAccountId: "ops",
    ownerOrigin: { kind: "external", channel: "foreign-reader" },
  });
  try {
    await expect(f.read()).rejects.toThrow("exact current conversation");
    expect(f.handleAction).not.toHaveBeenCalled();
  } finally {
    f.owner.close();
  }
});
