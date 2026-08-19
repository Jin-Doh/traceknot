import {
  missingCapabilities,
  type CapabilityName,
  type CapabilitySet,
} from "./capability-model";

import { readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionReference, type QaBoardManifest } from "../presentation/qa-board";

export const BOARD_PUBLICATION_REQUIRED_CAPABILITIES = Object.freeze([
  "executeCommands",
  "bindSnapshot",
  "persistEvidence",
] as const satisfies readonly CapabilityName[]);

export type BoardPublicationPolicy = Readonly<{
  schemaVersion: "traceknot-board-policy/v1";
  publication: "required";
  onUnavailable: "report";
  explicitOptOut: "--no-board";
}>;

export const DEFAULT_BOARD_PUBLICATION_POLICY: BoardPublicationPolicy = Object.freeze({
  schemaVersion: "traceknot-board-policy/v1",
  publication: "required",
  onUnavailable: "report",
  explicitOptOut: "--no-board",
});

export type BoardPublicationDecision = Readonly<{
  status: "ready" | "unavailable" | "disabled";
  requiredCapabilities: readonly CapabilityName[];
  missingCapabilities: readonly CapabilityName[];
  reason?: string;
}>;

function object(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw Error(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(value: Readonly<Record<string, unknown>>): boolean {
  const keys = Object.keys(value).sort();
  return JSON.stringify(keys) === JSON.stringify([
    "explicitOptOut",
    "onUnavailable",
    "publication",
    "schemaVersion",
  ]);
}

export function parseBoardPublicationPolicy(value: unknown): BoardPublicationPolicy {
  const input = object(value, "Board publication policy");
  if (!exactKeys(input)) throw Error("Board publication policy keys are invalid");
  if (input.schemaVersion !== "traceknot-board-policy/v1") {
    throw Error("unsupported Board publication policy schemaVersion");
  }
  if (input.publication !== "required") throw Error("Board publication must be required");
  if (input.onUnavailable !== "report") throw Error("Board unavailability must be reported");
  if (input.explicitOptOut !== "--no-board") throw Error("Board opt-out must be --no-board");
  return DEFAULT_BOARD_PUBLICATION_POLICY;
}

export function resolveBoardPublicationDecision(
  capabilities: CapabilitySet,
  options: Readonly<{ policy?: BoardPublicationPolicy; explicitOptOut?: boolean }> = {},
): BoardPublicationDecision {
  const policy = options.policy ?? DEFAULT_BOARD_PUBLICATION_POLICY;
  parseBoardPublicationPolicy(policy);
  const requiredCapabilities = BOARD_PUBLICATION_REQUIRED_CAPABILITIES;
  if (options.explicitOptOut === true) {
    return Object.freeze({
      status: "disabled",
      requiredCapabilities,
      missingCapabilities: Object.freeze([]),
      reason: policy.explicitOptOut,
    });
  }
  const unavailable = missingCapabilities(capabilities, requiredCapabilities);
  if (unavailable.length > 0) {
    return Object.freeze({
      status: "unavailable",
      requiredCapabilities,
      missingCapabilities: unavailable,
      reason: `missing capabilities: ${unavailable.join(", ")}`,
    });
  }
  return Object.freeze({
    status: "ready",
    requiredCapabilities,
    missingCapabilities: Object.freeze([]),
  });
}

export type BoardPublicationOutcome = Readonly<
  | { status: "generated"; result: BoardPublisherResult }
  | { status: "unavailable"; missingCapabilities: readonly CapabilityName[]; reason: string }
  | { status: "disabled"; reason: string }
>;

export async function publishBoard(
  capabilities: CapabilitySet,
  publisher: BoardPublisher | undefined,
  input: BoardPublisherInput,
  options: Readonly<{ policy?: BoardPublicationPolicy; explicitOptOut?: boolean }> = {},
): Promise<BoardPublicationOutcome> {
  const decision = resolveBoardPublicationDecision(capabilities, options);
  if (decision.status === "disabled") {
    return Object.freeze({ status: "disabled", reason: decision.reason ?? "--no-board" });
  }
  if (decision.status === "unavailable") {
    return Object.freeze({
      status: "unavailable",
      missingCapabilities: decision.missingCapabilities,
      reason: decision.reason ?? "missing Board publication capability",
    });
  }
  if (publisher === undefined) {
    return Object.freeze({
      status: "unavailable",
      missingCapabilities: Object.freeze([]),
      reason: "no Board publisher is available",
    });
  }
  try {
    return Object.freeze({ status: "generated", result: await publisher.publish(input) });
  } catch (error) {
    return Object.freeze({
      status: "unavailable",
      missingCapabilities: Object.freeze([]),
      reason: `Board publisher failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

export type BoardPublisherInput = Readonly<{
  rootDir: string;
  requestPath: string;
  manifestPath: string;
  stateDir: string;
  artifactDir: string;
  runId: string;
  sessionId: string;
  snapshotId: string;
  sessionHost: string;
}>;

export type BoardPublisherResult = Readonly<{
  status: "generated";
  publisher: string;
  entrypoint: string;
  manifestPath: string;
  runId: string;
}>;

export type BoardPublisher = Readonly<{
  publish: (input: BoardPublisherInput) => Promise<BoardPublisherResult>;
}>;

export type CanonicalCliRunner = (
  command: readonly string[],
  cwd: string,
) => Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>>;

function defaultCanonicalCliRunner(
  command: readonly string[],
  cwd: string,
): Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>> {
  const child = Bun.spawn([...command], { cwd, stdout: "pipe", stderr: "pipe" });
  return Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).then(([stdout, stderr, exitCode]) => Object.freeze({ stdout, stderr, exitCode }));
}

function boardUriFromOutput(stdout: string, stderr: string): string {
  const matches = [stdout, stderr].flatMap(output =>
    [...output.matchAll(/^Traceknot Board: (file:\/\/\S+)$/gm)].map(match => match[1]!),
  );
  const unique = [...new Set(matches)];
  if (unique.length === 0) throw Error("canonical Board publisher did not report a file URI");
  if (unique.length > 1) throw Error("canonical Board publisher reported conflicting file URIs");
  return unique[0]!;
}

export async function validatePublishedBoard(
  entrypoint: string,
  expected?: Readonly<{ sessionId?: string; sessionHost?: string; snapshotId?: string; runId?: string; stateDir?: string }>,
): Promise<Readonly<{ entrypointPath: string; manifestPath: string; currentPath?: string; immutableManifestPath?: string }>> {
  let entrypointPath: string;
  try {
    entrypointPath = fileURLToPath(entrypoint);
  } catch {
    throw Error("canonical Board publisher reported an invalid file URI");
  }
  if (basename(entrypointPath) !== "index.html") throw Error(`canonical Board publisher reported a non-Board entrypoint: ${entrypointPath}`);
  const manifestPath = join(dirname(entrypointPath), "manifest.json");
  for (const [label, path] of [["Board entrypoint", entrypointPath], ["Board manifest", manifestPath] as const]) {
    const information = await stat(path).catch(() => undefined);
    if (information === undefined) throw Error(`canonical Board publisher reported ${label} that does not exist: ${path}`);
    if (!information.isFile()) throw Error(`canonical Board publisher reported ${label} that is not a regular file: ${path}`);
  }
  const components = entrypointPath.split("/");
  const sessionsIndex = components.lastIndexOf("sessions");
  if (sessionsIndex < 0 || components[sessionsIndex + 1] === undefined || !/^s-[0-9a-f]{64}$/.test(components[sessionsIndex + 1]!)) throw Error("canonical Board publisher reported a non-session Board URI");
  const sessionKey = components[sessionsIndex + 1]!;
  const sessionRoot = components.slice(0, sessionsIndex + 2).join("/");
  if (expected?.stateDir !== undefined) {
    const [canonicalStateDir, canonicalSessionRoot] = await Promise.all([realpath(expected.stateDir), realpath(sessionRoot)]);
    if (canonicalSessionRoot !== join(canonicalStateDir, "sessions", sessionKey)) throw Error("canonical Board publisher session Board is outside the requested state directory");
  }
  if (entrypointPath !== join(sessionRoot, "index.html")) throw Error("canonical Board publisher reported an unstable session Board URI");
  const currentPath = join(sessionRoot, "current.json");
  const currentBytes = await readFile(currentPath).catch(() => undefined);
  if (!currentBytes) throw Error("canonical Board publisher reported a session Board without current.json");
  let current: Record<string, unknown>;
  try { current = JSON.parse(new TextDecoder().decode(currentBytes)) as Record<string, unknown>; } catch { throw Error("canonical Board publisher reported malformed current.json"); }
  if (current.schemaVersion !== "traceknot-session-board-current/v1" || current.sessionKey !== sessionKey || current.entrypoint !== "index.html" || current.authoritative !== false || typeof current.revisionPath !== "string" || !/^boards\/(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(current.revisionPath) || typeof current.entrypointSha256 !== "string" || !/^[0-9a-f]{64}$/.test(current.entrypointSha256) || typeof current.manifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(current.manifestSha256) || typeof current.sessionRef !== "string") throw Error("canonical Board publisher reported an invalid current pointer");
  const stableBytes = await readFile(entrypointPath);
  const stableManifestBytes = await readFile(manifestPath);
  const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
  if (digest(stableBytes) !== current.entrypointSha256 || digest(stableManifestBytes) !== current.manifestSha256) throw Error("canonical Board publisher stable files do not match current pointer");
  const immutableManifestPath = join(sessionRoot, current.revisionPath, "manifest.json");
  const immutableManifestBytes = await readFile(immutableManifestPath).catch(() => undefined);
  if (!immutableManifestBytes || digest(immutableManifestBytes) !== current.manifestSha256) throw Error("canonical Board publisher immutable manifest does not match current pointer");
  let manifest: QaBoardManifest;
  try { manifest = JSON.parse(new TextDecoder().decode(immutableManifestBytes)) as QaBoardManifest; } catch { throw Error("canonical Board publisher reported malformed immutable manifest"); }
  if (manifest.authoritative !== false || manifest.sessionKey !== sessionKey || manifest.generatedBy.sessionRef !== current.sessionRef) throw Error("canonical Board publisher immutable manifest identity does not match current pointer");
  if (expected?.sessionId !== undefined && expected.sessionHost !== undefined && current.sessionRef !== sessionReference(expected.sessionHost, expected.sessionId)) throw Error("canonical Board publisher session identity does not match current pointer");
  if (expected?.snapshotId !== undefined && manifest.snapshotId !== expected.snapshotId) throw Error("canonical Board publisher snapshot identity does not match the request");
  if (expected?.runId !== undefined && manifest.runId !== expected.runId) throw Error("canonical Board publisher run identity does not match the request");
  for (const file of manifest.files) {
    const bytes = await readFile(join(sessionRoot, current.revisionPath, file.path)).catch(() => undefined);
    if (!bytes || bytes.byteLength !== file.bytes || digest(bytes) !== file.sha256) throw Error(`canonical Board publisher immutable file hash mismatch: ${file.path}`);
  }
  if (digest(stableManifestBytes) !== digest(immutableManifestBytes)) throw Error("canonical Board publisher stable manifest differs from immutable revision");
  return Object.freeze({ entrypointPath, manifestPath, currentPath, immutableManifestPath });
}

export function createCanonicalCliBoardPublisher(input: Readonly<{
  executable: string;
  runner?: CanonicalCliRunner;
  publisherName?: string;
}>): BoardPublisher {
  const runner = input.runner ?? defaultCanonicalCliRunner;
  const publisher = input.publisherName ?? "canonical-cli";
  return Object.freeze({
    publish: async (request: BoardPublisherInput): Promise<BoardPublisherResult> => {
      const command = Object.freeze([
        input.executable,
        "verify",
        "--root",
        request.rootDir,
        "--request",
        request.requestPath,
        "--manifest",
        request.manifestPath,
        "--state-dir",
        request.stateDir,
        "--artifact-dir",
        request.artifactDir,
        "--run-id",
        request.runId,
        "--session-id",
        request.sessionId,
        "--session-host",
        request.sessionHost,
        "--board",
      ]);
      const result = await runner(command, request.rootDir);
      if (![0, 1, 2, 3].includes(result.exitCode)) {
        throw Error(`canonical Board publisher failed (${result.exitCode}): ${result.stderr}`);
      }
      const entrypoint = boardUriFromOutput(result.stdout, result.stderr);
      const board = await validatePublishedBoard(entrypoint, { sessionId: request.sessionId, sessionHost: request.sessionHost, snapshotId: request.snapshotId, runId: request.runId, stateDir: request.stateDir });
      return Object.freeze({
        status: "generated",
        publisher,
        entrypoint,
        manifestPath: board.manifestPath,
        runId: request.runId,
      });
    },
  });
}
