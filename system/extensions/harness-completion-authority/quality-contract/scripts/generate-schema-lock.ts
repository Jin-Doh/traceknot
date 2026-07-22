#!/usr/bin/env bun

import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const CONTRACT_ROOT = join(process.cwd(), "quality-contract");
const SCHEMA_DIR = join(CONTRACT_ROOT, "schemas");
const GENERATED_DIR = join(CONTRACT_ROOT, "generated");
const LEGACY_LOCK_VERSION = "phase0.v1";
const LEGACY_PIN_DOMAIN = "gajae:quality-contract:schema-lock-pin:v1";
const PIN_DOMAIN = "gajae:quality-contract:qtb:extension-lock-pin:v1";
const SIGNATURE_SET_DOMAIN = "gajae:quality-contract:qtb:extension-lock-signature-set:v1";
const SIGNATURE_RECORD_DOMAIN = "gajae:quality-contract:qtb:extension-lock-signature:v1";
const EXTENSION_LOCK_VERSION = "qtb-extension-lock-v1";
const SOURCE_INVENTORY_DOMAIN = "gajae:quality-contract:qtb:extension-source-inventory:v1";
const FIXTURE_NOTICE = "Phase 0 development fixture only; not production signing material.";
const GENERATOR_VERSION = "phase0-schema-lock-v4";
const EXTENSION_VERIFICATION_REPORT_DOMAIN = "gajae:quality-contract:qtb:extension-verification-report:v1";
const EXTENSION_APPROVAL_PAYLOAD_DOMAIN = "gajae:quality-contract:qtb:extension-approval-payload:v1";
const EXTENSION_APPROVAL_RECEIPT_DOMAIN = "gajae:quality-contract:qtb:extension-approval-receipt:v1";
const EXTENSION_FINAL_INDEX_DOMAIN = "gajae:quality-contract:qtb:extension-final-index:v1";
const EXTENSION_CONTRACT_VERSION = "quality-contract.v1";
const EXTENSION_TIMESTAMP = "2026-01-01T00:00:00.000Z";
const EXTENSION_SIGNER = {
  principalId: "independent-contract-verifier",
  role: "independent-contract-verifier" as const,
  keyId: "independent-contract-verifier-fixture-v1",
  algorithm: "hmac-sha256" as const,
  fixtureOnly: true as const,
  secret: "gajae-quality-contract-independent-verifier-development-fixture-v1",
};
const EXTENSION_REVIEWS = [
  { role: "architect", runId: "run-019f68ee-1669-7000-b298-2f02d3a57a8a", stage: "phase-a-extension-freeze", stageN: 5, artifactSha256: "55a552b0782c2c74af9e7e8a7fece494cd2f518aa2c0689d447983d1b4b01dec", verdict: "APPROVE/CLEAR" },
  { role: "critic", runId: "run-019f68ee-427a-7000-949b-603db39a08a1", stage: "phase-a-extension-freeze", stageN: 5, artifactSha256: "d9d6a302171adb10558141c0797f799bd0a208d2ec50b516ed076e3db91c6778", verdict: "OKAY" },
] as const;
const LEGACY_GENERATED_PATHS = [
  "quality-contract/generated/schema-lock.payload.json",
  "quality-contract/generated/schema-lock.signatures.json",
  "quality-contract/generated/schema-lock.pin.sha256",
  "quality-contract/generated/model-report.json",
  "quality-contract/generated/sqlite-report.json",
  "quality-contract/generated/callsite-manifest.json",
  "quality-contract/generated/callsite-audit-report.json",
] as const;
const EXTENSION_LAYER_PATHS = {
  sourceInventory: "quality-contract/generated/quiescence-extension-source-inventory.json",
  lockPayload: "quality-contract/generated/quiescence-extension-lock.payload.json",
  lockSignatures: "quality-contract/generated/quiescence-extension-lock.signatures.json",
  lockPin: "quality-contract/generated/quiescence-extension-lock.pin.sha256",
  verificationReport: "quality-contract/generated/quiescence-extension-verification-report.json",
  approvalPayload: "quality-contract/generated/quiescence-extension-approval.payload.json",
  approvalReceipt: "quality-contract/generated/quiescence-extension-approval-receipt.json",
  finalIndex: "quality-contract/generated/quiescence-extension-final-index.json",
} as const;
function layerHash(domain: string, unsigned: JsonObject): string {
  return sha256(framed(domain, utf8(canonicalize(unsigned))));
}
function inventoryEntry(relativePath: string, kind: Artifact["kind"]): Artifact {
  const absolute = join(process.cwd(), relativePath);
  if (!existsSync(absolute)) throw new Error(`required generated artifact does not exist: ${relativePath}`);
  const raw = readFileSync(absolute);
  const entry: Artifact = { path: relativePath, bytes: raw.byteLength, sha256: sha256(raw), kind };
  if (relativePath.endsWith(".json")) entry.canonicalSha256 = sha256(utf8(canonicalize(JSON.parse(raw.toString("utf8")) as JsonValue)));
  return entry;
}
function sortedInventory(entries: Artifact[]): Artifact[] {
  return entries.slice().sort((a, b) => compareUtf8(a.path, b.path));
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type Artifact = { path: string; bytes: number; sha256: string; canonicalSha256?: string; kind?: string };
type SignatureRecord = { artifact: string; domain: string; algorithm: "hmac-sha256"; keyId: string; fixtureOnly: true; signatureHash: string };

const LEGACY_BOUND_INPUTS = ["manifests/semantic-rules.json", "fixtures/schema-negative-fixtures.json"] as const;
const EXTENSION_SOURCE_PATHS = [
  "quality-contract/schemas/quiescence-and-budget.schema.json",
  "quality-contract/schemas/verification-command.schema.json",
  "quality-contract/schemas/official-source-evidence.schema.json",
  "quality-contract/schemas/phase-b-verification.schema.json",
  "quality-contract/schemas/quiescence-extension-approval.schema.json",
  "quality-contract/schemas/evidence-and-receipt.schema.json",
  "quality-contract/schemas/lifecycle-and-terminal.schema.json",
  "quality-contract/schemas/trust-and-identity.schema.json",
  "quality-contract/manifests/harness-lifecycle-events.json",
  "quality-contract/manifests/harness-ingress-contract.json",
  "quality-contract/manifests/candidate-materialization-policy.json",
  "quality-contract/manifests/verification-commands.json",
  "quality-contract/manifests/verification-obligations.json",
  "quality-contract/manifests/phase-b-verification-matrix.json",
  "quality-contract/manifests/risk-policy.json",
  "quality-contract/manifests/semantic-rules.json",
  "quality-contract/manifests/platform-profiles.json",
  "quality-contract/manifests/mutation-capabilities.json",
  "quality-contract/evidence/official/claude-code-hooks.v1.json",
  "quality-contract/evidence/official/openai-codex-hooks.v1.json",
  "quality-contract/evidence/official/openai-codex-app-server.v1.json",
  "quality-contract/models/quiescence-budget-model.ts",
  "quality-contract/fixtures/quiescence-model-fixtures.json",
  "quality-contract/fixtures/quiescence-sql-fixtures.json",
  "quality-contract/fixtures/quiescence-extension-approval-fixtures.json",
  "quality-contract/fixtures/callsite-audit-fixtures.json",
  "quality-contract/fixtures/sql-fixtures.json",
  "quality-contract/models/lifecycle-model.ts",
  "quality-contract/models/storage-model.ts",
  "quality-contract/fixtures/schema-negative-fixtures.json",
  "quality-contract/sql/quiescence-authority.sql",
  "quality-contract/sql/authority.sql",
  "quality-contract/sql/promotion.sql",
  "quality-contract/scripts/generate-schema-lock.ts",
  "quality-contract/scripts/verify-models.ts",
  "quality-contract/scripts/verify-contracts.ts",
  "quality-contract/scripts/verify-sqlite-node.ts",
  "quality-contract/scripts/verify-sqlite.ts",
  "quality-contract/scripts/sqlite-race-worker.ts",
  "quality-contract/scripts/generate-callsite-manifest.ts",
  "quality-contract/scripts/audit-callsite-coverage.ts",
  "quality-contract/scripts/run-phase-b-verification.ts",
] as const;

const BASE_PHASE0 = {
  reportHash: "f17975cfbfa945673d1a7f02bd990a5b5300f542423938ef7e85d8bfe5260402",
  payloadHash: "3883a611b61c28e81fb7b239bd9f98fc21b23f0bff9c98a5a4502a6009bcd63f",
  pinHash: "63659b6a830b64dc1f5b464a0a6aa06fead805df9dd95af9250b966a554885d5",
} as const;

function compareUtf8(left: string, right: string): number { return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")); }
function canonicalize(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number is not canonical JSON");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value).sort(compareUtf8).map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}
function utf8(value: string): Buffer { return Buffer.from(value, "utf8"); }
function sha256(value: Uint8Array | string): string { return createHash("sha256").update(value).digest("hex"); }
function lp8(value: Uint8Array): Buffer { const result = Buffer.alloc(8); result.writeBigUInt64BE(BigInt(value.byteLength)); return result; }
function framed(domain: string, bytes: Uint8Array): Buffer { const d = utf8(domain); return Buffer.concat([lp8(d), d, lp8(bytes), bytes]); }
function writeJson(file: string, value: JsonValue): void { writeFileSync(file, `${canonicalize(value)}\n`, "utf8"); }
function writeLayerJson(relativePath: string, value: JsonValue): void {
  writeJson(join(process.cwd(), relativePath), value);
}
function rejectPlaceholder(value: unknown, at: string): void {
  if (typeof value === "string" && /(?:TODO|PLACEHOLDER|REPLACE[_-]?ME|FIXME)/i.test(value)) throw new Error(`placeholder marker at ${at}`);
  if (Array.isArray(value)) value.forEach((child, index) => rejectPlaceholder(child, `${at}[${index}]`));
  else if (value !== null && typeof value === "object") for (const [key, child] of Object.entries(value)) rejectPlaceholder(child, `${at}.${key}`);
}
function walkSchemaFiles(directory: string): string[] {
  if (!existsSync(directory)) throw new Error(`schema directory does not exist: ${directory}`);
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => compareUtf8(a.name, b.name))) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walkSchemaFiles(file));
    else if (entry.isFile() && entry.name.endsWith(".schema.json")) result.push(file);
  }
  return result.sort((a, b) => compareUtf8(relative(directory, a), relative(directory, b)));
}
function validateStructure(schema: JsonObject, file: string): void {
  if (schema.$schema !== DRAFT_2020_12 || typeof schema.$id !== "string" || schema.type !== "object") throw new Error(`${file}: invalid closed schema header`);
  if (schema.unevaluatedProperties !== false && schema.additionalProperties !== false) throw new Error(`${file}: root must be closed`);
  if (!Array.isArray(schema.oneOf) || schema.oneOf.length === 0 || schema.$defs === null || typeof schema.$defs !== "object" || Array.isArray(schema.$defs)) throw new Error(`${file}: oneOf/$defs are required`);
  rejectPlaceholder(schema, file);
  const defs = schema.$defs as JsonObject;
  const visit = (value: unknown, at: string, closedByComposition = false): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach((child, index) => visit(child, `${at}[${index}]`, closedByComposition));
    const object = value as Record<string, unknown>;
    if (typeof object.$ref === "string" && object.$ref.startsWith("#/$defs/") && !(object.$ref.slice(8) in defs)) throw new Error(`${file}: missing reference at ${at}`);
    if (object.type === "object" && object["x-composition-fragment"] !== true && object.additionalProperties !== false && (object.additionalProperties === undefined || object.additionalProperties === true) && object.unevaluatedProperties !== false && !closedByComposition && !at.endsWith("/$defs/envelope")) throw new Error(`${file}: object schema is not closed at ${at}`);
    for (const [key, child] of Object.entries(object)) {
      visit(child, `${at}/${key}`, closedByComposition || (key === "allOf" && object.unevaluatedProperties === false));
    }
  };
  visit(schema, "#");
}
function readJsonArtifact(relativePath: string): Artifact {
  const absolute = join(process.cwd(), relativePath);
  if (!existsSync(absolute)) throw new Error(`required source does not exist: ${relativePath}`);
  const raw = readFileSync(absolute); let parsed: JsonValue;
  try { parsed = JSON.parse(raw.toString("utf8")) as JsonValue; } catch (error) { throw new Error(`${relativePath}: invalid JSON (${String(error)})`); }
  rejectPlaceholder(parsed, relativePath);
  return { path: relativePath, bytes: raw.byteLength, sha256: sha256(raw), canonicalSha256: sha256(utf8(canonicalize(parsed))) };
}
function readSource(relativePath: string): Artifact {
  if (relativePath.endsWith(".json")) return { ...readJsonArtifact(relativePath), kind: "source" };
  const absolute = join(process.cwd(), relativePath); if (!existsSync(absolute)) throw new Error(`required source does not exist: ${relativePath}`);
  const raw = readFileSync(absolute);
  return { path: relativePath, bytes: raw.byteLength, sha256: sha256(raw), kind: "source" };
}
function readSchemas(): { records: Artifact[]; bytesByPath: Map<string, Buffer> } {
  const records: Artifact[] = []; const bytesByPath = new Map<string, Buffer>();
  for (const absolute of walkSchemaFiles(SCHEMA_DIR)) {
    const raw = readFileSync(absolute); let parsed: JsonObject;
    try { parsed = JSON.parse(raw.toString("utf8")) as JsonObject; } catch (error) { throw new Error(`${absolute}: invalid JSON (${String(error)})`); }
    validateStructure(parsed, absolute);
    const pathName = `schemas/${relative(SCHEMA_DIR, absolute).replaceAll("\\", "/")}`;
    records.push({ path: pathName, bytes: raw.byteLength, sha256: sha256(raw), canonicalSha256: sha256(utf8(canonicalize(parsed))), schemaId: String(parsed.$id), schemaVersion: LEGACY_LOCK_VERSION }); bytesByPath.set(pathName, raw);
  }
  if (!records.length) throw new Error("no schema artifacts found");
  return { records: records.sort((a, b) => compareUtf8(a.path, b.path)), bytesByPath };
}
function legacyBoundInputs(): Artifact[] {
  return LEGACY_BOUND_INPUTS.map(input => readJsonArtifact(`quality-contract/${input}`)).map(item => {
    const pathName = item.path.replace("quality-contract/", "");
    return { ...item, path: pathName, kind: pathName.startsWith("fixtures/") ? "fixture" : "semantic-rules" };
  }).sort((a, b) => compareUtf8(a.path, b.path));
}
function goldenVectors(): JsonObject[] {
  const canonical = canonicalize({ z: 3, a: [true, null, "phase0"], nested: { beta: 2, alpha: 1 } });
  return [{ name: "canonical-object-order", canonical, sha256: sha256(utf8(canonical)) }];
}
function generateLegacy(): void {
  const allSchemas = readSchemas();
  const records = allSchemas.records;
  const bytesByPath = allSchemas.bytesByPath;
  const boundInputs = legacyBoundInputs();
  const payload: JsonObject = { lockVersion: LEGACY_LOCK_VERSION, generator: "quality-contract/scripts/generate-schema-lock.ts", generatorVersion: GENERATOR_VERSION, canonicalization: "RFC8785-compatible-json-canonicalization", schemaDraft: DRAFT_2020_12, schemas: records as unknown as JsonValue, boundInputs: boundInputs as unknown as JsonValue, goldenVectors: goldenVectors() };
  const payloadBytes = utf8(canonicalize(payload));
  const keys = [{ keyId: "phase0-fixture-alpha", key: "gajae-phase0-development-fixture-alpha-v1" }, { keyId: "phase0-fixture-beta", key: "gajae-phase0-development-fixture-beta-v1" }] as const;
  const signatures: SignatureRecord[] = []; const sign = (artifact: string, bytes: Uint8Array, index: number): void => { const key = keys[index % keys.length]!; const domain = `gajae:quality-contract:schema-artifact:${artifact}:v1`; signatures.push({ artifact, domain, algorithm: "hmac-sha256", keyId: key.keyId, fixtureOnly: true, signatureHash: createHmac("sha256", key.key).update(framed(domain, bytes)).digest("hex") }); };
  records.forEach((record, index) => sign(record.path, bytesByPath.get(record.path)!, index)); boundInputs.forEach((record, index) => sign(record.path, readFileSync(join(CONTRACT_ROOT, record.path)), records.length + index));
  const payloadDomain = "gajae:quality-contract:schema-lock-payload:v1";
  const payloadKey = keys[0]!;
  signatures.push({ artifact: "generated/schema-lock.payload.json", domain: payloadDomain, algorithm: "hmac-sha256", keyId: payloadKey.keyId, fixtureOnly: true, signatureHash: createHmac("sha256", payloadKey.key).update(framed(payloadDomain, payloadBytes)).digest("hex") });
  signatures.sort((a, b) => compareUtf8(a.artifact, b.artifact)); const signatureBytes = utf8(canonicalize({ lockVersion: LEGACY_LOCK_VERSION, fixtureOnly: true, fixtureNotice: FIXTURE_NOTICE, records: signatures as unknown as JsonValue }));
  const pin = sha256(Buffer.concat([framed(LEGACY_PIN_DOMAIN, payloadBytes), framed(LEGACY_PIN_DOMAIN, signatureBytes)]));
  mkdirSync(GENERATED_DIR, { recursive: true }); writeFileSync(join(GENERATED_DIR, "schema-lock.payload.json"), payloadBytes); writeFileSync(join(GENERATED_DIR, "schema-lock.signatures.json"), signatureBytes); writeFileSync(join(GENERATED_DIR, "schema-lock.pin.sha256"), `${pin}\n`, "utf8");
}
function extensionReportArtifact(): Artifact {
  return inventoryEntry(EXTENSION_LAYER_PATHS.verificationReport, "generated");
}
function phase0VerificationArtifact(): Artifact {
  return inventoryEntry("quality-contract/generated/phase0-verification-report.json", "generated");
}
const PREAPPROVAL_CHECK_IDS = [
  "schemas/closed-draft-2020-12-structure",
  "phase-b/intent-matrix-and-trace-mutants",
  "schemas/negative-fixture-mutations-rejected",
  "schema-lock/exact-canonical-payload-signature-pin",
  "model-reducer/source-mutants-killed",
  "model-report/zero-failures-required-cases-invariants",
  "model/strict-no-emit-typecheck",
  "sqlite-report/zero-failures-boundary-assertions",
  "callsite-manifest/source-hashes-and-fail-closed-allow",
  "callsite-manifest/independent-complete-coverage-audit",
  "policy-manifests/unknown-block-risk-raise-only-unsupported-profiles",
] as const;

function walkContractFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => compareUtf8(a.name, b.name))) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walkContractFiles(file));
    else if (entry.isFile()) result.push(file);
  }
  return result.sort((a, b) => compareUtf8(a, b));
}
function phase0Artifacts(): Array<{ path: string; bytes: number; sha256: string }> {
  return walkContractFiles(CONTRACT_ROOT)
    .map(file => relative(process.cwd(), file).replaceAll("\\", "/"))
    .filter(pathName => pathName !== "quality-contract/generated/phase0-verification-report.json" &&
      !pathName.startsWith("quality-contract/generated/quiescence-extension-"))
    .map(pathName => {
      const entry = inventoryEntry(pathName, "generated");
      return { path: entry.path, bytes: entry.bytes, sha256: entry.sha256 };
    })
    .sort((a, b) => compareUtf8(a.path, b.path));
}
function readLayerJson(relativePath: string): JsonObject {
  const file = join(process.cwd(), relativePath);
  if (!existsSync(file)) throw new Error(`required evidence does not exist: ${relativePath}`);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")) as unknown; }
  catch (error) { throw new Error(`${relativePath}: invalid JSON (${String(error)})`); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${relativePath}: evidence must be an object`);
  return parsed as JsonObject;
}
function validatePreapprovalEvidence(
  inventory: JsonObject,
  payloadDigest: string,
  pin: string,
  entries: Artifact[],
  legacyEntries: Artifact[],
  l0AndL1Entries: Artifact[],
): JsonObject {
  if (payloadDigest !== sha256(utf8(canonicalize(readLayerJson(EXTENSION_LAYER_PATHS.lockPayload))))) {
    throw new Error("extension lock payload digest changed before approval");
  }
  if (pin !== readFileSync(join(process.cwd(), EXTENSION_LAYER_PATHS.lockPin), "utf8").trim()) {
    throw new Error("extension lock pin changed before approval");
  }
  const report = readLayerJson(EXTENSION_LAYER_PATHS.verificationReport);
  const reportHash = report.reportHash;
  const reportUnsigned = { ...report };
  delete reportUnsigned.reportHash;
  if (report.format !== "quality-contract.quiescence-extension-verification-report.v1" ||
      report.hashDomain !== EXTENSION_VERIFICATION_REPORT_DOMAIN ||
      report.phase1Authorized !== false ||
      report.passed !== true ||
      !Array.isArray(report.failures) || report.failures.length !== 0 ||
      typeof reportHash !== "string" ||
      reportHash !== layerHash(EXTENSION_VERIFICATION_REPORT_DOMAIN, reportUnsigned)) {
    throw new Error("missing, stale, or failing extension preapproval evidence");
  }
  const expectedReportEntries = sortedInventory([
    ...entries,
    ...legacyEntries,
    ...l0AndL1Entries,
    phase0VerificationArtifact(),
  ]);
  if (canonicalize(report.entries as JsonValue) !== canonicalize(expectedReportEntries as unknown as JsonValue)) {
    throw new Error("extension preapproval evidence is not bound to exact report artifacts");
  }
  const sourceInventoryEntry = l0AndL1Entries.find(entry => entry.path === EXTENSION_LAYER_PATHS.sourceInventory);
  const reportedSourceEntry = (report.entries as Artifact[]).find(entry => entry.path === EXTENSION_LAYER_PATHS.sourceInventory);
  if (sourceInventoryEntry === undefined || reportedSourceEntry === undefined ||
      canonicalize(sourceInventoryEntry as unknown as JsonValue) !== canonicalize(reportedSourceEntry as unknown as JsonValue) ||
      String(inventory.inventoryHash) !== layerHash(SOURCE_INVENTORY_DOMAIN, {
        format: inventory.format,
        hashDomain: inventory.hashDomain,
        phase1Authorized: false,
        entries: inventory.entries,
      } as JsonObject)) {
    throw new Error("extension preapproval evidence is not bound to the exact current source inventory hash");
  }

  const phase0Path = "quality-contract/generated/phase0-verification-report.json";
  const phase0 = readLayerJson(phase0Path);
  if (phase0.format !== "quality-contract.phase0-verification-report.v1" ||
      phase0.verifier !== "quality-contract/scripts/verify-contracts.ts" ||
      phase0.phase1Authorized !== false ||
      phase0.failed !== 0 ||
      !Array.isArray(phase0.checks) ||
      phase0.checks.length !== PREAPPROVAL_CHECK_IDS.length ||
      PREAPPROVAL_CHECK_IDS.some(id => {
        const item = (phase0.checks as JsonObject[]).find(candidate => candidate.id === id);
        return item === undefined || item.passed !== true;
      })) {
    throw new Error("extension preapproval evidence is not a fresh zero-failure A-D report");
  }
  const expectedPhase0Artifacts = phase0Artifacts();
  if (canonicalize(phase0.artifactHashes as JsonValue) !== canonicalize(expectedPhase0Artifacts as unknown as JsonValue)) {
    throw new Error("extension preapproval evidence has stale phase0 report artifacts");
  }
  return report;
}
function generateExtension(): void {
  if (process.env.CODEX_CANONICAL_ROOT) throw new Error("CODEX_CANONICAL_ROOT is forbidden during hermetic freeze");
  const entries = sortedInventory([...new Set(EXTENSION_SOURCE_PATHS)].map(readSource));
  const inventoryUnsigned: JsonObject = {
    format: "quality-contract.quiescence-extension-source-inventory.v1",
    hashDomain: SOURCE_INVENTORY_DOMAIN,
    phase1Authorized: false,
    entries: entries as unknown as JsonValue,
  };
  const inventory = { ...inventoryUnsigned, inventoryHash: layerHash(SOURCE_INVENTORY_DOMAIN, inventoryUnsigned) } as JsonObject;
  mkdirSync(GENERATED_DIR, { recursive: true });
  writeLayerJson(EXTENSION_LAYER_PATHS.sourceInventory, inventory);

  const payload = {
    format: "quality-contract.quiescence-extension-lock-payload.v1",
    lockVersion: EXTENSION_LOCK_VERSION,
    hashDomain: "gajae:quality-contract:qtb:extension-lock-payload:v1",
    phase1Authorized: false,
    sourceInventoryHash: inventory.inventoryHash,
    basePhase0: BASE_PHASE0,
    goldenVectors: [
      { name: "u64-empty-components", inputHex: "", outputHex: "0000000000000000000000000000000000000000000000000000000000000000" },
      { name: "sha256-abc", inputHex: "616263", outputHex: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
    ],
  } as JsonObject;
  const payloadBytes = utf8(canonicalize(payload));
  const payloadDigest = sha256(payloadBytes);
  const key = { signerId: "qtb-extension-fixture", keyId: "qtb-extension-fixture-v1", algorithm: "hmac-sha256" as const, secret: "gajae-qtb-extension-development-fixture-v1" };
  const projection = { payloadDigest, signerId: key.signerId, keyId: key.keyId, algorithm: key.algorithm } as JsonObject;
  const signatureHash = createHmac("sha256", key.secret).update(framed(SIGNATURE_RECORD_DOMAIN, utf8(canonicalize(projection)))).digest("hex");
  const signatureRecords = [{ signerId: key.signerId, keyId: key.keyId, algorithm: key.algorithm, signatureHash }];
  const signature = { version: "qtb-lock-signatures-v1", hashDomain: SIGNATURE_SET_DOMAIN, payloadDigest, threshold: 1, records: signatureRecords } as JsonObject;
  const signatureBytes = utf8(canonicalize(signature));
  const pin = sha256(Buffer.concat([framed(PIN_DOMAIN, payloadBytes), framed(SIGNATURE_SET_DOMAIN, signatureBytes)]));
  writeLayerJson(EXTENSION_LAYER_PATHS.lockPayload, payload);
  writeLayerJson(EXTENSION_LAYER_PATHS.lockSignatures, signature);
  writeFileSync(join(process.cwd(), EXTENSION_LAYER_PATHS.lockPin), `${pin}\n`, "utf8");

  const legacyEntries = LEGACY_GENERATED_PATHS.map(pathName => inventoryEntry(pathName, "generated"));
  const l0AndL1Entries = [
    inventoryEntry(EXTENSION_LAYER_PATHS.sourceInventory, "generated"),
    inventoryEntry(EXTENSION_LAYER_PATHS.lockPayload, "generated"),
    inventoryEntry(EXTENSION_LAYER_PATHS.lockSignatures, "generated"),
    inventoryEntry(EXTENSION_LAYER_PATHS.lockPin, "generated"),
  ];
  const report = validatePreapprovalEvidence(inventory, payloadDigest, pin, entries, legacyEntries, l0AndL1Entries);
  const reportHash = String(report.reportHash);
  const approvalPayloadUnsigned: JsonObject = {
    format: "quality-contract.quiescence-extension-approval-payload.v1",
    contractVersion: EXTENSION_CONTRACT_VERSION,
    hashDomain: EXTENSION_APPROVAL_PAYLOAD_DOMAIN,
    decision: "APPROVE_PHASE0_EXTENSION_ONLY",
    phase1Authorized: false,
    basePhase0: BASE_PHASE0,
    extension: { payloadHash: payloadDigest, pinHash: pin, verificationReportHash: reportHash },
    reviewRecords: EXTENSION_REVIEWS as unknown as JsonValue,
    artifactInventory: sortedInventory([
      ...(report.entries as Artifact[]),
      extensionReportArtifact(),
    ]) as unknown as JsonValue,
    verifier: {
      path: "quality-contract/scripts/verify-contracts.ts",
      sourceSha256: sha256(readFileSync(join(process.cwd(), "quality-contract/scripts/verify-contracts.ts"))),
      command: "bun quality-contract/scripts/verify-contracts.ts --preapprove-extension",
      environment: "TZ=UTC;LC_ALL=C;SOURCE_DATE_EPOCH=0",
    },
  };
  const approvalPayloadBytes = utf8(canonicalize(approvalPayloadUnsigned));
  const approvalPayloadHash = layerHash(EXTENSION_APPROVAL_PAYLOAD_DOMAIN, approvalPayloadUnsigned);
  writeLayerJson(EXTENSION_LAYER_PATHS.approvalPayload, approvalPayloadUnsigned);

  const issuer = { principalId: EXTENSION_SIGNER.principalId, role: EXTENSION_SIGNER.role, keyId: EXTENSION_SIGNER.keyId, algorithm: EXTENSION_SIGNER.algorithm, fixtureOnly: EXTENSION_SIGNER.fixtureOnly };
  const receiptUnsigned: JsonObject = {
    format: "quality-contract.quiescence-extension-approval-receipt.v1",
    contractVersion: EXTENSION_CONTRACT_VERSION,
    hashDomain: EXTENSION_APPROVAL_RECEIPT_DOMAIN,
    decision: "APPROVE_PHASE0_EXTENSION_ONLY",
    phase1Authorized: false,
    payloadHash: approvalPayloadHash,
    issuer,
    issuedAtUtc: EXTENSION_TIMESTAMP,
    canonicalPayloadSha256: sha256(approvalPayloadBytes),
  };
  const receiptSignatureHash = createHmac("sha256", EXTENSION_SIGNER.secret).update(framed(EXTENSION_APPROVAL_RECEIPT_DOMAIN, utf8(canonicalize(receiptUnsigned)))).digest("hex");
  const receipt = { ...receiptUnsigned, signature: { signerId: EXTENSION_SIGNER.principalId, keyId: EXTENSION_SIGNER.keyId, algorithm: EXTENSION_SIGNER.algorithm, signatureHash: receiptSignatureHash } } as JsonObject;
  writeLayerJson(EXTENSION_LAYER_PATHS.approvalReceipt, receipt);

  const finalEntries = sortedInventory([
    ...(approvalPayloadUnsigned.artifactInventory as Artifact[]),
    inventoryEntry(EXTENSION_LAYER_PATHS.approvalPayload, "generated"),
    inventoryEntry(EXTENSION_LAYER_PATHS.approvalReceipt, "generated"),
  ]);
  const finalIndexUnsigned: JsonObject = {
    format: "quality-contract.quiescence-extension-final-index.v1",
    hashDomain: EXTENSION_FINAL_INDEX_DOMAIN,
    phase1Authorized: false,
    entries: finalEntries as unknown as JsonValue,
    overallPass: true,
  };
  writeLayerJson(EXTENSION_LAYER_PATHS.finalIndex, { ...finalIndexUnsigned, finalIndexHash: layerHash(EXTENSION_FINAL_INDEX_DOMAIN, finalIndexUnsigned) } as JsonObject);
}
function main(): void { if (process.env.CODEX_CANONICAL_ROOT) throw new Error("CODEX_CANONICAL_ROOT is forbidden during hermetic freeze"); generateLegacy(); generateExtension(); }
if (process.argv[1] && relative(process.cwd(), process.argv[1]) === relative(process.cwd(), new URL(import.meta.url).pathname)) { try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; } }
