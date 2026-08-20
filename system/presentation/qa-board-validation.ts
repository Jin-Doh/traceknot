import type { QaBoardManifest } from "./qa-board";
import { isIsoUtcTimestamp } from "./timestamp";

export const QA_BOARD_PAGE_PATHS = Object.freeze(["index.html", "index.en.html", "index.ko.html", "index.zh-CN.html"] as const);
export type QaBoardCurrent = Readonly<{
  schemaVersion: "traceknot-session-board-current/v1";
  sessionKey: string;
  sourceRevision: number;
  invocationId: string;
  revisionPath: string;
  entrypoint: "index.html";
  entrypointSha256: string;
  manifestSha256: string;
  sessionRef: string;
  generatedAt: string;
  authoritative: false;
}>;

type RecordValue = Record<string, unknown>;
const DIGEST = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_PAGE = /^(?:index(?:\.(?:en|ko|zh-CN))?\.html|evidence\/[0-9a-f]{64}\.png)$/u;
const STATES = new Set(["CREATED", "BASIS_ESTABLISHED", "DISCOVERY_COMPLETED", "PLANNED", "EXECUTING", "EVIDENCE_EVALUATED", "VERDICT_RESOLVED", "TERMINAL"]);
const VERDICTS = new Set(["PASS", "PASS_WITH_ACCEPTED_RISK", "FAIL", "BLOCKED", "INCOMPLETE"]);

function record(value: unknown, label: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as RecordValue;
}
function exact(value: RecordValue, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every(key => key in value) && keys.every(key => required.includes(key) || optional.includes(key));
}
function nonnegativeInteger(value: unknown): boolean { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }

export function parseQaBoardManifest(value: unknown): QaBoardManifest {
  const manifest = record(value, "Board manifest");
  const required = ["schemaVersion", "runId", "requestId", "rootIdentity", "snapshotId", "sourceRevision", "sourceState", "sourceUpdatedAt", "generatedAt", "entrypoint", "authoritative", "assurance", "verdict", "counts", "generatedBy", "files"];
  if (!exact(manifest, required, ["sessionKey"]) || manifest.schemaVersion !== "traceknot-qa-board/v1" || manifest.entrypoint !== "index.html" || manifest.authoritative !== false) throw new Error("Board manifest contract is invalid");
  for (const key of ["runId", "requestId", "rootIdentity", "snapshotId"] as const) if (typeof manifest[key] !== "string" || manifest[key].length === 0) throw new Error(`Board manifest ${key} is invalid`);
  if (!nonnegativeInteger(manifest.sourceRevision) || typeof manifest.sourceState !== "string" || !STATES.has(manifest.sourceState) || typeof manifest.sourceUpdatedAt !== "string" || typeof manifest.generatedAt !== "string" || typeof manifest.verdict !== "string" || !VERDICTS.has(manifest.verdict)) throw new Error("Board manifest identity fields are invalid");
  if (!isIsoUtcTimestamp(manifest.sourceUpdatedAt) || !isIsoUtcTimestamp(manifest.generatedAt)) throw new Error("Board manifest timestamps are invalid");
  const assurance = record(manifest.assurance, "Board manifest assurance");
  if (!exact(assurance, ["context", "requiredIndependence", "releaseStatus"]) || !["local", "release"].includes(String(assurance.context)) || !["separate-verification-context", "independent-producer"].includes(String(assurance.requiredIndependence)) || !["not-evaluated", "satisfied", "insufficient"].includes(String(assurance.releaseStatus))) throw new Error("Board manifest assurance is invalid");
  const counts = record(manifest.counts, "Board manifest counts");
  if (!exact(counts, ["mandatory", "passed", "failed", "blocked", "incomplete"]) || Object.values(counts).some(item => !nonnegativeInteger(item))) throw new Error("Board manifest counts are invalid");
  const generatedBy = record(manifest.generatedBy, "Board manifest generatedBy");
  if (!exact(generatedBy, ["invocationId", "sessionHost", "sessionRef"]) || typeof generatedBy.invocationId !== "string" || !SAFE_ID.test(generatedBy.invocationId) || typeof generatedBy.sessionHost !== "string" || generatedBy.sessionHost.length === 0 || typeof generatedBy.sessionRef !== "string" || generatedBy.sessionRef.length === 0) throw new Error("Board manifest generatedBy is invalid");
  if (manifest.sessionKey !== undefined && (typeof manifest.sessionKey !== "string" || !/^s-[0-9a-f]{64}$/u.test(manifest.sessionKey))) throw new Error("Board manifest sessionKey is invalid");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error("Board manifest files are invalid");
  const paths = new Set<string>();
  let entrypoints = 0;
  for (const candidate of manifest.files) {
    const file = record(candidate, "Board manifest file");
    if (!exact(file, ["path", "role", "sha256", "bytes"], ["artifactDigest", "observationId"]) || typeof file.path !== "string" || !SAFE_PAGE.test(file.path)) throw new Error(`Board manifest file is invalid: ${String(file.path)}`);
    if (paths.has(file.path)) throw new Error("duplicate file declarations");
    if (file.artifactDigest !== undefined && (typeof file.artifactDigest !== "string" || !DIGEST.test(file.artifactDigest))) throw new Error(`Board manifest artifactDigest is invalid: ${file.path}`);
    if (file.observationId !== undefined && (typeof file.observationId !== "string" || file.observationId.length === 0)) throw new Error(`Board manifest observationId is invalid: ${file.path}`);
    if (typeof file.sha256 !== "string" || !DIGEST.test(file.sha256) || !nonnegativeInteger(file.bytes)) throw new Error(`Board manifest file is invalid: ${file.path}`);
    paths.add(file.path);
    const expectedRole = file.path === "index.html" ? "entrypoint" : file.path.endsWith(".html") ? "localized-view" : "screenshot-preview";
    if (file.role !== expectedRole) throw new Error(`Board manifest role does not match path: ${file.path}`);
    if (file.path === "index.html") entrypoints += 1;
  }
  for (const requiredPath of QA_BOARD_PAGE_PATHS) if (!paths.has(requiredPath)) throw new Error(`missing required page: ${requiredPath}`);
  if (entrypoints !== 1) throw new Error("Board manifest must declare exactly one entrypoint");
  return manifest as QaBoardManifest;
}

