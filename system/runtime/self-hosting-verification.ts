import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { VerificationRequest } from "./verification-run";

export type SelfHostingCommand = Readonly<{
  rootDir: string;
  executable: string;
  argv: readonly string[];
}>;
export type SelfHostingManifest = Readonly<{
  schemaVersion: "verification-manifest/v1";
  obligations: readonly Readonly<{
    id: string;
    executable: string;
    argv: readonly string[];
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
    toolVersion: string;
  }>[];
}>;
export type SelfHostingReport = Readonly<{
  schemaVersion: "traceknot-cli-report/v1";
  run: Readonly<Record<string, unknown>>;
  verdict: Readonly<Record<string, unknown>>;
  snapshot: Readonly<Record<string, unknown>>;
  documents?: unknown;
}>;
export type SelfHostingResult = Readonly<{
  executed: SelfHostingReport;
  reportOnly: SelfHostingReport;
}>;

const REQUEST_ID = "traceknot-self-hosting";

export function buildCanonicalSelfHostingCommand(
  root: string,
  bunExecutable = process.execPath,
  ghExecutable = Bun.which("gh"),
): SelfHostingCommand {
  const rootDir = resolve(root);
  if (!isAbsolute(bunExecutable)) throw Error("self-hosting Bun executable must be absolute");
  if (!ghExecutable || !isAbsolute(ghExecutable)) throw Error("self-hosting requires an absolute GitHub CLI executable");
  const path = [...new Set([
    dirname(bunExecutable),
    dirname(ghExecutable),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ])].join(":");
  return Object.freeze({
    rootDir,
    executable: "/usr/bin/env",
    argv: Object.freeze([
      `PATH=${path}`,
      "/bin/sh",
      join(rootDir, "scripts/ci"),
      "--self-hosted-inner",
    ]),
  });
}

export function buildSelfHostingInputs(command: SelfHostingCommand): Readonly<{
  request: VerificationRequest;
  manifest: SelfHostingManifest;
}> {
  const rootDir = resolve(command.rootDir);
  if (!isAbsolute(command.executable)) throw Error("self-hosting executable must be absolute");
  const request: VerificationRequest = Object.freeze({
    schemaVersion: "verification-request/v1",
    requestId: REQUEST_ID,
    project: Object.freeze({ rootIdentity: "auto", snapshotId: "auto" }),
    change: Object.freeze({
      summary: "Verify Traceknot with its canonical repository gate.",
      paths: Object.freeze([".github/workflows/ci.yml", "scripts/ci", "system/cli/verify.ts"]),
    }),
    testBasis: Object.freeze([Object.freeze({
      id: "canonical-gate",
      kind: "acceptance-criterion",
      origin: "explicit",
      text: "The canonical repository gate passes against the immutable target snapshot.",
    })]),
  });
  const manifest: SelfHostingManifest = Object.freeze({
    schemaVersion: "verification-manifest/v1",
    obligations: Object.freeze([Object.freeze({
      id: "obligation:condition:canonical-gate",
      executable: command.executable,
      argv: Object.freeze([...command.argv]),
      cwd: rootDir,
      timeoutMs: 600_000,
      maxOutputBytes: 4 * 1024 * 1024,
      toolVersion: `bun-${Bun.version}`,
    })]),
  });
  return Object.freeze({ request, manifest });
}

function parseReport(value: string, label: string): SelfHostingReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw Error(`${label} did not emit a JSON report`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Error(`${label} report must be an object`);
  const report = parsed as Partial<SelfHostingReport>;
  if (
    report.schemaVersion !== "traceknot-cli-report/v1"
    || !report.run || typeof report.run !== "object"
    || !report.verdict || typeof report.verdict !== "object"
    || !report.snapshot || typeof report.snapshot !== "object"
  ) throw Error(`${label} emitted an invalid report`);
  return report as SelfHostingReport;
}

async function runCli(
  executable: string,
  rootDir: string,
  args: readonly string[],
  label: string,
): Promise<SelfHostingReport> {
  const child = Bun.spawn([executable, "verify", ...args], {
    cwd: rootDir,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
    throw Error(`${label} failed with exit ${exitCode}${details ? `:\n${details}` : ""}`);
  }
  return parseReport(stdout, label);
}

export async function runSelfHostingVerification(
  command: SelfHostingCommand,
  traceknotExecutable = resolve(dirname(fileURLToPath(import.meta.url)), "../../bin/traceknot"),
): Promise<SelfHostingResult> {
  if (!isAbsolute(traceknotExecutable)) throw Error("Traceknot executable must be absolute");
  const inputs = buildSelfHostingInputs(command);
  const workspace = await mkdtemp(join(tmpdir(), "traceknot-self-hosting."));
  const requestPath = join(workspace, "request.json");
  const manifestPath = join(workspace, "manifest.json");
  const stateDir = join(workspace, "state");
  const artifactDir = join(workspace, "artifacts");
  try {
    await Promise.all([
      writeFile(requestPath, `${JSON.stringify(inputs.request)}\n`, { mode: 0o600 }),
      writeFile(manifestPath, `${JSON.stringify(inputs.manifest)}\n`, { mode: 0o600 }),
    ]);
    const common = ["--root", resolve(command.rootDir), "--state-dir", stateDir, "--artifact-dir", artifactDir];
    const executed = await runCli(traceknotExecutable, command.rootDir, [
      ...common,
      "--request", requestPath,
      "--manifest", manifestPath,
    ], "self-hosting execution");
    const reportOnly = await runCli(traceknotExecutable, command.rootDir, [
      ...common,
      "--run-id", REQUEST_ID,
      "--report-only",
    ], "self-hosting report-only");
    if (executed.run.state !== "TERMINAL" || executed.verdict.qaVerdict !== "PASS") {
      throw Error("self-hosting verification did not reach TERMINAL/PASS");
    }
    for (const field of ["runId", "requestId", "rootIdentity", "snapshotId", "state"] as const) {
      if (executed.run[field] !== reportOnly.run[field]) throw Error(`self-hosting report-only ${field} does not match the executed run`);
    }
    if (
      executed.verdict.qaVerdict !== reportOnly.verdict.qaVerdict
      || JSON.stringify(executed.snapshot) !== JSON.stringify(reportOnly.snapshot)
    ) throw Error("self-hosting report-only verdict or snapshot does not match the executed run");
    return Object.freeze({ executed, reportOnly });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
