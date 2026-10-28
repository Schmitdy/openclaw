import { afterEach, expect, it } from "vitest";
import type { CliBackendExecute } from "../../plugins/cli-backend.types.js";
import { createOwnedTestInstance } from "../../plugins/plugin-instance.test-support.js";
import {
  closePluginTestAdmissions,
  createExecution,
  runPlugin,
  SUCCESS_RESULT,
} from "./execute-plugin.test-support.js";

afterEach(closePluginTestAdmissions);

it.each(["bundled", "workspace", "global", "config", "unowned"] as const)(
  "offers reserved lifecycle diagnostics only to the exact bundled owner (%s)",
  async (origin) => {
    const { context } = await createExecution();
    let observed = false;
    const execute: CliBackendExecute = async function* (execution) {
      observed = Object.hasOwn(execution, "processLifecycle");
      yield SUCCESS_RESULT;
    };
    // Same provider and plugin id in every case: only the exact retained function owner differs.
    const owned =
      origin === "unowned" ? execute : createOwnedTestInstance("same-plugin", origin).wrap(execute);
    expect((await runPlugin(context, owned)).exitCode).toBe(0);
    expect(observed).toBe(origin === "bundled");
  },
);
