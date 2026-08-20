import {
  discoverHostCapabilities,
  type HostCapabilityHandshake,
} from "../shared/capability-adapter";
import type { CapabilityRecord } from "../../system/runtime/capability-model";

export type OpenCodeCapabilityHandshake = HostCapabilityHandshake;

export async function discoverOpenCodeCapabilities(
  handshake: OpenCodeCapabilityHandshake | undefined,
): Promise<CapabilityRecord> {
  return discoverHostCapabilities(
    "opencode",
    new URL("./capability.json", import.meta.url),
    handshake,
  );
}
