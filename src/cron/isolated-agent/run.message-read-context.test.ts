import { afterEach, expect, it, vi } from "vitest";
import type { AdmittedRunContext } from "../../agents/admitted-run-context.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { jsonResult } from "../../agents/tools/common.js";
import { resolveMessageActionTurnAuthorization } from "../../gateway/message-action-turn-capability.js";
import { runMessageAction } from "../../infra/outbound/message-action-runner.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createDirectOutboundTestAdapter,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { bindCronJobAdmittedRun, markCronJobActive, resetCronActiveJobs } from "../active-jobs.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import {
  getChannelPluginMock,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronDeliveryPlanMock,
  resolveDeliveryTargetMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

afterEach(() => {
  resetCronActiveJobs();
  resetPluginRuntimeStateForTest();
});

it.each([true, false])(
  "carries only an originally explicit account through the prompt executor (explicit=%s)",
  async (explicitAccount) => {
    resetRunCronIsolatedAgentTurnHarness();
    mockRunCronFallbackPassthrough();
    const handleAction = vi.fn(async () => jsonResult({ messages: [] }));
    const plugin = {
      ...createChannelTestPluginBase({
        id: "scheduled-reader",
        config: { listAccountIds: () => ["ops"] },
      }),
      outbound: createDirectOutboundTestAdapter({ channel: "scheduled-reader" }),
      messaging: { targetResolver: { looksLikeId: () => true } },
      actions: {
        describeMessageTool: () => ({ actions: ["read" as const] }),
        providerOwnedReadGates: true as const,
        handleAction,
      },
    };
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: plugin.id, source: "synthetic-external", origin: "config", plugin },
      ]),
    );
    getChannelPluginMock.mockReturnValue(plugin);
    const delivery = {
      mode: "none",
      channel: plugin.id,
      to: "room:current",
      ...(explicitAccount ? { accountId: "ops" } : {}),
    };
    resolveCronDeliveryPlanMock.mockReturnValue({
      ...delivery,
      requested: false,
      source: "delivery",
    });
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      mode: "explicit",
      channel: plugin.id,
      to: "room:current",
      accountId: "ops",
    });
    const jobId = "prompt-read-context";
    const marker = markCronJobActive(jobId, { isMessageActionAuthorityCurrent: () => true });
    const controller = new AbortController();
    runEmbeddedAgentMock.mockImplementation(async (run: RunEmbeddedAgentParams) => {
      const authorization = resolveMessageActionTurnAuthorization({
        token: run.messageActionTurnCapability,
        agentId: run.agentId ?? "main",
        runId: run.runId,
        sessionKey: run.sessionKey ?? "",
        sessionId: run.sessionId,
      });
      expect(authorization?.scheduled).toBeDefined();
      const read = runMessageAction({
        cfg: { channels: { "scheduled-reader": { enabled: true } } },
        action: "read",
        params: { channel: plugin.id, target: "room:current", accountId: "ops" },
        conversationReadOrigin: "delegated",
        messageActionAuthorization: authorization,
      });
      if (explicitAccount) {
        await expect(read).resolves.toMatchObject({ action: "read", handledBy: "plugin" });
      } else {
        await expect(read).rejects.toThrow("exact current conversation");
      }
      return { payloads: [], meta: { agentMeta: {} } };
    });
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          id: jobId,
          delivery,
          payload: { kind: "agentTurn", message: "read the current room", toolsAllow: ["message"] },
          scheduledToolPolicy: { version: 1, mode: "trusted" },
        }),
        deliveryAttemptFence: { beforeAttempt: async () => {}, assertCurrent: () => {} },
        executionIdentity: {
          ingress: { kind: "schedule", boundary: "cron.isolated-agent", state: "present" },
          onPostAdmission: (admitted: AdmittedRunContext) => {
            bindCronJobAdmittedRun(marker, admitted, controller.signal);
          },
        },
      }),
    );
    expect(result.status, result.error).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(handleAction).toHaveBeenCalledTimes(explicitAccount ? 1 : 0);
  },
);
