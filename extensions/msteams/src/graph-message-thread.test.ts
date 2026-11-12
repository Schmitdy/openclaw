import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { msteamsPlugin } from "./channel.js";
import { getMessageMSTeams } from "./graph-messages.js";

const graph = vi.hoisted(() => ({ fetch: vi.fn(), token: vi.fn() }));
vi.mock("./graph.js", async (original) => ({
  ...(await original<typeof import("./graph.js")>()),
  fetchGraphJson: graph.fetch,
  resolveGraphToken: graph.token,
}));

const teamId = "11111111-1111-1111-1111-111111111111";
const channelId = "19:channel@thread.tacv2";
const to = `${teamId}/${channelId}`;
const rootPath = `/teams/${teamId}/channels/19%3Achannel%40thread.tacv2/messages/root`;
const repliesPath = `${rootPath}/replies`;
const nextLink = `https://graph.microsoft.com/v1.0${repliesPath}?$skiptoken=page-2`;
const target = { cfg: {}, to, messageId: "root", threadId: "root" };
const handle = msteamsPlugin.actions!.handleAction!;
function message(id: string, parent: string | null = "root") {
  return {
    id,
    replyToId: parent,
    createdDateTime: "2026-01-02T03:04:05Z",
    lastModifiedDateTime: "2026-01-02T03:04:06Z",
    body: { content: `Message ${id}`, contentType: "text" },
    from: { user: { id: "author", displayName: "Example Author" } },
    mentions: [{ id: 0, mentionText: "Example", mentioned: { user: { id: "mentioned-user" } } }],
    attachments: [
      {
        id: "menu-pdf",
        name: "menu.pdf",
        contentType: "application/pdf",
        contentUrl: "https://example.invalid/menu.pdf",
      },
    ],
    channelIdentity: { teamId, channelId },
  };
}
const root = message("root", null);
function read(
  params: Record<string, unknown> = {},
  context: Partial<ChannelMessageActionContext> = {},
) {
  return handle({
    channel: "msteams",
    cfg: { channels: { msteams: { groupPolicy: "allowlist" } } },
    action: "read",
    params: { messageId: "root", threadId: "root", ...params },
    accountId: "support",
    requesterAccountId: "support",
    toolContext: {
      currentChannelProvider: "msteams",
      currentChannelId: `conversation:${channelId}`,
      currentGraphChannelId: to,
      currentChatType: "channel",
    },
    ...context,
  });
}
function pages(...values: unknown[]) {
  graph.fetch.mockResolvedValueOnce(root);
  for (const value of values) {
    graph.fetch.mockResolvedValueOnce(value);
  }
}

beforeEach(() => {
  graph.fetch.mockReset();
  graph.token.mockReset().mockResolvedValue("synthetic-token");
});

