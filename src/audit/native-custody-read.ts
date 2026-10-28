import { sql } from "kysely";
import { validateDecisionReceiptV1 } from "../../packages/gateway-protocol/src/audit-run-validators.js";
import type {
  AuditRunCustodyParams,
  AuditRunCustodyResult,
} from "../../packages/gateway-protocol/src/schema/audit-run.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { runSqliteReadSnapshotSync } from "../infra/sqlite-transaction.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { EXECUTION_DECISION_FACT_RETENTION_MS } from "./execution-decision-facts.js";
import { NATIVE_CUSTODY_OWNERS } from "./native-custody-brand.js";

export function parseNativeCustodyCursor(cursor: string | undefined) {
  if (cursor === undefined) {
    return undefined;
  }
  const match = /^(0|[1-9]\d*):([1-9]\d*)$/u.exec(cursor);
  if (!match) {
    throw new Error("invalid native custody cursor");
  }
  const occurredAt = Number(match[1]);
  const cursorId = Number(match[2]);
  if (!Number.isSafeInteger(occurredAt) || !Number.isSafeInteger(cursorId)) {
    throw new Error("invalid native custody cursor");
  }
  return { occurredAt, cursorId };
}

export function readNativeCustodyFactsInDatabase(
  db: EngineConnection,
  input: AuditRunCustodyParams & { now: number },
): AuditRunCustodyResult {
  const cursor = parseNativeCustodyCursor(input.cursor);
  const limit = Math.min(100, Math.max(1, input.limit ?? 50));
  if (!tableExists(db, "execution_decision_facts")) {
    return { entries: [] };
  }
  return runSqliteReadSnapshotSync(db, () => {
    const kysely = getNodeSqliteKysely<Pick<DB, "execution_decision_facts">>(db);
    const base = () =>
      kysely
        .selectFrom("execution_decision_facts")
        .where("context_id", "=", input.contextId)
        .where("execution_id", "=", input.executionId)
        .where("owner", "in", [...NATIVE_CUSTODY_OWNERS])
        .where("occurred_at", ">=", input.now - EXECUTION_DECISION_FACT_RETENTION_MS);
    if (
      cursor &&
      executeSqliteQuerySync(
        db,
        base()
          .select("cursor_id")
          .where("cursor_id", "=", cursor.cursorId)
          .where("occurred_at", "=", cursor.occurredAt)
          .limit(1),
      ).rows.length !== 1
    ) {
      throw new Error("native custody cursor is no longer retained");
    }
    const rows = executeSqliteQuerySync(
      db,
      base()
        .$if(Boolean(cursor), (q) =>
          q.where((eb) =>
            eb.or([
              eb("occurred_at", ">", cursor!.occurredAt),
              eb.and([
                eb("occurred_at", "=", cursor!.occurredAt),
                eb("cursor_id", ">", cursor!.cursorId),
              ]),
            ]),
          ),
        )
        .selectAll()
        .where(sql<number>`length(CAST(receipt_json AS BLOB))`, "<=", 16 * 1024)
        .orderBy("occurred_at", "asc")
        .orderBy("cursor_id", "asc")
        .limit(limit + 1),
    ).rows;
    const page = rows.slice(0, limit);
    const entries: AuditRunCustodyResult["entries"] = [];
    for (const row of page) {
      try {
        const receipt: unknown = JSON.parse(row.receipt_json);
        if (
          !validateDecisionReceiptV1(receipt) ||
          receipt.contextId !== input.contextId ||
          receipt.executionId !== input.executionId ||
          receipt.runId !== row.run_id ||
          receipt.receiptId !== row.receipt_id ||
          receipt.source.owner !== row.owner ||
          receipt.occurredAt !== row.occurred_at ||
          JSON.stringify(receipt) !== row.receipt_json
        ) {
          continue;
        }
        const producer = receipt.source.owner;
        if (producer !== "cli-process" && producer !== "cron-standing-grant") {
          continue;
        }
        entries.push({
          receiptId: receipt.receiptId,
          family: receipt.action.family,
          operation: receipt.action.operation,
          outcome: receipt.decision.outcome,
          reasonCode: receipt.decision.reasonCode,
          occurredAt: receipt.occurredAt,
          ...(receipt.actionId ? { actionId: receipt.actionId } : {}),
          recordRef: receipt.source.recordRef,
          ...(receipt.action.resourceRef ? { resourceRef: receipt.action.resourceRef } : {}),
          ...(receipt.action.targetRef ? { targetRef: receipt.action.targetRef } : {}),
          policyRefs: receipt.enforcement.policyRefs,
          ...(receipt.action.summary ? { summary: receipt.action.summary } : {}),
          missingEvidence: receipt.missingEvidence,
          producer,
        });
      } catch {
        /* Corrupt or missing evidence cannot establish custody. */
      }
    }
    const last = page.at(-1);
    return {
      entries,
      ...(rows.length > limit && last
        ? { nextCursor: `${last.occurred_at}:${last.cursor_id}` }
        : {}),
    };
  });
}

export async function readNativeCustodyFacts(
  input: AuditRunCustodyParams,
): Promise<AuditRunCustodyResult> {
  const result = await executeExistingOpenClawStateRead(
    {},
    { type: "audit.nativeCustody", input: { ...input, now: Date.now() } },
  );
  if (!result) {
    if (input.cursor) {
      throw new Error("native custody cursor is no longer retained");
    }
    return { entries: [] };
  }
  if (result.type !== "audit.nativeCustody") {
    throw new Error("native custody read unavailable");
  }
  return result.result;
}
