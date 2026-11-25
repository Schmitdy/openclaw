import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../../scripts/lib/package-dist-inventory.js";
import { defaultPayload } from "../../infra/gateway-state-owner-record.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import {
  resolvePackageActivationHelper,
  resolvePackageActivationJournalPath,
} from "../../infra/package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "../../infra/package-update-activation-lifetime.test-support.js";
import { assertNoPendingPackageActivation } from "../../infra/package-update-activation.js";
import * as packageFilesystem from "../../infra/package-update-filesystem.js";
import { createPackageIntegrityReader } from "../../infra/package-update-integrity.js";
import { createPublicationOwner } from "../../infra/package-update-publication-owner.js";
import { writePackageRoot } from "../../infra/package-update-steps.test-support.js";
import { createRetainedUpdateRecovery } from "../../infra/update-retained-recovery.test-support.js";
import { readUpdateRunDriver } from "../../infra/update-run-driver.js";
import { createUpdateRun, finishUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { runRegisteredCli } from "../../test-utils/command-runner.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { writeFixtureJsonSync } from "../cli-fixtures.test-support.js";
import { registerUpdateCli } from "../update-cli.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { createInterruptedPackagePublication } from "./update-package-publication.test-support.js";
import { updateRepairCommand } from "./update-repair-command.js";

const mocks = vi.hoisted(() => ({ root: vi.fn(), finalize: vi.fn() }));
vi.mock("./shared.js", async (original) => ({
  ...(await original<typeof import("./shared.js")>()),
  resolveUpdateRoot: mocks.root,
}));
// mock-isolation: finalization is an effect sink; package and state custody stay real.
vi.mock("./update-command-finalize.js", () => ({ updateFinalizeCommand: mocks.finalize }));

const fixtures = createPackageActivationLifetimeFixture();
let state: OpenClawTestState;
let fixtureRoot: string;
beforeEach(async () => {
  vi.clearAllMocks();
  fixtureRoot = fixtures.setup().root;
  state = await createOpenClawTestState({
    label: "repair-package-activation",
    env: { OPENCLAW_UPDATE_RUN_ID: undefined },
  });
  await state.writeConfig({ plugins: { enabled: false } });
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
  mocks.finalize.mockImplementation(async () => {
    assertNoPendingPackageActivation(await mocks.root());
  });
});
afterEach(async () => {
  await state.cleanup();
  await fixtures.lifetime.cleanup();
  vi.restoreAllMocks();
});

function readArchivedSettlement(anchor: string, operationId: string) {
  const db = new DatabaseSync(
    path.join(`${anchor}.superseded-${operationId}`, "control/operation.sqlite"),
    { readOnly: true },
  );
  try {
    const row = db
      .prepare("SELECT phase, intent_json, descriptor_json FROM package_activation WHERE slot = 1")
      .get()!;
    return {
      phase: row.phase,
      intent: JSON.parse(String(row.intent_json)),
      descriptor: JSON.parse(String(row.descriptor_json)),
    };
  } finally {
    db.close();
  }
}

describe.skipIf(process.platform === "win32")("offline package settlement only", () => {
  async function supersededRetirement() {
    const f = await createInterruptedPackagePublication(fixtureRoot, "publication-complete", {
      previous: "2026.10.1",
      candidate: "2026.11.3",
    });
    mocks.root.mockResolvedValue(f.packageRoot);
    writeConfigMachineState("offline-settlement-fixture", { keep: true });
    const remove = vi
      .spyOn(packageFilesystem, "removePackagePath")
      .mockRejectedValueOnce(new Error("interrupted previous retirement"));
    try {
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(f.packageRoot);
        await expect(
          createPublicationOwner(f.anchor, f.journal, fence.assertCurrent, f.record).retire(),
        ).rejects.toThrow("interrupted previous retirement");
      });
    } finally {
      remove.mockRestore();
    }
    const record = f.journal.read();
    expect(record).toMatchObject({
      phase: "retiring",
      intent: { kind: "remove", name: "previous", selected: "candidate" },
    });
    fs.renameSync(f.packageRoot, `${f.packageRoot}.manually-replaced`);
    await writePackageRoot(f.packageRoot, "2026.11.10");
    writeFixtureJsonSync(path.join(f.packageRoot, "package.json"), {
      name: "openclaw",
      version: "2026.11.10",
      type: "module",
      bin: { openclaw: "openclaw.mjs" },
      main: "dist/index.js",
    });
    fs.writeFileSync(path.join(f.packageRoot, "openclaw.mjs"), 'import "./dist/index.js";\n');
    writeFixtureJsonSync(path.join(f.packageRoot, "dist/build-info.json"), {
      version: "2026.11.10",
    });
    await writePackageDistInventory(f.packageRoot);
    fs.renameSync(f.launcher, `${f.launcher}.manually-replaced`);
    fs.symlinkSync("../lib/node_modules/openclaw/openclaw.mjs", f.launcher);
    const lease = record.descriptor.authority.databasePath;
    fs.renameSync(lease, `${lease}.old`);
    fs.copyFileSync(`${lease}.old`, lease);
    fs.chmodSync(lease, 0o600);
    return {
      ...f,
      record,
      lease,
      retained: `${f.anchor}.superseded-${record.descriptor.operationId}`,
    };
  }

  const invoke = () => updateRepairCommand({ json: true, settlePackageOnly: true });

  it("closes verified manual supersession without finalization or changing unrelated state", async () => {
    const f = await supersededRetirement();
    const run = createUpdateRun({ trigger: "cli" });
    finishUpdateRun(run.runId, { status: "failed", reason: "package-failure" });
    const originalRun = getUpdateRun(run.runId)!;
    const capture = state.statePath("update-recovery", "unrelated-capture");
    fs.mkdirSync(capture, { recursive: true });
    fs.writeFileSync(path.join(capture, "manifest.json"), "unrelated capture\n");
    const databasePath = resolveOpenClawStateSqlitePath(state.env);
    await closeStateDatabaseForTest();
    const database = fs.readFileSync(databasePath);
    const config = fs.readFileSync(state.configPath);
    const installed = await createPackageIntegrityReader().tree(f.packageRoot);
    const previous = await createPackageIntegrityReader().tree(path.join(f.anchor, "previous"));
    const helper = fs.readFileSync(resolvePackageActivationHelper(f.anchor));
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
    await invoke();
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(readArchivedSettlement(f.anchor, f.record.descriptor.operationId)).toMatchObject({
      phase: "superseded",
      descriptor: f.record.descriptor,
      intent: {
        kind: "superseded-by-manual-install",
        settled: true,
        detail: expect.stringContaining("Inventoried dist content mismatches: none"),
      },
    });
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "warning",
        mode: "package-settlement",
        restart: false,
        operationId: f.record.descriptor.operationId,
        retained: f.retained,
      }),
    );
    expect(fs.readFileSync(databasePath)).toEqual(database);
    expect(fs.readFileSync(state.configPath)).toEqual(config);
    expect(getUpdateRun(originalRun.runId)).toEqual(originalRun);
    expect(fs.readFileSync(path.join(capture, "manifest.json"), "utf8")).toBe(
      "unrelated capture\n",
    );
    expect(await createPackageIntegrityReader().tree(f.packageRoot)).toEqual(installed);
    expect(await createPackageIntegrityReader().tree(path.join(f.retained, "previous"))).toEqual(
      previous,
    );
    expect(fs.readFileSync(path.join(f.retained, "control/recovery.mjs"))).toEqual(helper);
    expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
  });

  it("exposes settlement only through the public repair command", async () => {
    const f = await supersededRetirement();
    await runRegisteredCli({
      register: registerUpdateCli,
      argv: ["update", "repair", "--settle-package-only", "--no-restart", "--yes"],
    });
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(fs.existsSync(f.retained)).toBe(true);
  });

  it.each([
    ["unchanged lease", /verified changed lease/u],
    ["missing lease", /verified changed lease/u],
    ["not newer", /verified newer manual installation/u],
    ["different root", /existing retiring operation/u],
    ["wrong phase", /superseded retiring/u],
    ["unfinished rollback", /superseded retiring/u],
    ["wrong retirement", /superseded retiring/u],
    ["dist drift", /inventoried dist files changed/u],
    ["launcher drift", /launcher changed/u],
    ["invalid manifest", /package.json/u],
    ["active update", /remains recorded as running/u],
    ["unknown driver", /remains recorded as running/u],
    ["pending restore", /Interrupted shared-database publication/u],
    ["pending recovery", /unfinished recovery/u],
    ["corrupt journal", /database|SQLite|sqlite/u],
    ["channel change", /fresh repair/u],
  ] as const)(
    "refuses %s without changing package evidence or finalizing",
    async (failure, message) => {
      const f = await supersededRetirement();
      if (failure === "unchanged lease") {
        fs.unlinkSync(f.lease);
        fs.renameSync(`${f.lease}.old`, f.lease);
      } else if (failure === "missing lease") {
        fs.unlinkSync(f.lease);
      } else if (failure === "not newer") {
        writeFixtureJsonSync(path.join(f.packageRoot, "package.json"), {
          name: "openclaw",
          version: "2026.11.3",
          type: "module",
        });
      } else if (failure === "different root") {
        mocks.root.mockResolvedValue(state.root);
      } else if (["wrong phase", "unfinished rollback", "wrong retirement"].includes(failure)) {
        await withUpdateCommandExecutor(randomUUID(), async (executor) => {
          const fence = await executor.enter(f.packageRoot);
          f.journal.transition(
            f.journal.read(),
            failure === "wrong phase"
              ? "publishing"
              : failure === "unfinished rollback"
                ? "rollback-in-progress"
                : "retiring",
            failure === "wrong retirement" ? { kind: "retire", selected: "previous" } : null,
            fence.assertCurrent,
          );
        });
      } else if (failure === "dist drift") {
        fs.writeFileSync(path.join(f.packageRoot, "dist/index.js"), "changed\n");
      } else if (failure === "launcher drift") {
        fs.unlinkSync(f.launcher);
        fs.symlinkSync("elsewhere", f.launcher);
      } else if (failure === "invalid manifest") {
        writeFixtureJsonSync(path.join(f.packageRoot, "package.json"), {
          name: "other",
          version: "2026.11.10",
        });
      } else if (failure === "active update" || failure === "unknown driver") {
        const driver = readUpdateRunDriver()!;
        createUpdateRun({
          trigger: "cli",
          origin: {
            driver: failure === "unknown driver" ? { ...driver, host: "unknown.invalid" } : driver,
          },
        });
      } else if (failure === "pending restore") {
        fs.mkdirSync(
          path.join(
            path.dirname(resolveOpenClawStateSqlitePath(state.env)),
            ".openclaw-restore-pending",
          ),
        );
      } else if (failure === "pending recovery") {
        const runtime = {
          root: f.packageRoot,
          nodePath: process.execPath,
          version: "2026.11.3",
          buildId: null,
        };
        createRetainedUpdateRecovery({ runId: randomUUID(), from: runtime, to: runtime });
      } else if (failure === "corrupt journal") {
        fs.writeFileSync(resolvePackageActivationJournalPath(f.anchor), "corrupt\n");
      }
      const journal = fs.readFileSync(resolvePackageActivationJournalPath(f.anchor));
      await expect(
        updateRepairCommand({
          json: true,
          settlePackageOnly: true,
          ...(failure === "channel change" ? { channel: "beta" } : {}),
        }),
      ).rejects.toThrow(message);
      expect(fs.readFileSync(resolvePackageActivationJournalPath(f.anchor))).toEqual(journal);
      expect(fs.existsSync(f.retained)).toBe(false);
      expect(mocks.finalize).not.toHaveBeenCalled();
    },
  );

  it.each(["package executor", "Gateway state owner"] as const)(
    "refuses a live %s",
    async (owner) => {
      const f = await supersededRetirement();
      const journal = fs.readFileSync(resolvePackageActivationJournalPath(f.anchor));
      if (owner === "package executor") {
        await withUpdateCommandExecutor(randomUUID(), async (executor) => {
          await executor.enter(f.packageRoot);
          await expect(invoke()).rejects.toThrow(/executor|owns/u);
        });
      } else {
        const databasePath = resolveOpenClawStateSqlitePath(state.env);
        const lease = acquireGatewayStateOwner({
          databasePath,
          payload: { ...defaultPayload(databasePath), role: "gateway" },
        });
        try {
          await expect(invoke()).rejects.toThrow(/offline|Gateway/u);
        } finally {
          lease.release();
        }
      }
      expect(fs.readFileSync(resolvePackageActivationJournalPath(f.anchor))).toEqual(journal);
      expect(fs.existsSync(f.retained)).toBe(false);
      expect(mocks.finalize).not.toHaveBeenCalled();
    },
  );
});
