import { describe, expect, it } from "vitest";
import {
  resolveControlUiAutomationRunUrl,
  resolveControlUiPublicSessionUrl,
  resolveControlUiSessionLinkBase,
  resolveControlUiSessionUrl,
} from "./control-ui-link-base.js";

const origin = "https://gateway.example.com";
const maxBasePathLength = 200 - origin.length - 1;
const linkBase = (controlUi: { enabled?: boolean; basePath?: string }) =>
  resolveControlUiSessionLinkBase({ gateway: { publicOrigin: origin, controlUi } });

describe("resolveControlUiSessionLinkBase", () => {
  it.each([
    ["disabled", { enabled: false }, undefined],
    ["normalized", { basePath: " /control/// " }, `${origin}/control`],
    [
      "under the cap",
      { basePath: `/${"a".repeat(maxBasePathLength)}` },
      `${origin}/${"a".repeat(maxBasePathLength)}`,
    ],
    ["over the cap", { basePath: `/${"a".repeat(maxBasePathLength + 1)}` }, undefined],
  ] as const)("handles %s Control UI bases", (_name, config, expected) => {
    expect(linkBase(config)).toBe(expected);
  });
  it("omits session links without a public Gateway origin", () => {
    expect(resolveControlUiSessionLinkBase({ gateway: {} })).toBeUndefined();
  });
});

describe("resolveControlUiAutomationRunUrl", () => {
  it("omits automation links without a public Gateway origin", () => {
    expect(
      resolveControlUiAutomationRunUrl({ gateway: {} }, { jobId: "daily-report" }),
    ).toBeUndefined();
  });

  it("joins the normalized Control UI base path and encodes job and run identifiers", () => {
    expect(
      resolveControlUiAutomationRunUrl(
        { gateway: { publicOrigin: origin, controlUi: { basePath: " /control/// " } } },
        { jobId: "job /?&", runId: "cron:job /?&:123" },
      ),
    ).toBe(`${origin}/control/automations?job=job+%2F%3F%26&run=cron%3Ajob+%2F%3F%26%3A123`);
  });

  it("omits the run query parameter when no run identifier is available", () => {
    expect(
      resolveControlUiAutomationRunUrl(
        { gateway: { publicOrigin: "https://gateway.example.com" } },
        { jobId: "daily-report" },
      ),
    ).toBe("https://gateway.example.com/automations?job=daily-report");
  });
});

describe("resolveControlUiPublicSessionUrl", () => {
  const config = { gateway: { publicOrigin: "https://gateway.example" } };
  const entry = {
    sessionId: "session-1",
    updatedAt: 1,
    publicShare: { id: "a".repeat(48), sessionId: "session-1", createdAt: 1 },
  };
  const session = { sessionKey: "agent:main:main", sessionId: "session-1", agentId: "main" };
  it("uses the canonical anonymous chat route for the published generation", () => {
    expect(resolveControlUiPublicSessionUrl(config, { ...session, entry })).toBe(
      "https://gateway.example/chat/main",
    );
  });
  it.each([
    { name: "missing", entry: undefined },
    { name: "private", entry: { ...entry, publicShare: undefined } },
    { name: "incognito", entry: { ...entry, incognito: true as const } },
    { name: "stale", entry: { ...entry, sessionId: "session-2" } },
  ])("omits $name sessions", ({ entry: current }) => {
    expect(
      resolveControlUiPublicSessionUrl(config, { ...session, entry: current }),
    ).toBeUndefined();
  });
});

describe("shared Control UI links", () => {
  it.each([
    "http://127.0.0.1:18789",
    "http://127.0.0.2:18789",
    "http://localhost:18789",
    "http://localhost.:18789",
    "http://[::1]:18789",
    "http://[::ffff:127.0.0.1]:18789",
  ])("omits device-local inspection and session links for %s", (publicOrigin) => {
    const config = { gateway: { publicOrigin } };
    expect(resolveControlUiAutomationRunUrl(config, { jobId: "daily-reminder" })).toBeUndefined();
    expect(resolveControlUiSessionLinkBase(config)).toBeUndefined();
    expect(resolveControlUiSessionUrl(config, { sessionKey: "agent:main:main" })).toBeUndefined();
  });

  it.each(["http://192.168.1.10:18789", "https://gateway.example.ts.net"])(
    "retains explicitly configured network origins: %s",
    (publicOrigin) => {
      expect(
        resolveControlUiAutomationRunUrl(
          { gateway: { publicOrigin } },
          { jobId: "daily-reminder" },
        ),
      ).toBe(`${publicOrigin}/automations?job=daily-reminder`);
    },
  );
});
