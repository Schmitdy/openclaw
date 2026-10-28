import { createRequire } from "node:module";
import type { SpawnStdioEntry } from "../spawn-secret-input.js";
import type { ServiceChildStart } from "./service-child-protocol.js";
import { reserveStdioEntry, setStdioEntry } from "./service-child-stdio.js";

export function commandStdio(start: ServiceChildStart) {
  const stdio: SpawnStdioEntry[] = [
    start.stdinMode === "inherit" ? "inherit" : "pipe",
    "pipe",
    "pipe",
  ];
  if (start.secretFd !== undefined) {
    setStdioEntry(stdio, start.secretFd, start.secretFd);
  }
  const lineageFd = reserveStdioEntry(stdio, start.lineageFd ?? "pipe");
  const inheritedLineageFds = [
    lineageFd,
    ...(start.parentLineageFds ?? []).map((fd) => reserveStdioEntry(stdio, fd)),
  ];
  if (start.ownedWorker) {
    stdio.push("ipc");
  }
  return { stdio, lineageFd, inheritedLineageFds };
}

export function delay(ms: number, retainOwner = false): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (!retainOwner) {
      timer.unref?.();
    }
  });
}

export function loadBunOutputShutdown(): ((fd: number, how: number) => number) | undefined {
  if (process.versions.bun && (process.platform === "darwin" || process.platform === "linux")) {
    // SAFETY: Bun's built-in FFI binds only the POSIX socket shutdown ABI here.
    const ffi = createRequire(import.meta.url)("bun:ffi") as {
      dlopen(
        path: string,
        symbols: Record<string, { args: string[]; returns: string }>,
      ): {
        symbols: { shutdown: (fd: number, how: number) => number };
      };
    };
    const library = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
    return ffi.dlopen(library, {
      shutdown: { args: ["i32", "i32"], returns: "i32" },
    }).symbols.shutdown;
  }

  return undefined;
}
