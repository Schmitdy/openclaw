import { afterEach, expect, it, vi } from "vitest";
import { createChildAdapter } from "./child.js";
import { createStubChild, setPlatform } from "./child.test-support.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
// mock-isolation: exercise command-start classification without creating Windows processes.
vi.mock("../../spawn-utils.js", async (original) => ({
  ...(await original<typeof import("../../spawn-utils.js")>()),
  spawnAndWait: spawn,
}));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
  spawn.mockReset();
});

it.each([false, true])(
  "does not invent a spawned digest when Node applies a shell (shell=%s)",
  async (shell) => {
    setPlatform("win32");
    const stub = createStubChild();
    spawn.mockResolvedValue(stub.child);
    const observation = vi.fn();
    const { adapter, ready } = await createChildAdapter({
      argv: ["synthetic.exe", "argument"],
      windowsShell: shell,
      exactEnv: true,
      onCommandStart: observation,
    });
    try {
      await ready;
      expect(observation).toHaveBeenCalledOnce();
      const fact = observation.mock.calls[0]![0];
      expect(fact.outcome).toBe("started");
      expect(fact.sentInvocationDigest).toMatch(/^[a-f0-9]{64}$/u);
      if (shell) {
        expect(fact).not.toHaveProperty("spawnedInvocationDigest");
      } else {
        expect(fact.spawnedInvocationDigest).toBe(fact.sentInvocationDigest);
      }
    } finally {
      stub.emitExit(0);
      stub.emitClose(0);
      adapter.dispose();
    }
  },
);
