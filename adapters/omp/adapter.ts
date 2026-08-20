import {
  discoverHostCapabilities,
  type HostCapabilityHandshake,
} from "../shared/capability-adapter";
import type { CapabilityRecord } from "../../system/runtime/capability-model";

export type OmpCapabilityHandshake = HostCapabilityHandshake;

export async function discoverOmpCapabilities(
  handshake: OmpCapabilityHandshake | undefined,
): Promise<CapabilityRecord> {
  return discoverHostCapabilities(
    "omp",
    new URL("./capability.json", import.meta.url),
    handshake,
  );
}
