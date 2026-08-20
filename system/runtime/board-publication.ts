import {
  missingCapabilities,
  type CapabilityName,
  type CapabilitySet,
} from "./capability-model";

import { lstat, readdir, readlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeHTML } from "entities";
import { parse } from "parse5";
import { sessionReference, type QaBoardManifest } from "../presentation/qa-board";
import { parseQaBoardCurrent, parseQaBoardManifest, validateManifestCurrentBinding, type QaBoardCurrent } from "../presentation/qa-board-validation";
import { containsBoundaryIdentity, containsBoundaryIdentityDeep, decodeCssEscapes } from "../presentation/session-identity";
import { isIsoUtcTimestamp } from "../presentation/timestamp";
import { closeSecureRoot, openSecureRoot, readSecureRegularFile } from "./local-artifact-store";


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
async function inventoryPublishedRevision(directory: string, relativePath = ""): Promise<Readonly<{ files: Set<string>; directories: Set<string> }>> {
  const files = new Set<string>();
  const directories = new Set<string>();
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const child = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw Error(`canonical Board publisher revision contains a symlink: ${child}`);
    if (entry.isFile()) files.add(child);
    else if (entry.isDirectory()) {
      directories.add(child);
      const nested = await inventoryPublishedRevision(join(directory, entry.name), child);
      for (const file of nested.files) files.add(file);
      for (const nestedDirectory of nested.directories) directories.add(nestedDirectory);
    } else throw Error(`canonical Board publisher revision contains an unsupported entry: ${child}`);
  }
  return { files, directories };
}

function sameSet(actual: ReadonlySet<string>, expected: ReadonlySet<string>): boolean {
  return actual.size === expected.size && [...actual].every(item => expected.has(item));
}


type ParsedHtmlAttribute = Readonly<{ name: string; value: string }>;
type ParsedHtmlNode = Readonly<{ nodeName: string; value?: string; attrs?: readonly ParsedHtmlAttribute[]; childNodes?: readonly ParsedHtmlNode[] }>;
function renderedPageText(source: string): string {
  const text: string[] = [];
  const visitNode = (node: ParsedHtmlNode): void => {
    if (node.nodeName === "#text" && node.value !== undefined) text.push(node.value);
    for (const attribute of node.attrs ?? []) {
      if (!["href", "src", "action", "formaction", "poster", "cite", "data", "longdesc", "usemap", "ping", "srcset"].includes(attribute.name)) continue;
      text.push(attribute.value);
      try { text.push(decodeURIComponent(attribute.value)); } catch { /* Preserve raw URL when percent decoding is malformed. */ }
    }
    for (const child of node.childNodes ?? []) visitNode(child);
  };
  visitNode(parse(source) as unknown as ParsedHtmlNode);
  return text.join("");
}

function containsActiveHtml(source: string): boolean {
  let active = false;
  const visitNode = (node: ParsedHtmlNode): void => {
    if (["script", "iframe", "frame", "object", "embed"].includes(node.nodeName) || (node.attrs ?? []).some(attribute => attribute.name === "srcdoc"
      || /^on[a-z]+$/iu.test(attribute.name)
      || ["href", "src", "action", "formaction"].includes(attribute.name) && /^\s*javascript:/iu.test(attribute.value))) {
      active = true;
      return;
    }
    for (const child of node.childNodes ?? []) visitNode(child);
  };
  visitNode(parse(source) as unknown as ParsedHtmlNode);
  return active;
}

function renderedCssContent(source: string): string {
  const values: string[] = [];
  const declarations = /\bcontent\s*:\s*((?:"(?:\\.|[^"\\])*"\s*)+|(?:'(?:\\.|[^'\\])*'\s*)+)/giu;
  const strings = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/gu;
  for (const match of source.matchAll(declarations)) {
    let value = "";
    for (const item of match[1]!.matchAll(strings)) value += item[1] ?? item[2] ?? "";
    values.push(decodeCssEscapes(value));
  }
  const attrDeclarations = /\bcontent\s*:\s*((?:attr\(\s*[-\w:]+\s*\)\s*)+)/giu;
  const attrTokens = /attr\(\s*([-\w:]+)\s*\)/giu;
  for (const match of source.matchAll(attrDeclarations)) {
    let value = "";
    for (const token of match[1]!.matchAll(attrTokens)) {
      const attribute = new RegExp(`\\b${token[1]}\\s*=\\s*(["'])(.*?)\\1`, "giu");
      for (const item of source.matchAll(attribute)) value += item[2] ?? "";
    }
    values.push(decodeCssEscapes(value));
  }
  return values.join("");
}

