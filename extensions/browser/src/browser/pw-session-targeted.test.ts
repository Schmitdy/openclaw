import { once } from "node:events";
import { createServer } from "node:http";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, expect, it } from "vitest";
import { listenOnLoopback } from "../../../test-support/hanging-loopback-server.js";
import { connectOverCdpTransport } from "./pw-session-cdp-transport.js";
import { markTargetBlocked } from "./pw-session-connection.js";
import {
  closePlaywrightBrowserConnection,
  getPageForTargetId,
  getDocumentIdentitiesViaPlaywright,
  refLocator,
} from "./pw-session.js";
import { clickCoordsViaPlaywright } from "./pw-tools-core.interactions.actions.js";
import { snapshotAriaViaPlaywright } from "./pw-tools-core.snapshot.js";

type Command = {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await closePlaywrightBrowserConnection();
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

// Real Playwright against synthetic CDP I/O. STALLED accepts attachment but never
// answers renderer commands, matching the cold-connect failure without Chrome.
async function cdpFixture(options: { wrongTarget?: boolean; url?: string; type?: string } = {}) {
  let cdpUrl = "";
  const commands: Command[] = [];
  const sessions = new Map<string, string>();
  const clicks: string[] = [];
  let nextSession = 0;
  let loaderId = "document-1";
  const navigatePages: Array<() => void> = [];
  const detachPages: Array<() => void> = [];
  const available = new Set(["HEALTHY", "SECOND", "STALLED"]);
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ webSocketDebuggerUrl: cdpUrl.replace("http:", "ws:") }));
  });
  const sockets = new WebSocketServer({ server });
  const targetInfo = (targetId: string) => ({
    targetId,
    type: options.type ?? "page",
    title: targetId,
    url: options.url ?? "https://example.com/fixture",
    browserContextId: "default-context",
    attached: true,
  });
  sockets.on("connection", (socket) => {
    const send = (value: object) => socket.send(JSON.stringify(value));
    socket.on("message", (raw) => {
      const command = JSON.parse(rawDataToString(raw)) as Command;
      commands.push(command);
      const { id, method, params, sessionId } = command;
      const targetId = sessions.get(sessionId ?? "");
      const reply = (result: object = {}) => send({ id, sessionId, result });
      const attach = (target: string, parent?: string) => {
        const attachedSession = `session-${++nextSession}`;
        sessions.set(attachedSession, target);
        send({
          sessionId: parent,
          method: "Target.attachedToTarget",
          params: {
            sessionId: attachedSession,
            targetInfo: targetInfo(target),
            waitingForDebugger: false,
          },
        });
        if (!parent) {
          detachPages.push(() =>
            send({
              method: "Target.detachedFromTarget",
              params: { sessionId: attachedSession, targetId: target },
            }),
          );
          navigatePages.push(() =>
            send({
              method: "Page.frameNavigated",
              sessionId: attachedSession,
              params: {
                frame: { id: target, loaderId, url: options.url ?? "https://example.com/fixture" },
              },
            }),
          );
        }
        return attachedSession;
      };
      if (targetId === "STALLED") {
        return;
      }
      switch (method) {
        case "Browser.getVersion":
          reply({ product: "Chrome/156.0.0.0", userAgent: "Chrome", revision: "fixture" });
          break;
        case "Target.setAutoAttach":
          if (!sessionId) {
            attach("HEALTHY");
            attach("STALLED");
          }
          reply();
          break;
        case "Target.attachToBrowserTarget": {
          const browserSession = `browser-${++nextSession}`;
          reply({ sessionId: browserSession });
          break;
        }
        case "Target.attachToTarget": {
          const requested = String(params?.targetId);
          if (!available.has(requested)) {
            send({ id, sessionId, error: { code: -32602, message: "No target with given id" } });
            break;
          }
          reply({ sessionId: attach(options.wrongTarget ? "OTHER" : requested, sessionId) });
          break;
        }
        case "Target.getTargetInfo":
          reply({ targetInfo: targetInfo(targetId ?? "BROWSER") });
          break;
        case "SystemInfo.getInfo":
          reply({ commandLine: "chrome" });
          break;
        case "Page.getFrameTree":
          reply({
            frameTree: {
              frame: { id: targetId, loaderId, url: options.url ?? "https://example.com/fixture" },
            },
          });
          break;
        case "Accessibility.getFullAXTree":
          reply({
            nodes: [
              {
                nodeId: "1",
                role: { value: "button" },
                name: {
                  value: clicks.includes(targetId ?? "")
                    ? "Safe control activated"
                    : "Safe control",
                },
                backendDOMNodeId: 10,
              },
            ],
          });
          break;
        case "DOM.getDocument":
          reply({ root: { nodeId: 1, backendNodeId: 1 } });
          break;
        case "DOM.resolveNode":
          reply({ object: { objectId: "document" } });
          break;
        case "DOM.pushNodesByBackendIdsToFrontend":
          reply({ nodeIds: [10] });
          break;
        case "Input.dispatchMouseEvent":
          if (params?.type === "mouseReleased" && params.x === 20 && params.y === 20) {
            clicks.push(targetId ?? "UNKNOWN");
          }
          reply();
          break;
        default:
          reply();
      }
    });
  });
  const port = await listenOnLoopback(server);
  cdpUrl = `http://127.0.0.1:${port}`;
  cleanups.push(async () => {
    for (const socket of sockets.clients) {
      const closed = once(socket, "close");
      socket.close();
      await closed;
    }
    await new Promise<void>((resolve) => {
      sockets.close(() => {
        server.close(() => resolve());
      });
    });
  });
  return {
    cdpUrl,
    commands,
    clicks,
    sessions,
    sockets,
    removeTargets: () => {
      available.clear();
      detachPages.forEach((emit) => emit());
    },
    navigate: () => {
      loaderId = "document-2";
      navigatePages.forEach((emit) => emit());
    },
  };
}

