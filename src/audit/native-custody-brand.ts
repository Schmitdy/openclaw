/** Process-local diagnostic origin only, never execution or disclosure authority. */
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export const NATIVE_CUSTODY_OWNERS = ["cli-process", "cron-standing-grant"] as const;
const receipts = resolveGlobalSingleton(
  Symbol.for("openclaw.nativeCustodyReceipts"),
  () => new WeakSet<object>(),
);
export function isNativeCustodyOwner(value: string): boolean {
  return NATIVE_CUSTODY_OWNERS.some((owner) => owner === value);
}
export function markNativeCustodyReceipt(value: object): void {
  receipts.add(value);
}
export function isNativeCustodyReceipt(value: object): boolean {
  return receipts.has(value);
}
