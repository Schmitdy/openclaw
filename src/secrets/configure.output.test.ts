import fs from "node:fs/promises";
import { expect, it } from "vitest";
import {
  createApiKeyCredential as apiKey,
  createAuthProfileStoreFixture,
} from "../agents/auth-profiles/credential-fixtures.test-support.js";
import { noteCommittedSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import { SHARED_AUTH_STORE_STATE_KEY } from "../agents/auth-profiles/sqlite-json.js";
import { readPersistedSharedAuthProfileStoreRaw } from "../agents/auth-profiles/sqlite.js";
import {
  cliMessageExitEntrypoints,
  cliRecoveryEntrypoints,
} from "../cli/cli-entrypoint.test-support.js";
import { runCliProcessChild } from "../cli/cli-process-child.test-helpers.js";
import { createCliProcessFixture } from "../cli/isolated-process-fixture.test-support.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const configureUrl = resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.secretsConfigure);
const outputUrl = resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.secretsOutput);
const exitUrl = resolveRuntimeWorkerUrl(cliMessageExitEntrypoints.oneShotExit);

it.each(["plaintext", "references", "missing"])(
  "keeps configure JSON output parseable without changing shared credentials (%s)",
  (kind) =>
    withOpenClawTestState({ layout: "home" }, async (state) => {
      await state.writeConfig({});
      const keyRef = { source: "env" as const, provider: "default", id: "OPENAI_API_KEY" };
      const sharedStore = createAuthProfileStoreFixture({
        "openai:ref": { type: "api_key", provider: "openai", keyRef },
        "openai:dollar": apiKey("openai", "$OPENAI_API_KEY"),
        "openai:braced": apiKey("openai", "${OPENAI_API_KEY}"),
        ...(kind === "plaintext"
          ? {
              "openai:plaintext": apiKey("openai", "synthetic-plaintext-value"),
              "openai:residue": {
                ...apiKey("openai", "synthetic-residue-value"),
                keyRef,
              },
            }
          : {}),
      });
      noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, state.env);
      if (kind !== "missing") {
        const { db } = openOpenClawStateDatabase({ env: state.env });
        try {
          db.prepare(
            "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, 1)",
          ).run("authProfiles.store", JSON.stringify(sharedStore));
          db.prepare(
            "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, 1)",
          ).run(SHARED_AUTH_STORE_STATE_KEY, JSON.stringify({ location: "state-db" }));
        } finally {
          closeOpenClawStateDatabaseForTest();
        }
      }
      const configBefore = await fs.readFile(state.configPath, "utf8");
      const cli = createCliProcessFixture(state.home, {
        OPENCLAW_CONFIG_PATH: state.configPath,
        OPENCLAW_STATE_DIR: state.stateDir,
        NO_COLOR: "1",
      });
      const result = await runCliProcessChild({
        nodeArgs: [
          ...resolveRuntimeWorkerArgv(configureUrl).slice(0, -1),
          "--input-type=module",
          "--eval",
          `
            import { runSecretsCommand } from ${JSON.stringify(outputUrl.href)};
            import { runSecretsConfigureInteractive } from ${JSON.stringify(configureUrl.href)};
            import { runCliWithExitFinalization } from ${JSON.stringify(exitUrl.href)};
            Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
            await runCliWithExitFinalization({
              run: () => runSecretsCommand(true,
                () => runSecretsConfigureInteractive({ skipProviderSetup: true }),
                () => { throw new Error("JSON failures must not use the human renderer."); }, 1),
              onError: error => { throw error; },
            });
          `,
        ],
        env: cli.env,
      });
      expect(result.code, result.stderr).toBe(1);
      expect(result.signal, result.stderr).toBeNull();
      const { stdout, stderr } = result;
      if (!stdout) {
        throw new Error(stderr);
      }
      expect(JSON.parse(stdout)).toEqual({
        ok: false,
        error: {
          type: "cli_error",
          message: "No configurable secret-bearing fields found for this agent scope.",
        },
      });
      if (kind === "plaintext") {
        expect(stderr).toContain("2 plaintext credential(s)");
        expect(stderr).toContain("cannot migrate shared credentials");
      } else {
        expect(stderr).not.toContain("Shared auth-profile store");
      }
      expect(readPersistedSharedAuthProfileStoreRaw(state.env)).toEqual(
        kind === "missing" ? null : sharedStore,
      );
      expect(`${stdout}${stderr}`).not.toContain("synthetic-plaintext-value");
      expect(`${stdout}${stderr}`).not.toContain("synthetic-residue-value");
      expect(await fs.readFile(state.configPath, "utf8")).toBe(configBefore);
    }),
);
