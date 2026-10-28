import type { CliBackendExecuteContext } from "openclaw/plugin-sdk/cli-backend";
import { isClaudeRestrictedSettingsValue } from "./cli-shared.js";

const PROTOCOL_FLAGS = new Set([
  "-p",
  "--print",
  "--verbose",
  "--include-partial-messages",
  "--replay-user-messages",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
]);
const PROTOCOL_VALUE_FLAGS = new Set([
  "--output-format",
  "--input-format",
  "--permission-prompt-tool",
  "--permission-mode",
  "--model",
  "--session-id",
  "--resume",
  "-r",
  "--append-system-prompt-file",
  "--append-system-prompt",
  "--system-prompt-file",
  "--system-prompt",
]);
const TOOL_FLAGS = new Set(["--tools", "--allowedTools", "--allowed-tools"]);

/** Keep prepared CLI arguments, replacing only transport and admission-owned policy. */
export function prepareClaudeCliTransportArgs(context: CliBackendExecuteContext) {
  const args: string[] = [];
  const allowedTools: string[] = [];
  let tools: string[] | undefined;
  let settingSources = "user";
  let excludeDynamicSections = false;
  for (let index = 0; index < context.args.length; index += 1) {
    const raw = context.args[index]!;
    const equals = raw.indexOf("=");
    const flag = equals < 0 ? raw : raw.slice(0, equals);
    if (PROTOCOL_FLAGS.has(flag)) {
      continue;
    }
    if (flag === "--exclude-dynamic-system-prompt-sections") {
      excludeDynamicSections = true;
      continue;
    }
    if (!PROTOCOL_VALUE_FLAGS.has(flag) && !TOOL_FLAGS.has(flag) && flag !== "--setting-sources") {
      args.push(raw);
      continue;
    }
    const value = equals < 0 ? context.args[++index] : raw.slice(equals + 1);
    if (value === undefined) {
      throw new Error(`Claude CLI cannot preserve ${flag} without its value.`);
    }
    if (PROTOCOL_VALUE_FLAGS.has(flag)) {
      continue;
    }
    if (flag === "--setting-sources") {
      if (value !== "" && value !== "user") {
        throw new Error("Claude CLI settings must be limited to user settings.");
      }
      settingSources = value;
      continue;
    }
    const values = [value];
    if (equals < 0) {
      while (index + 1 < context.args.length && !context.args[index + 1]?.startsWith("-")) {
        values.push(context.args[++index]!);
      }
    }
    const names = values.flatMap((entry) =>
      entry
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    );
    if (flag === "--tools") {
      tools = names;
    } else {
      // Native actions must pass the host hooks, even if argv requested automatic approval.
      allowedTools.push(...names.filter((name) => name.startsWith("mcp__openclaw__")));
    }
  }
  let approvedTools = [...new Set(allowedTools)];
  if (context.toolAvailability) {
    tools = [...context.toolAvailability.native];
    approvedTools = context.toolAvailability.openClaw
      .map((name) => `mcp__openclaw__${name}`)
      .filter((name) => allowedTools.includes(name) || allowedTools.includes("mcp__openclaw__*"));
  }
  args.push(
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--replay-user-messages",
    "--permission-prompt-tool",
    "stdio",
    "--permission-mode",
    "default",
    "--setting-sources",
    settingSources,
    "--model",
    context.modelId,
  );
  if (tools) {
    args.push("--tools", tools.join(","));
  }
  if (approvedTools.length) {
    args.push("--allowedTools", approvedTools.join(","));
  }
  if (context.sessionId) {
    args.push(context.useResume ? "--resume" : "--session-id", context.sessionId);
  }
  return { args, excludeDynamicSections };
}

/** Facts about final argv, not claims about native runtime enforcement. */
export function describeClaudeTransportArgs(args: readonly string[]) {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const raw = args[index]!;
    if (!raw.startsWith("--")) {
      continue;
    }
    const equals = raw.indexOf("=");
    const flag = equals < 0 ? raw : raw.slice(0, equals);
    flags.add(flag);
    if (equals >= 0) {
      values.set(flag, raw.slice(equals + 1));
    } else if (args[index + 1] !== undefined && !args[index + 1]!.startsWith("--")) {
      values.set(flag, args[++index]!);
    }
  }
  return {
    settingSourcesEmpty: values.get("--setting-sources") === "",
    toolsFlagPresent: flags.has("--tools"),
    toolsEmpty: values.get("--tools") === "",
    allowedToolsPresent: flags.has("--allowedTools") || flags.has("--allowed-tools"),
    strictMcpConfig: flags.has("--strict-mcp-config"),
    disallowedHasMcpWildcard: (values.get("--disallowedTools") ?? "")
      .split(/[ ,]+/u)
      .includes("mcp__*"),
    disableSlashCommands: flags.has("--disable-slash-commands"),
    noChrome: flags.has("--no-chrome"),
    restrictedSettingsExact: isClaudeRestrictedSettingsValue(values.get("--settings")),
    sessionFlag: flags.has("--resume")
      ? "resume"
      : flags.has("--session-id")
        ? "session-id"
        : "none",
  };
}
export type ClaudeTransportArgFacts = ReturnType<typeof describeClaudeTransportArgs>;
