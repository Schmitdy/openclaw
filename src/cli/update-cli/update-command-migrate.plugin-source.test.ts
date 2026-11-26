import fs from "node:fs/promises";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import * as doctorUi from "../../commands/doctor-ui.js";
import * as pluginConvergence from "../../commands/doctor/shared/post-core-plugin-convergence.js";
import { resolveConfigWidePluginMetadataSnapshotAsync } from "../../config/io.plugin-metadata.js";
import { isUpdateAdmissionAuthorityEnvKey } from "../../infra/update-admission-contract.js";
import * as candidateCheck from "../../infra/update-candidate-check.js";
import { closeDefaultRetainedNativeWorkerSource } from "../../infra/worker-native-lifecycle.js";
import { refreshPersistedInstalledPluginIndex } from "../../plugins/installed-plugin-index-store-write.js";
import { createPluginCache, withPluginCache } from "../../plugins/plugin-cache.js";
import { defaultRuntime } from "../../runtime.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { updateMigrateCommand, updateRestoreCommand } from "./update-command-migrate.js";
import { updatePreflightCommand } from "./update-command-preflight.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDefaultRetainedNativeWorkerSource();
});

it.each(["ready", "incompatible", "unprepared"] as const)(
  "preflights selected external Doctor source before native migration (%s)",
  async (condition) => {
    // Worker-thread tests bypass the source-preparation guard exercised by native migration.
    expect(isMainThread).toBe(true);
    await withOpenClawTestState(
      {
        scenario: "minimal",
        env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_SUPERVISOR_MODE: "external" },
      },
      async (state) => {
        vi.spyOn(doctorUi, "maybeRepairUiProtocolFreshness").mockResolvedValue();
        const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
        const errors = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
        vi.spyOn(candidateCheck, "checkUpdateCandidate").mockResolvedValue({
          status: "ok",
          steps: [],
        });
        const root = state.statePath("extensions", "codex");
        await fs.mkdir(root, { recursive: true });
        for (const [name, content] of Object.entries({
          "package.json": JSON.stringify({
            name: "@openclaw/codex",
            version: "1.0.0",
            type: "module",
            openclaw: { extensions: ["./index.mjs"] },
          }),
          "openclaw.plugin.json": JSON.stringify({
            id: "codex",
            configSchema: {
              type: "object",
              properties: { current: { type: "boolean" } },
              additionalProperties: false,
            },
            providers: ["codex"],
            providerCatalogEntry: "./provider-discovery.mjs",
            doctorContract: {
              configRepair: true,
              stateMigrations: [{ id: "fixture-state", doctorOnly: true }],
            },
          }),
          "index.mjs": "throw new Error('native migration must not load plugin runtime');",
          "provider-discovery.mjs": "export default { id: 'codex', label: 'Fixture', auth: [] };",
          "provider-policy-api.js":
            "export const normalizeModelCatalogId = ({ modelId }) => modelId;",
          "doctor-contract-api.mjs": `export const legacyConfigRules = [{ path: ["plugins", "entries", "codex", "config", "legacy"], message: "legacy fixture setting" }];
          export const stateMigrations = [{ id: "fixture-state", label: "Fixture state", doctorOnly: true, detectLegacyState() { return null; }, migrateLegacyState() { throw new Error("no fixture state requires migration"); }, collectBackupResources() { return []; } }];
          export function normalizeCompatibilityConfig({ cfg }) {
            const config = cfg.plugins?.entries?.codex?.config;
            if (!config || config.legacy === undefined) return { config: cfg, changes: [] };
            config.current = config.legacy; delete config.legacy;
            return { config: cfg, changes: ["Migrated fixture setting"] };
          }`,
        })) {
          await fs.writeFile(path.join(root, name), content);
        }
        await state.writeConfig({
          agents: {
            defaults: { heartbeat: { every: "17m", target: "none" } },
            entries: { main: { workspace: state.workspaceDir } },
          },
          plugins: {
            allow: ["codex"],
            entries: { codex: { enabled: true, config: { legacy: true } } },
          },
          gateway: { mode: "local", controlUi: { enabled: false }, auth: { mode: "none" } },
        });
        const original = await fs.readFile(state.configPath, "utf8");
        openOpenClawStateDatabase();
        await closeOpenClawStateDatabaseAsync();
        await refreshPersistedInstalledPluginIndex({
          config: JSON.parse(original),
          env: state.env,
          stateDir: state.stateDir,
          reason: "source-changed",
          installRecords: {
            codex: { source: "path", sourcePath: root, installPath: root, version: "1.0.0" },
          },
        });
        const selected = await resolveConfigWidePluginMetadataSnapshotAsync({
          config: JSON.parse(original),
          env: state.env,
        });
        expect(
          selected.manifestRegistry.plugins.find((record) => record.id === "codex"),
        ).toMatchObject({
          rootDir: root,
          origin: "global",
          doctorContract: { configRepair: true },
        });
        const convergence = vi
          .spyOn(pluginConvergence, "runPostCorePluginConvergence")
          .mockRejectedValue(
            new Error("Generic plugin convergence must not run during native migration"),
          );
        if (condition === "incompatible") {
          const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
          pkg.openclaw.install = { minHostVersion: ">=2099.1.1" };
          await fs.writeFile(path.join(root, "package.json"), JSON.stringify(pkg));
        } else if (condition === "unprepared") {
          await fs.writeFile(
            path.join(root, "doctor-contract-api.mjs"),
            "import './missing-source.mjs';",
          );
        }
        const readPluginFiles = async () =>
          Promise.all(
            (await fs.readdir(root))
              .toSorted()
              .map(async (name) => [name, await fs.readFile(path.join(root, name), "utf8")]),
          );
        const pluginFilesBefore = await readPluginFiles();
        const database = state.statePath("state", "openclaw.sqlite");
        await closeOpenClawStateDatabaseAsync();
        const databaseBefore = await fs.readFile(database);
        const backupRoot = state.path("external-source-recovery", "native");
        const exitCode = process.exitCode;
        try {
          await withEnvAsync(
            Object.fromEntries(
              Object.keys(process.env)
                .filter(isUpdateAdmissionAuthorityEnvKey)
                .map((key) => [key, undefined]),
            ),
            () => updatePreflightCommand(),
          );
          expect(output).toHaveBeenLastCalledWith(
            expect.objectContaining({ status: condition === "ready" ? "ready" : "unverified" }),
          );
          if (condition !== "ready") {
            expect(errors).toHaveBeenLastCalledWith(
              expect.stringMatching(
                condition === "incompatible"
                  ? /2099\.1\.1/
                  : /config repair|missing-source|Doctor.*source/i,
              ),
            );
          }
        } finally {
          process.exitCode = exitCode;
        }
        expect(await fs.readFile(state.configPath, "utf8")).toBe(original);
        expect(await fs.readFile(database)).toEqual(databaseBefore);
        expect(await readPluginFiles()).toEqual(pluginFilesBefore);
        if (condition !== "ready") {
          await using refusedCache = createPluginCache();
          await expect(
            withPluginCache(refusedCache, () => updateMigrateCommand(backupRoot)),
          ).rejects.toThrow(
            condition === "incompatible"
              ? /2099\.1\.1/
              : /config repair|missing-source|Doctor.*source/i,
          );
          expect(await fs.readFile(state.configPath, "utf8")).toBe(original);
          expect(await fs.readFile(database)).toEqual(databaseBefore);
          await expect(fs.stat(`${backupRoot}.receipt.json`)).rejects.toMatchObject({
            code: "ENOENT",
          });
          expect(convergence).not.toHaveBeenCalled();
          expect(await readPluginFiles()).toEqual(pluginFilesBefore);
          return;
        }

        await using candidateCache = createPluginCache();
        await withPluginCache(candidateCache, () => updateMigrateCommand(backupRoot));
        expect(JSON.parse(await fs.readFile(`${backupRoot}.receipt.json`, "utf8")).status).toBe(
          "migrated",
        );
        expect(
          JSON.parse(await fs.readFile(state.configPath, "utf8")).agents.defaults,
        ).not.toHaveProperty("heartbeat");
        expect(await readPluginFiles()).toEqual(pluginFilesBefore);
        expect(convergence).not.toHaveBeenCalled();
        await updateRestoreCommand(backupRoot);
        expect(await fs.readFile(state.configPath, "utf8")).toBe(original);
      },
    );
  },
);
