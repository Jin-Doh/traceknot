import {
  missingCapabilities,
  type CapabilityName,
  type CapabilitySet,
} from "./capability-model";

import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

async function validatePublishedBoard(entrypoint: string): Promise<Readonly<{ entrypointPath: string; manifestPath: string }>> {
  let entrypointPath: string;
  try {
    entrypointPath = fileURLToPath(entrypoint);
  } catch {
    throw Error("canonical Board publisher reported an invalid file URI");
  }
  if (basename(entrypointPath) !== "index.html") {
    throw Error(`canonical Board publisher reported a non-Board entrypoint: ${entrypointPath}`);
  }
  const manifestPath = join(dirname(entrypointPath), "manifest.json");
  for (const [label, path] of [["Board entrypoint", entrypointPath], ["Board manifest", manifestPath]] as const) {
    const information = await stat(path).catch(() => undefined);
    if (information === undefined) throw Error(`canonical Board publisher reported ${label} that does not exist: ${path}`);
    if (!information.isFile()) throw Error(`canonical Board publisher reported ${label} that is not a regular file: ${path}`);
  }
  return Object.freeze({ entrypointPath, manifestPath });
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
      if (result.exitCode !== 0) {
        throw Error(`canonical Board publisher failed (${result.exitCode}): ${result.stderr}`);
      }
      const entrypoint = boardUriFromOutput(result.stdout, result.stderr);
      const board = await validatePublishedBoard(entrypoint);
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
