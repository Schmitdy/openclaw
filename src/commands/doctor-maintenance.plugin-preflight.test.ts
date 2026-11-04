import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { autoMigrateLegacyState } from "../infra/state-migrations.doctor.js";
import {
  refreshPersistedInstalledPluginIndex,
  writePersistedInstalledPluginIndex,
} from "../plugins/installed-plugin-index-store-write.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { capturePluginNativeNamespace } from "../plugins/plugin-native-namespace.js";
import { pluginSourceStatIdentity } from "../plugins/plugin-source-file.js";
import { writeManagedNpmPlugin } from "../plugins/test-helpers/managed-npm-plugin.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

const serviceInspection = vi.hoisted(() => vi.fn());
vi.mock("../cli/update-cli/update-command-service-maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../cli/update-cli/update-command-service-maintenance.js")
  >()),
  maybeStopManagedServiceBeforeMutableUpdate: serviceInspection,
}));
vi.mock("../config/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/paths.js")>()),
  isDefaultInstallIdentity: () => true,
}));
vi.mock("./doctor-service-repair-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor-service-repair-policy.js")>()),
  shouldManageGatewayService: async () => true,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.unstubAllEnvs();
  serviceInspection.mockReset();
  clearPluginMetadataLifecycleCaches();
  closeOpenClawStateDatabaseForTest();
});

