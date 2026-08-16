export const V2_CAPABILITY_NAMES = [
  "executeCommands",
  "executeBrowser",
  "captureArtifacts",
  "bindSnapshot",
  "provideIndependentEvidence",
  "persistEvidence",
  "approveExceptions",
  "isolatedReadOnlyReview",
  "enforcedStructuredOutput",
] as const;

export const CAPABILITY_NAMES = [
  ...V2_CAPABILITY_NAMES,
  "enforceSkillOriginEgressDeny",
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];
export type V2CapabilityName = (typeof V2_CAPABILITY_NAMES)[number];
export type CapabilitySet = Readonly<Record<CapabilityName, boolean>>;
export type V2CapabilitySet = Readonly<Record<V2CapabilityName, boolean>>;

export const EGRESS_ORIGIN_ATTRIBUTIONS = ["none", "session-scope", "host-attested"] as const;
export const EGRESS_TOOL_MEDIATIONS = ["none", "known-network-tools", "all-tool-calls"] as const;
export const EGRESS_PROCESS_ISOLATIONS = ["none", "network-denied", "managed-egress"] as const;
export const EGRESS_AUDIT_DURABILITIES = ["none", "best-effort", "pre-transmit-durable"] as const;

export type EgressEnforcementProfile = Readonly<{
  originAttribution: (typeof EGRESS_ORIGIN_ATTRIBUTIONS)[number];
  toolMediation: (typeof EGRESS_TOOL_MEDIATIONS)[number];
  processIsolation: (typeof EGRESS_PROCESS_ISOLATIONS)[number];
  auditDurability: (typeof EGRESS_AUDIT_DURABILITIES)[number];
}>;

export type CapabilityRecordV2 = Readonly<{
  schemaVersion: "quality-capability/v2";
  host: string;
  adapterVersion: string;
  capabilities: CapabilitySet;
  limitations: readonly string[];
}>;

export type CapabilityRecordV3 = Readonly<{
  schemaVersion: "quality-capability/v3";
  host: string;
  adapterVersion: string;
  capabilities: V2CapabilitySet;
  enforcementProfile: EgressEnforcementProfile;
  limitations: readonly string[];
}>;

export type CapabilityRecord = CapabilityRecordV2 | CapabilityRecordV3;

const LEGACY_CAPABILITY_NAMES = V2_CAPABILITY_NAMES;
const RECORD_KEYS = ["schemaVersion", "host", "adapterVersion", "capabilities"] as const;
const V3_RECORD_KEYS = ["schemaVersion", "host", "adapterVersion", "capabilities", "enforcementProfile"] as const;

