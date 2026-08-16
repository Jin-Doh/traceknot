import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "bun:test";
import {
  CAPABILITY_NAMES,
  missingCapabilities,
  parseCapabilityRecord,
} from "./capability-model";

const adapterNames = ["omp", "opencode", "gajae-code", "codex", "claude-code"] as const;

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

describe("shared host capability model", () => {
  test("keeps every public capability-bearing schema standalone", async () => {
    const modelSchema = await json("contracts/capability-model.schema.json");
    for (const path of [
      "contracts/capability-v2.schema.json",
      "contracts/risk-discovery-report.schema.json",
    ]) {
      const publicSchema = await json(path) as {
        $defs?: { capabilityModel?: unknown };
      };
      expect(publicSchema.$defs?.capabilityModel).toEqual(modelSchema);
      expect(() => new Ajv2020({ strict: true }).compile(publicSchema)).not.toThrow();
    }
  });

  test("keeps TypeScript, shared schema, and every adapter record aligned", async () => {
    const modelSchema = await json("contracts/capability-model.schema.json") as Record<string, unknown>;
    const recordSchema = await json("contracts/capability-v2.schema.json") as object;
    const ajv = new Ajv2020({ strict: true });
    const validate = ajv.compile(recordSchema);

    expect([...(modelSchema as { required: readonly string[] }).required]).toEqual([...CAPABILITY_NAMES]);
    for (const adapterName of adapterNames) {
      const input = await json(`adapters/${adapterName}/capability.json`);
      expect(validate(input)).toBe(true);
      const record = parseCapabilityRecord(input);
      expect(record.host).toBe(adapterName);
      expect(Object.keys(record.capabilities)).toEqual([...CAPABILITY_NAMES]);
      expect(Object.isFrozen(record)).toBe(true);
      expect(Object.isFrozen(record.capabilities)).toBe(true);
    }
  });

  test("rejects partial, extra, and ambiguous capability records", () => {
    const base = {
      schemaVersion: "quality-capability/v2",
      host: "test-host",
      adapterVersion: "test-v1",
      capabilities: Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, false])),
      limitations: ["runtime handshake required"],
    };
    expect(() => parseCapabilityRecord({
      ...base,
      capabilities: { ...base.capabilities, executeCommands: "yes" },
    })).toThrow("executeCommands");
    const { executeCommands: _, ...partial } = base.capabilities;
    expect(() => parseCapabilityRecord({ ...base, capabilities: partial })).toThrow("capability keys");
    const { enforceSkillOriginEgressDeny: __, ...legacyCapabilities } = base.capabilities;
    expect(parseCapabilityRecord({ ...base, capabilities: legacyCapabilities }).capabilities.enforceSkillOriginEgressDeny).toBe(false);
    expect(() => parseCapabilityRecord({
      ...base,
      capabilities: { ...base.capabilities, inventedCapability: false },
    })).toThrow("capability keys");
    expect(() => parseCapabilityRecord({
      ...base,
      limitations: ["runtime handshake required", "runtime handshake required"],
    })).toThrow("duplicate limitation");
    const sparseLimitations = new Array<string>(1);
    expect(() => parseCapabilityRecord({
      ...base,
      capabilities: { ...base.capabilities, executeCommands: true },
      limitations: sparseLimitations,
    })).toThrow("limitation");
    expect(() => parseCapabilityRecord({ ...base, extra: true })).toThrow("record keys");
  });

  test("accepts legacy v2 capability records in the schema", async () => {
    const recordSchema = await json("contracts/capability-v2.schema.json") as object;
    const validate = new Ajv2020({ strict: true }).compile(recordSchema);
    const capabilities = Object.fromEntries(CAPABILITY_NAMES.slice(0, -1).map((name) => [name, false]));
    expect(validate({
      schemaVersion: "quality-capability/v2",
      host: "legacy-host",
      adapterVersion: "legacy-v1",
      capabilities,
      limitations: [],
    })).toBe(true);
  });

  test("reports every unavailable required capability in canonical order", () => {
    const available = Object.fromEntries(
      CAPABILITY_NAMES.map((name) => [name, name === "executeCommands"]),
    ) as Record<(typeof CAPABILITY_NAMES)[number], boolean>;
    expect(missingCapabilities(available, [
      "persistEvidence",
      "executeCommands",
      "bindSnapshot",
      "persistEvidence",
    ])).toEqual(["bindSnapshot", "persistEvidence"]);
  });
});
