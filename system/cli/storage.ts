import {
  DEFAULT_CACHE_RETENTION_POLICY,
  inspectStorage,
  pinRun,
  pruneStorage,
  unpinRun,
  type StorageMaintenanceOptions,
  type StorageRetentionPolicy,
} from "../runtime/storage-retention";

export const STORAGE_EXIT_CODES = Object.freeze({ OK: 0, USAGE: 64, INTERNAL: 70 });
type MutableRetentionPolicy = { -readonly [Key in keyof StorageRetentionPolicy]?: number };
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SAFE_ID = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type Parsed = {
  command: "status" | "prune" | "pin" | "unpin";
  stateDir: string;
  artifactDir: string;
  runId?: string;
  apply: boolean;
  now?: string;
  policy: Partial<StorageRetentionPolicy>;
};

function usage(): string {
  return [
    "traceknot storage status --state-dir DIR --artifact-dir DIR",
    "traceknot storage prune --state-dir DIR --artifact-dir DIR [--apply]",
    "traceknot storage pin RUN_ID --state-dir DIR --artifact-dir DIR",
    "traceknot storage unpin RUN_ID --state-dir DIR --artifact-dir DIR",
    "",
    "Options:",
    "  --state-dir DIR       Durable run state root (required)",
    "  --artifact-dir DIR   Content-addressed artifact root (required)",
    "  --apply               Apply prune candidates (prune is dry-run by default)",
    "  --run-id ID           Run ID for pin/unpin",
    "  --now ISO             Deterministic inspection time (for maintenance tooling)",
    "  --board-max-per-session N  Maximum immutable session Boards to retain",
  ].join("\n");
}

class StorageUsageError extends Error {}

function fail(message: string): never {
  throw new StorageUsageError(message);
}

function parse(args: readonly string[]): Parsed {
  const command = args[0];
  if (command !== "status" && command !== "prune" && command !== "pin" && command !== "unpin") fail(`unknown storage command: ${command ?? ""}`);
  let stateDir: string | undefined;
  let artifactDir: string | undefined;
  let runId: string | undefined;
  let now: string | undefined;
  let apply = false;
  const policy: MutableRetentionPolicy = {};
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--apply") { apply = true; continue; }
    const value = args[index + 1];
    if (arg === "--state-dir" || arg === "--artifact-dir" || arg === "--run-id" || arg === "--now") {
      if (!value || value.startsWith("--")) fail(`${arg} requires a value`);
      if (arg === "--state-dir") stateDir = value;
      else if (arg === "--artifact-dir") artifactDir = value;
      else if (arg === "--run-id") runId = value;
      else {
        if (!ISO_UTC.test(value) || !Number.isFinite(Date.parse(value))) fail("--now must be a valid UTC ISO timestamp");
        now = value;
      }
      index += 1;
      continue;
    }
    if (arg === "--board-ttl-days" || arg === "--board-max-per-run" || arg === "--board-max-per-session" || arg === "--board-quota-bytes" || arg === "--canonical-run-ttl-days" || arg === "--canonical-quota-bytes" || arg === "--grace-hours") {
      if (!value || value.startsWith("--")) fail(`${arg} requires a value`);
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0) fail(`${arg} must be a non-negative number`);
      if (arg === "--board-ttl-days") policy.boardTtlMs = number * DAY_MS;
      else if (arg === "--canonical-run-ttl-days") policy.canonicalRunTtlMs = number * DAY_MS;
      else if (arg === "--grace-hours") policy.graceMs = number * HOUR_MS;
      else if (arg === "--board-max-per-run") policy.boardMaxPerRun = Math.floor(number);
      else if (arg === "--board-max-per-session") policy.boardMaxPerSession = Math.floor(number);
      else if (arg === "--board-quota-bytes") policy.boardQuotaBytes = Math.floor(number);
      else policy.canonicalQuotaBytes = Math.floor(number);
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") return fail(usage());
    if ((command === "pin" || command === "unpin") && runId === undefined && !arg.startsWith("--")) { runId = arg; continue; }
    fail(`unknown storage option: ${arg}`);
  }
  if (!stateDir || !artifactDir) fail("--state-dir and --artifact-dir are required");
  if ((command === "pin" || command === "unpin") && !runId) fail(`${command} requires RUN_ID or --run-id`);
  if ((command === "pin" || command === "unpin") && runId !== undefined && !SAFE_ID.test(runId)) fail("run ID contains unsafe characters");
  if ((command === "status" || command === "prune") && runId !== undefined) fail("--run-id is only valid for storage pin/unpin");
  if (command !== "prune" && Object.keys(policy).length > 0) fail("retention policy options are only valid for storage prune");
  if ((command === "pin" || command === "unpin") && now !== undefined) fail("--now is only valid for storage status/prune");
  if (Object.values(policy).some(value => !Number.isFinite(value))) fail("retention policy value is too large");
  if (command !== "prune" && apply) fail("--apply is only valid for storage prune");
  return { command, stateDir, artifactDir, runId, apply, now, policy };
}

function options(parsed: Parsed): StorageMaintenanceOptions {
  return {
    stateDir: parsed.stateDir,
    artifactDir: parsed.artifactDir,
    ...(parsed.now === undefined ? {} : { now: parsed.now }),
    policy: { ...DEFAULT_CACHE_RETENTION_POLICY, ...parsed.policy },
    apply: parsed.apply,
  };
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (args.some(arg => arg === "--help" || arg === "-h")) {
    process.stdout.write(`${usage()}\n`);
    return STORAGE_EXIT_CODES.OK;
  }
  let parsed: Parsed;
  try { parsed = parse(args); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return STORAGE_EXIT_CODES.USAGE;
  }
  try {
    let result: unknown;
    if (parsed.command === "status") result = await inspectStorage(options(parsed));
    else if (parsed.command === "prune") result = await pruneStorage(options(parsed));
    else result = { schemaVersion: "traceknot-storage-pins/v1", stateDir: parsed.stateDir, artifactDir: parsed.artifactDir, runId: parsed.runId, pinned: parsed.command === "pin", pins: parsed.command === "pin" ? await pinRun(parsed.stateDir, parsed.runId!) : await unpinRun(parsed.stateDir, parsed.runId!) };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return STORAGE_EXIT_CODES.OK;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return STORAGE_EXIT_CODES.INTERNAL;
  }
}

export { usage as storageUsage };
