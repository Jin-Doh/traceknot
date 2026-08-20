import {
  discoverHostCapabilities,
  type HostCapabilityHandshake,
} from "../shared/capability-adapter";
import type { CapabilityRecord } from "../../system/runtime/capability-model";

export type CodexCapabilityHandshake = HostCapabilityHandshake;

export async function discoverCodexCapabilities(
  handshake: CodexCapabilityHandshake | undefined,
): Promise<CapabilityRecord> {
  return discoverHostCapabilities(
    "codex",
    new URL("./capability.json", import.meta.url),
    handshake,
  );
}
