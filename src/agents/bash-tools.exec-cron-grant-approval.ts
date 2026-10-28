import { createHash, randomUUID } from "node:crypto";
import { recordNativeCustodyEvent } from "../audit/native-custody-facts.js";
import type { CronRunExecSource } from "../infra/cron-run-exec-source.js";
import type { ExecAsk, ExecSecurity } from "../infra/exec-approvals.js";
import { prepareCronStandingGrantConsumption } from "./bash-tools.exec-cron-grant.js";
import { buildGatewayExecApprovalDeniedToolResult } from "./bash-tools.exec-host-gateway.output.js";
import type {
  ProcessGatewayAllowlistParams,
  ProcessGatewayAllowlistResult,
} from "./bash-tools.exec-host-gateway.types.js";

/** Resolve a standing-grant use without changing the Gateway policy decision. */
export async function resolveCronStandingGrantGatewayApproval(
  params: ProcessGatewayAllowlistParams,
  ctx: {
    source: CronRunExecSource;
    security: ExecSecurity;
    ask: ExecAsk;
    enforcedCommand: string | undefined;
    emitApprovalEvent(event: {
      action: "exec.approval.requested" | "exec.approval.approved" | "exec.approval.denied";
      outcome: "success" | "denied" | "error";
      severity: "low" | "medium" | "high";
      reason?: string;
      decision?: string | null;
    }): void;
  },
): Promise<ProcessGatewayAllowlistResult | undefined> {
  const {
    source: cronExecutionSource,
    security: hostSecurity,
    ask: hostAsk,
    enforcedCommand,
    emitApprovalEvent,
  } = ctx;
  let consumeGrant: Awaited<ReturnType<typeof prepareCronStandingGrantConsumption>>;
  try {
    consumeGrant = await prepareCronStandingGrantConsumption(params, cronExecutionSource, {
      security: hostSecurity,
      ask: hostAsk,
    });
  } catch {
    consumeGrant = undefined;
  }
  if (consumeGrant) {
    const consume = consumeGrant.consume;
    const custody = consumeGrant;
    const token = params.executionIdentityToken;
    const useId = token
      ? createHash("sha256")
          .update(
            JSON.stringify([
              token.contextId,
              token.executionId,
              params.toolCallId ?? randomUUID(),
              custody.grantId,
            ]),
          )
          .digest("hex")
      : "";
    let consumptionRecorded = false;
    const recordUse = (outcome: string, useCount?: number) => {
      if (consumptionRecorded || !token) {
        return;
      }
      consumptionRecorded = true;
      recordNativeCustodyEvent({
        token,
        owner: "cron-standing-grant",
        family: "cron-grant-consume",
        operation: "consume",
        receiptId: `cron-grant-use:${useId}`,
        recordRef: custody.receiptId,
        ...(params.toolCallId
          ? {
              actionId: `tool-call:${createHash("sha256").update(params.toolCallId).digest("hex")}`,
            }
          : {}),
        outcome: outcome === "consumed" ? "allowed" : outcome === "unknown" ? "unknown" : "denied",
        reasonCode: outcome,
        summary: `useCount=${useCount ?? "unknown"} receipt=${custody.receiptId}`,
        refs: {
          resource: { namespace: "cron-standing-grant", value: custody.grantId },
          target: { namespace: "cron-operation-binding", value: custody.operationBindingDigest },
        },
      });
    };

    const emitGrantEvent = (approved: boolean, reason: string) =>
      emitApprovalEvent({
        action: approved ? "exec.approval.approved" : "exec.approval.denied",
        outcome: approved ? "success" : "denied",
        severity: "medium",
        reason,
        decision: "standing-grant",
      });
    return {
      execCommandOverride: enforcedCommand,
      assertCurrent: consumeGrant.assertCurrent,
      initiateSpawn: (launch, settlement) => {
        const result = custody.initiateSpawn(launch, settlement);
        recordNativeCustodyEvent({
          token,
          owner: "cron-standing-grant",
          family: "cron-grant-initiate",
          operation: "initiate",
          receiptId: `cron-grant-initiate:${useId}`,
          recordRef: custody.receiptId,
          ...(params.toolCallId
            ? {
                actionId: `tool-call:${createHash("sha256").update(params.toolCallId).digest("hex")}`,
              }
            : {}),
          outcome: "allowed",
          reasonCode: "cron_exec_initiated",
          summary: `receipt=${custody.receiptId}`,
          refs: {
            resource: { namespace: "cron-standing-grant", value: custody.grantId },
            target: {
              namespace: "cron-operation-binding",
              value: custody.operationBindingDigest,
            },
          },
        });
        return result;
      },
      releaseSpawn: consumeGrant.releaseSpawn,
      revalidateBeforeExecution: async () => {
        let grantUse: Awaited<ReturnType<typeof consume>> | undefined;
        try {
          grantUse = await consume(params.signal);
        } catch {
          grantUse = undefined;
        }
        const grant = grantUse?.outcome === "consumed" ? grantUse.grant : undefined;
        recordUse(grantUse?.outcome ?? "unknown", grant?.useCount);
        if (grant && (grant.expiresAtMs === null || grant.expiresAtMs > Date.now())) {
          emitGrantEvent(
            true,
            `standing-grant grant=${grant.grantId} approval=${grant.mintedByApprovalId}`,
          );
          return undefined;
        }
        const reason = grant ? "expired" : (grantUse?.outcome ?? "grant-store-unavailable");
        emitGrantEvent(false, `standing-grant-invalidated ${reason}`);
        return buildGatewayExecApprovalDeniedToolResult({
          deniedReason: `standing grant no longer valid (${reason}); the next occurrence will prompt for approval again`,
          command: params.command,
          cwd: params.workdir,
        });
      },
    };
  }
  return undefined;
}