describe("native Teams read action with complete channel threads", () => {
  it("returns root and every page, chronological replies and native metadata through the real read owner", async () => {
    const earlier = { ...message("earlier"), createdDateTime: "2026-01-02T03:04:04Z" };
    const later = message("later");
    pages({ value: [later], "@odata.nextLink": nextLink }, { value: [earlier, later] });
    const result = await read();
    expect(result).toMatchObject({
      details: {
        ok: true,
        action: "read",
        message: {
          id: "root",
          threadId: "root",
          complete: true,
          hasMore: false,
          pageCount: 2,
          messages: [
            { id: "root", replyToId: null },
            { id: "earlier", replyToId: "root" },
            {
              id: "later",
              replyToId: "root",
              from: later.from,
              createdAt: "2026-01-02T03:04:05Z",
              lastModifiedAt: "2026-01-02T03:04:06Z",
              mentions: later.mentions,
              attachments: later.attachments,
              text: "Message later",
            },
          ],
        },
      },
    });
    expect(graph.fetch.mock.calls.map(([request]) => request.path)).toEqual([
      rootPath,
      `${repliesPath}?$top=50`,
      `${repliesPath}?$skiptoken=page-2`,
    ]);
    expect(graph.token).toHaveBeenCalledWith(expect.anything(), { accountId: "support" });
  });

  it("retains replies beyond the inbound newest-50 window", async () => {
    pages(
      {
        value: Array.from({ length: 50 }, (_, index) => message(`reply-${index}`)),
        "@odata.nextLink": nextLink,
      },
      { value: [message("last-reply")] },
    );
    const result = await getMessageMSTeams(target);
    expect(result).toMatchObject({ complete: true, hasMore: false, pageCount: 2 });
    expect(result).toHaveProperty(
      "messages",
      expect.arrayContaining([
        expect.objectContaining({ id: "root" }),
        expect.objectContaining({ id: "reply-0" }),
        expect.objectContaining({ id: "last-reply" }),
      ]),
    );
    expect(result).toHaveProperty("messages.length", 52);
  });

  it.each([
    nextLink.replace("19%3Achannel%40thread.tacv2", channelId),
    nextLink.replace("%3A", "%3a"),
  ])("accepts equivalent channel encoding in a Graph continuation: %s", async (continuation) => {
    pages({ value: [], "@odata.nextLink": continuation }, { value: [message("reply")] });
    await expect(getMessageMSTeams(target)).resolves.toMatchObject({
      complete: true,
      pageCount: 2,
      messages: [{ id: "root" }, { id: "reply" }],
    });
    expect(graph.fetch.mock.calls[2]![0].path).toBe(`${repliesPath}?$skiptoken=page-2`);
  });

  it("preserves attachment-only answers and deletion metadata without claiming content inspection", async () => {
    const attachment = { ...message("attachment"), body: { content: "", contentType: "text" } };
    const deleted = {
      ...message("withdrawn"),
      deletedDateTime: "2026-01-02T03:04:07Z",
      from: null,
    };
    pages({ value: [attachment, deleted] });
    await expect(getMessageMSTeams(target)).resolves.toMatchObject({
      complete: true,
      messages: expect.arrayContaining([
        expect.objectContaining({
          id: "attachment",
          text: "",
          attachments: attachment.attachments,
        }),
        expect.objectContaining({
          id: "withdrawn",
          deletedAt: deleted.deletedDateTime,
          from: null,
        }),
      ]),
    });
  });

  it("preserves ordinary single-message reads without explicit thread selection", async () => {
    graph.fetch.mockResolvedValueOnce(root);
    const result = await read({ threadId: undefined });
    expect(result).toMatchObject({
      details: {
        message: {
          id: "root",
          text: "Message root",
          from: root.from,
          createdAt: root.createdDateTime,
        },
      },
    });
    expect(result.details).not.toHaveProperty("message.complete");
    expect(graph.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects inconsistent explicit root selection without requesting Graph", async () => {
    expect(await read({ threadId: "other" })).toMatchObject({ isError: true });
    expect(graph.fetch).not.toHaveBeenCalled();
    await expect(getMessageMSTeams({ ...target, threadId: "other" })).rejects.toThrow("must match");
    expect(graph.token).not.toHaveBeenCalled();
  });

  it.each([
    { requesterAccountId: "other" },
    { toolContext: { currentChannelProvider: "discord", currentGraphChannelId: to } },
  ])("does not promote a non-current or foreign-account reader: %j", async (context) => {
    await expect(read({}, context)).rejects.toThrow("read target is not allowed");
    expect(graph.token).not.toHaveBeenCalled();
    expect(graph.fetch).not.toHaveBeenCalled();
  });

  it.each(["", "   ", 42])("rejects an invalid explicit thread selector: %j", async (threadId) => {
    expect(await read({ threadId })).toMatchObject({ isError: true });
    expect(graph.fetch).not.toHaveBeenCalled();
  });

  it("rejects chat thread selection rather than treating it as a complete channel thread", async () => {
    await expect(getMessageMSTeams({ ...target, to: "19:chat@thread.v2" })).rejects.toThrow(
      "teamId/channelId",
    );
    expect(graph.fetch).not.toHaveBeenCalled();
  });
});

describe("complete thread traversal failure controls", () => {
  it.each([
    ["foreign host", nextLink.replace("graph.microsoft.com", "example.invalid")],
    ["HTTP", nextLink.replace("https:", "http:")],
    ["other team", nextLink.replace(teamId, "other-team")],
    ["other channel", nextLink.replace("19%3Achannel%40thread.tacv2", "other-channel")],
    ["other root", nextLink.replace("/root/", "/other/")],
    ["other collection", nextLink.replace("/replies?", "?")],
    ["encoded channel separator", nextLink.replace("/channels/", "/channels%2F")],
    ["encoded root separator", nextLink.replace("/root/replies", "/root%2Freplies")],
    ["credential URL", nextLink.replace("https://", "https://user:password@")],
    ["fragment", `${nextLink}#fragment`],
    ["malformed", "not a URL"],
    ["missing", ""],
    ["null", null],
  ])("rejects %s continuation before a second replies request", async (_name, continuation) => {
    pages({ value: [], "@odata.nextLink": continuation });
    await expect(getMessageMSTeams(target)).rejects.toThrow();
    expect(graph.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["missing collection", {}],
    ["malformed collection", { value: {} }],
    ["missing ID", { value: [{ ...message("reply"), id: undefined }] }],
    ["wrong parent", { value: [message("reply", "foreign-root")] }],
    ["root in replies", { value: [message("root")] }],
    ["missing timestamp", { value: [{ ...message("reply"), createdDateTime: undefined }] }],
    [
      "foreign channel",
      { value: [{ ...message("reply"), channelIdentity: { teamId, channelId: "foreign" } }] },
    ],
    ["malformed mentions", { value: [{ ...message("reply"), mentions: {} }] }],
    ["malformed attachments", { value: [{ ...message("reply"), attachments: {} }] }],
    [
      "malformed deletion timestamp",
      { value: [{ ...message("reply"), deletedDateTime: "not-a-date" }] },
    ],
    ["malformed body", { value: [{ ...message("reply"), body: { content: 42 } }] }],
    ["malformed author", { value: [{ ...message("reply"), from: "author" }] }],
    [
      "conflicting duplicate",
      { value: [message("reply"), { ...message("reply"), body: { content: "changed" } }] },
    ],
  ])("fails closed on %s", async (_name, page) => {
    pages(page);
    await expect(getMessageMSTeams(target)).rejects.toThrow();
  });

  it.each([message("other", null), message("root", "parent")])(
    "rejects an inconsistent root resource",
    async (invalidRoot) => {
      graph.fetch.mockResolvedValueOnce(invalidRoot);
      await expect(getMessageMSTeams(target)).rejects.toThrow("malformed identity");
      expect(graph.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("fails rather than claim completion when a later page fails", async () => {
    pages({ value: [message("reply")], "@odata.nextLink": nextLink });
    graph.fetch.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(getMessageMSTeams(target)).rejects.toThrow("provider unavailable");
  });

  it("rejects pagination cycles without repeating a physical page request", async () => {
    pages({ value: [], "@odata.nextLink": nextLink }, { value: [], "@odata.nextLink": nextLink });
    await expect(getMessageMSTeams(target)).rejects.toThrow("loop detected");
    expect(graph.fetch).toHaveBeenCalledTimes(3);
  });

  it("fails closed at the bounded page limit", async () => {
    graph.fetch.mockResolvedValueOnce(root).mockImplementation(async () => ({
      value: [],
      "@odata.nextLink": `https://graph.microsoft.com/v1.0${repliesPath}?$skiptoken=${graph.fetch.mock.calls.length}`,
    }));
    await expect(getMessageMSTeams(target)).rejects.toThrow("page limit");
    expect(graph.fetch).toHaveBeenCalledTimes(51);
  });

  it.each([
    ["message", () => Array.from({ length: 2_501 }, (_, index) => message(`reply-${index}`))],
    ["byte", () => [{ ...message("large"), body: { content: "x".repeat(8 * 1024 * 1024) } }]],
  ] as const)("fails closed at the %s limit", async (_name, replies) => {
    pages({ value: replies() });
    await expect(getMessageMSTeams(target)).rejects.toThrow("message or byte limit");
  });

  it("marks an exhausted empty replies collection complete", async () => {
    pages({ value: [] });
    await expect(getMessageMSTeams(target)).resolves.toMatchObject({
      messages: [{ id: "root", replyToId: null }],
      pageCount: 1,
      complete: true,
      hasMore: false,
    });
  });
});
