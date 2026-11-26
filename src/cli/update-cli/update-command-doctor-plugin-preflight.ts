import { inspectPluginMigrationAvailability } from "../../commands/doctor/shared/plugin-migration-availability.js";
import { resolveConfigWidePluginMetadataSnapshotAsync } from "../../config/io.plugin-metadata.js";
import { resolveStateDir } from "../../config/paths.js";
import type { ConfigFileSnapshot } from "../../config/types.js";
import { resolveDatabaseEngineSelection } from "../../infra/database-engine/config.js";
import { withDatabaseEngineSelection } from "../../infra/database-engine/context.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { preparePluginDoctorContractModules } from "../../plugins/doctor-contract-preparation.js";
import {
  collectDoctorConfigRepairPluginIds,
  listPluginDoctorLegacyConfigRules,
  listPluginDoctorStateMigrationEntries,
} from "../../plugins/doctor-contract-registry.js";
import { createPluginCache, withPluginCache } from "../../plugins/plugin-cache.js";
import { withPluginGenerationSourceCustody } from "../../plugins/plugin-generation-source-lookup.js";
import { withPreparedPluginSetupRead } from "../../plugins/plugin-setup-module.js";
import { withPluginSourceCaptureStorage } from "../../plugins/plugin-source-capture-context.js";
import { withArtifactPreservingStateReads } from "../../state/artifact-preserving-state-reads.js";

/** Inspect installed Doctor sources before a supervisor admits any live migration work. */
export async function preflightSupervisedDoctorPlugins(
  snapshot: ConfigFileSnapshot,
  env: NodeJS.ProcessEnv,
) {
  const config = snapshot.sourceConfig ?? snapshot.config;
  if (!snapshot.exists) {
    return;
  }
  await withArtifactPreservingStateReads(async () =>
    withDatabaseEngineSelection(await resolveDatabaseEngineSelection(config, env), async () => {
      await using cache = createPluginCache();
      await withPluginCache(cache, () =>
        withPluginSourceCaptureStorage(
          { stateDir: resolveStateDir(env), placement: "temporary" },
          () =>
            withPluginGenerationSourceCustody(async () => {
              const metadata = await resolveConfigWidePluginMetadataSnapshotAsync({
                config,
                env,
                allowCurrent: false,
              });
              await withPluginMetadataSnapshotScope(
                metadata,
                async () => {
                  const availability = await inspectPluginMigrationAvailability({
                    cfg: config,
                    env,
                    installRecords: metadata.index.installRecords,
                    deferInstallation: false,
                  });
                  // Version drift alone does not require replacing a compatible source.
                  const unavailable = availability.pending.filter(
                    ({ pluginId }) =>
                      availability.discoveryBlockedPluginIds?.includes(pluginId) ||
                      !metadata.byPluginId.has(pluginId),
                  );
                  if (unavailable.length) {
                    const diagnostics = [
                      ...metadata.manifestRegistry.diagnostics,
                      ...metadata.diagnostics,
                    ];
                    throw new Error(
                      `Required plugin sources are unavailable: ${unavailable.map(({ pluginId, reason }) => `${pluginId}: ${diagnostics.find((diagnostic) => diagnostic.pluginId === pluginId)?.message ?? reason}`).join("; ")}`,
                    );
                  }
                  if (!metadata.plugins.some((plugin) => plugin.origin !== "bundled")) {
                    return;
                  }
                  const unavailableSource = (pluginId: string, reason: string) => {
                    throw new Error(
                      `Required plugin ${pluginId} Doctor source is unavailable: ${reason}`,
                    );
                  };
                  const repair = {
                    config,
                    env,
                    manifestRegistry: metadata.manifestRegistry,
                    pluginIds: collectDoctorConfigRepairPluginIds(config),
                  };
                  await preparePluginDoctorContractModules({
                    ...repair,
                    surfaces: ["configRepair"],
                  });
                  // Read declarations only. Config and state repairs belong after the recovery capture.
                  await withPreparedPluginSetupRead(() =>
                    listPluginDoctorLegacyConfigRules({
                      ...repair,
                      onContractError: unavailableSource,
                    }),
                  );
                  await preparePluginDoctorContractModules({
                    config,
                    env,
                    surfaces: ["stateMigrations"],
                    manifestRegistry: metadata.manifestRegistry,
                  });
                  listPluginDoctorStateMigrationEntries({
                    config,
                    env,
                    manifestRegistry: metadata.manifestRegistry,
                    onUnavailablePlugin: unavailableSource,
                  });
                },
                { config, env },
              );
            }),
        ),
      );
    }),
  );
}