function closedKeys(value: Readonly<Record<string, unknown>>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every(key => key in value) && keys.every(key => required.includes(key) || optional.includes(key));
}

function parsePublishedManifest(value: unknown): QaBoardManifest {
  return parseQaBoardManifest(value);
}

type PublishedCurrent = QaBoardCurrent;
function parsePublishedCurrent(value: unknown, sessionKey: string, selectorTarget: string): PublishedCurrent {
  return parseQaBoardCurrent(value, sessionKey, selectorTarget);
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
  const components = entrypointPath.split("/");
  const sessionsIndex = components.lastIndexOf("sessions");
  if (sessionsIndex < 0 || components[sessionsIndex + 1] === undefined || !/^s-[0-9a-f]{64}$/.test(components[sessionsIndex + 1]!)) throw Error("canonical Board publisher reported a non-session Board URI");
  const sessionKey = components[sessionsIndex + 1]!;
  const sessionRoot = components.slice(0, sessionsIndex + 2).join("/");
  if (entrypointPath !== join(sessionRoot, "index.html")) throw Error("canonical Board publisher reported an unstable session Board URI");
  const stateDir = expected?.stateDir ?? dirname(dirname(sessionRoot));
  const root = await openSecureRoot(stateDir);
  try {
    const sessionRelative = relative(root.canonical, sessionRoot);
    if (sessionRelative !== join("sessions", sessionKey)) throw Error("canonical Board publisher session Board is outside the requested state directory");
    const stableLinks = new Map([
      [entrypointPath, "current/index.html"],
      [join(sessionRoot, "index.en.html"), "current/index.en.html"],
      [join(sessionRoot, "index.ko.html"), "current/index.ko.html"],
      [join(sessionRoot, "index.zh-CN.html"), "current/index.zh-CN.html"],
      [join(sessionRoot, "evidence"), "current/evidence"],
      [manifestPath, "current/manifest.json"],
      [join(sessionRoot, "current.json"), "current/current.json"],
    ]);
    for (const [path, expectedTarget] of stableLinks) {
      const information = await lstat(path).catch(() => undefined);
      if (information === undefined || !information.isSymbolicLink() || await readlink(path) !== expectedTarget) throw Error("canonical Board publisher reported an invalid stable session link");
    }
    const selectorPath = join(sessionRoot, "current");
    const selectorInformation = await lstat(selectorPath).catch(() => undefined);
    if (selectorInformation === undefined || !selectorInformation.isSymbolicLink()) throw Error("canonical Board publisher reported an invalid current selector");
    const selectorTarget = await readlink(selectorPath);
    if (!/^boards\/(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(selectorTarget)) throw Error("canonical Board publisher reported an unsafe current selector");
    const revisionRelative = join(sessionRelative, selectorTarget);
    let currentBytes: Uint8Array;
    try { currentBytes = await readSecureRegularFile(root.fd, join(revisionRelative, "current.json"), 1024 * 1024); } catch { throw Error("canonical Board publisher selected revision is invalid or escapes the session state root"); }
    let currentValue: unknown;
    try { currentValue = JSON.parse(new TextDecoder().decode(currentBytes)) as unknown; } catch { throw Error("canonical Board publisher reported malformed current.json"); }
    if (expected?.sessionId !== undefined && containsBoundaryIdentityDeep(currentValue, expected.sessionId)) throw Error("canonical Board publisher current pointer exposes the raw session ID");
    if (expected?.sessionId !== undefined && containsBoundaryIdentity(new TextDecoder("utf-8", { fatal: true }).decode(currentBytes), expected.sessionId)) throw Error("canonical Board publisher current pointer exposes the raw session ID");
    const current = parsePublishedCurrent(currentValue, sessionKey, selectorTarget);
    const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
    let immutableManifestBytes: Uint8Array;
    try { immutableManifestBytes = await readSecureRegularFile(root.fd, join(revisionRelative, "manifest.json"), 4 * 1024 * 1024); } catch { throw Error("canonical Board publisher immutable manifest is not a secure regular file"); }
    if (expected?.sessionId !== undefined && containsBoundaryIdentity(new TextDecoder("utf-8", { fatal: true }).decode(immutableManifestBytes), expected.sessionId)) throw Error("canonical Board publisher manifest exposes the raw session ID");
    if (digest(immutableManifestBytes) !== current.manifestSha256) throw Error("canonical Board publisher immutable manifest does not match current pointer");
    let manifestValue: unknown;
    try { manifestValue = JSON.parse(new TextDecoder().decode(immutableManifestBytes)) as unknown; } catch { throw Error("canonical Board publisher reported malformed immutable manifest"); }
    if (expected?.sessionId !== undefined && containsBoundaryIdentityDeep(manifestValue, expected.sessionId)) throw Error("canonical Board publisher manifest exposes the raw session ID");
    const manifest = parsePublishedManifest(manifestValue);
    validateManifestCurrentBinding(manifest, current);
    const declaredPaths = manifest.files.map(file => file.path);
    if (new Set(declaredPaths).size !== declaredPaths.length) throw Error("canonical Board publisher manifest contains duplicate file declarations");
    const expectedFiles = new Set(["manifest.json", "current.json", ...declaredPaths]);
    const expectedDirectories = new Set(["evidence"]);
    for (const path of declaredPaths) {
      const components = path.split("/");
      for (let index = 1; index < components.length; index += 1) expectedDirectories.add(components.slice(0, index).join("/"));
    }
    const inventory = await inventoryPublishedRevision(join(root.canonical, revisionRelative));
    if (!sameSet(inventory.files, expectedFiles) || !sameSet(inventory.directories, expectedDirectories)) throw Error("canonical Board publisher revision inventory does not match the manifest");
    if (expected?.sessionId !== undefined && expected.sessionHost !== undefined && current.sessionRef !== sessionReference(expected.sessionHost, expected.sessionId)) throw Error("canonical Board publisher session identity does not match current pointer");
    if (expected?.sessionHost !== undefined && manifest.generatedBy.sessionHost !== expected.sessionHost) throw Error("canonical Board publisher session host does not match the request");
    if (expected?.snapshotId !== undefined && manifest.snapshotId !== expected.snapshotId) throw Error("canonical Board publisher snapshot identity does not match the request");
    if (expected?.runId !== undefined && manifest.runId !== expected.runId) throw Error("canonical Board publisher run identity does not match the request");
    let entrypointValidated = false;
    for (const file of manifest.files) {
      let bytes: Uint8Array;
      try { bytes = await readSecureRegularFile(root.fd, join(revisionRelative, file.path), 128 * 1024 * 1024); } catch { throw Error(`canonical Board publisher immutable file is not secure: ${file.path}`); }
      if (bytes.byteLength !== file.bytes || digest(bytes) !== file.sha256) throw Error(`canonical Board publisher immutable file hash mismatch: ${file.path}`);
      if (expected?.sessionId !== undefined && file.path.endsWith(".html")) {
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw Error(`canonical Board publisher page is not UTF-8: ${file.path}`); }
        if (containsActiveHtml(text)) throw Error(`canonical Board publisher page contains active HTML: ${file.path}`);
        const decodedSource = text.includes("&") ? decodeHTML(text) : text;
        const decodedCss = decodeCssEscapes(text);
        const decodedCssContent = renderedCssContent(text);
        if (containsBoundaryIdentity(decodedSource, expected.sessionId)
          || containsBoundaryIdentity(decodedCss, expected.sessionId)
          || containsBoundaryIdentity(decodedCssContent, expected.sessionId)
          || containsBoundaryIdentity(renderedPageText(text), expected.sessionId)) throw Error(`canonical Board publisher page exposes the raw session ID: ${file.path}`);
      }
      if (file.path === "index.html" && file.role === "entrypoint") {
        if (digest(bytes) !== current.entrypointSha256) throw Error("canonical Board publisher immutable entrypoint does not match current pointer");
        entrypointValidated = true;
      }
    }
    if (!entrypointValidated) throw Error("canonical Board publisher did not validate the immutable entrypoint");
    return Object.freeze({ entrypointPath, manifestPath, currentPath: join(sessionRoot, "current.json"), immutableManifestPath: join(sessionRoot, selectorTarget, "manifest.json") });
  } finally {
    await closeSecureRoot(root);
  }
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