it.each([
  "first-install",
  "healthy-capture",
  "missing-companion",
  "expired-capture",
  "module-error",
] as const)("preflights selected Doctor artifacts before maintenance (%s)", async (capture) => {
  const root = tempDirs.make("openclaw-doctor-plugin-maintenance-");
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "openclaw.json");
  const bundledDir = path.join(root, "bundled-disabled");
  fs.mkdirSync(bundledDir);
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledDir);
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  vi.stubEnv("OPENCLAW_HOME", undefined);
  const pluginId = "fixture-maintenance-owner";
  const packageName = `@fixture/${pluginId}`;
  const pluginDir = writeManagedNpmPlugin({ stateDir, packageName, pluginId, version: "1.0.0" });
  const marker = (name: string) => path.join(root, `${name}.marker`);
  const writeMarker = (name: string) =>
    `require("node:fs").writeFileSync(${JSON.stringify(marker(name))}, "executed");`;
  const writeJson = (name: string, value: unknown) =>
    fs.writeFileSync(path.join(pluginDir, name), JSON.stringify(value));
  writeJson("package.json", {
    name: packageName,
    version: "1.0.0",
    openclaw: {
      extensions: ["./dist/index.js"],
      setupEntry: "./dist/setup-entry.cjs",
      setupFeatures: { legacySessionSurfaces: true },
      channel: { id: "fixture-chat" },
    },
  });
  writeJson("openclaw.plugin.json", {
    id: pluginId,
    channels: ["fixture-chat"],
    doctorContract: { stateMigrations: true, resolveSessionStoreAgentIds: true },
    configSchema: { type: "object" },
  });
  fs.writeFileSync(
    path.join(pluginDir, "dist", "setup-entry.cjs"),
    `${writeMarker("setup")}
  module.exports = {
    kind: "bundled-channel-setup-entry",
    loadLegacySessionSurface() {
      return { canonicalizeLegacySessionKey() { return null; } };
    },
  };`,
  );
  fs.writeFileSync(
    path.join(pluginDir, "doctor-contract-api.cjs"),
    `${writeMarker("doctor")}
  ${capture === "module-error" ? 'throw Object.assign(new Error("fixture contract resource missing"), { code: "ENOENT" });' : ""}
  module.exports = {
    resolveSessionStoreAgentIds() { ${writeMarker("session-agent")} return []; },
    stateMigrations: [{
      id: "fixture-state", label: "Fixture state", doctorOnly: true,
      detectLegacyState() {
        return require("node:fs").existsSync(${JSON.stringify(marker("migrated"))})
          ? null : { preview: ["Repair plugin-owned state"] };
      },
      migrateLegacyState() {
        ${writeMarker("migrated")}
        return { changes: ["Repaired plugin-owned state"], warnings: [] };
      },
    }],
  };`,
  );
  const config: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: { main: { workspace: path.join(root, "workspace") } },
    },
    plugins: { allow: [pluginId], entries: { [pluginId]: { enabled: true } } },
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const index = await refreshPersistedInstalledPluginIndex({
    stateDir,
    env: process.env,
    config,
    reason: "source-changed",
    installRecords: {
      [pluginId]: { source: "npm", spec: `${packageName}@1.0.0`, installPath: pluginDir },
    },
  });
  if (capture !== "first-install" && capture !== "module-error") {
    const sourceDirectory = path.join(root, "native-source");
    const capturedRoot = path.join(root, "native-capture");
    fs.mkdirSync(sourceDirectory);
    fs.mkdirSync(capturedRoot);
    fs.writeFileSync(path.join(sourceDirectory, "README.md"), "native companion");
    const { fact } = capturePluginNativeNamespace({
      sourceDirectory,
      boundary: sourceDirectory,
      capturedRoot,
      managed: false,
      copyOnly: true,
    });
    if (capture === "missing-companion") {
      fs.unlinkSync(path.join(capturedRoot, "content", "README.md"));
      // Removing a member also changes its parent; keep the directory observation current
      // so this fixture specifically proves inventory completeness, not only a stat mismatch.
      fact.members[""]!.capturedIdentity = pluginSourceStatIdentity(
        fs.statSync(path.join(capturedRoot, "content"), { bigint: true }),
      );
    } else if (capture === "expired-capture") {
      fs.rmSync(capturedRoot, { recursive: true });
    }
    const key = `${fs.realpathSync(pluginDir)}\0${fs.realpathSync(path.join(pluginDir, "doctor-contract-api.cjs"))}`;
    await writePersistedInstalledPluginIndex(
      {
        ...index,
        plugins: index.plugins.map((record) =>
          record.pluginId === pluginId
            ? {
                ...record,
                sourceAdmissions: {
                  [key]: {
                    signature: "fixture-admission",
                    sourceDigest: "a".repeat(64),
                    nativeArtifacts: {},
                    nativeNamespaces: { [capturedRoot]: fact },
                  },
                },
              }
            : record,
        ),
      },
      { stateDir, env: process.env },
    );
  }
  clearPluginMetadataLifecycleCaches();
  const markers = () =>
    ["setup", "doctor", "session-agent", "migrated"].map((name) => fs.existsSync(marker(name)));
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  const databaseBefore = fs.readFileSync(databasePath);
  const beforeStateMutation = vi.fn(async () => {
    expect(markers()).toEqual([false, true, false, false]);
  });
  const begin = () =>
    beginDoctorMaintenance({
      options: { repair: true, nonInteractive: true },
      root: capture === "missing-companion" ? root : null,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      beforeStateMutation,
    });
  if (capture === "missing-companion") {
    await expect(begin()).rejects.toThrow(
      "Captured Doctor contract bytes are incomplete or changed",
    );
    expect(markers()).toEqual([false, false, false, false]);
    expect(beforeStateMutation).not.toHaveBeenCalled();
    expect(serviceInspection).not.toHaveBeenCalled();
    expect(fs.readFileSync(databasePath)).toEqual(databaseBefore);
    expect(fs.readFileSync(configPath, "utf8")).toBe(JSON.stringify(config));
    return;
  }
  if (capture === "module-error") {
    await expect(begin()).rejects.toThrow("fixture contract resource missing");
    expect(markers()).toEqual([false, true, false, false]);
    expect(beforeStateMutation).not.toHaveBeenCalled();
    expect(fs.readFileSync(configPath, "utf8")).toBe(JSON.stringify(config));
    return;
  }
  const otherOwner = acquireGatewayStateOwner({ databasePath });
  try {
    await expect(begin()).rejects.toThrow("OpenClaw state database is busy at");
    expect(markers()).toEqual([false, false, false, false]);
    expect(fs.readFileSync(databasePath)).toEqual(databaseBefore);
  } finally {
    otherOwner?.release();
  }
  const maintenance = await begin();
  try {
    expect(markers()).toEqual([false, true, false, false]);
    expect(beforeStateMutation).toHaveBeenCalledTimes(1);
    const result = await maintenance!.run(() =>
      autoMigrateLegacyState({
        cfg: config,
        env: process.env,
        homedir: () => root,
        doctorOnlyStateMigrations: true,
      }),
    );
    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain("Repaired plugin-owned state");
    expect(markers()).toEqual([true, true, true, true]);
    await maintenance?.finish(config);
  } finally {
    await maintenance?.release();
  }
});
