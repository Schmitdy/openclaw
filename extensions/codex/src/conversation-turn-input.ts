import path from "node:path";
import { fileURLToPath } from "node:url";
import { isImageMediaFact } from "openclaw/plugin-sdk/media-mime";
import type {
  PluginHookInboundClaimEvent,
  PluginHookMediaFact,
} from "openclaw/plugin-sdk/plugin-entry";
import type { CodexUserInput } from "./app-server/protocol.js";

export function buildCodexConversationTurnInput(params: {
  prompt: string;
  event: PluginHookInboundClaimEvent;
}): CodexUserInput[] {
  return [
    { type: "text", text: params.prompt, text_elements: [] },
    ...(params.event.media ?? [])
      .map(toCodexImageInput)
      .filter((item): item is CodexUserInput => item !== undefined),
  ];
}

function toCodexImageInput(media: PluginHookMediaFact): CodexUserInput | undefined {
  if (!isImageMediaFact(media)) {
    return undefined;
  }
  const localPath = media.path ?? readLocalMediaPath(media.url);
  if (localPath) {
    if (!/^file:\/\//iu.test(localPath)) {
      return { type: "localImage", path: localPath };
    }
    try {
      const fileUrl = new URL(localPath);
      // Validate encoding explicitly because fileURLToPath validation differs by runtime.
      decodeURIComponent(fileUrl.pathname);
      const normalized = fileURLToPath(fileUrl);
      return normalized ? { type: "localImage", path: normalized } : undefined;
    } catch {
      return undefined;
    }
  }
  return media.url ? { type: "image", url: media.url } : undefined;
}

function readLocalMediaPath(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (/^file:\/\//iu.test(value)) {
    return value;
  }
  if (value.startsWith("//")) {
    return undefined;
  }
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return value;
  }
  return /^[a-z][a-z0-9+.-]*:/i.test(value) ? undefined : value;
}
