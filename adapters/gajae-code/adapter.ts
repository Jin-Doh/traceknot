import {
  discoverHostCapabilities,
  type HostCapabilityHandshake,
} from "../shared/capability-adapter";
import type { CapabilityRecord } from "../../system/runtime/capability-model";

export type GajaeCodeCapabilityHandshake = HostCapabilityHandshake;

export async function discoverGajaeCodeCapabilities(
  handshake: GajaeCodeCapabilityHandshake | undefined,
): Promise<CapabilityRecord> {
  return discoverHostCapabilities(
    "gajae-code",
    new URL("./capability.json", import.meta.url),
    handshake,
  );
}
