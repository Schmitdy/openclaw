import {
  type AdmittedRunContext,
  type AdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../agents/admitted-run-context.js";
import type { ScheduledToolPolicyContext } from "../agents/scheduled-tool-policy.js";
import { isRuntimeToolAllowed } from "../agents/tool-policy-match.js";
import { withPostAdmissionExecutionOwnerBinding } from "../audit/execution-owner-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronAuthenticatedChannelRequester } from "../gateway/cron-creator-authority-grant.types.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../gateway/message-action-turn-capability.js";
import type { GatewayContextResolver } from "../gateway/server-methods/types.js";
import { drainAgentRunTerminalWrites } from "../infra/agent-run-terminal-writes.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";
import {
  captureCronJobMessageActionAuthority,
  captureCronJobMessageSourceAuthority,
  captureCronJobStandingGrantAuthority,
} from "./active-jobs.js";
import type { CronCompletionDeliveryFence } from "./delivery-attempt-fence.js";
import type { DeliveryTargetResolution } from "./isolated-agent/delivery-target.js";
import type { CronExecutionIdentityAdmission } from "./service/state.js";
import type { CronDelivery } from "./types.js";

/** Owns one cron tool admission and its private message grant through settlement. */
export function prepareCronRunAdmission(params: {
  admissionSource?: AdmittedRunContext["admissionSource"];
  assertSourceCurrent?: () => void;
  cfg: OpenClawConfig;
  agentId: string;
  runId: string;
  sessionId?: string;
  sessionKey: string;
  jobId: string;
  deliveryAttemptFence: CronCompletionDeliveryFence | null;
  channelRequester?: CronAuthenticatedChannelRequester;
  messageDelivery?: {
    requested?: Pick<CronDelivery, "mode" | "channel" | "to" | "accountId">;
    resolved: Pick<
      DeliveryTargetResolution,
      "ok" | "mode" | "channel" | "to" | "accountId" | "threadId"
    >;
  };
  toolsAllow?: string[];
  scheduledToolPolicy?: ScheduledToolPolicyContext;
  executionIdentity?: CronExecutionIdentityAdmission;
  ingressBoundary?: "cron.isolated-agent" | "cron.session-agent" | "cron.script";
  onAdmitted?: (context: AdmittedRunContext) => void;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  resolveGatewayContext?: GatewayContextResolver;
}) {
  const { runId, scheduledToolPolicy } = params;
  const operationalRunInstance = createOperationalRunInstanceRef(runId);
  const resolveGatewayContext =
    params.resolveGatewayContext ?? getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext;
  let assertAdmitted: (() => void) | undefined;
  const basePreparedRunAdmission = prepareAgentRunAdmission({
    operationalRunInstance,
    admissionSource: params.admissionSource,
    assertSourceCurrent: params.assertSourceCurrent,
    operatorAuthority: params.operatorAuthority,
    cfg: params.cfg,
    facts: {
      runId,
      agentId: params.agentId,
      ingress: params.executionIdentity?.ingress ?? {
        kind: "schedule",
        boundary: params.ingressBoundary ?? "cron.isolated-agent",
        state: "present",
      },
      ...(params.executionIdentity?.invoker ? { invoker: params.executionIdentity.invoker } : {}),
    },
    onAdmitted: (admitted) => {
      bindGatewayContextResolver(admitted, resolveGatewayContext);
      assertAdmitted = resolveAdmittedRunActiveAssertion(admitted);
      params.onAdmitted?.(admitted);
    },
  });
  const preparedRunAdmission = params.executionIdentity?.onPostAdmission
    ? withPostAdmissionExecutionOwnerBinding(
        basePreparedRunAdmission,
        params.executionIdentity.onPostAdmission,
      )
    : basePreparedRunAdmission;
  const scheduledMessageAuthority =
    scheduledToolPolicy && isRuntimeToolAllowed("message", params.toolsAllow)
      ? captureCronJobMessageActionAuthority({ jobId: params.jobId, operationalRunInstance })
      : undefined;
  const scheduledMessageSourceAuthority = scheduledMessageAuthority
    ? captureCronJobMessageSourceAuthority({ jobId: params.jobId, operationalRunInstance })
    : undefined;
  // Only original explicit operator routing can become current read context.
  // Resolution alone may have inherited an account or destination from history.
  const requested = params.messageDelivery?.requested;
  const resolved = params.messageDelivery?.resolved;
  const channel = requested?.channel?.trim().toLowerCase();
  const accountId = requested?.accountId?.trim();
  const currentConversation =
    scheduledMessageAuthority &&
    scheduledToolPolicy?.mode === "trusted" &&
    requested?.mode !== "webhook" &&
    channel &&
    channel !== "last" &&
    channel !== INTERNAL_MESSAGE_CHANNEL &&
    requested?.to?.trim() &&
    accountId &&
    resolved?.ok &&
    resolved.mode === "explicit" &&
    resolved.channel === channel &&
    resolved.accountId === accountId &&
    resolved.to?.trim()
      ? { channel, accountId, to: resolved.to, threadId: resolved.threadId }
      : undefined;
  const deliveryAttemptFence = params.deliveryAttemptFence;
  if (scheduledMessageAuthority && !deliveryAttemptFence) {
    preparedRunAdmission.close();
    throw new Error("scheduled message authority requires its occurrence delivery fence");
  }
  // This opaque token remains unusable until this exact operational instance
  // is admitted by the live occurrence. Scheduled runners redeem the same host grant.
  const messageActionTurnCapability = deliveryAttemptFence
    ? mintMessageActionTurnCapability({
        agentId: params.agentId,
        runId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        requesterAccountId:
          scheduledMessageAuthority && scheduledToolPolicy?.mode === "account"
            ? scheduledToolPolicy.ownerAccountId
            : currentConversation?.accountId,
        ...(currentConversation
          ? {
              toolContext: {
                currentChannelProvider: currentConversation.channel,
                currentChannelId: currentConversation.to,
                currentMessagingTarget: currentConversation.to,
                ...(currentConversation.threadId !== undefined
                  ? { currentThreadTs: String(currentConversation.threadId) }
                  : {}),
              },
            }
          : {}),
        deliveryAttempt: {
          beforeAttempt: () => deliveryAttemptFence.beforeAttempt(),
          assertCurrent: () => {
            if (!assertAdmitted) {
              throw new Error("cron message delivery requires its admitted run");
            }
            assertAdmitted();
            deliveryAttemptFence.assertCurrent();
          },
        },
        ...(scheduledMessageAuthority && scheduledToolPolicy
          ? {
              scheduled: {
                policy: scheduledToolPolicy,
                assertCurrent: scheduledMessageAuthority,
                ...(scheduledMessageSourceAuthority
                  ? { assertSourceCurrent: scheduledMessageSourceAuthority }
                  : {}),
                ...(params.channelRequester ? { channelRequester: params.channelRequester } : {}),
              },
            }
          : {}),
        expiresWithRun: true,
      })
    : undefined;
  const close = () => {
    revokeMessageActionTurnCapability(messageActionTurnCapability);
    preparedRunAdmission.close();
  };
  return {
    preparedRunAdmission,
    standingGrantAuthority: captureCronJobStandingGrantAuthority({
      jobId: params.jobId,
      operationalRunInstance,
    }),
    messageActionTurnCapability,
    close,
    finish: async () => {
      await drainAgentRunTerminalWrites(preparedRunAdmission.operationalRunInstance).finally(close);
    },
  };
}
