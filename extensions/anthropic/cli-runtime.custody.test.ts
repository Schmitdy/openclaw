import { afterEach, expect, it, vi } from "vitest";
import { describeClaudeTransportArgs } from "./cli-runtime-args.js";
import { createCliTestHarness, collectClaudeCli } from "./cli-runtime.test-support.js";
import { resolveClaudeCliExecutionArgs } from "./cli-shared.js";
import type { ClaudeCliExecuteContext } from "./cli.runtime.js";

const harness = createCliTestHarness("claude-custody-");
afterEach(() => harness.cleanup());
type Observer = NonNullable<ClaudeCliExecuteContext["processLifecycle"]>;
function observer(throws = false): Observer {
  const fn = () =>
    vi.fn(() => {
      if (throws) {
        throw new Error("diagnostic fault");
      }
    });
  return {
    processStarted: fn(),
    processInitialized: fn(),
    turnUsed: fn(),
    retireRequested: fn(),
    exitSettled: fn(),
  };
}
const source = String.raw`
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
for await (const line of createInterface({input:process.stdin})) {
 const m = JSON.parse(line);
 if (m.type === "control_request") {
  send({type:"control_response",response:{subtype:"success",request_id:m.request_id,response:{}}});
  send({type:"system",subtype:"init",capabilities:process.env.NO_LIFECYCLE ? [] : ["msg_lifecycle_v1"], ...(process.env.INIT_SESSION ? {session_id:process.env.INIT_SESSION} : {})});
 } else if (m.type === "user") {
  send({...m, session_id:"host-echo"});
  send({type:"command_lifecycle",state:"started",command_uuid:m.uuid});
  send({type:"result",subtype:"success",is_error:false,result:"ok", ...(process.env.RESULT_SESSION ? {session_id:process.env.RESULT_SESSION} : {})});
 }
}`;

it.each(["side-question", "disabled-live-session"])(
  "observes one-shot %s start, use, idle retirement and confirmed exit",
  async (mode) => {
    const lifecycle = observer();
    const context: ClaudeCliExecuteContext = {
      ...(await harness.context(
        source,
        mode === "side-question" ? { executionMode: "side-question" } : {},
        { RESULT_SESSION: "native-session" },
      )),
      processLifecycle: lifecycle,
    };
    await collectClaudeCli(context);
    expect(lifecycle.processStarted).toHaveBeenCalledOnce();
    expect(lifecycle.processStarted).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "one-shot",
        observation: expect.objectContaining({ outcome: "started" }),
      }),
    );
    expect(lifecycle.turnUsed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        reused: false,
        inputAcknowledged: true,
        conversation: { state: "grounded", value: "native-session" },
      }),
    );
    expect(lifecycle.retireRequested).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ reason: "idle", mode: "one-shot" }),
    );
    expect(lifecycle.exitSettled).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "exit-confirmed" }),
    );
  },
);

it("uses one warm generation and preserves launch attribution after the launching turn ends", async () => {
  const launch = observer();
  const next = observer();
  const capability = harness.liveSession();
  const context: ClaudeCliExecuteContext = {
    ...(await harness.context(
      source,
      { liveSession: capability },
      { RESULT_SESSION: "native-session" },
    )),
    processLifecycle: launch,
  };
  await collectClaudeCli(context);
  const nextContext: ClaudeCliExecuteContext = { ...context, processLifecycle: next };
  await collectClaudeCli(nextContext);
  expect(launch.processStarted).toHaveBeenCalledOnce();
  expect(next.processStarted).not.toHaveBeenCalled();
  expect(next.turnUsed).toHaveBeenCalledWith(expect.objectContaining({ reused: true }));
  expect(launch.retireRequested).not.toHaveBeenCalled();
  await capability.restart();
  expect(launch.retireRequested).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ reason: "restart" }),
  );
  expect(launch.exitSettled).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ outcome: "exit-confirmed" }),
  );
  expect(next.retireRequested).not.toHaveBeenCalled();
});

it.each([
  [{}, { state: "unobserved" }],
  [{ RESULT_SESSION: "native-result" }, { state: "grounded", value: "native-result" }],
  [{ INIT_SESSION: "native-a", RESULT_SESSION: "native-b" }, { state: "ambiguous" }],
  [{ NO_LIFECYCLE: "1", RESULT_SESSION: "native-result" }, { state: "lifecycle-unsupported" }],
] as const)(
  "grounds provider conversation only in native init and completing result (%j)",
  async (env, conversation) => {
    const lifecycle = observer();
    const context: ClaudeCliExecuteContext = {
      ...(await harness.context(source, { sessionId: "host-echo" }, env)),
      processLifecycle: lifecycle,
    };
    await collectClaudeCli(context);
    expect(lifecycle.turnUsed).toHaveBeenCalledWith(expect.objectContaining({ conversation }));
  },
);

it("keeps output and warm reuse identical when every observer throws", async () => {
  const capability = harness.liveSession();
  const context = await harness.context(source, { liveSession: capability });
  const firstContext: ClaudeCliExecuteContext = { ...context, processLifecycle: observer(true) };
  const first = await collectClaudeCli(firstContext);
  const handle = capability.current();
  const secondContext: ClaudeCliExecuteContext = { ...context, processLifecycle: observer(true) };
  const second = await collectClaudeCli(secondContext);
  expect(capability.current()).toBe(handle);
  expect(first.filter((r) => r.type === "result")).toEqual(
    second.filter((r) => r.type === "result"),
  );
});

it("describes exact final empty flags and restricted settings without exposing their text", () => {
  const args = resolveClaudeCliExecutionArgs({
    workspaceDir: "/synthetic",
    provider: "claude-cli",
    modelId: "synthetic",
    useResume: false,
    baseArgs: [],
    toolAvailability: { native: [], openClaw: [] },
  });
  const facts = describeClaudeTransportArgs([...args, "--session-id", "synthetic"]);
  expect(facts).toMatchObject({
    settingSourcesEmpty: true,
    toolsFlagPresent: true,
    toolsEmpty: true,
    strictMcpConfig: true,
    disallowedHasMcpWildcard: true,
    disableSlashCommands: true,
    noChrome: true,
    restrictedSettingsExact: true,
    sessionFlag: "session-id",
  });
  expect(describeClaudeTransportArgs([])).toMatchObject({
    toolsFlagPresent: false,
    toolsEmpty: false,
    settingSourcesEmpty: false,
    sessionFlag: "none",
  });
  expect(
    describeClaudeTransportArgs(["--tools=", "--setting-sources=", "--resume", "synthetic"]),
  ).toMatchObject({ toolsEmpty: true, settingSourcesEmpty: true, sessionFlag: "resume" });
});
