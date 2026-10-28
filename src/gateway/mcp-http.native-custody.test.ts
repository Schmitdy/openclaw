import { expect, it, vi } from "vitest";
import { createExecTool } from "../agents/bash-tools.exec-run.js";
import {
  configureNativeCustodyFactSink,
  type NativeCustodyFactWork,
} from "../audit/native-custody-facts.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { bindCronJobAdmittedRun, resetCronActiveJobs } from "../cron/active-jobs.js";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { prepareCronRunAdmission } from "../cron/run-admission.js";
import { TEST_SCHEDULED_EXECUTION } from "../cron/scheduled-occurrence.test-support.js";
import { markServiceCronJobActive } from "../cron/service/run-receipts.js";
import { createCronServiceState } from "../cron/service/state.js";
import { upsertCronJobRow } from "../cron/store/row-codec.js";
import { claimCronRunReceiptForTest } from "../cron/store/run-receipt-store.test-support.js";
import { registerCronRunExecSource } from "../infra/cron-run-exec-source.js";
import { readExecApprovalsSnapshot, updateExecApprovals } from "../infra/exec-approvals-store.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { revokeMcpLoopbackClientGrant } from "./mcp-grant-store.js";
import * as request from "./mcp-http-request.test-support.js";
import { closeMcpLoopbackServer } from "./mcp-http.js";
import * as mcp from "./mcp-http.test-support.js";
import { buildCronExecOperationBinding } from "./operator-approval-standing-grants.js";
import { inspectCronStandingGrantInDatabase } from "./operator-approval-standing-grants.worker.js";
import {
  listCronStandingGrants,
  insertOperatorApproval,
  resolveOperatorApproval,
} from "./operator-approval-store.js";
import { createExecApprovalPresentation } from "./operator-approval-store.test-support.js";
import type { resolveGatewayScopedTools } from "./tool-resolution.js";

const resolveTools = vi.hoisted(() => vi.fn<typeof resolveGatewayScopedTools>());
// mock-isolation: Native admission, grants, HTTP dispatch, exec, and custody producers stay real.
vi.mock("./tool-resolution.js", async (original) => ({
  ...(await original<typeof import("./tool-resolution.js")>()),
  resolveGatewayScopedTools: resolveTools,
}));
// The fixture deliberately requires approval even if the harmless command matches a safe bin.
vi.mock("../infra/exec-approvals.js", async (original) => ({
  ...(await original<typeof import("../infra/exec-approvals.js")>()),
  requiresExecApproval: () => true,
}));
vi.mock("../agents/agent-tools.before-tool-call.js", async (original) => ({
  ...(await original<typeof import("../agents/agent-tools.before-tool-call.js")>()),
  runBeforeToolCallHook: async ({ params }: { params: unknown }) => ({ blocked: false, params }),
}));