it("snapshots and controls the exact page while an unrelated renderer stalls", async () => {
  const fixture = await cdpFixture();
  const result = await snapshotAriaViaPlaywright({ cdpUrl: fixture.cdpUrl, targetId: "HEALTHY" });
  expect(result.nodes).toEqual([
    expect.objectContaining({ role: "button", name: "Safe control", ref: "ax1" }),
  ]);
  await clickCoordsViaPlaywright({ cdpUrl: fixture.cdpUrl, targetId: "HEALTHY", x: 20, y: 20 });
  expect(fixture.clicks).toEqual(["HEALTHY"]);
  expect(
    (await snapshotAriaViaPlaywright({ cdpUrl: fixture.cdpUrl, targetId: "HEALTHY" })).nodes,
  ).toEqual([
    expect.objectContaining({ role: "button", name: "Safe control activated", ref: "ax1" }),
  ]);
  const page = await getPageForTargetId({ cdpUrl: fixture.cdpUrl, targetId: "HEALTHY" });
  expect(refLocator(page, "ax1").toString()).toContain('data-openclaw-browser-ref="ax1"');
  const before = await getDocumentIdentitiesViaPlaywright({
    cdpUrl: fixture.cdpUrl,
    targetId: "HEALTHY",
  });
  expect(before.mainFrame).toBe("cdp:document-1");
  const navigated = page.waitForEvent("framenavigated");
  fixture.navigate();
  await navigated;
  expect(
    (await getDocumentIdentitiesViaPlaywright({ cdpUrl: fixture.cdpUrl, targetId: "HEALTHY" }))
      .mainFrame,
  ).toBe("cdp:document-2");
  expect(() => refLocator(page, "ax1")).toThrow("Unknown ref");
  expect(
    fixture.commands.filter(
      (command) => !command.sessionId && command.method === "Target.setAutoAttach",
    ),
  ).toEqual([]);
  expect([...fixture.sessions.values()]).not.toContain("STALLED");
}, 10_000);

it("reproduces the browser-wide vendor initialization timeout", async () => {
  const fixture = await cdpFixture();
  await expect(
    connectOverCdpTransport(fixture.cdpUrl, {
      timeout: 100,
      headers: {},
      resolveWebSocketUrl: async () => fixture.cdpUrl.replace("http:", "ws:"),
    }),
  ).rejects.toThrow('page target "STALLED"');
  expect([...fixture.sessions.values()]).toContain("HEALTHY");
  expect([...fixture.sessions.values()]).toContain("STALLED");
});

