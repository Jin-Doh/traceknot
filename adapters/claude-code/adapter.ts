import {
  discoverHostCapabilities,
  type HostCapabilityHandshake,
} from "../shared/capability-adapter";
import type { CapabilityRecord } from "../../system/runtime/capability-model";

export type ClaudeCodeCapabilityHandshake = HostCapabilityHandshake;

export async function discoverClaudeCodeCapabilities(
  handshake: ClaudeCodeCapabilityHandshake | undefined,
): Promise<CapabilityRecord> {
  return discoverHostCapabilities(
    "claude-code",
    new URL("./capability.json", import.meta.url),
    handshake,
  );
}
