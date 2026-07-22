#!/usr/bin/env bun
import { proveConstructorRoundTrips } from "./run-phase-b-verification";

import { createHash, createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type Check = { id: string; passed: boolean; details?: string };
type SchemaRecord = { path: string; bytes: number; sha256: string; canonicalSha256: string; schemaId: string; schemaVersion: string };
type ValidationResult = { errors: string[]; evaluated: Set<string> };
type AnyObject = Record<string, any>;
type ModelSourceMutation = { id: string; target: "lifecycle" | "storage"; from: string; to: string };
type ModelMutationResult = { id: string; target: ModelSourceMutation["target"]; killed: boolean; status: "killed" | "survived" | "invalid"; details: string };

const repoRoot = resolve(import.meta.dir, "../..");
const contractRoot = join(repoRoot, "quality-contract");
const schemaRoot = join(contractRoot, "schemas");
const generatedRoot = join(contractRoot, "generated");
const reportPath = join(generatedRoot, "phase0-verification-report.json");
const draft = "https://json-schema.org/draft/2020-12/schema";
const lockVersion = "phase0.v1";
const fixtureNotice = "Phase 0 development fixture only; not production signing material.";
const extensionDomains = {
  sourceInventory: "gajae:quality-contract:qtb:extension-source-inventory:v1",
  lockPayload: "gajae:quality-contract:qtb:extension-lock-payload:v1",
  lockSignatureSet: "gajae:quality-contract:qtb:extension-lock-signature-set:v1",
  lockSignature: "gajae:quality-contract:qtb:extension-lock-signature:v1",
  lockPin: "gajae:quality-contract:qtb:extension-lock-pin:v1",
  verificationReport: "gajae:quality-contract:qtb:extension-verification-report:v1",
  approvalPayload: "gajae:quality-contract:qtb:extension-approval-payload:v1",
  approvalReceipt: "gajae:quality-contract:qtb:extension-approval-receipt:v1",
  finalIndex: "gajae:quality-contract:qtb:extension-final-index:v1",
} as const;
const extensionTimestamp = "2026-01-01T00:00:00.000Z";
const extensionSigner = {
  principalId: "independent-contract-verifier",
  role: "independent-contract-verifier",
  keyId: "independent-contract-verifier-fixture-v1",
  algorithm: "hmac-sha256",
  fixtureOnly: true,
  secret: "gajae-quality-contract-independent-verifier-development-fixture-v1",
} as const;
const extensionReviews = [
  { role: "architect", runId: "run-019f68ee-1669-7000-b298-2f02d3a57a8a", stage: "phase-a-extension-freeze", stageN: 5, artifactSha256: "55a552b0782c2c74af9e7e8a7fece494cd2f518aa2c0689d447983d1b4b01dec", verdict: "APPROVE/CLEAR" },
  { role: "critic", runId: "run-019f68ee-427a-7000-949b-603db39a08a1", stage: "phase-a-extension-freeze", stageN: 5, artifactSha256: "d9d6a302171adb10558141c0797f799bd0a208d2ec50b516ed076e3db91c6778", verdict: "OKAY" },
] as const;
const extensionPaths = {
  sourceInventory: "quality-contract/generated/quiescence-extension-source-inventory.json",
  lockPayload: "quality-contract/generated/quiescence-extension-lock.payload.json",
  lockSignatures: "quality-contract/generated/quiescence-extension-lock.signatures.json",
  lockPin: "quality-contract/generated/quiescence-extension-lock.pin.sha256",
  verificationReport: "quality-contract/generated/quiescence-extension-verification-report.json",
  approvalPayload: "quality-contract/generated/quiescence-extension-approval.payload.json",
  approvalReceipt: "quality-contract/generated/quiescence-extension-approval-receipt.json",
  finalIndex: "quality-contract/generated/quiescence-extension-final-index.json",
} as const;
const extensionSourcePaths = [
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
const extensionLegacyPaths = [
  "quality-contract/generated/schema-lock.payload.json",
  "quality-contract/generated/schema-lock.signatures.json",
  "quality-contract/generated/schema-lock.pin.sha256",
  "quality-contract/generated/model-report.json",
  "quality-contract/generated/sqlite-report.json",
  "quality-contract/generated/callsite-manifest.json",
  "quality-contract/generated/callsite-audit-report.json",
] as const;
const pinDomain = "gajae:quality-contract:schema-lock-pin:v1";
const checks: Check[] = [];

const check = (id: string, passed: boolean, details?: string): void => {
  checks.push({ id, passed, ...(details === undefined ? {} : { details }) });
};
const run = (id: string, action: () => void): void => {
  try { action(); check(id, true); }
  catch (error) { check(id, false, error instanceof Error ? error.message : String(error)); }
};
const compare = (a: string, b: string): number => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
const utf8 = (value: string): Buffer => Buffer.from(value, "utf8");
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const canonicalize = (value: JsonValue): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number is not canonical JSON");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value).sort(compare).map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
};
const lengthPrefix = (bytes: Uint8Array): Buffer => {
  const output = Buffer.alloc(8);
  output.writeBigUInt64BE(BigInt(bytes.byteLength));
  return output;
};
const domainSeparated = (domain: string, bytes: Uint8Array): Buffer => Buffer.concat([lengthPrefix(utf8(domain)), utf8(domain), lengthPrefix(bytes), Buffer.from(bytes)]);
const parseStrictJson = (text: string, label: string): any => {
  let offset = 0;
  const whitespace = (): void => { while (/\s/.test(text[offset] ?? "")) offset++; };
  const stringValue = (): string => {
    if (text[offset] !== "\"") throw new Error(`${label}: expected JSON string at ${offset}`);
    const start = offset++;
    while (offset < text.length) {
      const character = text[offset++];
      if (character === "\\") {
        if (offset >= text.length) throw new Error(`${label}: unterminated escape`);
        offset++;
        continue;
      }
      if (character === "\"") return JSON.parse(text.slice(start, offset));
    }
    throw new Error(`${label}: unterminated string`);
  };
  const value = (): void => {
    whitespace();
    const character = text[offset];
    if (character === "{") {
      offset++;
      whitespace();
      const keys = new Set<string>();
      if (text[offset] === "}") { offset++; return; }
      while (true) {
        whitespace();
        const key = stringValue();
        if (keys.has(key)) throw new Error(`${label}: duplicate JSON key ${JSON.stringify(key)}`);
        keys.add(key);
        whitespace();
        if (text[offset++] !== ":") throw new Error(`${label}: expected colon`);
        value();
        whitespace();
        const delimiter = text[offset++];
        if (delimiter === "}") return;
        if (delimiter !== ",") throw new Error(`${label}: expected object delimiter`);
      }
    }
    if (character === "[") {
      offset++;
      whitespace();
      if (text[offset] === "]") { offset++; return; }
      while (true) {
        value();
        whitespace();
        const delimiter = text[offset++];
        if (delimiter === "]") return;
        if (delimiter !== ",") throw new Error(`${label}: expected array delimiter`);
      }
    }
    if (character === "\"") { stringValue(); return; }
    const remainder = text.slice(offset);
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(remainder)?.[0];
    if (token === undefined) throw new Error(`${label}: invalid JSON token at ${offset}`);
    offset += token.length;
  };
  if (text.charCodeAt(0) === 0xfeff) throw new Error(`${label}: BOM is forbidden`);
  value();
  whitespace();
  if (offset !== text.length) throw new Error(`${label}: trailing JSON bytes`);
  return JSON.parse(text);
};
const readJson = (file: string): any => parseStrictJson(readFileSync(file, "utf8"), file);
const expectObject = (value: unknown, label: string): AnyObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as AnyObject;
};
const walkFiles = (directory: string): string[] => {
  if (!existsSync(directory)) return [];
  const output: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...walkFiles(file));
    else if (entry.isFile()) output.push(file);
  }
  return output.sort(compare);
};

const placeholder = /(?:TODO|PLACEHOLDER|REPLACE[_-]?ME|FIXME)/i;
const schemaFiles = (): string[] => walkFiles(schemaRoot).filter(file => file.endsWith(".schema.json"));
const schemaMap = new Map<string, AnyObject>();

function validateSchemaShape(schema: AnyObject, file: string): void {
  if (schema.$schema !== draft) throw new Error(`${file}: Draft 2020-12 declaration missing`);
  if (typeof schema.$id !== "string" || schema.$id.length === 0) throw new Error(`${file}: missing $id`);
  if (schema.type !== "object" || !Array.isArray(schema.oneOf) || schema.oneOf.length === 0) throw new Error(`${file}: root object/oneOf contract missing`);
  if (schema.unevaluatedProperties !== false && schema.additionalProperties !== false) throw new Error(`${file}: root object is not closed`);
  const defs = expectObject(schema.$defs, `${file}: $defs`);
  const visit = (node: unknown, at: string, propertyName?: string, closedByComposition = false): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach((item, index) => visit(item, `${at}[${index}]`, undefined, closedByComposition)); return; }
    const object = node as AnyObject;
    for (const [key, child] of Object.entries(object)) {
      if (placeholder.test(key) || (typeof child === "string" && placeholder.test(child))) throw new Error(`${file}: placeholder at ${at}.${key}`);
    }
    if (typeof object.$ref === "string") {
      if (!object.$ref.startsWith("#/$defs/")) throw new Error(`${file}: external reference at ${at}`);
      const target = object.$ref.slice("#/$defs/".length);
      if (!(target in defs)) throw new Error(`${file}: missing reference target ${target}`);
    }
    if (object.pattern !== undefined && (typeof object.pattern !== "string" || (!at.endsWith("/propertyNames") && object.type !== "string" && object.$ref === undefined))) {
      throw new Error(`${file}: pattern is not a typed string at ${at}`);
    }
    if (Array.isArray(object.required) && object.properties !== undefined) {
      const properties = expectObject(object.properties, `${file}: properties for ${at}`);
      for (const required of object.required) {
        if (typeof required !== "string" || !(required in properties)) throw new Error(`${file}: required field ${String(required)} lacks a property schema at ${at}`);
      }
    }
    if (object.properties !== undefined) {
      const properties = expectObject(object.properties, `${file}: properties for ${at}`);
      for (const [name, propertySchema] of Object.entries(properties)) {
        const descriptor = expectObject(propertySchema, `${file}: property ${name}`);
        if (!["type", "$ref", "const", "enum", "anyOf", "oneOf", "allOf"].some(key => key in descriptor)) {
          throw new Error(`${file}: property ${name} has no type or constraint at ${at}`);
        }
      }
    }
    if (object.type === "object" && object["x-composition-fragment"] !== true && object.additionalProperties !== false && (object.additionalProperties === undefined || object.additionalProperties === true) && object.unevaluatedProperties !== false && !closedByComposition && !at.endsWith("/$defs/envelope")) {
      throw new Error(`${file}: object schema is not closed at ${at}`);
    }
    if (propertyName && /(?:hash|signaturehash)$/i.test(propertyName)) {
      const isHashPattern = object.$ref === "#/$defs/hash" || object.const === null || object.type === "null" || (object.type === "string" && object.pattern === "^[a-f0-9]{64}$") ||
        (Array.isArray(object.anyOf) && object.anyOf.some((item: unknown) => item !== null && typeof item === "object" && ((item as AnyObject).$ref === "#/$defs/hash" || (item as AnyObject).const === null)));
      if (!isHashPattern && propertyName.toLowerCase().includes("hash")) throw new Error(`${file}: hash field is not typed as a lowercase SHA-256 at ${at}`);
      if (propertyName === "signatureHash" && !isHashPattern) throw new Error(`${file}: signatureHash is not a hash reference at ${at}`);
    }
    for (const [key, child] of Object.entries(object)) {
      const childClosedByComposition = closedByComposition || (key === "allOf" && object.unevaluatedProperties === false);
      visit(child, `${at}/${key}`, key, childClosedByComposition);
    }
  };
  visit(schema, "#");
  for (const [name, definition] of Object.entries(defs)) {
    if (definition === null || typeof definition !== "object" || Array.isArray(definition)) throw new Error(`${file}: $defs.${name} is not a schema object`);
  }
}

function readSchemas(): { records: SchemaRecord[]; bytes: Map<string, Buffer> } {
  const files = schemaFiles();
  if (files.length === 0) throw new Error("no schema files found");
  const records: SchemaRecord[] = [];
  const bytes = new Map<string, Buffer>();
  for (const file of files) {
    const parsed = expectObject(readJson(file), file);
    validateSchemaShape(parsed, file);
    const relativePath = `schemas/${relative(schemaRoot, file).replaceAll("\\", "/")}`;
    const raw = readFileSync(file);
    records.push({ path: relativePath, bytes: raw.byteLength, sha256: sha256(raw), canonicalSha256: sha256(utf8(canonicalize(parsed))), schemaId: String(parsed.$id), schemaVersion: lockVersion });
    bytes.set(relativePath, raw);
    schemaMap.set(relativePath, parsed);
  }
  records.sort((a, b) => compare(a.path, b.path));
  return { records, bytes };
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  try {
    return canonicalize(left as JsonValue) === canonicalize(right as JsonValue);
  } catch {
    return JSON.stringify(left) === JSON.stringify(right);
  }
}

function validateConditional(schema: AnyObject, value: unknown, root: AnyObject, at: string, deferClosure: boolean): ValidationResult {
  if (schema.if === undefined) return { errors: [], evaluated: new Set() };
  const condition = validateInstance(expectObject(schema.if, `${at}.if`), value, root, `${at}.if`, false);
  const branchName = condition.errors.length === 0 ? "then" : "else";
  const branch = schema[branchName];
  if (branch === undefined) return { errors: [], evaluated: new Set() };
  return validateInstance(expectObject(branch, `${at}.${branchName}`), value, root, `${at}.${branchName}`, deferClosure);
}

