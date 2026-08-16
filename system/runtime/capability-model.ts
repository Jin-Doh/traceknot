export const CAPABILITY_NAMES = [
  "executeCommands",
  "executeBrowser",
  "captureArtifacts",
  "bindSnapshot",
  "provideIndependentEvidence",
  "persistEvidence",
  "approveExceptions",
  "isolatedReadOnlyReview",
  "enforcedStructuredOutput",
  "enforceSkillOriginEgressDeny",
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];
export type CapabilitySet = Readonly<Record<CapabilityName, boolean>>;
export type CapabilityRecord = Readonly<{
  schemaVersion: "quality-capability/v2";
  host: string;
  adapterVersion: string;
  capabilities: CapabilitySet;
  limitations: readonly string[];
}>;

const LEGACY_CAPABILITY_NAMES = CAPABILITY_NAMES.slice(0, -1);
const RECORD_KEYS = ["schemaVersion", "host", "adapterVersion", "capabilities", "limitations"] as const;

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
    capabilities[name] = enabled;
  }
  return Object.freeze(capabilities);
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
  if (!exactKeys(input, ["schemaVersion", "host", "adapterVersion", "capabilities"], ["limitations"])) {
    throw Error("capability record keys are invalid");
  }
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