it.each([
  { label: "wrong", options: { wrongTarget: true }, targetId: "HEALTHY" },
  { label: "missing", options: {}, targetId: "MISSING" },
  { label: "non-page", options: { type: "service_worker" }, targetId: "HEALTHY" },
])("never inspects or acts on a $label target", async ({ options, targetId }) => {
  const fixture = await cdpFixture(options);
  await expect(snapshotAriaViaPlaywright({ cdpUrl: fixture.cdpUrl, targetId })).rejects.toThrow();
  expect(
    fixture.commands.filter(
      (command) =>
        command.method === "Accessibility.getFullAXTree" || command.method.startsWith("Input."),
    ),
  ).toEqual([]);
  expect(fixture.commands.filter((command) => command.method === "Page.enable")).toEqual([]);
});

it("bounds initialization when the selected renderer itself stalls", async () => {
  const fixture = await cdpFixture();
  await expect(
    connectOverCdpTransport(fixture.cdpUrl, {
      timeout: 100,
      headers: {},
      targetId: "STALLED",
      resolveWebSocketUrl: async () => fixture.cdpUrl.replace("http:", "ws:"),
    }),
  ).rejects.toThrow('page target "STALLED"');
  expect([...fixture.sessions.values()]).not.toContain("HEALTHY");
});

it("keeps target connections distinct under interleaving and retires both by endpoint", async () => {
  const fixture = await cdpFixture();
  const select = (targetId: string) => getPageForTargetId({ cdpUrl: fixture.cdpUrl, targetId });
  const [first, same, second] = await Promise.all([
    select("HEALTHY"),
    select("HEALTHY"),
    select("SECOND"),
  ]);
  expect(first).toBe(same);
  expect(first).not.toBe(second);
  expect(await select("HEALTHY")).toBe(first);
  expect(await select("SECOND")).toBe(second);
  expect(fixture.sockets.clients.size).toBe(2);
  expect(
    fixture.commands
      .filter((command) => command.method === "Target.attachToTarget" && !command.sessionId)
      .map((command) => command.params?.targetId)
      .toSorted((left, right) => String(left).localeCompare(String(right))),
  ).toEqual(["HEALTHY", "SECOND"]);
  const closed = [...fixture.sockets.clients].map((socket) => once(socket, "close"));
  await closePlaywrightBrowserConnection({ cdpUrl: fixture.cdpUrl });
  await Promise.all(closed);
  expect(fixture.sockets.clients.size).toBe(0);
  expect(fixture.commands.some((command) => command.method === "Target.closeTarget")).toBe(false);
});

it("enforces quarantine before attaching the target", async () => {
  const fixture = await cdpFixture();
  markTargetBlocked(fixture.cdpUrl, "HEALTHY");
  await expect(getPageForTargetId({ cdpUrl: fixture.cdpUrl, targetId: "HEALTHY" })).rejects.toThrow(
    "SSRF policy",
  );
  expect(fixture.commands).toEqual([]);
});

it("enforces navigation policy before reading or controlling a selected private page", async () => {
  const url = "http://127.0.0.1/private";
  const fixture = await cdpFixture({ url });
  await expect(
    snapshotAriaViaPlaywright({ cdpUrl: fixture.cdpUrl, targetId: "HEALTHY", ssrfPolicy: {} }),
  ).rejects.toThrow(/private|internal|blocked|unsupported|navigation/i);
  expect(fixture.commands.some((command) => command.method === "Page.enable")).toBe(true);
  await expect(
    clickCoordsViaPlaywright({
      cdpUrl: fixture.cdpUrl,
      targetId: "HEALTHY",
      x: 20,
      y: 20,
      ssrfPolicy: {},
    }),
  ).rejects.toThrow();
  expect(fixture.commands.some((command) => command.method === "Accessibility.getFullAXTree")).toBe(
    false,
  );
  expect(fixture.clicks).toEqual([]);
});

it("does not replace a stale selected target with a different page", async () => {
  const fixture = await cdpFixture();
  const page = await getPageForTargetId({ cdpUrl: fixture.cdpUrl, targetId: "HEALTHY" });
  const closed = page.waitForEvent("close");
  fixture.removeTargets();
  await closed;
  await expect(
    snapshotAriaViaPlaywright({ cdpUrl: fixture.cdpUrl, targetId: "HEALTHY" }),
  ).rejects.toThrow("No target with given id");
  expect(fixture.commands.some((command) => command.method === "Accessibility.getFullAXTree")).toBe(
    false,
  );
  expect(
    fixture.commands
      .filter((command) => command.method === "Target.attachToTarget" && !command.sessionId)
      .every((command) => command.params?.targetId === "HEALTHY"),
  ).toBe(true);
});