it("joins real HTTP exec consumption to the exact admitted token and emits nothing for an unbound request", async () => {
  await withOpenClawTestState(
    {
      layout: "state-only",
      prefix: "mcp-native-custody-",
      env: { OPENCLAW_EXEC_SHELL_SNAPSHOT: "0", OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    },
    async (state) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: state.workspaceDir, skipBootstrap: true } },
        plugins: { enabled: false },
        logging: { audit: { executionIdentity: true } },
        tools: {
          allow: ["exec"],
          exec: { host: "gateway", security: "allowlist", ask: "on-miss" },
        },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const file = readExecApprovalsSnapshot().file;
      await updateExecApprovals({
        update: {
          kind: "replace",
          file: {
            ...file,
            defaults: { ...file.defaults, security: "allowlist", ask: "on-miss" },
          },
        },
      });
      const storeKey = state.path("synthetic-cron-store");
      const runId = "synthetic-u1-run";
      const sessionKey = "agent:main:cron:job-1";
      const command = process.platform === "win32" ? "echo synthetic-custody" : "/usr/bin/true";
      const job = makeCronJob({
        agentId: "main",
        name: "Synthetic custody proof",
        schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "synthetic only" },
      });
      upsertCronJobRow(openOpenClawStateDatabase().db, storeKey, job, 0);
      const revision = resolveCronJobConfigRevision(job);
      const receipt = claimCronRunReceiptForTest(storeKey, job, Date.now());
      const marker = markServiceCronJobActive(
        createCronServiceState({
          scheduler: createTestGatewayScheduler(),
          storePath: storeKey,
          cronEnabled: true,
          log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          enqueueSystemEvent: vi.fn(),
          runIsolatedAgentJob: vi.fn(),
        }),
        job,
        receipt,
      );
      const owner = prepareCronRunAdmission({
        scheduledExecution: TEST_SCHEDULED_EXECUTION,
        cfg,
        agentId: "main",
        runId,
        jobId: job.id,
        sessionKey,
        deliveryAttemptFence: null,
      });
      const controller = new AbortController();
      const facts: NativeCustodyFactWork[] = [];
      const clear = configureNativeCustodyFactSink((work) => {
        facts.push(work);
        return true;
      });
      let unregister: (() => void) | undefined;
      let grantToken: string | undefined;
      try {
        const admitted = await owner.preparedRunAdmission.admit("gateway");
        expect(admitted.executionIdentityToken).toBeDefined();
        bindCronJobAdmittedRun(marker, admitted, controller.signal);
        await insertOperatorApproval({
          approval: {
            id: "synthetic-u1-approval",
            kind: "exec",
            presentation: createExecApprovalPresentation(command),
            source: {
              agentId: "main",
              sessionKey,
              sessionId: "synthetic-session",
              runId,
              toolName: "exec",
            },
            runtimeEpoch: "synthetic-epoch",
            createdAtMs: Date.now() - 1,
            expiresAtMs: Date.now() + 60_000,
          },
        });
        expect(
          (
            await resolveOperatorApproval({
              id: "synthetic-u1-approval",
              decision: "allow-always",
              resolver: { kind: "device", id: "synthetic-reviewer" },
              standingGrant: {
                kind: "cron",
                agentId: "main",
                cronJobId: job.id,
                jobConfigRevision: revision,
                operationBinding: buildCronExecOperationBinding({
                  command,
                  cwd: state.workspaceDir,
                  env: undefined,
                }),
                expiresAtMs: null,
              },
            })
          ).outcome,
        ).toBe("resolved");
        const grantsBeforeInspection = await listCronStandingGrants({});
        const ownGrant = grantsBeforeInspection.find(
          (grant) => grant.mintedByApprovalId === "synthetic-u1-approval",
        );
        expect(ownGrant).toBeDefined();
        const inspection = {
          grantId: ownGrant!.grantId,
          source: {
            agentId: "main",
            cronJobId: job.id,
            jobConfigRevision: revision,
            handle: receipt,
          },
          expected: { command, cwd: state.workspaceDir },
        };
        const inspect = (source: typeof inspection.source) =>
          inspectCronStandingGrantInDatabase(openOpenClawStateDatabase().db, {
            ...inspection,
            source,
          });
        expect(inspect(inspection.source)).toMatchObject({
          grant: { evaluated: true, found: true },
          bindingMatches: true,
        });
        for (const source of [
          { ...inspection.source, agentId: "another-agent" },
          { ...inspection.source, cronJobId: "another-job" },
        ]) {
          expect(inspect(source)).toEqual({ grant: { evaluated: true, found: false } });
        }
        expect(await listCronStandingGrants({})).toEqual(grantsBeforeInspection);
        unregister = registerCronRunExecSource(runId, {
          agentId: "main",
          jobId: job.id,
          jobConfigRevision: revision,
          jobName: job.name,
          standingGrantAuthority: owner.standingGrantAuthority,
        });
        resolveTools.mockImplementation(async () =>
          mcp.scopedToolFixture(
            [
              createExecTool({
                config: cfg,
                host: "gateway",
                security: "allowlist",
                ask: "on-miss",
                cwd: state.workspaceDir,
                agentId: "main",
                runId,
                sessionKey,
                operationalRunInstance: admitted.operationalRunInstance,
              }),
            ],
            state.workspaceDir,
          ),
        );
        const { runtime } = await mcp.startLoopbackServerForTest();
        const grant = request.captureGrant(
          {
            runtimeOwnerToken: runtime.ownerToken,
            admittedRunContext: admitted,
            toolPolicyConfig: cfg,
            context: {
              sessionKey,
              agentId: "main",
              runId,
              trigger: "cron",
              workspaceDir: state.workspaceDir,
              cwd: state.workspaceDir,
              senderIsOwner: true,
              toolsAllow: ["exec"],
            },
          },
          "synthetic-u1-capture",
          (token) => {
            grantToken = token;
          },
        );
        const response = await request.request(
          runtime,
          request.toolCall("exec", { command, yieldMs: 10000 }),
          grant,
        );
        expect(await request.json(response)).toMatchObject({ result: { isError: false } });
        const consumption = facts.filter(
          (work) => work.receipt.action.family === "cron-grant-consume",
        );
        expect(consumption).toHaveLength(1);
        expect(consumption[0]?.token).toEqual(admitted.executionIdentityToken);
        expect(consumption[0]?.receipt.decision.outcome).toBe("allowed");
        expect(
          facts.filter((work) => work.receipt.action.family === "cron-grant-initiate"),
        ).toHaveLength(1);
        const before = facts.length;
        const unbound = await request.request(runtime, request.toolCall("exec", { command }), {
          token: "synthetic-unbound-token",
        });
        expect(unbound.status).toBe(401);
        await unbound.body?.cancel();
        expect(facts).toHaveLength(before);
      } finally {
        clear();
        if (grantToken) {
          revokeMcpLoopbackClientGrant(grantToken);
        }
        await closeMcpLoopbackServer();
        unregister?.();
        owner.close();
        resetCronActiveJobs();
        clearRuntimeConfigSnapshot();
        vi.restoreAllMocks();
      }
    },
  );
});