function validateInstance(schema: AnyObject, value: unknown, root: AnyObject, at = "#", deferClosure = false): ValidationResult {
  const fail = (message: string): ValidationResult => ({ errors: [`${at}: ${message}`], evaluated: new Set() });
  if (schema.$ref !== undefined) {
    const target = String(schema.$ref).slice("#/$defs/".length);
    return validateInstance(expectObject(root.$defs[target], `${at} reference`), value, root, at, deferClosure);
  }
  if (schema.allOf !== undefined) {
    const baseSchema = { ...schema };
    delete baseSchema.allOf;
    delete baseSchema.unevaluatedProperties;
    delete baseSchema.if;
    delete baseSchema.then;
    delete baseSchema.else;
    delete baseSchema.not;
    const results = [
      validateInstance(baseSchema, value, root, at, true),
      ...(schema.allOf as unknown[]).map((child, index) => validateInstance(expectObject(child, `${at}.allOf[${index}]`), value, root, `${at}.allOf[${index}]`, true)),
    ];
    const errors = results.flatMap(result => result.errors);
    const evaluated = new Set(results.flatMap(result => [...result.evaluated]));
    if (errors.length > 0) return { errors, evaluated };
    if (schema.not !== undefined) {
      const prohibited = validateInstance(expectObject(schema.not, `${at}.not`), value, root, `${at}.not`);
      if (prohibited.errors.length === 0) return fail("not schema matched");
    }
    const conditional = validateConditional(schema, value, root, at, deferClosure);
    if (conditional.errors.length > 0) return { errors: conditional.errors, evaluated };
    for (const key of conditional.evaluated) evaluated.add(key);
    if (schema.unevaluatedProperties === false && value !== null && typeof value === "object" && !Array.isArray(value) && !deferClosure) {
      for (const key of Object.keys(value as AnyObject)) if (!evaluated.has(key)) errors.push(`${at}: unexpected property ${key}`);
    }
    return { errors, evaluated };
  }
  let combinatorEvaluated: Set<string> | undefined;
  if (schema.oneOf !== undefined) {
    const results = (schema.oneOf as unknown[]).map((child, index) => validateInstance(expectObject(child, `${at}.oneOf[${index}]`), value, root, `${at}.oneOf[${index}]`, false));
    const valid = results.filter(result => result.errors.length === 0);
    if (valid.length !== 1) return fail(`oneOf matched ${valid.length} branches`);
    combinatorEvaluated = valid[0].evaluated;
  }
  if (schema.anyOf !== undefined) {
    const results = (schema.anyOf as unknown[]).map((child, index) => validateInstance(expectObject(child, `${at}.anyOf[${index}]`), value, root, `${at}.anyOf[${index}]`, false));
    const valid = results.find(result => result.errors.length === 0);
    if (!valid) return fail("anyOf matched no branches");
    combinatorEvaluated = valid.evaluated;
  }
  if (schema.not !== undefined) {
    const prohibited = validateInstance(expectObject(schema.not, `${at}.not`), value, root, `${at}.not`);
    if (prohibited.errors.length === 0) return fail("not schema matched");
  }
  if (schema.const !== undefined && !jsonValuesEqual(value, schema.const)) return fail(`expected constant ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((item: unknown) => jsonValuesEqual(item, value))) return fail("value is outside enum");
  if (schema.type === "object" && (value === null || typeof value !== "object" || Array.isArray(value))) return fail("expected object");
  if (schema.type === "null" && value !== null) return fail("expected null");
  if (schema.type === "array" && !Array.isArray(value)) return fail("expected array");
  if (schema.type === "string" && typeof value !== "string") return fail("expected string");
  if (schema.type === "boolean" && typeof value !== "boolean") return fail("expected boolean");
  if (schema.type === "integer" && (!Number.isInteger(value) || !Number.isFinite(value))) return fail("expected integer");
  if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return fail("expected number");
  if (typeof value === "string") {
    if (schema.pattern !== undefined && !(new RegExp(String(schema.pattern))).test(value)) return fail("string does not match pattern");
    if (schema.minLength !== undefined && value.length < schema.minLength) return fail("string is shorter than minLength");
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return fail("string exceeds maxLength");
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) return fail("invalid date-time");
    if (schema.format === "uri") {
      try {
        const parsed = new URL(value);
        if (parsed.protocol.length === 0) return fail("invalid URI");
      } catch {
        return fail("invalid URI");
      }
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return fail("number is below minimum");
    if (schema.maximum !== undefined && value > schema.maximum) return fail("number exceeds maximum");
  }
  const evaluated = combinatorEvaluated ?? new Set<string>();
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return fail("array is shorter than minItems");
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return fail("array exceeds maxItems");
    if (schema.uniqueItems === true && value.some((item: unknown, index: number) => value.slice(0, index).some(previous => jsonValuesEqual(previous, item)))) {
      return fail("array items are not unique");
    }
    if (schema.items !== undefined) for (let index = 0; index < value.length; index++) {
      const result = validateInstance(expectObject(schema.items, `${at}.items`), value[index], root, `${at}[${index}]`);
      if (result.errors.length > 0) return result;
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const object = value as AnyObject;
    const properties = schema.properties === undefined ? {} : expectObject(schema.properties, `${at}.properties`);
    for (const required of (schema.required ?? []) as unknown[]) if (!(String(required) in object)) return fail(`missing required property ${String(required)}`);
    for (const [key, child] of Object.entries(properties)) {
      if (key in object) {
        evaluated.add(key);
        const result = validateInstance(expectObject(child, `${at}.properties.${key}`), object[key], root, `${at}.${key}`);
        if (result.errors.length > 0) return result;
      }
    }
    if (schema.propertyNames !== undefined) {
      const nameSchema = expectObject(schema.propertyNames, `${at}.propertyNames`);
      for (const key of Object.keys(object)) {
        const result = validateInstance(nameSchema, key, root, `${at}.propertyNames(${key})`);
        if (result.errors.length > 0) return result;
      }
    }
    const patterns = schema.patternProperties === undefined ? {} : expectObject(schema.patternProperties, `${at}.patternProperties`);
    for (const key of Object.keys(object)) {
      if (evaluated.has(key)) continue;
      const matching = Object.entries(patterns).filter(([pattern]) => new RegExp(pattern).test(key));
      if (matching.length > 0) {
        evaluated.add(key);
        for (const [, child] of matching) {
          const result = validateInstance(expectObject(child, `${at}.patternProperties`), object[key], root, `${at}.${key}`);
          if (result.errors.length > 0) return result;
        }
      }
    }
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== false && typeof schema.additionalProperties === "object") {
      const additionalSchema = expectObject(schema.additionalProperties, `${at}.additionalProperties`);
      for (const key of Object.keys(object)) {
        if (evaluated.has(key)) continue;
        const result = validateInstance(additionalSchema, object[key], root, `${at}.${key}`);
        if (result.errors.length > 0) return result;
        evaluated.add(key);
      }
    }
    const conditional = validateConditional(schema, value, root, at, true);
    if (conditional.errors.length > 0) return { errors: conditional.errors, evaluated };
    for (const key of conditional.evaluated) evaluated.add(key);
    if (schema.additionalProperties === false && !deferClosure && Object.keys(object).some(key => !evaluated.has(key))) return fail("additional property is not allowed");
    if (schema.unevaluatedProperties === false && !deferClosure && Object.keys(object).some(key => !evaluated.has(key))) return fail("unevaluated property is not allowed");
    if (schema.minProperties !== undefined && Object.keys(object).length < schema.minProperties) return fail("object is smaller than minProperties");
    if (schema.maxProperties !== undefined && Object.keys(object).length > schema.maxProperties) return fail("object exceeds maxProperties");
  }
  return { errors: [], evaluated };
}

function pointerParts(pointer: string): string[] {
  if (!pointer.startsWith("/") && pointer !== "") throw new Error(`invalid JSON pointer ${pointer}`);
  return pointer === "" ? [] : pointer.slice(1).split("/").map(part => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}
function applyFixtureMutation(baseline: unknown, mutation: AnyObject): unknown {
  const output = JSON.parse(JSON.stringify(baseline)) as AnyObject;
  const parts = pointerParts(String(mutation.path));
  if (parts.length === 0) throw new Error("fixture mutation cannot replace the root");
  let parent: AnyObject | unknown[] = output;
  for (const part of parts.slice(0, -1)) {
    if (Array.isArray(parent)) parent = parent[Number(part)] as AnyObject;
    else parent = parent[part] as AnyObject;
    if (parent === undefined || parent === null || typeof parent !== "object") throw new Error(`mutation path does not exist: ${mutation.path}`);
  }
  const last = parts.at(-1) as string;
  if (mutation.op === "add" || mutation.op === "replace") {
    if (mutation.op === "replace") {
      const current = Array.isArray(parent) ? parent[Number(last)] : parent[last];
      if (JSON.stringify(current) !== JSON.stringify(mutation.from)) throw new Error(`mutation from value mismatch at ${mutation.path}`);
    }
    if (Array.isArray(parent)) parent[Number(last)] = mutation.value;
    else parent[last] = mutation.value;
  } else if (mutation.op === "remove") {
    const current = Array.isArray(parent) ? parent[Number(last)] : parent[last];
    if (JSON.stringify(current) !== JSON.stringify(mutation.from)) throw new Error(`mutation from value mismatch at ${mutation.path}`);
    if (Array.isArray(parent)) parent.splice(Number(last), 1);
    else delete parent[last];
  } else throw new Error(`unsupported mutation operation ${String(mutation.op)}`);
  return output;
}
function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function signaturesValid(group: unknown, authorizedKeys?: Set<string>): boolean {
  if (group === null || typeof group !== "object" || Array.isArray(group)) return false;
  const object = group as AnyObject;
  if (!Number.isInteger(object.threshold) || Number(object.threshold) < 1 || !Array.isArray(object.signatures)) return false;
  const signatures = object.signatures as AnyObject[];
  if (Number(object.threshold) > signatures.length) return false;
  const signerIds = signatures.map(signature => String(signature.signerId));
  const keyIds = signatures.map(signature => String(signature.keyId));
  if (new Set(signerIds).size !== signerIds.length || new Set(keyIds).size !== keyIds.length) return false;
  for (const signature of signatures) {
    if (typeof signature.signerId !== "string" || typeof signature.keyId !== "string" || signature.keyId.toLowerCase().includes("revoked")) return false;
    if (authorizedKeys && !authorizedKeys.has(signature.keyId)) return false;
  }
  return true;
}
function uint64(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid uint64 value ${value}`);
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}
function receiptCanonicalEnvelopeHash(candidate: AnyObject): string {
  const envelope = JSON.parse(JSON.stringify(candidate)) as AnyObject;
  delete envelope.canonicalEnvelopeHash;
  const canonicalBytes = utf8(canonicalize(envelope));
  return sha256(Buffer.concat([utf8("GJC-QUALITY-RECEIPT-HASH\u0000v1\u0000"), uint64(canonicalBytes.byteLength), canonicalBytes]));
}
function evidenceSetHash(ids: string[]): string {
  const parts: Buffer[] = [utf8("GJC-QUALITY-EVIDENCE-SET\u0000v1\u0000"), uint64(ids.length)];
  for (const id of ids) {
    const bytes = utf8(id);
    parts.push(uint64(bytes.byteLength), bytes);
  }
  return sha256(Buffer.concat(parts));
}
function evidenceMerkleRoot(ids: string[]): string {
  let level = ids.map(id => Buffer.from(sha256(Buffer.concat([Buffer.from([0x00]), utf8(id)])), "hex"));
  if (level.length === 0) level = [Buffer.from(sha256(Buffer.from([0x03])), "hex")];
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index] as Buffer;
      const right = level[index + 1];
      next.push(Buffer.from(sha256(right === undefined
        ? Buffer.concat([Buffer.from([0x02]), left])
        : Buffer.concat([Buffer.from([0x01]), left, right])), "hex"));
    }
    level = next;
  }
  return sha256(Buffer.concat([Buffer.from([0x04]), uint64(ids.length), level[0] as Buffer]));
}
function snapshotCommittedHash(snapshot: AnyObject): string {
  const excluded = new Set(["$schema", "schemaVersion", "objectType", "objectId", "issuedAt", "rootTransition", "signatureGroup", "snapshotHash", "stateHash"]);
  const committed: JsonObject = {};
  for (const key of Object.keys(snapshot).filter(key => !excluded.has(key)).sort(compare)) committed[key] = snapshot[key] as JsonValue;
  return sha256(utf8(canonicalize(committed)));
}
function semanticViolation(ruleId: string, baseline: AnyObject, candidate: AnyObject): boolean {
  switch (ruleId) {
    case "terminal.verdict-reason-binding": {
      const nested = candidate.terminalState as AnyObject | undefined;
      if (!["CLEAR", "WATCH"].includes(String(candidate.status))) return true;
      const expectedReason = candidate.status === "CLEAR" ? "QUALITY_CLEAR" : "QUALITY_WATCH_EXCEPTION";
      return candidate.reasonCode !== expectedReason ||
        nested === undefined ||
        nested.state !== candidate.status ||
        nested.status !== candidate.status ||
        nested.reasonCode !== candidate.reasonCode ||
        nested.receiptHash !== candidate.receiptHash ||
        !isHash(candidate.receiptHash) ||
        !isHash(nested.receiptHash);
    }
    case "terminal.identity-binding": {
      const fields = ["sessionId", "promptGeneration", "terminalId", "status", "reasonCode", "receiptHash"];
      return fields.some(field => candidate[field] !== baseline[field]) ||
        fields.some(field => candidate[field] === undefined) ||
        !isHash(candidate.receiptHash);
    }
    case "timer.restart-bound":
      return candidate.timerId !== baseline.timerId ||
        candidate.originBootId !== baseline.originBootId ||
        candidate.monoAtPersistMs !== baseline.monoAtPersistMs ||
        candidate.wallAtPersistMs !== baseline.wallAtPersistMs ||
        candidate.cancellationEpoch !== baseline.cancellationEpoch ||
        typeof candidate.originBootId !== "string" ||
        !Number.isInteger(candidate.monoAtPersistMs) ||
        !Number.isInteger(candidate.wallAtPersistMs) ||
        !Number.isInteger(candidate.wallDeadlineUtcMs) ||
        Number(candidate.wallDeadlineUtcMs) > Number(baseline.wallDeadlineUtcMs) ||
        Number(candidate.wallDeadlineUtcMs) < Number(candidate.wallAtPersistMs) ||
        !Number.isInteger(candidate.originUncertaintyBoundMs) ||
        Number(candidate.originUncertaintyBoundMs) < 0 ||
        Number(candidate.originUncertaintyBoundMs) !== Number(baseline.originUncertaintyBoundMs);
    case "admission.durable-start": {
      const required = ["claimId", "headHash", "epoch", "principalId", "nonceHash", "invocationId", "outboxId", "archiveId"];
      if (required.some(field => candidate[field] === undefined)) return true;
      if (["claimId", "principalId", "invocationId", "outboxId", "archiveId"].some(field => typeof candidate[field] !== "string")) return true;
      if (!isHash(candidate.headHash) || !isHash(candidate.nonceHash) || !Number.isInteger(candidate.epoch) || Number(candidate.epoch) < 0) return true;
      if (["claimId", "headHash", "epoch", "principalId", "nonceHash", "invocationId", "outboxId", "archiveId"].some(field => candidate[field] !== baseline[field])) return true;
      if (candidate.invocationId !== baseline.invocationId || candidate.outboxId !== baseline.outboxId || candidate.archiveId !== baseline.archiveId) return true;
      const suffix = String(candidate.invocationId).match(/([A-Za-z0-9]+)$/)?.[1];
      return suffix === undefined || !String(candidate.outboxId).endsWith(suffix) || !String(candidate.archiveId).endsWith(suffix);
    }
    case "recovery.same-slot":
      return candidate.recoveryOfSeq !== candidate.originalPhysicalWriteSeq ||
        !Number.isInteger(candidate.originalPhysicalWriteSeq) || Number(candidate.originalPhysicalWriteSeq) < 0 ||
        !Number.isInteger(candidate.recoveryOfSeq) || Number(candidate.recoveryOfSeq) < 0 ||
        !Number.isInteger(candidate.recoveryAttempt) || Number(candidate.recoveryAttempt) < 1 || Number(candidate.recoveryAttempt) > 3 ||
        !isHash(candidate.inputFileVersion) ||
        typeof candidate.claimId !== "string" || typeof candidate.claimantPrincipal !== "string" || typeof candidate.invocationId !== "string" ||
        !["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "ABORTED"].includes(String(candidate.status)) ||
        !["RETRY", "COMMIT", "ABORT", "BLOCK"].includes(String(candidate.disposition));
    case "receipt.canonical-binding":
      return candidate.hashDomain !== "gajae.quality.receipt.v1" ||
        candidate.canonicalization !== "JCS-RFC8785" ||
        !isHash(candidate.canonicalEnvelopeHash) ||
        !signaturesValid(candidate.signatureGroup) ||
        candidate.canonicalEnvelopeHash !== receiptCanonicalEnvelopeHash(candidate);
    case "evidence.exact-set": {
      const evidenceIds = Array.isArray(candidate.evidenceIds) ? candidate.evidenceIds.map(String) : [];
      return Number(candidate.evidenceCount) !== evidenceIds.length ||
        new Set(evidenceIds).size !== evidenceIds.length ||
        evidenceIds.some(id => id.length === 0) ||
        !isHash(candidate.evidenceMerkleRoot) ||
        candidate.evidenceMerkleRoot !== evidenceMerkleRoot(evidenceIds) ||
        !isHash(candidate.evidenceHash) ||
        candidate.evidenceHash !== evidenceSetHash(evidenceIds);
    }
    case "signature.threshold-unique": {
      const group = candidate.signatureGroup as AnyObject | undefined;
      const authorized = Array.isArray(candidate.rootKeySet) ? new Set(candidate.rootKeySet.map(String)) : undefined;
      if (!signaturesValid(group, authorized)) return true;
      const transitionGroup = (candidate.rootTransition as AnyObject | undefined)?.signatureGroup;
      return transitionGroup !== undefined && !signaturesValid(transitionGroup, authorized);
    }
    case "authorization.scope": {
      if (candidate.effect !== "ALLOW" || !Array.isArray(candidate.actions) || candidate.actions.length === 0 ||
        !Array.isArray(candidate.resources) || !candidate.resources.map(String).includes(String(candidate.projectId)) ||
        !["R0", "R1", "R2", "R3"].includes(String(candidate.riskLevel)) ||
        typeof candidate.role !== "string" || typeof candidate.keyId !== "string") return true;
      const validFrom = Date.parse(String(candidate.validFrom));
      const validUntil = Date.parse(String(candidate.validUntil));
      return !Number.isFinite(validFrom) || !Number.isFinite(validUntil) || validFrom >= validUntil ||
        !Number.isInteger(candidate.rootSequence) || Number(candidate.rootSequence) < 1 ||
        !Number.isInteger(candidate.trustSequence) || Number(candidate.trustSequence) < 1 ||
        candidate.subjectId === undefined;
    }
    case "root.transition": {
      const transition = candidate.objectType === "RootTransition" ? candidate : candidate.rootTransition as AnyObject | undefined;
      if (!transition || !["GENESIS", "ROTATE", "REVOKE"].includes(String(transition.transitionKind)) ||
        !isHash(transition.nextRootHash) || !signaturesValid(transition.signatureGroup)) return true;
      if (transition.transitionKind === "GENESIS") return transition.previousRootHash !== null || (candidate.rootEpoch !== undefined && candidate.rootEpoch !== 0);
      return !isHash(transition.previousRootHash) ||
        transition.previousRootHash === transition.nextRootHash ||
        !Number.isInteger(candidate.rootEpoch) || Number(candidate.rootEpoch) < 1 ||
        (candidate.trustSequence !== undefined && (!Number.isInteger(candidate.trustSequence) || Number(candidate.trustSequence) < 1));
    }
    case "attestation.binding":
      return ["nonce", "principalId", "keyId", "executableDigest", "deviceId", "bootId", "ipcPeer"].some(field => candidate[field] === undefined) ||
        ["nonce", "executableDigest", "measurementHash"].some(field => !isHash(candidate[field])) ||
        candidate.executableDigest !== baseline.executableDigest ||
        candidate.principalId !== baseline.principalId ||
        candidate.keyId !== baseline.keyId ||
        candidate.deviceId !== baseline.deviceId ||
        candidate.bootId !== baseline.bootId ||
        candidate.ipcPeer !== baseline.ipcPeer;
    case "risk.raise-only": {
      const level = String(candidate.riskLevel);
      const baselineLevel = String(baseline.riskLevel);
      const rank = (value: string): number => Number(value.slice(1));
      if (!/^R[0-3]$/.test(level) || !/^R[0-3]$/.test(baselineLevel) || rank(level) < rank(baselineLevel)) return true;
      if (candidate.unsupported === true || candidate.classified === "unknown" || candidate.projectHint === "unknown") return level !== "R3";
      return false;
    }
    case "exception.single-use": {
      if (!isHash(candidate.causeHash) || !isHash(candidate.scopeHash) || typeof candidate.subjectId !== "string" ||
        !Number.isInteger(candidate.maxUses) || Number(candidate.maxUses) !== 1 || candidate.revoked !== false ||
        typeof candidate.approvedBy !== "string" || candidate.subjectId === candidate.approvedBy) return true;
      const raised = Date.parse(String(candidate.raisedAt));
      const expires = Date.parse(String(candidate.expiresAt));
      return !Number.isFinite(raised) || !Number.isFinite(expires) || expires <= raised;
    }
    case "metrics.identity-binding": {
      const identityFields = ["projectId", "riskLevel", "checkpointId", "profileId", "stage", "rootSequence", "trustSequence", "windowStart", "windowEnd"];
      if (!identityFields.every(field => candidate[field] !== undefined) || identityFields.some(field => candidate[field] !== baseline[field])) return true;
      const counters = candidate.counters;
      if (counters === null || typeof counters !== "object" || Array.isArray(counters) ||
        Object.values(counters as AnyObject).some(value => !Number.isInteger(value) || Number(value) < 0)) return true;
      const start = Date.parse(String(candidate.windowStart));
      const end = Date.parse(String(candidate.windowEnd));
      return !Number.isFinite(start) || !Number.isFinite(end) || start >= end ||
        !Number.isInteger(candidate.rootSequence) || Number(candidate.rootSequence) < 0 ||
        !Number.isInteger(candidate.trustSequence) || Number(candidate.trustSequence) < 0;
    }
    case "adjudication.rank2": {
      const group = candidate.signatureGroup as AnyObject | undefined;
      const signatures = Array.isArray(group?.signatures) ? group.signatures as AnyObject[] : [];
      const principals = new Set(signatures.map(signature => String(signature.signerId)));
      const security = signatures.some(signature => /security/i.test(String(signature.signerId)) || /security/i.test(String(signature.keyId)));
      return !["REJECT", "ESCALATE", "WATCH", "CLEAR"].includes(String(candidate.decision)) ||
        !Array.isArray(candidate.evidenceIds) ||
        !signaturesValid(group) || Number(group?.threshold) < 2 || principals.size < 2 || !security ||
        signatures.some(signature => String(signature.signerId) === String(candidate.subjectId));
    }
    case "adapter.manifest-identity": {
      const required = ["owner", "signer", "project", "tool", "interpreter", "argv", "cwd", "env", "secrets", "network", "fixture", "timeout", "output", "cleanup", "rerun", "surface", "surfaceIdentity"];
      if (required.some(field => candidate[field] === undefined)) return true;
      if (!Array.isArray(candidate.argv) || !Array.isArray(candidate.secrets)) return true;
      return canonicalize(candidate as JsonObject) !== canonicalize(baseline as JsonObject);
    }
    case "snapshot.inventory-binding": {
      const required = ["physicalRoot", "treeHash", "worktreeHash", "baseHash", "headHash", "mutationEpoch", "inventoryPolicy", "entries", "snapshotHash", "stateHash"];
      if (required.some(field => candidate[field] === undefined) || !Array.isArray(candidate.entries)) return true;
      const entries = candidate.entries as AnyObject[];
      if (entries.some(entry => typeof entry.path !== "string" || typeof entry.type !== "string")) return true;
      return candidate.snapshotHash !== baseline.snapshotHash ||
        candidate.stateHash !== baseline.stateHash ||
        snapshotCommittedHash(candidate) !== snapshotCommittedHash(baseline);
    }
    case "terminal.branch-binding": {
      const terminal = candidate.terminalState as AnyObject | undefined;
      if (!terminal || terminal.status !== candidate.status) return true;
      const status = String(candidate.status);
      const receipt = candidate.receiptHash;
      if (status === "verified_success") {
        return !isHash(receipt) || terminal.state !== "CLEAR-WATCH" ||
          !["QUALITY_CLEAR", "QUALITY_WATCH_EXCEPTION"].includes(String(terminal.reasonCode)) ||
          terminal.reason !== "clear_watch_receipt" || terminal.receiptHash !== receipt;
      }
      if (receipt !== undefined) return true;
      if (status === "failed") return !["pre_agent", "provider", "scheduler", "watchdog", "global_deadline"].includes(String(terminal.reason));
      if (status === "cancelled") return !["user_abort", "dispose"].includes(String(terminal.reason));
      if (status === "blocked") return !["policy", "snapshot", "trust", "capability", "quality_timeout"].includes(String(terminal.reason));
      return true;
    }
    default:
    case "quiescence.source-action-authority": {
      const objectType = String(candidate.objectType);
      if (objectType === "harness_observation") {
        return ["principalId", "candidateGeneration", "mutationEpoch", "coordinatorSequence", "actionKind", "seal", "lease", "result", "receipt"].some(field => candidate[field] !== undefined);
      }
      if (objectType !== "quiescence_action") return true;
      return candidate.principalId !== "coordinator" ||
        typeof candidate.actionKind !== "string" ||
        !Number.isInteger(candidate.coordinatorSequence) ||
        !Number.isInteger(candidate.candidateGeneration) ||
        !Number.isInteger(candidate.mutationEpoch) ||
        !Array.isArray(candidate.causeObservationIds) ||
        candidate.payload === undefined;
    }
    case "quiescence.single-signal-nonauthority": {
      if (candidate.objectType === "harness_observation") {
        const payload = candidate.boundedPayload as AnyObject | undefined;
        return payload !== undefined &&
          (["sealed", "verifying", "clear"].includes(String(payload.phase)) ||
            ["candidate_sealed", "lease_claimed", "verification_result_committed", "terminal_binding_committed"].includes(String(payload.actionKind)));
      }
      if (candidate.objectType === "quiescence_action") {
        return ["candidate_sealed", "lease_claimed", "verification_result_committed", "terminal_binding_committed"].includes(String(candidate.actionKind)) &&
          candidate.principalId !== "coordinator";
      }
      return false;
    }
    case "quiescence.seal-conjunction": {
      if (candidate.objectType !== "quiescence_ledger") return true;
      const actorMode = String(candidate.actorMode);
      const expectedQuietWindow = actorMode === "single" ? 2000 : actorMode === "multi" ? 5000 : -1;
      const clock = candidate.clockState as AnyObject | undefined;
      return candidate.mutationEpoch !== baseline.mutationEpoch ||
        candidate.rootCandidateSeen !== true ||
        candidate.mainSettled !== true ||
        !["quiet_wait", "sealing", "sealed"].includes(String(candidate.phase)) ||
        !Number.isInteger(candidate.activeCount) || Number(candidate.activeCount) !== 0 ||
        !Number.isInteger(candidate.queuedCount) || Number(candidate.queuedCount) !== 0 ||
        !Number.isInteger(candidate.pendingDeliveryCount) || Number(candidate.pendingDeliveryCount) !== 0 ||
        !Number.isInteger(candidate.incompleteRequiredTaskCount) || Number(candidate.incompleteRequiredTaskCount) !== 0 ||
        !Number.isInteger(candidate.sourceGapCount) || Number(candidate.sourceGapCount) !== 0 ||
        !Number.isInteger(candidate.deadLetterCount) || Number(candidate.deadLetterCount) !== 0 ||
        Number(candidate.quietWindowMs) !== expectedQuietWindow ||
        clock === undefined || !Number.isInteger(clock.monoMs) ||
        !Number.isInteger(candidate.quietSinceMonoMs) ||
        Number(clock.monoMs) - Number(candidate.quietSinceMonoMs) < expectedQuietWindow;
    }
    case "quiescence.reconciliation-census": {
      if (candidate.objectType !== "quiescence_action" || candidate.actionKind !== "source_snapshot_reconciled") return true;
      const payload = candidate.payload as AnyObject | undefined;
      if (payload === undefined || payload.closedSnapshot !== true ||
        typeof payload.sourceKey !== "string" || typeof payload.capabilityProfileId !== "string" ||
        !Number.isInteger(payload.authoritativeCursor) || !Number.isInteger(payload.coversThroughCursor) ||
        Number(payload.coversThroughCursor) < Number(payload.authoritativeCursor) ||
        !Array.isArray(payload.actors) || !Array.isArray(payload.tasks) || !Array.isArray(payload.deliveries) ||
        typeof payload.nativeRootIdentity !== "string" || !isHash(payload.snapshotCanonicalHash) || !isHash(payload.observationInventoryHash)) return true;
      return candidate.principalId !== "coordinator" || !Array.isArray(candidate.causeObservationIds);
    }
    case "quiescence.ledger-derived-counts": {
      if (candidate.objectType !== "quiescence_ledger") return true;
      const actors = candidate.actors as AnyObject | undefined;
      const tasks = candidate.tasks as AnyObject | undefined;
      const deliveries = candidate.deliveries as AnyObject | undefined;
      const sources = candidate.sources as AnyObject | undefined;
      if (actors === undefined || tasks === undefined || deliveries === undefined || sources === undefined) return true;
      const actorValues = Object.values(actors);
      const taskValues = Object.values(tasks);
      const deliveryValues = Object.values(deliveries);
      const active = actorValues.filter(actor => (actor as AnyObject).status === "active").length;
      const queued = actorValues.filter(actor => (actor as AnyObject).status === "queued").length;
      const pending = deliveryValues.filter(delivery => ["queued", "started"].includes(String((delivery as AnyObject).status))).length;
      const incomplete = taskValues.filter(task => (task as AnyObject).required === true && ["open", "reopened"].includes(String((task as AnyObject).status))).length;
      const gaps = Object.values(sources).reduce((total, source) => total + (Array.isArray((source as AnyObject).gapRanges) ? (source as AnyObject).gapRanges.length : 0), 0);
      const deadLetters = deliveryValues.filter(delivery => (delivery as AnyObject).status === "dead_lettered").length;
      const pausedRequiredTaskValid = actorValues.filter(actor => (actor as AnyObject).status === "paused").every(actor => {
        const taskId = (actor as AnyObject).requiredTaskId;
        const task = typeof taskId === "string" ? tasks[taskId] as AnyObject | undefined : undefined;
        return task !== undefined && task.required === true && ["open", "reopened"].includes(String(task.status));
      });
      return Number(candidate.activeCount) !== active || Number(candidate.queuedCount) !== queued ||
        Number(candidate.pendingDeliveryCount) !== pending || Number(candidate.incompleteRequiredTaskCount) !== incomplete ||
        Number(candidate.sourceGapCount) !== gaps || Number(candidate.deadLetterCount) !== deadLetters || !pausedRequiredTaskValid;
    }
    case "quiescence.generation-epoch-invalidation": {
      if (candidate.objectType !== "quiescence_action") return true;
      const payload = candidate.payload as AnyObject | undefined;
      const commitAction = ["lease_committed", "verification_result_committed", "terminal_binding_committed"].includes(String(candidate.actionKind));
      if (commitAction && (payload === undefined ||
        payload.candidateGeneration !== candidate.candidateGeneration ||
        payload.mutationEpoch !== undefined && payload.mutationEpoch !== candidate.mutationEpoch ||
        payload.cancellationEpoch !== undefined && payload.cancellationEpoch !== candidate.cancellationEpoch)) return true;
      return !Number.isInteger(candidate.candidateGeneration) || Number(candidate.candidateGeneration) < 0 ||
        !Number.isInteger(candidate.mutationEpoch) || Number(candidate.mutationEpoch) < 0 ||
        (candidate.payload !== undefined && typeof candidate.payload !== "object");
    }
    case "quiescence.candidate-lease-binding": {
      if (candidate.objectType !== "verification_lease") return true;
      const base = candidate.baseLeaseTuple as AnyObject | undefined;
      const hashes = ["leaseKey", "candidateKey", "snapshotHash", "inventoryHash", "physicalRootHash"];
      return base === undefined || hashes.some(field => !isHash(candidate[field])) ||
        !["claimed", "running", "released", "expired", "committed"].includes(String(candidate.status)) ||
        !Number.isInteger(candidate.fenceToken) || Number(candidate.fenceToken) < 1 ||
        !Number.isInteger(candidate.cancellationEpoch) || Number(candidate.cancellationEpoch) < 0 ||
        !Number.isInteger(candidate.attempt) || Number(candidate.attempt) < 1 ||
        candidate.baseLeaseTuple.projectId === undefined || candidate.baseLeaseTuple.rootObjectiveId === undefined ||
        candidate.baseLeaseTuple.candidateGeneration === undefined || candidate.baseLeaseTuple.mutationEpoch === undefined ||
        candidate.baseLeaseTuple.profileId === undefined ||
        candidate.physicalRootHash !== baseline.physicalRootHash ||
        candidate.snapshotHash !== baseline.snapshotHash ||
        candidate.inventoryHash !== baseline.inventoryHash;
    }
    case "quiescence.mandatory-budget": {
      if (candidate.objectType !== "timing_observation") return true;
      const unfinished = Array.isArray(candidate.unfinishedMandatoryIds) ? candidate.unfinishedMandatoryIds : [];
      const skipped = Array.isArray(candidate.skippedOptionalIds) ? candidate.skippedOptionalIds : [];
      if (!candidate.softCrossed && skipped.length > 0) return true;
      return (candidate.hardCrossed === true || unfinished.length > 0) && candidate.outcome === "clear";
    }
    case "quiescence.phase-timing": {
      if (candidate.objectType !== "timing_observation") return true;
      const scalarToSegment: Record<string, string> = {
        queueMs: "queue", bootstrapMs: "bootstrap", collectionMs: "collection",
        executionMs: "execution", evidenceFlushMs: "evidenceFlush", shutdownMs: "shutdown",
      };
      for (const [scalar, segmentName] of Object.entries(scalarToSegment)) {
        const segment = (candidate.segments as AnyObject | undefined)?.[segmentName] as AnyObject | undefined;
        if (segment === undefined || !Number.isInteger(candidate[scalar]) || Number(candidate[scalar]) < 0 ||
          segment.durationMs !== candidate[scalar] || !Number.isInteger(segment.durationMs) || segment.durationMs < 0) return true;
      }
      return !Number.isInteger(candidate.globalCompletionMs) || Number(candidate.globalCompletionMs) < 0 ||
        !Number.isInteger(candidate.runnerSoftTotalMs) || !Number.isInteger(candidate.runnerHardTotalMs) ||
        !Number.isInteger(candidate.riskSoftMs) || !Number.isInteger(candidate.riskHardMs) ||
        Number(candidate.runnerSoftTotalMs) > Number(candidate.runnerHardTotalMs) ||
        Number(candidate.riskSoftMs) > Number(candidate.riskHardMs) ||
        (candidate.hardCrossed === true && candidate.outcome === "clear");
    }
    case "quiescence.completion-bridge": {
      if (candidate.objectType !== "quality_completion_binding") return true;
      const requiredHashes = ["candidateKey", "physicalRootHash", "snapshotHash", "inventoryHash", "acceptanceContractHash", "obligationSetHash", "timingObservationHash", "verificationOutcomeHash", "receiptCanonicalHash", "bindingCanonicalHash"];
      const requiredIds = ["receiptObjectId", "sessionId", "terminalId", "primaryId", "secondaryId", "activeId"];
      return requiredHashes.some(field => !isHash(candidate[field])) ||
        requiredIds.some(field => typeof candidate[field] !== "string" || String(candidate[field]).length === 0) ||
        candidate.activeId !== candidate.primaryId && candidate.activeId !== candidate.secondaryId ||
        !Number.isInteger(candidate.promptGeneration) || Number(candidate.promptGeneration) < 0 ||
        !Number.isInteger(candidate.fenceToken) || Number(candidate.fenceToken) < 1 ||
        candidate.candidateKey !== baseline.candidateKey ||
        candidate.receiptCanonicalHash !== baseline.receiptCanonicalHash ||
        candidate.sessionId !== baseline.sessionId ||
        candidate.promptGeneration !== baseline.promptGeneration ||
        candidate.terminalId !== baseline.terminalId;
    }
      throw new Error(`unknown semantic rule ${ruleId}`);
  }
}
function checkNegativeFixtures(): void {
  for (const [label, raw] of [
    ["duplicate-key", "{\"schemaVersion\":\"0.1.0\",\"schemaVersion\":\"9.9.9\"}"],
    ["bom", "\ufeff{\"schemaVersion\":\"0.1.0\"}"],
    ["trailing-bytes", "{\"schemaVersion\":\"0.1.0\"}x"],
  ] as const) {
    let rejected = false;
    try { parseStrictJson(raw, `raw-${label}`); } catch { rejected = true; }
    if (!rejected) throw new Error(`raw JSON ${label} was accepted`);
  }
  const fixture = expectObject(readJson(join(contractRoot, "fixtures/schema-negative-fixtures.json")), "negative fixtures");
  if (fixture.format !== "quality-contract.schema-negative-fixtures.v2" || !Array.isArray(fixture.cases)) throw new Error("negative fixture format is invalid");
  const semantic = expectObject(readJson(join(contractRoot, "manifests/semantic-rules.json")), "semantic rules");
  if (semantic.failClosed !== true || semantic.unknownRuleDisposition !== "BLOCK" || !Array.isArray(semantic.rules)) throw new Error("semantic manifest is not fail closed");
  const implemented = new Set([
    "terminal.verdict-reason-binding", "terminal.identity-binding", "timer.restart-bound", "admission.durable-start",
    "recovery.same-slot", "receipt.canonical-binding", "evidence.exact-set", "signature.threshold-unique",
    "authorization.scope", "root.transition", "attestation.binding", "risk.raise-only", "exception.single-use",
    "metrics.identity-binding", "adjudication.rank2", "adapter.manifest-identity",
    "snapshot.inventory-binding", "terminal.branch-binding",
    "quiescence.source-action-authority", "quiescence.single-signal-nonauthority",
    "quiescence.seal-conjunction", "quiescence.reconciliation-census",
    "quiescence.ledger-derived-counts", "quiescence.generation-epoch-invalidation",
    "quiescence.candidate-lease-binding", "quiescence.mandatory-budget",
    "quiescence.phase-timing", "quiescence.completion-bridge",
  ]);
  const rules = new Map<string, AnyObject>();
  for (const raw of semantic.rules as unknown[]) {
    const rule = expectObject(raw, "semantic rule");
    const id = String(rule.id);
    if (rules.has(id) || !implemented.has(id)) throw new Error(`semantic rule is unknown or duplicated: ${id}`);
    if (!Array.isArray(rule.inputs) || rule.inputs.length === 0 || typeof rule.predicate !== "string" || rule.predicate.trim().length === 0) throw new Error(`semantic rule ${id} lacks declared inputs/predicate`);
    rules.set(id, rule);
  }
  if (rules.size !== implemented.size) throw new Error("semantic manifest does not declare exactly the executable rule set");
  const cases = fixture.cases as AnyObject[];
  const byId = new Map<string, AnyObject>();
  for (const item of cases) {
    const id = String(item.id);
    if (byId.has(id)) throw new Error(`duplicate fixture id ${id}`);
    byId.set(id, item);
  }
  const referenced = new Set<string>();
  for (const [ruleId, rule] of rules) {
    const requirements = expectObject(rule.fixtureRequirements, `${ruleId} fixture requirements`);
    for (const kind of ["positive", "negative"] as const) {
      const ids = requirements[kind];
      if (!Array.isArray(ids) || ids.length === 0 || new Set(ids.map(String)).size !== ids.length) throw new Error(`${ruleId} ${kind} fixture requirements are invalid`);
      for (const rawId of ids) {
        const id = String(rawId);
        const item = byId.get(id);
        if (!item || item.ruleId !== ruleId || (kind === "positive" ? item.expectedValid !== true : item.expectedValid !== false)) throw new Error(`${ruleId} ${kind} fixture ${id} is missing or mismatched`);
        referenced.add(id);
      }
    }
  }
  for (const item of cases) {
    const id = String(item.id);
    const schema = schemaMap.get(String(item.schema));
    if (!schema) throw new Error(`${id} references unknown schema`);
    const baselineObject = expectObject(item.baseline, `${id} baseline`);
    const baseline = validateInstance(schema, baselineObject, schema);
    if (baseline.errors.length > 0) throw new Error(`${id} baseline is not schema-valid: ${baseline.errors.join("; ")}`);
    if (typeof item.ruleId !== "string") throw new Error(`${id} lacks ruleId`);
    if (item.ruleId.startsWith("schema.")) {
      if (item.expectedValid === true) {
        if (item.mutation !== undefined) throw new Error(`${id} positive schema fixture must not carry a mutation`);
      } else {
        const mutation = expectObject(item.mutation, `${id} mutation`);
        const result = validateInstance(schema, applyFixtureMutation(baselineObject, mutation), schema);
        if (result.errors.length === 0) throw new Error(`${id} mutation did not produce the expected schema error`);
      }
      continue;
    }
    if (!rules.has(item.ruleId) || !referenced.has(id)) throw new Error(`${id} semantic fixture is not exhaustively declared by its rule`);
    if (item.expectedValid === true) {
      if (item.mutation !== undefined || semanticViolation(item.ruleId, baselineObject, baselineObject)) throw new Error(`${id} positive fixture does not satisfy ${item.ruleId}`);
      continue;
    }
    const mutation = expectObject(item.mutation, `${id} mutation`);
    const mutated = expectObject(applyFixtureMutation(baselineObject, mutation), `${id} mutated instance`);
    if (semanticViolation(item.ruleId, baselineObject, baselineObject)) throw new Error(`${id} baseline violates semantic rule ${item.ruleId}`);
    if (!semanticViolation(item.ruleId, baselineObject, mutated)) throw new Error(`${id} mutation did not produce semantic rule ${item.ruleId}`);
  }
}

const generatorVersion = "phase0-schema-lock-v4";
const boundInputPaths = [
  "manifests/semantic-rules.json",
  "fixtures/schema-negative-fixtures.json",
] as const;
function boundInputRecords(): AnyObject[] {
  return boundInputPaths.map(pathName => {
    const file = join(contractRoot, pathName);
    if (!existsSync(file)) throw new Error(`missing lock input ${pathName}`);
    const raw = readFileSync(file);
    const canonicalBytes = pathName.endsWith(".json") ? utf8(canonicalize(readJson(file) as JsonValue)) : raw;
    const kind = pathName.startsWith("fixtures/") ? "fixture" : pathName.startsWith("models/") || pathName.endsWith("verify-models.ts") ? "model" : pathName.startsWith("sql/") ? "sql" : "semantic-rules";
    return { path: pathName, bytes: raw.byteLength, sha256: sha256(raw), canonicalSha256: sha256(canonicalBytes), kind };
  }).sort((a, b) => compare(String(a.path), String(b.path)));
}
function checkSchemaLock(loaded: { records: SchemaRecord[]; bytes: Map<string, Buffer> }): void {
  const payload: JsonObject = {
    lockVersion,
    generator: "quality-contract/scripts/generate-schema-lock.ts",
    generatorVersion,
    canonicalization: "RFC8785-compatible-json-canonicalization",
    schemaDraft: draft,
    schemas: loaded.records as unknown as JsonValue,
    boundInputs: boundInputRecords() as unknown as JsonValue,
    goldenVectors: [{ name: "canonical-object-order", canonical: "{\"a\":[true,null,\"phase0\"],\"nested\":{\"alpha\":1,\"beta\":2},\"z\":3}", sha256: "d494759a4c804456f2a90cc5fd7d9fdbb8f1159dc8720aa391489ca797eff108" }],
  };
  const payloadCanonical = canonicalize(payload);
  const payloadBytes = readFileSync(join(generatedRoot, "schema-lock.payload.json"));
  if (!payloadBytes.equals(utf8(payloadCanonical))) throw new Error("schema-lock.payload.json differs byte-for-byte (JCS bytes must be pure, with no LF/BOM)");
  const keys = [{ keyId: "phase0-fixture-alpha", key: "gajae-phase0-development-fixture-alpha-v1" }, { keyId: "phase0-fixture-beta", key: "gajae-phase0-development-fixture-beta-v1" }];
  const records: AnyObject[] = [];
  const sign = (artifact: string, bytes: Buffer, keyIndex: number): void => {
    const key = keys[keyIndex % keys.length];
    const domain = `gajae:quality-contract:schema-artifact:${artifact}:v1`;
    records.push({ artifact, domain, algorithm: "hmac-sha256", keyId: key.keyId, fixtureOnly: true, signatureHash: createHmac("sha256", key.key).update(domainSeparated(domain, bytes)).digest("hex") });
  };
  loaded.records.forEach((record, index) => {
    const bytes = loaded.bytes.get(record.path);
    if (!bytes) throw new Error(`missing schema bytes for ${record.path}`);
    sign(record.path, bytes, index);
  });
  boundInputRecords().forEach((record, index) => sign(String(record.path), readFileSync(join(contractRoot, String(record.path))), loaded.records.length + index));
  const payloadDomain = "gajae:quality-contract:schema-lock-payload:v1";
  records.push({ artifact: "generated/schema-lock.payload.json", domain: payloadDomain, algorithm: "hmac-sha256", keyId: keys[0].keyId, fixtureOnly: true, signatureHash: createHmac("sha256", keys[0].key).update(domainSeparated(payloadDomain, payloadBytes)).digest("hex") });
  records.sort((a, b) => compare(String(a.artifact), String(b.artifact)));
  const signatureCanonical = canonicalize({ lockVersion, fixtureOnly: true, fixtureNotice, records: records as unknown as JsonValue });
  const signatureBytes = readFileSync(join(generatedRoot, "schema-lock.signatures.json"));
  if (!signatureBytes.equals(utf8(signatureCanonical))) throw new Error("schema-lock.signatures.json differs byte-for-byte (JCS bytes must be pure, with no LF/BOM)");
  const pinFor = (payload: Uint8Array, signatures: Uint8Array): string =>
    sha256(Buffer.concat([domainSeparated(pinDomain, payload), domainSeparated(pinDomain, signatures)]));
  const pin = pinFor(payloadBytes, signatureBytes);
  if (readFileSync(join(generatedRoot, "schema-lock.pin.sha256"), "utf8") !== `${pin}\n`) throw new Error("schema-lock.pin.sha256 differs");
  const tamperVectors: Array<[string, Buffer, Buffer]> = [
    ["payload-LF", Buffer.concat([payloadBytes, utf8("\n")]), signatureBytes],
    ["payload-BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), payloadBytes]), signatureBytes],
    ["payload-whitespace", Buffer.concat([utf8(" "), payloadBytes, utf8(" ")]), signatureBytes],
    ["signature-LF", payloadBytes, Buffer.concat([signatureBytes, utf8("\n")])],
    ["signature-BOM", payloadBytes, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), signatureBytes])],
    ["signature-whitespace", payloadBytes, Buffer.concat([utf8(" "), signatureBytes, utf8(" ")])],
  ];
  for (const [label, tamperedPayload, tamperedSignatures] of tamperVectors) {
    if (pinFor(tamperedPayload, tamperedSignatures) === pin) throw new Error(`schema-lock ${label} tamper vector was not rejected`);
  }
}
function extensionLayerHash(domain: string, unsigned: AnyObject): string {
  return sha256(domainSeparated(domain, utf8(canonicalize(unsigned as JsonValue))));
}
function extensionEntry(pathName: string, kind: string): AnyObject {
  const file = join(repoRoot, pathName);
  if (!existsSync(file)) throw new Error(`missing extension artifact ${pathName}`);
  const raw = readFileSync(file);
  const entry: AnyObject = { path: pathName, bytes: raw.byteLength, sha256: sha256(raw), kind };
  if (pathName.endsWith(".json")) entry.canonicalSha256 = sha256(utf8(canonicalize(readJson(file) as JsonValue)));
  return entry;
}
function extensionEntriesEqual(actual: unknown, expected: AnyObject[], label: string): void {
  if (!Array.isArray(actual) || actual.length !== expected.length) throw new Error(`${label}: entry count mismatch`);
  const actualCanonical = actual.map(item => canonicalize(item as JsonValue));
  const expectedCanonical = expected.map(item => canonicalize(item as JsonValue));
  if (actualCanonical.join("\u0000") !== expectedCanonical.join("\u0000")) throw new Error(`${label}: entries differ`);
}
function extensionJsonFile(pathName: string, expected: AnyObject, schema: AnyObject): void {
  const file = join(repoRoot, pathName);
  const raw = readFileSync(file);
  const canonical = utf8(`${canonicalize(expected as JsonValue)}\n`);
  if (!raw.equals(canonical)) throw new Error(`${pathName}: bytes are not JCS plus one LF`);
  const result = validateInstance(schema, readJson(file), schema);
  if (result.errors.length > 0) throw new Error(`${pathName}: schema-invalid: ${result.errors.join("; ")}`);
}
function checkQuiescenceExtension(finalIndexOnly = false): string | undefined {
  const schema = schemaMap.get("schemas/quiescence-extension-approval.schema.json");
  if (!schema) throw new Error("extension approval schema was not loaded");
  const jsonPaths = Object.values(extensionPaths);
  for (const pathName of jsonPaths) if (!existsSync(join(repoRoot, pathName))) throw new Error(`missing extension layer ${pathName}`);
  const extensionFiles = walkFiles(generatedRoot).filter(file => file.includes("quiescence-extension")).map(file => relative(repoRoot, file).replaceAll("\\", "/")).sort(compare);
  if (extensionFiles.join("\u0000") !== jsonPaths.slice().sort(compare).join("\u0000")) throw new Error("extension generated directory has an extra or missing layer");
  const sourceEntries = extensionSourcePaths.map(pathName => extensionEntry(pathName, "source")).sort((a, b) => compare(String(a.path), String(b.path)));
  const sourceUnsigned = { format: "quality-contract.quiescence-extension-source-inventory.v1", hashDomain: extensionDomains.sourceInventory, phase1Authorized: false, entries: sourceEntries };
  const source = { ...sourceUnsigned, inventoryHash: extensionLayerHash(extensionDomains.sourceInventory, sourceUnsigned) };
  extensionJsonFile(extensionPaths.sourceInventory, source, schema);
  const lockPayload = {
    format: "quality-contract.quiescence-extension-lock-payload.v1",
    lockVersion: "qtb-extension-lock-v1",
    hashDomain: extensionDomains.lockPayload,
    phase1Authorized: false,
    sourceInventoryHash: source.inventoryHash,
    basePhase0: { reportHash: "f17975cfbfa945673d1a7f02bd990a5b5300f542423938ef7e85d8bfe5260402", payloadHash: "3883a611b61c28e81fb7b239bd9f98fc21b23f0bff9c98a5a4502a6009bcd63f", pinHash: "63659b6a830b64dc1f5b464a0a6aa06fead805df9dd95af9250b966a554885d5" },
    goldenVectors: [
      { name: "u64-empty-components", inputHex: "", outputHex: "0000000000000000000000000000000000000000000000000000000000000000" },
      { name: "sha256-abc", inputHex: "616263", outputHex: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
    ],
  };
  const payloadBytes = utf8(canonicalize(lockPayload as JsonValue));
  const payloadDigest = sha256(payloadBytes);
  const projection = { payloadDigest, signerId: "qtb-extension-fixture", keyId: "qtb-extension-fixture-v1", algorithm: "hmac-sha256" };
  const lockSignatureRecord = { signerId: projection.signerId, keyId: projection.keyId, algorithm: projection.algorithm, signatureHash: createHmac("sha256", "gajae-qtb-extension-development-fixture-v1").update(domainSeparated(extensionDomains.lockSignature, utf8(canonicalize(projection)))).digest("hex") };
  const lockSignatures = { version: "qtb-lock-signatures-v1", hashDomain: extensionDomains.lockSignatureSet, payloadDigest, threshold: 1, records: [lockSignatureRecord] };
  const lockSignatureBytes = utf8(canonicalize(lockSignatures as JsonValue));
  const lockPin = sha256(Buffer.concat([domainSeparated(extensionDomains.lockPin, payloadBytes), domainSeparated(extensionDomains.lockSignatureSet, lockSignatureBytes)]));
  extensionJsonFile(extensionPaths.lockPayload, lockPayload, schema);
  extensionJsonFile(extensionPaths.lockSignatures, lockSignatures, schema);
  if (readFileSync(join(repoRoot, extensionPaths.lockPin), "utf8") !== `${lockPin}\n`) throw new Error("extension lock pin mismatch");
  const legacyEntries = extensionLegacyPaths.map(pathName => extensionEntry(pathName, "generated"));
  const l0l1Entries = [
    extensionEntry(extensionPaths.sourceInventory, "generated"),
    extensionEntry(extensionPaths.lockPayload, "generated"),
    extensionEntry(extensionPaths.lockSignatures, "generated"),
    extensionEntry(extensionPaths.lockPin, "generated"),
  ];
  const phase0Entry = extensionEntry(reportPath.replace(repoRoot + "/", "").replaceAll("\\", "/"), "generated");
  const reportFile = expectObject(readJson(join(repoRoot, extensionPaths.verificationReport)), "extension verification report");
  const reportHash = reportFile.reportHash;
  const reportUnsignedActual = { ...reportFile };
  delete reportUnsignedActual.reportHash;
  if (reportFile.phase1Authorized !== false || reportFile.passed !== true || !Array.isArray(reportFile.failures) || reportFile.failures.length !== 0) {
    throw new Error("extension verification evidence is not a deterministic zero-failure pass");
  }
  if (reportHash !== extensionLayerHash(extensionDomains.verificationReport, reportUnsignedActual)) {
    throw new Error("extension verification report hash mismatch");
  }
  const sourceInventoryEntryFromReport = (Array.isArray(reportFile.entries) ? reportFile.entries : []).find((entry: unknown) =>
    entry !== null && typeof entry === "object" && (entry as AnyObject).path === extensionPaths.sourceInventory,
  ) as AnyObject | undefined;
  const sourceInventoryEntryActual = extensionEntry(extensionPaths.sourceInventory, "generated");
  if (sourceInventoryEntryFromReport === undefined ||
      canonicalize(sourceInventoryEntryFromReport as JsonValue) !== canonicalize(sourceInventoryEntryActual as JsonValue) ||
      source.inventoryHash !== extensionLayerHash(extensionDomains.sourceInventory, {
        format: sourceUnsigned.format,
        hashDomain: sourceUnsigned.hashDomain,
        phase1Authorized: false,
        entries: sourceUnsigned.entries,
      } as JsonObject) ||
      lockPayload.sourceInventoryHash !== source.inventoryHash) {
    throw new Error("extension verification evidence is not bound to the exact source inventory hash");
  }
  extensionEntriesEqual(
    reportFile.entries,
    [...sourceEntries, ...legacyEntries, ...l0l1Entries, phase0Entry].sort((a, b) => compare(String(a.path), String(b.path))),
    "extension verification evidence",
  );
  const reportUnsigned = {
    format: "quality-contract.quiescence-extension-verification-report.v1",
    hashDomain: extensionDomains.verificationReport,
    passed: reportFile.passed,
    failures: reportFile.failures,
    phase1Authorized: false,
    entries: [...sourceEntries, ...legacyEntries, ...l0l1Entries, phase0Entry].sort((a, b) => compare(String(a.path), String(b.path))),
  };
  const report = { ...reportUnsigned, reportHash: extensionLayerHash(extensionDomains.verificationReport, reportUnsigned) };
  extensionJsonFile(extensionPaths.verificationReport, report, schema);
  const reportEntry = extensionEntry(extensionPaths.verificationReport, "generated");
  const approvalPayload = {
    format: "quality-contract.quiescence-extension-approval-payload.v1",
    contractVersion: "quality-contract.v1",
    hashDomain: extensionDomains.approvalPayload,
    decision: "APPROVE_PHASE0_EXTENSION_ONLY",
    phase1Authorized: false,
    basePhase0: lockPayload.basePhase0,
    extension: { payloadHash: payloadDigest, pinHash: lockPin, verificationReportHash: report.reportHash },
    reviewRecords: extensionReviews,
    artifactInventory: [...reportUnsigned.entries, reportEntry].sort((a, b) => compare(String(a.path), String(b.path))),
    verifier: {
      path: "quality-contract/scripts/verify-contracts.ts",
      sourceSha256: sha256(readFileSync(join(repoRoot, "quality-contract/scripts/verify-contracts.ts"))),
      command: "bun quality-contract/scripts/verify-contracts.ts --preapprove-extension",
      environment: "TZ=UTC;LC_ALL=C;SOURCE_DATE_EPOCH=0",
    },
  };
  const approvalPayloadBytes = utf8(canonicalize(approvalPayload as JsonValue));
  const approvalPayloadHash = extensionLayerHash(extensionDomains.approvalPayload, approvalPayload);
  extensionJsonFile(extensionPaths.approvalPayload, approvalPayload, schema);
  const issuer = { principalId: extensionSigner.principalId, role: extensionSigner.role, keyId: extensionSigner.keyId, algorithm: extensionSigner.algorithm, fixtureOnly: true };
  const receiptUnsigned = {
    format: "quality-contract.quiescence-extension-approval-receipt.v1",
    contractVersion: "quality-contract.v1",
    hashDomain: extensionDomains.approvalReceipt,
    decision: "APPROVE_PHASE0_EXTENSION_ONLY",
    phase1Authorized: false,
    payloadHash: approvalPayloadHash,
    issuer,
    issuedAtUtc: extensionTimestamp,
    canonicalPayloadSha256: sha256(approvalPayloadBytes),
  };
  const receiptSignatureHash = createHmac("sha256", extensionSigner.secret).update(domainSeparated(extensionDomains.approvalReceipt, utf8(canonicalize(receiptUnsigned as JsonValue)))).digest("hex");
  const receipt = { ...receiptUnsigned, signature: { signerId: extensionSigner.principalId, keyId: extensionSigner.keyId, algorithm: extensionSigner.algorithm, signatureHash: receiptSignatureHash } };
  extensionJsonFile(extensionPaths.approvalReceipt, receipt, schema);
  const finalEntries = [...approvalPayload.artifactInventory, extensionEntry(extensionPaths.approvalPayload, "generated"), extensionEntry(extensionPaths.approvalReceipt, "generated")].sort((a, b) => compare(String(a.path), String(b.path)));
  const finalIndexUnsigned = {
    format: "quality-contract.quiescence-extension-final-index.v1",
    hashDomain: extensionDomains.finalIndex,
    phase1Authorized: false,
    entries: finalEntries,
    overallPass: true,
  };
  const finalIndex = { ...finalIndexUnsigned, finalIndexHash: extensionLayerHash(extensionDomains.finalIndex, finalIndexUnsigned) };
  extensionJsonFile(extensionPaths.finalIndex, finalIndex, schema);
  if (finalIndexOnly) process.stdout.write(`${sha256(readFileSync(join(repoRoot, extensionPaths.finalIndex)))}\n`);
  return sha256(readFileSync(join(repoRoot, extensionPaths.finalIndex)));
}

function checkQuiescenceExtensionPreapproval(): void {
  const schema = schemaMap.get("schemas/quiescence-extension-approval.schema.json");
  if (!schema) throw new Error("extension approval schema was not loaded");
  const sourceEntries = extensionSourcePaths.map(pathName => extensionEntry(pathName, "source")).sort((a, b) => compare(String(a.path), String(b.path)));
  const sourceUnsigned = { format: "quality-contract.quiescence-extension-source-inventory.v1", hashDomain: extensionDomains.sourceInventory, phase1Authorized: false, entries: sourceEntries };
  const source = { ...sourceUnsigned, inventoryHash: extensionLayerHash(extensionDomains.sourceInventory, sourceUnsigned) };
  extensionJsonFile(extensionPaths.sourceInventory, source, schema);
  const lockPayload = {
    format: "quality-contract.quiescence-extension-lock-payload.v1",
    lockVersion: "qtb-extension-lock-v1",
    hashDomain: extensionDomains.lockPayload,
    phase1Authorized: false,
    sourceInventoryHash: source.inventoryHash,
    basePhase0: { reportHash: "f17975cfbfa945673d1a7f02bd990a5b5300f542423938ef7e85d8bfe5260402", payloadHash: "3883a611b61c28e81fb7b239bd9f98fc21b23f0bff9c98a5a4502a6009bcd63f", pinHash: "63659b6a830b64dc1f5b464a0a6aa06fead805df9dd95af9250b966a554885d5" },
    goldenVectors: [
      { name: "u64-empty-components", inputHex: "", outputHex: "0000000000000000000000000000000000000000000000000000000000000000" },
      { name: "sha256-abc", inputHex: "616263", outputHex: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
    ],
  };
  const payloadBytes = utf8(canonicalize(lockPayload as JsonValue));
  const payloadDigest = sha256(payloadBytes);
  const projection = { payloadDigest, signerId: "qtb-extension-fixture", keyId: "qtb-extension-fixture-v1", algorithm: "hmac-sha256" };
  const lockSignatureRecord = { signerId: projection.signerId, keyId: projection.keyId, algorithm: projection.algorithm, signatureHash: createHmac("sha256", "gajae-qtb-extension-development-fixture-v1").update(domainSeparated(extensionDomains.lockSignature, utf8(canonicalize(projection)))).digest("hex") };
  const lockSignatures = { version: "qtb-lock-signatures-v1", hashDomain: extensionDomains.lockSignatureSet, payloadDigest, threshold: 1, records: [lockSignatureRecord] };
  const lockSignatureBytes = utf8(canonicalize(lockSignatures as JsonValue));
  const lockPin = sha256(Buffer.concat([domainSeparated(extensionDomains.lockPin, payloadBytes), domainSeparated(extensionDomains.lockSignatureSet, lockSignatureBytes)]));
  extensionJsonFile(extensionPaths.lockPayload, lockPayload, schema);
  extensionJsonFile(extensionPaths.lockSignatures, lockSignatures, schema);
  if (readFileSync(join(repoRoot, extensionPaths.lockPin), "utf8") !== `${lockPin}\n`) throw new Error("extension lock pin mismatch");
}
function emitQuiescenceExtensionPreapproval(): void {
  const collect = (pathName: string, kind: string): AnyObject | undefined => {
    try { return extensionEntry(pathName, kind); } catch { return undefined; }
  };
  const sourceEntries = extensionSourcePaths.flatMap(pathName => {
    const entry = collect(pathName, "source");
    return entry === undefined ? [] : [entry];
  });
  const generatedPaths = [
    ...extensionLegacyPaths,
    extensionPaths.sourceInventory,
    extensionPaths.lockPayload,
    extensionPaths.lockSignatures,
    extensionPaths.lockPin,
    reportPath.replace(repoRoot + "/", "").replaceAll("\\", "/"),
  ];
  const generatedEntries = generatedPaths.flatMap(pathName => {
    const entry = collect(pathName, "generated");
    return entry === undefined ? [] : [entry];
  });
  const failures = checks.filter(item => !item.passed).map(item => `${item.id}${item.details === undefined ? "" : `: ${item.details}`}`);
  const reportUnsigned = {
    format: "quality-contract.quiescence-extension-verification-report.v1",
    hashDomain: extensionDomains.verificationReport,
    phase1Authorized: false,
    passed: failures.length === 0,
    failures,
    entries: [...sourceEntries, ...generatedEntries].sort((a, b) => compare(String(a.path), String(b.path))),
  };
  const report = { ...reportUnsigned, reportHash: extensionLayerHash(extensionDomains.verificationReport, reportUnsigned) };
  mkdirSync(generatedRoot, { recursive: true });
  writeFileSync(join(repoRoot, extensionPaths.verificationReport), `${canonicalize(report as JsonValue)}\n`, "utf8");
  if (failures.length > 0) throw new Error(`extension preapproval verification failed: ${failures.join("; ")}`);
}
const requiredModelCases = [
  "lifecycle/pair-flush-requires-both-acks", "lifecycle/pair-flush-archives-and-releases", "lifecycle/fifo-head-before-successor", "lifecycle/manual-retry-continuation-lease", "lifecycle/abort-vs-clear-first-cas", "lifecycle/clear-loses-after-abort-cas", "lifecycle/stale-terminal-is-audit-noop", "lifecycle/crash-restart-preserves-start-outbox", "lifecycle/lost-effect-recovery-reuses-invocation", "lifecycle/stable-timer-same-boot", "lifecycle/stable-timer-changed-boot-uncertainty", "lifecycle/stable-timer-wall-clock-rollback-bounded", "lifecycle/early-timer-callback-does-not-fire", "lifecycle/verified-success-requires-receipt", "lifecycle/receipt-mismatch-is-stale", "lifecycle/full-pair-queues-successor", "lifecycle/two-prompt-reordered-ack-crash-trace", "lifecycle/guard-supported", "lifecycle/guard-unsupported", "lifecycle/guard-unknown-fails-closed", "lifecycle/owner-key-generation-scoped", "storage/R10-noop-then-B11-commit", "storage/prequeued-A-B-progress-v0-v1-v2", "storage/partial-move-recovered-commit", "storage/duplicate-recovery-cas-audit", "storage/blocked-successor", "storage/deferred-rewrite-does-not-reserve-version", "storage/crash-restart-enters-same-slot-recovery", "storage/sync-fsync-order", "storage/exdev-phase-order", "storage/same-fs-move-directory-fsync-evidence", "storage/exdev-copy-unlink-directory-fsync", "storage/exdev-source-unlink-order", "storage/exdev-unlink-failure-no-fabricated-evidence", "storage/reachable-exdev-commit-with-unlink", "storage/no-future-version-reservation",
  "lifecycle/stale-recovery-callback-is-audit-noop",
  "lifecycle/clear-requires-real-receipt",
];
const modelSourceMutations: readonly ModelSourceMutation[] = [
  {
    id: "lifecycle-terminal-pair-requires-both-acks",
    target: "lifecycle",
    from: 'if (!nextPair.qualityAck || !nextPair.agentEndAck) return { ...state, pairFlush: nextPair, durableOutbox: state.durableOutbox.map((item) => item.outboxId === entry.outboxId ? nextEntry : item) };',
    to: 'if (!nextPair.qualityAck && !nextPair.agentEndAck) return { ...state, pairFlush: nextPair, durableOutbox: state.durableOutbox.map((item) => item.outboxId === entry.outboxId ? nextEntry : item) };',
  },
  {
    id: "lifecycle-stale-duplicate-callback-rejected",
    target: "lifecycle",
    from: 'if (state.phase !== "start_pending" || state.startPending?.invocationId !== action.invocationId || entry === undefined) return audit(state, { kind: "stale_callback", invocationId: action.invocationId, at: action.now ?? 0 });',
    to: 'if (state.phase !== "start_pending" || entry === undefined) return audit(state, { kind: "stale_callback", invocationId: action.invocationId, at: action.now ?? 0 });',
  },
  {
    id: "lifecycle-verified-success-requires-receipt",
    target: "lifecycle",
    from: 'case "clear": return reduceLifecycle(state, { type: "terminalize", owner: action.owner, invocationId: action.invocationId, status: "verified_success", reason: "clear_watch_receipt", receiptId: action.receiptId, now: action.now });',
    to: 'case "clear": return reduceLifecycle(state, { type: "terminalize", owner: action.owner, invocationId: action.invocationId, status: "verified_success", reason: "clear_watch_receipt", receiptId: action.receiptId ?? `clear:${action.invocationId ?? state.activeInvocationId ?? "unknown"}`, now: action.now });',
  },
];

function copyModelVerificationTree(temporary: string): { script: string; lifecycle: string; storage: string } {
  const script = join(temporary, "quality-contract/scripts/verify-models.ts");
  const lifecycle = join(temporary, "quality-contract/models/lifecycle-model.ts");
  const storage = join(temporary, "quality-contract/models/storage-model.ts");
  mkdirSync(join(temporary, "quality-contract/scripts"), { recursive: true });
  cpSync(join(contractRoot, "scripts/verify-models.ts"), script);
  cpSync(join(contractRoot, "models"), join(temporary, "quality-contract/models"), { recursive: true });
  mkdirSync(join(temporary, "quality-contract/fixtures"), { recursive: true });
  cpSync(join(contractRoot, "fixtures/quiescence-model-fixtures.json"), join(temporary, "quality-contract/fixtures/quiescence-model-fixtures.json"));
  mkdirSync(join(temporary, "quality-contract/manifests"), { recursive: true });
  cpSync(join(contractRoot, "manifests/risk-policy.json"), join(temporary, "quality-contract/manifests/risk-policy.json"));
  cpSync(join(contractRoot, "manifests/verification-obligations.json"), join(temporary, "quality-contract/manifests/verification-obligations.json"));
  mkdirSync(join(temporary, "quality-contract/generated"), { recursive: true });
  return { script, lifecycle, storage };
}

function strictModelTypecheck(temporary: string): void {
  const result = spawnSync(process.execPath, [
    "x", "tsc", "--ignoreConfig", "--noEmit", "--strict", "--target", "ES2022",
    "--module", "ESNext", "--moduleResolution", "Bundler",
    "quality-contract/models/lifecycle-model.ts", "quality-contract/models/storage-model.ts", "quality-contract/models/quiescence-budget-model.ts",
  ], { cwd: temporary, encoding: "utf8" });
  const diagnostics = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status !== 0 || diagnostics.length > 0) {
    throw new Error(`strict model typecheck failed: ${diagnostics || `exit status ${String(result.status)}`}`);
  }
}

function runIndependentModel(temporary: string, script: string): Buffer {
  const result = spawnSync(process.execPath, [script], { cwd: temporary, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`independent model process failed: ${result.stderr || result.stdout}`);
  return readFileSync(join(temporary, "quality-contract/generated/model-report.json"));
}

function applyModelSourceMutation(temporary: string, mutation: ModelSourceMutation): void {
  const target = join(temporary, "quality-contract/models", `${mutation.target}-model.ts`);
  const source = readFileSync(target, "utf8");
  const occurrences = source.split(mutation.from).length - 1;
  if (occurrences !== 1) throw new Error(`${mutation.id}: expected one exact source match, found ${occurrences}`);
  writeFileSync(target, source.replace(mutation.from, mutation.to), "utf8");
}

function runModelSourceMutation(mutation: ModelSourceMutation): ModelMutationResult {
  const temporary = mkdtempSync(join(tmpdir(), `quality-contract-mutant-${mutation.target}-`));
  try {
    const { script } = copyModelVerificationTree(temporary);
    try {
      applyModelSourceMutation(temporary, mutation);
      strictModelTypecheck(temporary);
    } catch (error) {
      return { id: mutation.id, target: mutation.target, killed: false, status: "invalid", details: error instanceof Error ? error.message : String(error) };
    }
    const result = spawnSync(process.execPath, [script], { cwd: temporary, encoding: "utf8" });
    if (result.error || result.status === null) return { id: mutation.id, target: mutation.target, killed: false, status: "invalid", details: result.error?.message ?? "independent model process terminated without an exit status" };
    const details = `${result.stderr || result.stdout || ""}`.trim() || `exit status ${String(result.status)}`;
    return { id: mutation.id, target: mutation.target, killed: result.status !== 0, status: result.status !== 0 ? "killed" : "survived", details };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function runModelSourceMutations(): readonly ModelMutationResult[] {
  return modelSourceMutations.map(runModelSourceMutation);
}

function regenerateDisposable(kind: "model" | "sqlite"): Buffer {
  const temporary = mkdtempSync(join(tmpdir(), `quality-contract-${kind}-`));
  try {
    if (kind === "model") {
      const { script } = copyModelVerificationTree(temporary);
      return runIndependentModel(temporary, script);
    }
    const script = join(temporary, "quality-contract/scripts/verify-sqlite.ts");
    mkdirSync(join(temporary, "quality-contract/scripts"), { recursive: true });
    cpSync(join(contractRoot, "scripts/verify-sqlite.ts"), script);
    cpSync(join(contractRoot, "scripts/verify-sqlite-node.ts"), join(temporary, "quality-contract/scripts/verify-sqlite-node.ts"));
    cpSync(join(contractRoot, "scripts/sqlite-race-worker.ts"), join(temporary, "quality-contract/scripts/sqlite-race-worker.ts"));
    cpSync(join(contractRoot, "sql"), join(temporary, "quality-contract/sql"), { recursive: true });
    mkdirSync(join(temporary, "quality-contract/fixtures"), { recursive: true });
    cpSync(join(contractRoot, "fixtures/sql-fixtures.json"), join(temporary, "quality-contract/fixtures/sql-fixtures.json"));
    cpSync(join(contractRoot, "fixtures/quiescence-sql-fixtures.json"), join(temporary, "quality-contract/fixtures/quiescence-sql-fixtures.json"));
    mkdirSync(join(temporary, "quality-contract/generated"), { recursive: true });
    const result = spawnSync(process.execPath, [script], { cwd: temporary, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`independent SQLite process failed: ${result.stderr || result.stdout}`);
    return readFileSync(join(temporary, "quality-contract/generated/sqlite-report.json"));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
function checkStrictModelTypecheck(): void {
  const temporary = mkdtempSync(join(tmpdir(), "quality-contract-typecheck-"));
  try {
    const { lifecycle, storage } = copyModelVerificationTree(temporary);
    if (!existsSync(lifecycle) || !existsSync(storage)) throw new Error("disposable model sources were not copied");
    strictModelTypecheck(temporary);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
function checkModelReport(): void {
  const regenerated = regenerateDisposable("model");
  const existing = readFileSync(join(generatedRoot, "model-report.json"));
  if (!existing.equals(regenerated)) throw new Error("model report differs byte-for-byte from independent regeneration");
  const report = expectObject(JSON.parse(regenerated.toString("utf8")), "regenerated model report");
  const cases = Array.isArray(report.cases) ? report.cases as AnyObject[] : [];
  const names = new Set(cases.map(item => String(item.name)));
  const passed = cases.filter(item => item.passed === true).length;
  const failed = cases.filter(item => item.passed !== true).length;
  if (report.deterministic !== true || failed !== 0 || cases.length !== report.caseCount || passed !== cases.length) throw new Error("independent model report is not a zero-failure deterministic report");
  if (cases.some(item => item.passed !== true) || requiredModelCases.some(name => !names.has(name))) throw new Error("independent model report is missing a required passing case");
  const invariants = new Set(Array.isArray(report.invariants) ? report.invariants.map(String) : []);
  for (const invariant of ["bounded_liveness", "terminal_pair_exactly_once", "terminal_receipt_identity", "fifo_pair_drain", "no_future_version_reservation", "queued_head_rebases_version", "same_slot_recovery", "fifo", "cas_first_winner", "observed_operation_evidence", "exdev_source_unlink_order"]) if (!invariants.has(invariant)) throw new Error(`model invariant missing: ${invariant}`);
  const mutants = runModelSourceMutations();
  const allKilled = mutants.length > 0 && mutants.every((mutant) => mutant.killed && mutant.status === "killed");
  check("model-reducer/source-mutants-killed", allKilled, JSON.stringify(mutants));
  if (!allKilled) throw new Error(`model reducer mutant gate failed: ${JSON.stringify(mutants)}`);
}
function checkSqliteReport(): void {
  const regenerated = regenerateDisposable("sqlite");
  const existing = readFileSync(join(generatedRoot, "sqlite-report.json"));
  if (!existing.equals(regenerated)) throw new Error("SQLite report differs byte-for-byte from independent regeneration");
  const report = expectObject(JSON.parse(regenerated.toString("utf8")), "regenerated SQLite report");
  const assertions = Array.isArray(report.assertions) ? report.assertions as AnyObject[] : [];
  const ids = new Set(assertions.map(item => String(item.id)));
  const passed = assertions.filter(item => item.passed === true).length;
  const failed = assertions.filter(item => item.passed !== true).length;
  const fixture = expectObject(readJson(join(contractRoot, "fixtures/sql-fixtures.json")), "SQL fixtures");
  const quiescenceFixture = expectObject(readJson(join(contractRoot, "fixtures/quiescence-sql-fixtures.json")), "QTB SQL fixtures");
  const required = new Set(
    [fixture, quiescenceFixture].flatMap(item =>
      (Array.isArray(item.scenarios) ? item.scenarios : []).map((scenario: unknown) =>
        String(expectObject(scenario, "SQL fixture scenario").id),
      ),
    ),
  );
  if (report.format !== "quality-contract.sqlite-report.v1" || report.fixtureVersion !== fixture.version || report.quiescenceFixtureVersion !== quiescenceFixture.version || report.windowSeconds !== 1209600 || failed !== 0 || assertions.length !== passed || assertions.some(item => item.passed !== true) || [...required].some(id => !ids.has(id))) {
    throw new Error("independent SQLite report failed or lacks a required boundary assertion");
  }
  const authority = readFileSync(join(contractRoot, "sql/authority.sql"));
  const promotion = readFileSync(join(contractRoot, "sql/promotion.sql"));
  const quiescenceAuthority = readFileSync(join(contractRoot, "sql/quiescence-authority.sql"));
  const fixtures = readFileSync(join(contractRoot, "fixtures/sql-fixtures.json"));
  const quiescenceFixtures = readFileSync(join(contractRoot, "fixtures/quiescence-sql-fixtures.json"));
  if (report.authoritySqlSha256 !== sha256(authority) || report.promotionSqlSha256 !== sha256(promotion) || report.quiescenceSqlSha256 !== sha256(quiescenceAuthority) || report.fixturesSha256 !== sha256(fixtures) || report.quiescenceFixturesSha256 !== sha256(quiescenceFixtures)) throw new Error("SQLite report source hash mismatch");
}
function checkCallsiteManifest(): void {
  const manifest = expectObject(readJson(join(generatedRoot, "callsite-manifest.json")), "callsite manifest");
  const sourceFiles = Array.isArray(manifest.sourceFiles) ? manifest.sourceFiles as AnyObject[] : [];
  if (sourceFiles.length === 0) throw new Error("callsite manifest has no source files");
  for (const source of sourceFiles) {
    const relativePath = String(source.path);
    if (relativePath.startsWith("/") || relativePath.includes("..")) throw new Error(`invalid manifest source path ${relativePath}`);
    const file = join(repoRoot, relativePath);
    if (!existsSync(file) || !statSync(file).isFile() || source.sha256 !== sha256(readFileSync(file))) throw new Error(`source hash mismatch: ${relativePath}`);
  }
  const callsites = Array.isArray(manifest.callsites) ? manifest.callsites as AnyObject[] : [];
  for (const callsite of callsites) {
    const unknown = callsite.surface === "unknown" || callsite.scope === "unknown" || String(callsite.operationClass).includes("unknown") || String(callsite.token).toLowerCase().includes("unclassified");
    if (unknown && callsite.decision === "ALLOW") throw new Error(`unknown callsite is ALLOW: ${String(callsite.id)}`);
    if (callsite.decision === "ALLOW" && callsite.policyDisposition !== "supported") throw new Error(`unsupported callsite is ALLOW: ${String(callsite.id)}`);
    if (callsite.sourceFileHash !== undefined) {
      const source = sourceFiles.find(item => item.path === callsite.sourcePath);
      if (!source || source.sha256 !== callsite.sourceFileHash) throw new Error(`callsite source hash mismatch: ${String(callsite.id)}`);
    }
  }
}
function checkIndependentCallsiteAudit(): void {
  const script = join(contractRoot, "scripts/audit-callsite-coverage.ts");
  const result = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, GJC_CANONICAL_ROOT: repoRoot } });
  const lines = String(result.stdout ?? "").trim().split(/\r?\n/);
  let report: AnyObject;
  try { report = expectObject(JSON.parse(lines.at(-1) ?? ""), "independent callsite audit report"); }
  catch { throw new Error(`independent callsite audit produced no machine-readable report: ${result.stderr || result.stdout}`); }
  if (result.status !== 0 || report.format !== "quality-contract.callsite-audit-report.v3" || report.passed !== true || !Array.isArray(report.failures) || report.failures.length !== 0) throw new Error(`independent callsite audit failed: ${JSON.stringify(report.failures ?? result.stderr)}`);
  const expectedProbeIds = ["producer-create-write-stream-row-delete", "producer-create-write-stream-row-corrupt", "producer-create-write-stream-inventory-omission", "producer-create-write-stream-collector-omission", "auditor-oracle-unknown-fs-writer"];
  const expectedMutationKinds = ["row-delete", "row-corrupt", "producer-inventory-omission", "producer-collector-omission", "auditor-oracle-omission"];
  const omissionProbes = Array.isArray(report.omissionProbes) ? report.omissionProbes as AnyObject[] : [];
  if (omissionProbes.length !== expectedProbeIds.length || omissionProbes.some((probe, index) => probe.id !== expectedProbeIds[index] || probe.mutation !== expectedMutationKinds[index] || probe.outcome !== "killed")) throw new Error("callsite omission probes are not the exact nonempty all-killed Phase 0 set");
}
function checkPolicyManifests(): void {
  const mutation = expectObject(readJson(join(contractRoot, "manifests/mutation-capabilities.json")), "mutation capabilities");
  if (mutation.defaultDisposition !== "unsupported" || mutation.defaultDecision !== "BLOCK") throw new Error("mutation unknown default is not fail-closed");
  const matrix = Array.isArray(mutation.operationMatrix) ? mutation.operationMatrix as AnyObject[] : [];
  const unknown = matrix.find(item => item.id === "unknown");
  if (!unknown || unknown.disposition !== "unsupported" || unknown.decision !== "BLOCK") throw new Error("mutation matrix unknown row is not BLOCK");
  const risk = expectObject(readJson(join(contractRoot, "manifests/risk-policy.json")), "risk policy");
  const verificationProfiles = expectObject(risk.verificationProfiles, "risk verification profiles");
  const expectedVerification = {
    R0: ["existing-tests", "independent-smoke"],
    R1: ["existing-tests", "independent-smoke"],
    R2: ["sealed-snapshot", "independent-adversarial-test"],
    R3: ["sealed-snapshot", "independent-adversarial-test", "broker-receipt", "multi-approval", "managed-ci"],
  } as const;
  for (const [level, required] of Object.entries(expectedVerification)) {
    const profile = expectObject(verificationProfiles[level], `${level} verification profile`);
    if (!Array.isArray(profile.required) || profile.required.join("\u0000") !== required.join("\u0000")) throw new Error(`${level} verification profile mismatch`);
  }
  if (expectObject(verificationProfiles.R3, "R3 verification profile").receiptAuthority !== "managed-broker") throw new Error("R3 is not managed-broker authoritative");
  const precedence = Array.isArray(risk.precedence) ? risk.precedence as AnyObject[] : [];
  for (const item of precedence) {
    if (item.id !== "hard-r3" && item.id !== "unknown" && item.effect !== "raise-only") throw new Error(`risk precedence is not raise-only: ${String(item.id)}`);
    if ((item.id === "hard-r3" || item.id === "unknown") && (item.effect !== "force" || item.decision !== "BLOCK" || item.risk !== "R3")) throw new Error(`risk precedence is not fail-closed: ${String(item.id)}`);
  }
  for (const item of (Array.isArray(risk.decisionTable) ? risk.decisionTable as AnyObject[] : [])) {
    if (item.id === "risk-project-hint" && expectObject(item.result, "project hint result").effect !== "raise-only") throw new Error("project hint decision is not raise-only");
  }
  if (expectObject(risk.mergeRule, "risk merge rule").unknownInputs !== "BLOCK" || expectObject(risk.mergeRule, "risk merge rule").projectHints !== "can only increase risk or restrict decision") throw new Error("risk merge rule is not fail-closed/raise-only");
  const profiles = expectObject(readJson(join(contractRoot, "manifests/platform-profiles.json")), "platform profiles");
  const profileRows = Array.isArray(profiles.profiles) ? profiles.profiles as AnyObject[] : [];
  for (const profile of profileRows) if (profile.disposition === "unsupported" && (profile.decision !== "BLOCK" || !Array.isArray(profile.supportedOperations) || profile.supportedOperations.length !== 0)) throw new Error(`unsupported profile is enforcing: ${String(profile.id)}`);
  const defaultProfile = profileRows.find(profile => profile.id === profiles.defaultProfile);
  if (!defaultProfile || defaultProfile.disposition !== "unsupported" || defaultProfile.decision !== "BLOCK") throw new Error("default profile is not unsupported/BLOCK");
  const evidence = expectObject(profiles.codexEvidence, "codex evidence");
  if (evidence.absenceDisposition !== "unsupported" || evidence.cacheClaimsTrusted !== false) throw new Error("codex absence is not non-enforcing");
}

function phaseBClockAnchor(value: unknown, label: string): AnyObject {
  const anchor = expectObject(value, label);
  const expected = ["bootId", "wallUtcMs", "monoMs", "uncertaintyMs", "persistedActionSequence", "candidateGeneration", "mutationEpoch", "cancellationEpoch"].sort(compare);
  if (Object.keys(anchor).sort(compare).join("\u0000") !== expected.join("\u0000")) throw new Error(`${label} is not closed`);
  if (typeof anchor.bootId !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(anchor.bootId)) throw new Error(`${label}: invalid boot id`);
  for (const key of ["wallUtcMs", "monoMs", "persistedActionSequence", "candidateGeneration", "mutationEpoch", "cancellationEpoch"]) if (!Number.isSafeInteger(anchor[key]) || anchor[key] < 0) throw new Error(`${label}: invalid ${key}`);
  if (!Number.isSafeInteger(anchor.uncertaintyMs) || anchor.uncertaintyMs < 0 || anchor.uncertaintyMs > 1000) throw new Error(`${label}: invalid uncertainty`);
  return anchor;
}

function phaseBTraceDuration(segmentValue: unknown, label: string): number {
  const segment = expectObject(segmentValue, label);
  const expected = ["start", "end", "derivation", "durationMs"].sort(compare);
  if (Object.keys(segment).sort(compare).join("\u0000") !== expected.join("\u0000")) throw new Error(`${label} is not closed`);
  const start = phaseBClockAnchor(segment.start, `${label}.start`);
  const end = phaseBClockAnchor(segment.end, `${label}.end`);
  if (end.persistedActionSequence < start.persistedActionSequence) throw new Error(`${label}: action sequence inversion`);
  for (const key of ["candidateGeneration", "mutationEpoch", "cancellationEpoch"]) if (start[key] !== end[key]) throw new Error(`${label}: identity mismatch`);
  let duration: number;
  if (start.bootId === end.bootId) {
    if (segment.derivation !== "same-boot-monotonic" || end.monoMs < start.monoMs) throw new Error(`${label}: same-boot derivation`);
    duration = end.monoMs - start.monoMs;
  } else {
    if (segment.derivation !== "cross-boot-conservative-upper-bound") throw new Error(`${label}: cross-boot derivation`);
    duration = Math.max(0, (end.wallUtcMs + end.uncertaintyMs) - (start.wallUtcMs - start.uncertaintyMs));
  }
  if (!Number.isSafeInteger(segment.durationMs) || segment.durationMs < 0 || segment.durationMs !== duration) throw new Error(`${label}: durationMs does not equal its derived duration`);
  return duration;
}

function phaseBCausalBefore(left: AnyObject, right: AnyObject, label: string): void {
  if (left.bootId === right.bootId ? left.monoMs > right.monoMs : left.wallUtcMs + left.uncertaintyMs > right.wallUtcMs - right.uncertaintyMs) throw new Error(`${label} segments are causally inverted`);
}

const phaseBQualityGates = ["b1-unit", "b2-gjc-integration", "b3-hook-integration", "b4-enforcement-e2e"] as const;
const phaseBAllGates = [...phaseBQualityGates, "coding-agent-types", "coding-agent-check", "coding-agent-regression", "root-check-ts", "root-test-ts"] as const;
function phaseBHash(value: unknown, label: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} is not a SHA-256 hash`);
}
function phaseBIdentifier(value: unknown, label: string): void {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error(`${label} is not a bounded identifier`);
}
function phaseBPath(value: unknown, label: string): void {
  if (typeof value !== "string" || value.startsWith("/") || value.split("/").some(part => part === ".." || part.length === 0)) throw new Error(`${label} must be repo-relative`);
}
function phaseBBaseLease(value: unknown, label: string): void {
  const tuple = expectObject(value, label);
  const expected = ["projectId", "rootObjectiveId", "candidateGeneration", "mutationEpoch", "profileId"].sort(compare);
  if (Object.keys(tuple).sort(compare).join("\u0000") !== expected.join("\u0000")) throw new Error(`${label} is not closed`);
  phaseBIdentifier(tuple.projectId, `${label}.projectId`);
  phaseBIdentifier(tuple.rootObjectiveId, `${label}.rootObjectiveId`);
  for (const field of ["candidateGeneration", "mutationEpoch"]) if (!Number.isSafeInteger(tuple[field]) || tuple[field] < 0) throw new Error(`${label}.${field} is invalid`);
  phaseBIdentifier(tuple.profileId, `${label}.profileId`);
}
function phaseBBindings(trace: AnyObject, gateId: string): void {
  const demanding = gateId === "b2-gjc-integration" || gateId === "b4-enforcement-e2e";
  const enforcement = gateId === "b4-enforcement-e2e";
  if (demanding) {
    phaseBHash(trace.candidateKey, "trace.candidateKey");
    phaseBBaseLease(trace.baseLeaseTuple, "trace.baseLeaseTuple");
    if (!Array.isArray(trace.fenceTokens) || trace.fenceTokens.length === 0) throw new Error("trace fence tokens are required");
  } else {
    if (trace.candidateKey !== null || trace.baseLeaseTuple !== null) throw new Error("trace candidate/base lease must be null for this gate");
    if (!Array.isArray(trace.fenceTokens) || trace.fenceTokens.length !== 0) throw new Error("trace fence tokens must be empty for this gate");
  }
  for (const field of ["receiptHash", "bindingHash", "pairHash"]) {
    if (enforcement) phaseBHash(trace[field], `trace.${field}`);
    else if (trace[field] !== null) throw new Error(`trace.${field} must be null for this gate`);
  }
}

function validatePhaseBTrace(trace: AnyObject, runId: string, gateId: string): Record<string, number> {
  if (!phaseBQualityGates.includes(gateId as typeof phaseBQualityGates[number])) throw new Error("trace is forbidden for non-quality gate");
  for (const [key, expected] of Object.entries({ schemaVersion: "phase-b-trace/v1", objectType: "PhaseBTrace", runId, gateId, timingSource: "quality-trace" })) if (trace[key] !== expected) throw new Error(`trace ${key} mismatch`);
  const expectedKeys = ["schemaVersion", "objectType", "runId", "gateId", "timingSource", "candidateKey", "baseLeaseTuple", "fenceTokens", "receiptHash", "bindingHash", "pairHash", "timings", "assertions", "traceHash"].sort(compare);
  if (Object.keys(trace).sort(compare).join("\u0000") !== expectedKeys.join("\u0000")) throw new Error("trace is not closed");
  phaseBBindings(trace, gateId);
  const timing = expectObject(trace.timings, "trace timings");
  const timingKeys = ["unit", "clockSource", "queueMs", "bootstrapMs", "collectionMs", "executionMs", "evidenceFlushMs", "shutdownMs", "segments"].sort(compare);
  if (Object.keys(timing).sort(compare).join("\u0000") !== timingKeys.join("\u0000") || timing.unit !== "ms" || timing.clockSource !== "coordinator-monotonic-v1") throw new Error("trace timing source/closure mismatch");
  const segments = expectObject(timing.segments, "trace segments");
  const phases = ["queue", "bootstrap", "collection", "execution", "evidenceFlush", "shutdown"] as const;
  const segmentKeys = [...phases].sort(compare);
  if (Object.keys(segments).sort(compare).join("\u0000") !== segmentKeys.join("\u0000")) throw new Error("trace timing segments are not closed");
  const result: Record<string, number> = {};
  const anchors: Array<{ start: AnyObject; end: AnyObject }> = [];
  for (const phase of phases) {
    const segment = expectObject(segments[phase], `${phase} segment`);
    const start = phaseBClockAnchor(segment.start, `${phase}.start`);
    const end = phaseBClockAnchor(segment.end, `${phase}.end`);
    const duration = phaseBTraceDuration(segment, phase);
    const field = `${phase}Ms`;
    if (!Number.isSafeInteger(timing[field]) || timing[field] !== duration) throw new Error(`${field} does not equal its segment duration`);
    result[field] = duration;
    anchors.push({ start, end });
  }
  for (let index = 0; index < anchors.length - 1; index++) phaseBCausalBefore(anchors[index].end, anchors[index + 1].start, phases[index]);
  if (!Array.isArray(trace.fenceTokens) || trace.fenceTokens.some((token: unknown) => !Number.isSafeInteger(token) || (token as number) < 1) || trace.fenceTokens.some((token: number, index: number, all: number[]) => index > 0 && token <= all[index - 1])) throw new Error("trace fence tokens are not sorted unique positive integers");
  if (!Array.isArray(trace.assertions)) throw new Error("trace assertions are not an array");
  let previous = "";
  for (const assertionValue of trace.assertions) {
    const assertion = expectObject(assertionValue, "trace assertion");
    const assertionKeys = assertion.passed === true ? ["id", "passed", "evidenceHash"] : assertion.passed === false ? ["id", "passed"] : [];
    if (assertionKeys.length === 0 || Object.keys(assertion).sort(compare).join("\u0000") !== [...assertionKeys].sort(compare).join("\u0000")) throw new Error("trace assertion is not closed");
    phaseBIdentifier(assertion.id, "trace assertion id");
    if (previous !== "" && compare(previous, assertion.id) >= 0) throw new Error("trace assertions are not sorted unique");
    previous = assertion.id;
    if (assertion.passed) phaseBHash(assertion.evidenceHash, "trace assertion evidenceHash");
  }
  phaseBHash(trace.traceHash, "traceHash");
  const unsigned = { ...trace }; delete unsigned.traceHash;
  if (trace.traceHash !== sha256(domainSeparated("gajae:quality-contract:qtb:phase-b-trace:v1", utf8(canonicalize(unsigned))))) throw new Error("trace hash mismatch");
  return result;
}

function validatePhaseBResult(result: AnyObject, trace: AnyObject | undefined): void {
  const phases = ["queue", "bootstrap", "collection", "execution", "evidenceFlush", "shutdown"] as const;
  const expectedKeys = ["schemaVersion", "objectType", "runId", "gateId", "commandHash", "startedAtUtc", "endedAtUtc", "wallElapsedMs", "exitCode", "signal", "passed", "timingSource", "queueMs", "bootstrapMs", "collectionMs", "executionMs", "evidenceFlushMs", "shutdownMs", "contentInventoryPath", "contentInventoryFileSha256", "contentInventoryHash", "declaredArtifactIds", "resultHash"].sort(compare);
  if (Object.keys(result).sort(compare).join("\u0000") !== expectedKeys.join("\u0000")) throw new Error("result is not closed");
  if (result.schemaVersion !== "phase-b-result/v1" || result.objectType !== "PhaseBResult") throw new Error("result identity mismatch");
  phaseBIdentifier(result.runId, "result.runId");
  if (!phaseBAllGates.includes(result.gateId as typeof phaseBAllGates[number])) throw new Error("result gate is unknown");
  for (const field of ["commandHash", "contentInventoryFileSha256", "contentInventoryHash"] as const) phaseBHash(result[field], `result.${field}`);
  if (typeof result.startedAtUtc !== "string" || Number.isNaN(Date.parse(result.startedAtUtc)) || typeof result.endedAtUtc !== "string" || Number.isNaN(Date.parse(result.endedAtUtc))) throw new Error("result timestamps are invalid");
  if (!Number.isSafeInteger(result.wallElapsedMs) || result.wallElapsedMs < 0) throw new Error("result wallElapsedMs is invalid");
  if (result.exitCode !== null && (!Number.isSafeInteger(result.exitCode) || result.exitCode < 0)) throw new Error("result exitCode is invalid");
  if (result.signal !== null && typeof result.signal !== "string") throw new Error("result signal is invalid");
  if (typeof result.passed !== "boolean") throw new Error("result passed is invalid");
  const quality = phaseBQualityGates.includes(result.gateId as typeof phaseBQualityGates[number]);
  if (result.timingSource !== (quality ? "quality-trace" : "not-applicable")) throw new Error("result timing source does not match gate");
  if (quality) {
    if (trace === undefined) throw new Error("quality result is missing trace");
    const durations = validatePhaseBTrace(trace, result.runId, result.gateId);
    for (const phase of phases) if (result[`${phase}Ms`] !== durations[`${phase}Ms`]) throw new Error(`result ${phase} does not equal trace`);
  } else {
    if (trace !== undefined) throw new Error("non-quality result cannot carry trace");
    if (phases.some(phase => result[`${phase}Ms`] !== null)) throw new Error("non-quality result timing must be null");
  }
  if (!Array.isArray(result.declaredArtifactIds)) throw new Error("result declaredArtifactIds is invalid");
  const expectedArtifacts = quality ? ["artifacts/trace.json"] : [];
  if (result.declaredArtifactIds.length !== expectedArtifacts.length || result.declaredArtifactIds.some((value: unknown, index: number) => value !== expectedArtifacts[index])) throw new Error("result artifact declaration mismatch");
  phaseBHash(result.resultHash, "resultHash");
  const unsigned = { ...result }; delete unsigned.resultHash;
  if (result.resultHash !== sha256(domainSeparated("gajae:quality-contract:qtb:phase-b-result:v1", utf8(canonicalize(unsigned))))) throw new Error("result hash mismatch");
}

function validatePhaseBInventory(inventory: AnyObject): void {
  const expectedKeys = ["schemaVersion", "objectType", "runId", "gateId", "entries", "inventoryHash"].sort(compare);
  if (Object.keys(inventory).sort(compare).join("\u0000") !== expectedKeys.join("\u0000")) throw new Error("content inventory is not closed");
  if (inventory.schemaVersion !== "phase-b-content-inventory/v1" || inventory.objectType !== "PhaseBContentInventory") throw new Error("content inventory identity mismatch");
  phaseBIdentifier(inventory.runId, "inventory.runId");
  if (!phaseBAllGates.includes(inventory.gateId as typeof phaseBAllGates[number])) throw new Error("inventory gate is unknown");
  if (!Array.isArray(inventory.entries)) throw new Error("inventory entries are not an array");
  let previous = "";
  for (const item of inventory.entries) {
    const entry = expectObject(item, "inventory entry");
    const entryKeys = ["relativePath", "bytes", "sha256", "mediaType"].sort(compare);
    if (Object.keys(entry).sort(compare).join("\u0000") !== entryKeys.join("\u0000")) throw new Error("inventory entry is not closed");
    phaseBPath(entry.relativePath, "inventory relativePath");
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error("inventory bytes is invalid");
    phaseBHash(entry.sha256, "inventory sha256");
    if (typeof entry.mediaType !== "string" || !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/.test(entry.mediaType)) throw new Error("inventory mediaType is invalid");
    if (entry.relativePath === "inventory.json" || entry.relativePath === "result.json") throw new Error("inventory has a self/parent path");
    if (previous !== "" && compare(previous, entry.relativePath) >= 0) throw new Error("inventory paths are not deterministic UTF-8 sorted");
    previous = entry.relativePath;
  }
  phaseBHash(inventory.inventoryHash, "inventoryHash");
  const unsigned = { ...inventory }; delete unsigned.inventoryHash;
  if (inventory.inventoryHash !== sha256(domainSeparated("gajae:quality-contract:qtb:phase-b-content-inventory:v1", utf8(canonicalize(unsigned))))) throw new Error("inventory hash mismatch");
}

function validatePhaseBFinalInventory(finalInventory: AnyObject): void {
  const expectedKeys = ["schemaVersion", "objectType", "runId", "matrixHash", "wrapperHash", "schemaHash", "gates", "overallPass", "finalInventoryHash"].sort(compare);
  if (Object.keys(finalInventory).sort(compare).join("\u0000") !== expectedKeys.join("\u0000") || finalInventory.schemaVersion !== "phase-b-final-inventory/v1" || finalInventory.objectType !== "PhaseBFinalInventory" || !Array.isArray(finalInventory.gates)) throw new Error("final inventory is not closed");
  phaseBIdentifier(finalInventory.runId, "finalInventory.runId");
  for (const field of ["matrixHash", "wrapperHash", "schemaHash", "finalInventoryHash"] as const) phaseBHash(finalInventory[field], `finalInventory.${field}`);
  const expectedGates = [...phaseBAllGates].sort(compare);
  let previous = "";
  const seen = new Set<string>();
  for (const item of finalInventory.gates) {
    const gate = expectObject(item, "final inventory gate");
    const gateKeys = ["gateId", "inventoryPath", "inventoryFileSha256", "inventoryHash", "resultPath", "resultFileSha256", "resultHash"].sort(compare);
    if (Object.keys(gate).sort(compare).join("\u0000") !== gateKeys.join("\u0000")) throw new Error("final inventory gate is not closed");
    if (!phaseBAllGates.includes(gate.gateId as typeof phaseBAllGates[number])) throw new Error("final inventory gate is unknown");
    if (seen.has(gate.gateId) || (previous !== "" && compare(previous, gate.gateId) >= 0)) throw new Error("final inventory gates are not deterministic UTF-8 sorted");
    seen.add(gate.gateId); previous = gate.gateId;
    phaseBPath(gate.inventoryPath, "final inventoryPath"); phaseBPath(gate.resultPath, "final resultPath");
    if (gate.inventoryPath === gate.resultPath) throw new Error("final inventory aliases inventory and result");
    for (const field of ["inventoryFileSha256", "inventoryHash", "resultFileSha256", "resultHash"] as const) phaseBHash(gate[field], `final inventory ${field}`);
  }
  if (seen.size !== expectedGates.length || expectedGates.some(gateId => !seen.has(gateId))) throw new Error("final inventory gate membership mismatch");
  phaseBHash(finalInventory.finalInventoryHash, "finalInventoryHash");
  const unsigned = { ...finalInventory }; delete unsigned.finalInventoryHash;
  if (finalInventory.finalInventoryHash !== sha256(domainSeparated("gajae:quality-contract:qtb:phase-b-final-inventory:v1", utf8(canonicalize(unsigned))))) throw new Error("final inventory hash mismatch");
}
function checkPhaseBIntent(): void {
  const matrix = expectObject(readJson(join(contractRoot, "manifests/phase-b-verification-matrix.json")), "Phase B matrix");
  if (matrix.schemaVersion !== "phase-b-verification-matrix/v1" || matrix.objectType !== "PhaseBVerificationMatrix" || matrix.phase1Authorized !== false) throw new Error("Phase B matrix is not an unauthorized v1 intent");
  const expected: Record<string, string[]> = {
    "b1-unit": ["bun", "test", "packages/coding-agent/src/quality/quality-store.test.ts", "packages/coding-agent/src/quality/event-coordinator.test.ts"],
    "b2-gjc-integration": ["bun", "test", "packages/coding-agent/src/quality/gajae-code-observation.integration.test.ts"],
    "b3-hook-integration": ["bun", "test", "packages/coding-agent/src/quality/harness-hook.integration.test.ts"],
    "b4-enforcement-e2e": ["bun", "test", "packages/coding-agent/src/quality/quality-enforcement.e2e.test.ts"],
    "coding-agent-types": ["bun", "--cwd=packages/coding-agent", "run", "check:types"],
    "coding-agent-check": ["bun", "--cwd=packages/coding-agent", "run", "check"],
    "coding-agent-regression": ["bun", "--cwd=packages/coding-agent", "test"],
    "root-check-ts": ["bun", "run", "check:ts"],
    "root-test-ts": ["bun", "run", "test:ts"],
  };
  const gates = Array.isArray(matrix.gates) ? matrix.gates.map(value => expectObject(value, "Phase B gate")) : [];
  if (gates.length !== Object.keys(expected).length) throw new Error("Phase B matrix gate count mismatch");
  const ids = new Set<string>();
  for (const gate of gates) {
    const id = String(gate.gateId);
    if (ids.has(id) || expected[id] === undefined) throw new Error(`Phase B matrix gate is duplicate/unknown: ${id}`);
    ids.add(id);
    if (JSON.stringify(gate.argv) !== JSON.stringify(expected[id])) throw new Error(`Phase B argv mismatch: ${id}`);
    const quality = ["b1-unit", "b2-gjc-integration", "b3-hook-integration", "b4-enforcement-e2e"].includes(id);
    if (gate.qualityTrace !== quality || !Array.isArray(gate.declaredArtifacts) || (quality ? JSON.stringify(gate.declaredArtifacts) !== JSON.stringify(["artifacts/trace.json"]) : gate.declaredArtifacts.length !== 0)) throw new Error(`Phase B trace declaration mismatch: ${id}`);
    if ((gate.futurePaths ?? []).some((path: unknown) => typeof path !== "string" || path.startsWith("/") || path.includes(".."))) throw new Error(`Phase B future path is not repo-relative: ${id}`);
  }
  if (ids.size !== Object.keys(expected).length) throw new Error("Phase B matrix has missing gates");
  const domains = expectObject(matrix.hashDomains, "Phase B hash domains");
  for (const key of ["command", "trace", "contentInventory", "result", "finalInventory"]) if (typeof domains[key] !== "string" || !domains[key].includes("gajae:quality-contract:qtb:phase-b-")) throw new Error(`Phase B hash domain missing: ${key}`);
  const traceSchema = expectObject(schemaMap.get("schemas/phase-b-verification.schema.json"), "Phase B schema");
  const traceDef = expectObject(expectObject(traceSchema.$defs, "Phase B schema defs").phaseBTraceV1, "PhaseBTraceV1");
  if (traceDef.additionalProperties !== false || traceDef.unevaluatedProperties !== false || !Array.isArray(traceDef.required) || traceDef.required.join("\u0000") !== ["schemaVersion", "objectType", "runId", "gateId", "timingSource", "candidateKey", "baseLeaseTuple", "fenceTokens", "receiptHash", "bindingHash", "pairHash", "timings", "assertions", "traceHash"].join("\u0000")) throw new Error("PhaseBTraceV1 is not the exact closed envelope");

  const phases = ["queue", "bootstrap", "collection", "execution", "evidenceFlush", "shutdown"] as const;
  const hashTrace = (value: AnyObject, domain = "gajae:quality-contract:qtb:phase-b-trace:v1"): void => { const unsigned = { ...value }; delete unsigned.traceHash; value.traceHash = sha256(domainSeparated(domain, utf8(canonicalize(unsigned)))); };
  const hashResult = (value: AnyObject, domain = "gajae:quality-contract:qtb:phase-b-result:v1"): void => { const unsigned = { ...value }; delete unsigned.resultHash; value.resultHash = sha256(domainSeparated(domain, utf8(canonicalize(unsigned)))); };
  const anchor = (sequence: number): AnyObject => ({ bootId: "boot-a", wallUtcMs: 1000 + sequence, monoMs: sequence, uncertaintyMs: 0, persistedActionSequence: sequence, candidateGeneration: 0, mutationEpoch: 0, cancellationEpoch: 0 });
  const makeTrace = (gateId = "b1-unit"): AnyObject => {
    const value: AnyObject = { schemaVersion: "phase-b-trace/v1", objectType: "PhaseBTrace", runId: "run-a", gateId, timingSource: "quality-trace", candidateKey: null, baseLeaseTuple: null, fenceTokens: [], receiptHash: null, bindingHash: null, pairHash: null, timings: { unit: "ms", clockSource: "coordinator-monotonic-v1", queueMs: 1, bootstrapMs: 1, collectionMs: 1, executionMs: 1, evidenceFlushMs: 1, shutdownMs: 1, segments: Object.fromEntries(phases.map((phase, index) => [phase, { start: anchor(index), end: anchor(index + 1), derivation: "same-boot-monotonic", durationMs: 1 }])) }, assertions: [], traceHash: "" };
    hashTrace(value);
    return value;
  };
  const trace = makeTrace();
  validatePhaseBTrace(trace, "run-a", "b1-unit");
  const result: AnyObject = { schemaVersion: "phase-b-result/v1", objectType: "PhaseBResult", runId: "run-a", gateId: "b1-unit", commandHash: "a".repeat(64), startedAtUtc: "2026-01-01T00:00:00Z", endedAtUtc: "2026-01-01T00:00:01Z", wallElapsedMs: 1, exitCode: 0, signal: null, passed: true, timingSource: "quality-trace", queueMs: 1, bootstrapMs: 1, collectionMs: 1, executionMs: 1, evidenceFlushMs: 1, shutdownMs: 1, contentInventoryPath: "inventory.json", contentInventoryFileSha256: "b".repeat(64), contentInventoryHash: "c".repeat(64), declaredArtifactIds: ["artifacts/trace.json"], resultHash: "" };
  hashResult(result);
  validatePhaseBResult(result, trace);
  const inventory: AnyObject = { schemaVersion: "phase-b-content-inventory/v1", objectType: "PhaseBContentInventory", runId: "run-a", gateId: "b1-unit", entries: [{ relativePath: "command.json", bytes: 1, sha256: "d".repeat(64), mediaType: "application/json" }], inventoryHash: "" };
  const hashInventory = (value: AnyObject): void => { const unsigned = { ...value }; delete unsigned.inventoryHash; value.inventoryHash = sha256(domainSeparated("gajae:quality-contract:qtb:phase-b-content-inventory:v1", utf8(canonicalize(unsigned)))); };
  hashInventory(inventory);
  validatePhaseBInventory(inventory);
  const finalInventory: AnyObject = { schemaVersion: "phase-b-final-inventory/v1", objectType: "PhaseBFinalInventory", runId: "run-a", matrixHash: "a".repeat(64), wrapperHash: "b".repeat(64), schemaHash: "c".repeat(64), gates: [...phaseBAllGates].sort(compare).map((gateId, index) => ({ gateId, inventoryPath: `inventory-${index}.json`, inventoryFileSha256: "d".repeat(64), inventoryHash: inventory.inventoryHash, resultPath: `result-${index}.json`, resultFileSha256: "e".repeat(64), resultHash: result.resultHash })), overallPass: true, finalInventoryHash: "" };
  const hashFinal = (value: AnyObject): void => { const unsigned = { ...value }; delete unsigned.finalInventoryHash; value.finalInventoryHash = sha256(domainSeparated("gajae:quality-contract:qtb:phase-b-final-inventory:v1", utf8(canonicalize(unsigned)))); };
  hashFinal(finalInventory);
  validatePhaseBFinalInventory(finalInventory);

  const A4_CASES: Record<string, "pass" | "reject"> = {
    "constructor-roundtrip": "pass", "trace-anchor-boot": "pass",
    "trace-wrong-unit": "reject", "trace-wrong-clock": "reject", "trace-unknown-field": "reject",
    "trace-anchor-identity": "reject", "trace-anchor-order": "reject", "trace-anchor-actionSequence": "reject", "trace-anchor-generation": "reject", "trace-anchor-mutation": "reject", "trace-anchor-cancellation": "reject", "trace-anchor-uncertainty": "reject", "trace-anchor-derivation": "reject",
    "quality-candidate-null": "reject", "quality-base-lease-null": "reject", "quality-fence-empty": "reject", "quality-b1-candidate": "reject", "quality-b1-fence": "reject", "quality-b4-receipt-null": "reject", "quality-b4-binding-null": "reject", "quality-b4-pair-null": "reject",
    "non-quality-trace": "reject", "non-quality-timing": "reject", "result-trace-mismatch": "reject",
    "trace-hash-rewrite": "reject", "trace-domain-rewrite": "reject", "trace-projection-rewrite": "reject", "trace-canonical-lf-rewrite": "reject", "result-hash-rewrite": "reject", "result-domain-rewrite": "reject", "result-projection-rewrite": "reject", "result-canonical-lf-rewrite": "reject",
    "inventory-path": "reject", "inventory-media": "reject", "inventory-bytes": "reject", "inventory-sha": "reject", "inventory-unknown": "reject", "inventory-duplicate": "reject", "inventory-self": "reject", "inventory-post-bind-rewrite": "reject",
    "final-membership": "reject", "final-order": "reject", "final-hash-rewrite": "reject", "final-unknown": "reject",
  };
  for (const phase of phases) for (const kind of ["omission", "null", "type", "fractional", "string", "negative", "duration-mismatch"]) {
    A4_CASES[`trace-scalar-${phase}-${kind}`] = "reject";
    A4_CASES[`trace-segment-${phase}-${kind}`] = "reject";
  }
  const handlers: Record<string, () => void> = { "constructor-roundtrip": proveConstructorRoundTrips };
  handlers["trace-wrong-unit"] = () => { const altered = structuredClone(trace); altered.timings.unit = "seconds"; hashTrace(altered); validatePhaseBTrace(altered, "run-a", "b1-unit"); };
  handlers["trace-wrong-clock"] = () => { const altered = structuredClone(trace); altered.timings.clockSource = "wall-clock"; hashTrace(altered); validatePhaseBTrace(altered, "run-a", "b1-unit"); };
  handlers["trace-unknown-field"] = () => { const altered = structuredClone(trace); altered.extra = true; hashTrace(altered); validatePhaseBTrace(altered, "run-a", "b1-unit"); };
  for (const phase of phases) for (const kind of ["omission", "null", "type", "fractional", "string", "negative", "duration-mismatch"]) {
    handlers[`trace-scalar-${phase}-${kind}`] = () => {
      const altered = structuredClone(trace); const field = `${phase}Ms`;
      if (kind === "omission") delete altered.timings[field]; else if (kind === "null") altered.timings[field] = null; else if (kind === "type") altered.timings[field] = []; else if (kind === "fractional") altered.timings[field] = 1.5; else if (kind === "string") altered.timings[field] = "1"; else altered.timings[field] = -1;
      if (kind === "duration-mismatch") altered.timings[field] = 2;
      hashTrace(altered); validatePhaseBTrace(altered, "run-a", "b1-unit");
    };
    handlers[`trace-segment-${phase}-${kind}`] = () => {
      const altered = structuredClone(trace); const segment = altered.timings.segments[phase];
      if (kind === "omission") delete altered.timings.segments[phase]; else if (kind === "null") altered.timings.segments[phase] = null; else if (kind === "type") altered.timings.segments[phase] = "segment"; else if (kind === "fractional") segment.durationMs = 1.5; else if (kind === "string") segment.durationMs = "1"; else if (kind === "negative") segment.durationMs = -1; else segment.durationMs = 2;
      hashTrace(altered); validatePhaseBTrace(altered, "run-a", "b1-unit");
    };
  }
  handlers["trace-anchor-boot"] = () => { const altered = structuredClone(trace); altered.timings.segments.queue.end.bootId = "boot-b"; altered.timings.segments.queue.end.wallUtcMs = 1001; altered.timings.segments.queue.end.monoMs = 0; altered.timings.segments.queue.derivation = "cross-boot-conservative-upper-bound"; hashTrace(altered); validatePhaseBTrace(altered, "run-a", "b1-unit"); };
  const anchorMutations: Record<string, (value: AnyObject) => void> = {
    "trace-anchor-identity": value => { value.timings.segments.queue.start.bootId = ""; }, "trace-anchor-order": value => { value.timings.segments.bootstrap.start.monoMs = 0; },
    "trace-anchor-actionSequence": value => { value.timings.segments.queue.start.persistedActionSequence = 2; }, "trace-anchor-generation": value => { value.timings.segments.queue.end.candidateGeneration = 1; },
    "trace-anchor-mutation": value => { value.timings.segments.queue.end.mutationEpoch = 1; }, "trace-anchor-cancellation": value => { value.timings.segments.queue.end.cancellationEpoch = 1; },
    "trace-anchor-uncertainty": value => { value.timings.segments.queue.end.uncertaintyMs = 1001; }, "trace-anchor-derivation": value => { value.timings.segments.queue.derivation = "cross-boot-conservative-upper-bound"; },
  };
  for (const [id, mutate] of Object.entries(anchorMutations)) handlers[id] = () => { const altered = structuredClone(trace); mutate(altered); hashTrace(altered); validatePhaseBTrace(altered, "run-a", "b1-unit"); };
  const demanding = structuredClone(trace);
  demanding.gateId = "b2-gjc-integration"; demanding.candidateKey = "f".repeat(64); demanding.baseLeaseTuple = { projectId: "project-a", rootObjectiveId: "objective-a", candidateGeneration: 0, mutationEpoch: 0, profileId: "profile-a" }; demanding.fenceTokens = [1]; hashTrace(demanding);
  const bindingMutations: Record<string, (value: AnyObject) => void> = {
    "quality-candidate-null": value => { value.candidateKey = null; }, "quality-base-lease-null": value => { value.baseLeaseTuple = null; }, "quality-fence-empty": value => { value.fenceTokens = []; },
    "quality-b1-candidate": value => { value.candidateKey = "f".repeat(64); }, "quality-b1-fence": value => { value.fenceTokens = [1]; },
  };
  for (const [id, mutate] of Object.entries(bindingMutations)) handlers[id] = () => { const altered = structuredClone(id.startsWith("quality-b1") ? trace : demanding); mutate(altered); hashTrace(altered); validatePhaseBTrace(altered, "run-a", altered.gateId); };
  for (const field of ["receiptHash", "bindingHash", "pairHash"]) handlers[`quality-b4-${field.replace("Hash", "").toLowerCase()}-null`] = () => { const altered = structuredClone(demanding); altered.gateId = "b4-enforcement-e2e"; altered[field] = null; hashTrace(altered); validatePhaseBTrace(altered, "run-a", "b4-enforcement-e2e"); };

  for (const phase of phases) for (const kind of ["plus", "minus", "omission", "null", "type"]) handlers[`result-${phase}-${kind}`] = () => {
    const altered = structuredClone(result); const field = `${phase}Ms`;
    if (kind === "plus") altered[field] = 2; else if (kind === "minus") altered[field] = 0; else if (kind === "omission") delete altered[field]; else if (kind === "null") altered[field] = null; else altered[field] = "1";
    hashResult(altered); validatePhaseBResult(altered, trace);
  };
  handlers["result-trace-mismatch"] = () => { const altered = structuredClone(result); altered.executionMs = 2; hashResult(altered); validatePhaseBResult(altered, trace); };
  const hashMutant = (value: AnyObject, field: "traceHash" | "resultHash", domain: string, mode: string): void => {
    const altered = structuredClone(value); const unsigned = { ...altered }; delete unsigned[field];
    if (mode === "hash") altered[field] = "0".repeat(64); else if (mode === "domain") altered[field] = sha256(domainSeparated(`wrong:${domain}`, utf8(canonicalize(unsigned)))); else if (mode === "projection") altered[field] = sha256(domainSeparated(domain, utf8(canonicalize({ runId: unsigned.runId })))); else altered[field] = sha256(domainSeparated(domain, utf8(`${canonicalize(unsigned)}\n`)));
    if (field === "traceHash") validatePhaseBTrace(altered, "run-a", "b1-unit"); else validatePhaseBResult(altered, trace);
  };
  handlers["trace-hash-rewrite"] = () => hashMutant(trace, "traceHash", "gajae:quality-contract:qtb:trace:v1", "hash");
  handlers["trace-domain-rewrite"] = () => hashMutant(trace, "traceHash", "gajae:quality-contract:qtb:trace:v1", "domain");
  handlers["trace-projection-rewrite"] = () => hashMutant(trace, "traceHash", "gajae:quality-contract:qtb:trace:v1", "projection");
  handlers["trace-canonical-lf-rewrite"] = () => hashMutant(trace, "traceHash", "gajae:quality-contract:qtb:phase-b-trace:v1", "lf");
  handlers["result-hash-rewrite"] = () => hashMutant(result, "resultHash", "gajae:quality-contract:qtb:result:v1", "hash");
  handlers["result-domain-rewrite"] = () => hashMutant(result, "resultHash", "gajae:quality-contract:qtb:result:v1", "domain");
  handlers["result-projection-rewrite"] = () => hashMutant(result, "resultHash", "gajae:quality-contract:qtb:result:v1", "projection");
  handlers["result-canonical-lf-rewrite"] = () => hashMutant(result, "resultHash", "gajae:quality-contract:qtb:phase-b-result:v1", "lf");

  const inventoryMutant = (mutate: (value: AnyObject) => void): void => { const altered = structuredClone(inventory); mutate(altered); validatePhaseBInventory(altered); };
  handlers["inventory-path"] = () => inventoryMutant(value => { value.entries[0].relativePath = "../escape"; });
  handlers["inventory-media"] = () => inventoryMutant(value => { value.entries[0].mediaType = "not-media"; });
  handlers["inventory-bytes"] = () => inventoryMutant(value => { value.entries[0].bytes = -1; });
  handlers["inventory-sha"] = () => inventoryMutant(value => { value.entries[0].sha256 = "z".repeat(64); });
  handlers["inventory-unknown"] = () => inventoryMutant(value => { value.extra = true; });
  handlers["inventory-duplicate"] = () => inventoryMutant(value => { value.entries.push({ ...value.entries[0] }); });
  handlers["inventory-self"] = () => inventoryMutant(value => { value.entries[0].relativePath = "inventory.json"; });
  handlers["inventory-post-bind-rewrite"] = () => inventoryMutant(value => { value.entries[0].bytes = 2; });

  const finalMutant = (mutate: (value: AnyObject) => void): void => { const altered = structuredClone(finalInventory); mutate(altered); hashFinal(altered); validatePhaseBFinalInventory(altered); };
  handlers["final-membership"] = () => finalMutant(value => { value.gates.pop(); });
  handlers["final-order"] = () => finalMutant(value => { value.gates.reverse(); });
  handlers["final-hash-rewrite"] = () => { const altered = structuredClone(finalInventory); altered.finalInventoryHash = "0".repeat(64); validatePhaseBFinalInventory(altered); };
  handlers["final-unknown"] = () => finalMutant(value => { value.extra = true; });

  const nonQuality: AnyObject = { ...result, gateId: "coding-agent-check", timingSource: "not-applicable", queueMs: null, bootstrapMs: null, collectionMs: null, executionMs: null, evidenceFlushMs: null, shutdownMs: null, declaredArtifactIds: [] };
  hashResult(nonQuality);
  handlers["non-quality-trace"] = () => validatePhaseBTrace(trace, "run-a", "coding-agent-check");
  handlers["non-quality-timing"] = () => { const altered = structuredClone(nonQuality); altered.queueMs = 0; hashResult(altered); validatePhaseBResult(altered, undefined); };

  for (const phase of phases) for (const kind of ["omission", "null", "type", "fractional", "string", "negative", "duration-mismatch"]) {
    A4_CASES[`trace-scalar-${phase}-${kind}`] = "reject";
    A4_CASES[`trace-segment-${phase}-${kind}`] = "reject";
  }
  for (const phase of phases) for (const kind of ["plus", "minus", "omission", "null", "type"]) A4_CASES[`result-${phase}-${kind}`] = "reject";
  const consumed = new Set<string>();
  const consume = (id: string, action: () => void): void => {
    if (consumed.has(id) || A4_CASES[id] === undefined) throw new Error(`A4 case ${id} was not declared exactly once`);
    let rejected = false;
    try { action(); } catch { rejected = true; }
    if ((A4_CASES[id] === "reject") !== rejected) throw new Error(`A4 case ${id} expected ${A4_CASES[id]} but got ${rejected ? "reject" : "pass"}`);
    consumed.add(id);
  };
  for (const id of Object.keys(A4_CASES)) {
    const handler = handlers[id];
    if (handler === undefined) throw new Error(`A4 fixed table case has no proof: ${id}`);
    consume(id, handler);
  }
  for (const id of Object.keys(handlers)) if (A4_CASES[id] === undefined) throw new Error(`A4 proof is not governed by fixed table: ${id}`);
  if (consumed.size !== Object.keys(A4_CASES).length) throw new Error("A4 cases were not consumed exactly once");
}
function phase0Artifacts(): Array<{ path: string; bytes: number; sha256: string }> {
  return walkFiles(contractRoot)
    .filter(file => file !== reportPath)
    .map(file => relative(repoRoot, file).replaceAll("\\", "/"))
    .filter(pathName => !pathName.startsWith("quality-contract/generated/quiescence-extension-"))
    .map(pathName => {
      const file = join(repoRoot, pathName);
      return { path: pathName, bytes: readFileSync(file).byteLength, sha256: sha256(readFileSync(file)) };
    })
    .sort((a, b) => compare(a.path, b.path));
}

function main(): void {
  const bundleFlag = process.argv.indexOf("--bundle");
  const selected = bundleFlag >= 0 ? process.argv[bundleFlag + 1] : undefined;
  const finalIndexFlag = process.argv.includes("--verify-quiescence-final-index");
  const preapprovalFlag = process.argv.some(flag => ["--preapprove-extension", "--preapproval-extension", "--preapproval"].includes(flag));
  if (preapprovalFlag && (selected !== undefined || finalIndexFlag)) throw new Error("--preapprove-extension runs the complete A-D preapproval stage and cannot be combined with another mode");
  if (selected !== undefined && !["A", "B", "C", "D"].includes(selected)) throw new Error(`unknown bundle ${selected}`);
  const enabled = (bundle: "A" | "B" | "C" | "D"): boolean => selected === undefined || selected === bundle;
  let loaded: { records: SchemaRecord[]; bytes: Map<string, Buffer> } | undefined;
  if (enabled("A")) {
    run("schemas/closed-draft-2020-12-structure", () => { loaded = readSchemas(); });
    run("phase-b/intent-matrix-and-trace-mutants", checkPhaseBIntent);
    run("schemas/negative-fixture-mutations-rejected", () => { checkNegativeFixtures(); });
    run("schema-lock/exact-canonical-payload-signature-pin", () => { if (!loaded) throw new Error("schema load failed"); checkSchemaLock(loaded); });
    if (finalIndexFlag) run("quiescence-extension/final-index-and-approval", () => { checkQuiescenceExtension(true); });
  }
  if (enabled("B")) {
    run("model-report/zero-failures-required-cases-invariants", checkModelReport);
    run("model/strict-no-emit-typecheck", checkStrictModelTypecheck);
  }
  if (enabled("C")) run("sqlite-report/zero-failures-boundary-assertions", checkSqliteReport);
  if (enabled("D")) {
    run("callsite-manifest/source-hashes-and-fail-closed-allow", checkCallsiteManifest);
    run("callsite-manifest/independent-complete-coverage-audit", checkIndependentCallsiteAudit);
    run("policy-manifests/unknown-block-risk-raise-only-unsupported-profiles", checkPolicyManifests);
  }
  if (selected !== undefined) {
    const partial = { format: "quality-contract.bundle-verification.v1", bundle: selected, checks, passed: checks.filter(item => item.passed).length, failed: checks.filter(item => !item.passed).length, phase1Authorized: false };
    process.stdout.write(`${JSON.stringify(partial)}\n`);
    if (partial.failed > 0) process.exitCode = 1;
    return;
  }
  const report = {
    format: "quality-contract.phase0-verification-report.v1",
    verifier: "quality-contract/scripts/verify-contracts.ts",
    artifactHashes: phase0Artifacts(),
    checks,
    passed: checks.filter(item => item.passed).length,
    failed: checks.filter(item => !item.passed).length,
    phase1Authorized: false,
    phase1BlockReason: "Phase A extension frozen; separate Phase B approval required",
  };
  mkdirSync(generatedRoot, { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (preapprovalFlag) {
    run("quiescence-extension/preapproval-source-and-lock", checkQuiescenceExtensionPreapproval);
    try { emitQuiescenceExtensionPreapproval(); }
    catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
  if (checks.some(item => !item.passed)) {
    console.error(`contract verification failed: ${checks.filter(item => !item.passed).length} check(s)`);
    process.exitCode = 1;
  }
}

try { main(); }
catch (error) {
  const fallback = { format: "quality-contract.phase0-verification-report.v1", verifier: "quality-contract/scripts/verify-contracts.ts", artifactHashes: [], checks: [{ id: "verifier-fatal", passed: false, details: error instanceof Error ? error.message : String(error) }], passed: 0, failed: 1, phase1Authorized: false, phase1BlockReason: "Phase A verification failed; Phase B remains unauthorized" };
  mkdirSync(generatedRoot, { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(fallback, null, 2)}\n`, "utf8");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
