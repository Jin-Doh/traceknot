import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseSessionBoardUpdate } from "../presentation/qa-board-store";
import { renderQaBoardHtml, type QaBoardView } from "../presentation/qa-board";

export const SELF_CHECK_EXIT_CODES = Object.freeze({ OK: 0, USAGE: 64, INTERNAL: 70 });

const REQUIRED_CONTRACTS = Object.freeze([
  "qa-board-manifest.schema.json",
  "qa-board-view.schema.json",
  "traceknot-session-board-current.schema.json",
  "traceknot-session-board-update.schema.json",
]);
const REQUIRED_ADAPTERS = Object.freeze(["claude-code", "codex", "gajae-code", "omp", "opencode"]);
const MINIMUM_BUN_VERSION = Object.freeze([1, 3, 14] as const);

function usage(): string {
  return "traceknot self-check [--help]";
}

function versionParts(version: string): readonly number[] {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  if (match === null) throw new Error(`unsupported Bun version: ${version}`);
  return match.slice(1).map(Number);
}

function assertSupportedBun(version: string): void {
  const actual = versionParts(version);
  for (let index = 0; index < MINIMUM_BUN_VERSION.length; index += 1) {
    if (actual[index]! > MINIMUM_BUN_VERSION[index]!) return;
    if (actual[index]! < MINIMUM_BUN_VERSION[index]!) {
      throw new Error(`Bun ${MINIMUM_BUN_VERSION.join(".")} or later is required; found ${version}`);
    }
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`invalid required JSON ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function resolveSkillRoot(executablePath: string): Promise<string> {
  const executable = await realpath(resolve(executablePath));
  const binDirectory = dirname(executable);
  if (basename(binDirectory) !== "bin") throw new Error(`runtime is not inside a Skill bin directory: ${executable}`);
  const root = dirname(binDirectory);
  const skill = await stat(join(root, "SKILL.md"));
  if (!skill.isFile()) throw new Error(`required Skill entrypoint is not a file: ${join(root, "SKILL.md")}`);
  return root;
}

function selfCheckView(): QaBoardView {
  return {
    runId: "self-check",
    requestId: "self-check",
    rootIdentity: "self-check",
    snapshotId: "self-check",
    revision: 1,
    sourceState: "TERMINAL",
    sourceUpdatedAt: "2026-01-01T00:00:00Z",
    changeSummary: "installed runtime self-check",
    assurance: { context: "local", requiredIndependence: "separate-verification-context", releaseStatus: "not-evaluated" },
    verdict: "PASS",
    authoritative: false,
    rationale: "renderer availability probe",
    counts: { mandatory: 0, passed: 0, failed: 0, blocked: 0, incomplete: 0 },
    findings: [],
    coverage: {
      basis: { total: 0, covered: 0, uncoveredIds: [] },
      risks: { total: 0, covered: 0, uncoveredIds: [] },
      conditions: { total: 0, covered: 0, uncoveredIds: [] },
      mandatoryObligations: { total: 0, covered: 0, uncoveredIds: [] },
    },
    openDefectIds: [],
    acceptedRiskIds: [],
    residualRisks: [],
  };
}

export async function runSelfCheck(
  argv: readonly string[],
  stdout: (text: string) => void = text => process.stdout.write(text),
  stderr: (text: string) => void = text => process.stderr.write(text),
  executablePath = process.argv[1] ?? "",
  bunVersion = Bun.version,
  platform = process.platform,
): Promise<number> {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--help" && argv[0] !== "-h")) {
    stderr(`unknown self-check option: ${argv[0] ?? ""}\n${usage()}\n`);
    return SELF_CHECK_EXIT_CODES.USAGE;
  }
  if (argv.length === 1) {
    stdout(`${usage()}\n`);
    return SELF_CHECK_EXIT_CODES.OK;
  }

  try {
    assertSupportedBun(bunVersion);
    if (platform !== "darwin" && platform !== "linux") throw new Error(`installed runtime is unsupported on platform: ${platform}`);
    const root = await resolveSkillRoot(executablePath);
    for (const contract of REQUIRED_CONTRACTS) await readJson(join(root, "contracts", contract));
    for (const adapter of REQUIRED_ADAPTERS) await readJson(join(root, "adapters", adapter, "capability.json"));

    const view = selfCheckView();
    const update = parseSessionBoardUpdate({
      schemaVersion: "traceknot-session-board-update/v1",
      sessionId: "self-check",
      sessionHost: "installed-runtime",
      generatedAt: "2026-01-01T00:00:00Z",
      invocationId: "self-check",
      view,
    });
    const html = renderQaBoardHtml(update.view, "en", { showProjectSupport: false });
    if (!html.startsWith("<!doctype html>") || !html.includes("Content-Security-Policy")) {
      throw new Error("Board renderer probe produced an invalid page");
    }

    stdout(`Traceknot self-check: PASS\nSkill root: ${root}\nContracts: ${REQUIRED_CONTRACTS.length}\nAdapters: ${REQUIRED_ADAPTERS.length}\n`);
    return SELF_CHECK_EXIT_CODES.OK;
  } catch (error) {
    stderr(`Traceknot self-check: FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    return SELF_CHECK_EXIT_CODES.INTERNAL;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  return runSelfCheck(argv);
}

if (import.meta.main) process.exit(await main());