export function parseQaBoardCurrent(value: unknown, sessionKey: string, selectorTarget: string): QaBoardCurrent {
  const current = record(value, "Board current pointer");
  const required = ["schemaVersion", "sessionKey", "sourceRevision", "invocationId", "revisionPath", "entrypoint", "entrypointSha256", "manifestSha256", "sessionRef", "generatedAt", "authoritative"];
  if (!exact(current, required) || current.schemaVersion !== "traceknot-session-board-current/v1" || current.sessionKey !== sessionKey || current.revisionPath !== selectorTarget || current.entrypoint !== "index.html" || current.authoritative !== false || !nonnegativeInteger(current.sourceRevision) || typeof current.invocationId !== "string" || !SAFE_ID.test(current.invocationId) || typeof current.entrypointSha256 !== "string" || !DIGEST.test(current.entrypointSha256) || typeof current.manifestSha256 !== "string" || !DIGEST.test(current.manifestSha256) || typeof current.sessionRef !== "string" || current.sessionRef.length === 0 || !isIsoUtcTimestamp(current.generatedAt)) throw new Error("Board current pointer is invalid");
  return current as QaBoardCurrent;
}

export function validateManifestCurrentBinding(manifest: QaBoardManifest, current: QaBoardCurrent): void {
  const generatedBy = manifest.generatedBy;
  if (manifest.sessionKey !== current.sessionKey || manifest.sourceRevision !== current.sourceRevision || generatedBy.invocationId !== current.invocationId || generatedBy.sessionRef !== current.sessionRef || manifest.generatedAt !== current.generatedAt) throw new Error("canonical Board publisher immutable manifest identity does not match current pointer");
}