function object(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(`${label} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...expected, ...optional]);
  return expected.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function nonemptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw Error(`${label} must be a nonempty string`);
  return value;
}

function parseCapabilities(value: unknown): CapabilitySet {
  const input = object(value, "capabilities");
  const currentModel = exactKeys(input, CAPABILITY_NAMES);
  const legacyModel = exactKeys(input, LEGACY_CAPABILITY_NAMES);
  if (!currentModel && !legacyModel) throw Error("capability keys must exactly match the shared model");
  const capabilities = {} as Record<CapabilityName, boolean>;
  for (const name of CAPABILITY_NAMES) {
    const enabled = Object.hasOwn(input, name) ? input[name] : undefined;
    if (name === "enforceSkillOriginEgressDeny" && enabled === undefined && legacyModel) {
      capabilities[name] = false;
      continue;
    }
    if (typeof enabled !== "boolean") throw Error(`${name} must be boolean`);
    if (name === "enforceSkillOriginEgressDeny" && enabled) {
      throw Error("enforceSkillOriginEgressDeny requires a v3 enforcementProfile");
    }
    capabilities[name] = enabled;
  }
  return Object.freeze(capabilities);
}

function parseV2Capabilities(value: unknown): V2CapabilitySet {
  const input = object(value, "capabilities");
  if (!exactKeys(input, V2_CAPABILITY_NAMES)) throw Error("v3 capability keys must exactly match the v2 model");
  const capabilities = {} as Record<V2CapabilityName, boolean>;
  for (const name of V2_CAPABILITY_NAMES) {
    if (typeof input[name] !== "boolean") throw Error(`${name} must be boolean`);
    capabilities[name] = input[name] as boolean;
  }
  return Object.freeze(capabilities);
}

export function parseEnforcementProfile(value: unknown): EgressEnforcementProfile {
  const input = object(value, "enforcementProfile");
  if (!exactKeys(input, ["originAttribution", "toolMediation", "processIsolation", "auditDurability"])) {
    throw Error("enforcementProfile keys are invalid");
  }
  if (!EGRESS_ORIGIN_ATTRIBUTIONS.includes(input.originAttribution as EgressEnforcementProfile["originAttribution"])) {
    throw Error("enforcementProfile.originAttribution is invalid");
  }
  if (!EGRESS_TOOL_MEDIATIONS.includes(input.toolMediation as EgressEnforcementProfile["toolMediation"])) {
    throw Error("enforcementProfile.toolMediation is invalid");
  }
  if (!EGRESS_PROCESS_ISOLATIONS.includes(input.processIsolation as EgressEnforcementProfile["processIsolation"])) {
    throw Error("enforcementProfile.processIsolation is invalid");
  }
  if (!EGRESS_AUDIT_DURABILITIES.includes(input.auditDurability as EgressEnforcementProfile["auditDurability"])) {
    throw Error("enforcementProfile.auditDurability is invalid");
  }
  return Object.freeze({
    originAttribution: input.originAttribution as EgressEnforcementProfile["originAttribution"],
    toolMediation: input.toolMediation as EgressEnforcementProfile["toolMediation"],
    processIsolation: input.processIsolation as EgressEnforcementProfile["processIsolation"],
    auditDurability: input.auditDurability as EgressEnforcementProfile["auditDurability"],
  });
}

export function isHardenedEgressProfile(profile: EgressEnforcementProfile): boolean {
  return profile.originAttribution !== "none"
    && profile.toolMediation === "all-tool-calls"
    && profile.processIsolation === "network-denied"
    && profile.auditDurability === "pre-transmit-durable";
}

function parseLimitations(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw Error("limitations must be an array");
  const limitations: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw Error("limitation entries must not be sparse");
    limitations.push(nonemptyString(value[index], "limitation"));
  }
  if (new Set(limitations).size !== limitations.length) throw Error("duplicate limitation");
  return Object.freeze(limitations);
}

export function parseCapabilityRecord(value: unknown): CapabilityRecord {
  const input = object(value, "capability record");
  if (input.schemaVersion === "quality-capability/v3") {
    if (!exactKeys(input, V3_RECORD_KEYS, ["limitations"])) throw Error("v3 capability record keys are invalid");
    return Object.freeze({
      schemaVersion: "quality-capability/v3",
      host: nonemptyString(input.host, "host"),
      adapterVersion: nonemptyString(input.adapterVersion, "adapterVersion"),
      capabilities: parseV2Capabilities(input.capabilities),
      enforcementProfile: parseEnforcementProfile(input.enforcementProfile),
      limitations: parseLimitations(input.limitations),
    });
  }
  if (!exactKeys(input, RECORD_KEYS, ["limitations"])) throw Error("capability record keys are invalid");
  if (input.schemaVersion !== "quality-capability/v2") throw Error("unsupported capability schemaVersion");
  return Object.freeze({
    schemaVersion: "quality-capability/v2",
    host: nonemptyString(input.host, "host"),
    adapterVersion: nonemptyString(input.adapterVersion, "adapterVersion"),
    capabilities: parseCapabilities(input.capabilities),
    limitations: parseLimitations(input.limitations),
  });
}

export function missingCapabilities(
  available: CapabilitySet,
  required: readonly CapabilityName[],
): readonly CapabilityName[] {
  const requiredNames = new Set(required);
  return Object.freeze(CAPABILITY_NAMES.filter((name) => requiredNames.has(name) && !available[name]));
}
