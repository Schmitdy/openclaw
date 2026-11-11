import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
import { createProviderOperationDeadline } from "openclaw/plugin-sdk/provider-http";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { GRAPH_ROOT } from "./attachments/shared.js";
import { fetchGraphJson } from "./graph.js";
import { MSTEAMS_REQUEST_TIMEOUT_MS } from "./request-timeout.js";

const MAX_THREAD_PAGES = 50;
const MAX_THREAD_MESSAGES = 2_501;
const MAX_THREAD_BYTES = 8 * 1024 * 1024;

type ThreadMessage = {
  id: string;
  replyToId: string | null;
  text: unknown;
  contentType: unknown;
  from: unknown;
  createdAt: string;
  lastModifiedAt: unknown;
  deletedAt: unknown;
  mentions: unknown[];
  attachments: unknown[];
};

/** A complete read is distinct from the bounded newest-50 inbound enrichment. */
export async function readChannelMessageThread(params: {
  token: string;
  basePath: string;
  rootId: string;
}) {
  if (!params.rootId.trim()) {
    throw new Error("MS Teams thread root is required.");
  }
  const rootPath = `${params.basePath}/messages/${encodeURIComponent(params.rootId)}`;
  const repliesPath = `${rootPath}/replies`;
  const collection = new URL(`${GRAPH_ROOT}${repliesPath}`);
  const deadline = createProviderOperationDeadline({
    label: "MS Teams complete thread read",
    timeoutMs: MSTEAMS_REQUEST_TIMEOUT_MS,
  });
  const messages = new Map<string, { raw: Record<string, unknown>; message: ThreadMessage }>();
  let messageCount = 0;
  let bytes = 0;

  function addMessage(raw: unknown, root: boolean) {
    if (
      !isRecord(raw) ||
      typeof raw.id !== "string" ||
      !raw.id.trim() ||
      typeof raw.createdDateTime !== "string" ||
      !Number.isFinite(Date.parse(raw.createdDateTime)) ||
      (root
        ? raw.id !== params.rootId || (raw.replyToId != null && raw.replyToId !== "")
        : raw.id === params.rootId || raw.replyToId !== params.rootId) ||
      (raw.mentions !== undefined &&
        (!Array.isArray(raw.mentions) || !raw.mentions.every(isRecord))) ||
      (raw.attachments !== undefined &&
        (!Array.isArray(raw.attachments) || !raw.attachments.every(isRecord))) ||
      (raw.from != null && !isRecord(raw.from)) ||
      (raw.body != null &&
        (!isRecord(raw.body) ||
          (raw.body.content !== undefined && typeof raw.body.content !== "string") ||
          (raw.body.contentType !== undefined && typeof raw.body.contentType !== "string"))) ||
      (raw.lastModifiedDateTime != null &&
        (typeof raw.lastModifiedDateTime !== "string" ||
          !Number.isFinite(Date.parse(raw.lastModifiedDateTime)))) ||
      (raw.deletedDateTime != null &&
        (typeof raw.deletedDateTime !== "string" ||
          !Number.isFinite(Date.parse(raw.deletedDateTime))))
    ) {
      throw new Error("MS Teams thread message has malformed identity, parent or metadata.");
    }
    // Graph may omit channelIdentity, but an explicit identity must match the authorized route.
    if (raw.channelIdentity !== undefined) {
      const identity = raw.channelIdentity;
      if (
        !isRecord(identity) ||
        typeof identity.teamId !== "string" ||
        typeof identity.channelId !== "string" ||
        `/teams/${encodeURIComponent(identity.teamId)}/channels/${encodeURIComponent(identity.channelId)}` !==
          params.basePath
      ) {
        throw new Error("MS Teams thread message belongs to another channel.");
      }
    }
    bytes += Buffer.byteLength(JSON.stringify(raw), "utf8");
    messageCount++;
    if (messageCount > MAX_THREAD_MESSAGES || bytes > MAX_THREAD_BYTES) {
      throw new Error("MS Teams complete thread read exceeded its message or byte limit.");
    }
    const previous = messages.get(raw.id);
    if (previous) {
      if (!isDeepStrictEqual(previous.raw, raw)) {
        throw new Error("MS Teams thread contains conflicting duplicate message IDs.");
      }
      return;
    }
    const body = isRecord(raw.body) ? raw.body : undefined;
    messages.set(raw.id, {
      raw,
      message: {
        id: raw.id,
        replyToId: root ? null : params.rootId,
        text: body?.content,
        contentType: body?.contentType,
        from: raw.from,
        createdAt: raw.createdDateTime,
        lastModifiedAt: raw.lastModifiedDateTime,
        deletedAt: raw.deletedDateTime,
        mentions: raw.mentions ?? [],
        attachments: raw.attachments ?? [],
      },
    });
  }

  addMessage(
    await fetchGraphJson<unknown>({ token: params.token, path: rootPath, deadline }),
    true,
  );
  let path = `${repliesPath}?$top=50`;
  const visited = new Set<string>();
  let pageCount = 0;
  while (true) {
    const url = new URL(`${GRAPH_ROOT}${path}`);
    // Canonical query ordering also detects loops that only reorder query parameters.
    url.searchParams.sort();
    if (visited.has(url.href)) {
      throw new Error("MS Teams thread replies pagination loop detected.");
    }
    visited.add(url.href);
    const page = await fetchGraphJson<unknown>({ token: params.token, path, deadline });
    pageCount++;
    if (!isRecord(page) || !Array.isArray(page.value)) {
      throw new Error("MS Teams thread replies page is malformed.");
    }
    for (const raw of page.value) {
      addMessage(raw, false);
    }
    const next = page["@odata.nextLink"];
    if (next === undefined) {
      break;
    }
    if (typeof next !== "string" || !next) {
      throw new Error("MS Teams thread replies continuation is malformed.");
    }
    const continuation = new URL(next);
    if (
      continuation.protocol !== "https:" ||
      continuation.origin !== collection.origin ||
      continuation.pathname !== collection.pathname ||
      continuation.username ||
      continuation.password ||
      continuation.hash
    ) {
      throw new Error("MS Teams thread replies continuation is outside the authorized collection.");
    }
    if (pageCount >= MAX_THREAD_PAGES) {
      throw new Error("MS Teams complete thread read exceeded its page limit.");
    }
    // Keep transport, cloud origin, deadline and live read authority owned by graph.ts.
    path = `${repliesPath}${continuation.search}`;
  }
  const root = messages.get(params.rootId)!.message;
  const replies = [...messages.values()]
    .map(({ message }) => message)
    .filter((message) => message.id !== params.rootId)
    .toSorted(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id),
    );
  return {
    id: params.rootId,
    threadId: params.rootId,
    messages: [root, ...replies],
    pageCount,
    complete: true as const,
    hasMore: false as const,
  };
}
