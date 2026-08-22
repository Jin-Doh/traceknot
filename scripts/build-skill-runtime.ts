import { chmod, cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const RUNTIME_SOURCE = resolve(ROOT, "bin/traceknot");
const RUNTIME_OUTPUT = resolve(ROOT, "skill/bin/traceknot");
const UPDATER_SOURCE = resolve(ROOT, "bin/traceknot-skills-update");
const UPDATER_OUTPUT = resolve(ROOT, "skill/bin/traceknot-skills-update");
const UPDATE_NOTICE_SOURCE = resolve(ROOT, "bin/traceknot-update-notice");
const UPDATE_NOTICE_OUTPUT = resolve(ROOT, "skill/bin/traceknot-update-notice");
const CHECK = process.argv.slice(2).includes("--check");

type Mirror = Readonly<{ source: string; target: string; relative: string }>;

async function mirrors(): Promise<readonly Mirror[]> {
  const contractRoot = resolve(ROOT, "contracts");
  const adapterRoot = resolve(ROOT, "adapters");
  const contractEntries = (await readdir(contractRoot, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith(".schema.json"))
    .map(entry => ({
      source: resolve(contractRoot, entry.name),
      target: resolve(ROOT, "skill/contracts", entry.name),
      relative: `contracts/${entry.name}`,
    }));
  const adapterEntries: Mirror[] = [];
  const adapterHosts = (await readdir(adapterRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  for (const host of adapterHosts) {
    const source = resolve(adapterRoot, host, "capability.json");
    try {
      if (!(await stat(source)).isFile()) continue;
    } catch {
      continue;
    }
    adapterEntries.push({
      source,
      target: resolve(ROOT, "skill/adapters", host, "capability.json"),
      relative: `adapters/${host}/capability.json`,
    });
  }
  return [...contractEntries, ...adapterEntries].sort((a, b) => a.relative.localeCompare(b.relative));
}

async function buildBundle(output: string): Promise<void> {
  const buildEntry = resolve(ROOT, "bin/.traceknot-skill-runtime-entry.ts");
  const bundleRoot = await mkdtemp(join(tmpdir(), "traceknot-skill-bundle-"));
  try {
    const source = await readFile(RUNTIME_SOURCE, "utf8");
    await rm(buildEntry, { force: true });
    await writeFile(buildEntry, source.replace(/^#![^\n]*\n/u, ""));
    const result = await Bun.build({
      entrypoints: [buildEntry],
      target: "bun",
      minify: true,
      sourcemap: "none",
      splitting: false,
      outdir: bundleRoot,
    });
    if (!result.success) {
      const details = result.logs.map(log => log.message).join("\n");
      throw new Error(`Skill runtime build failed${details ? `:\n${details}` : ""}`);
    }
    const bundleOutput = result.outputs.find(candidate => candidate.path.endsWith(".js"))?.path;
    if (bundleOutput === undefined) throw new Error("Skill runtime build produced no JavaScript bundle");
    const bundle = await readFile(bundleOutput);
    await writeFile(output, Buffer.concat([Buffer.from("#!/usr/bin/env bun\n"), bundle]));
    await chmod(output, 0o755);
  } finally {
    await rm(buildEntry, { force: true });
    await rm(bundleRoot, { recursive: true, force: true });
  }
}

async function syncUpdater(): Promise<void> {
  await cp(UPDATER_SOURCE, UPDATER_OUTPUT, { preserveTimestamps: false });
  await chmod(UPDATER_OUTPUT, 0o755);
}

async function syncUpdateNotice(): Promise<void> {
  await cp(UPDATE_NOTICE_SOURCE, UPDATE_NOTICE_OUTPUT, { preserveTimestamps: false });
  await chmod(UPDATE_NOTICE_OUTPUT, 0o644);
}

async function syncMirrors(entries: readonly Mirror[]): Promise<void> {
  await rm(resolve(ROOT, "skill/contracts"), { recursive: true, force: true });
  await rm(resolve(ROOT, "skill/adapters"), { recursive: true, force: true });
  await mkdir(resolve(ROOT, "skill/contracts"), { recursive: true });
  await mkdir(resolve(ROOT, "skill/adapters"), { recursive: true });
  for (const entry of entries) {
    await mkdir(resolve(entry.target, ".."), { recursive: true });
    await cp(entry.source, entry.target, { preserveTimestamps: false });
  }
}

async function checkMirrors(entries: readonly Mirror[]): Promise<void> {
  const expected = new Set(entries.map(entry => entry.relative));
  const actual = new Set<string>();
  async function collect(root: string, prefix: string): Promise<void> {
    let directoryEntries;
    try {
      directoryEntries = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of directoryEntries) {
      const path = resolve(root, entry.name);
      const relativePath = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await collect(path, relativePath);
      else actual.add(relativePath);
    }
  }
  await collect(resolve(ROOT, "skill/contracts"), "contracts");
  await collect(resolve(ROOT, "skill/adapters"), "adapters");
  const missing = [...expected].filter(path => !actual.has(path));
  const extra = [...actual].filter(path => !expected.has(path));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`generated Skill mirrors differ (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`);
  }
  for (const entry of entries) {
    const [source, target] = await Promise.all([readFile(entry.source), readFile(entry.target)]);
    if (!source.equals(target)) throw new Error(`generated Skill mirror is out of date: skill/${entry.relative}`);
  }
}

async function assertExecutable(path: string): Promise<void> {
  const mode = (await stat(path)).mode & 0o777;
  if ((mode & 0o111) === 0) throw new Error(`generated Skill executable is not executable: ${path}`);
}

async function assertNonExecutable(path: string): Promise<void> {
  const mode = (await stat(path)).mode & 0o777;
  if ((mode & 0o111) !== 0) throw new Error(`generated Skill maintenance script must remain non-executable: ${path}`);
}

async function checkDrift(entries: readonly Mirror[]): Promise<void> {
  let expectedRuntime: Buffer;
  let expectedUpdater: Buffer;
  let expectedUpdateNotice: Buffer;
  try {
    [expectedRuntime, expectedUpdater, expectedUpdateNotice] = await Promise.all([
      readFile(RUNTIME_OUTPUT),
      readFile(UPDATER_OUTPUT),
      readFile(UPDATE_NOTICE_OUTPUT),
    ]);
  } catch {
    throw new Error("generated Skill runtime assets are missing; run bun run build:skill-runtime");
  }
  const temporaryRoot = await mkdtemp(join(tmpdir(), "traceknot-skill-runtime-"));
  const temporaryRuntime = join(temporaryRoot, "traceknot");
  try {
    await buildBundle(temporaryRuntime);
    const [actualRuntime, updaterSource, updateNoticeSource] = await Promise.all([
      readFile(temporaryRuntime),
      readFile(UPDATER_SOURCE),
      readFile(UPDATE_NOTICE_SOURCE),
    ]);
    if (!expectedRuntime.equals(actualRuntime)) {
      throw new Error(`generated Skill runtime is out of date: ${RUNTIME_OUTPUT}; run bun run build:skill-runtime`);
    }
    if (!expectedUpdater.equals(updaterSource)) {
      throw new Error(`generated Skills updater is out of date: ${UPDATER_OUTPUT}; run bun run build:skill-runtime`);
    }
    if (!expectedUpdateNotice.equals(updateNoticeSource)) {
      throw new Error(`generated update advisory is out of date: ${UPDATE_NOTICE_OUTPUT}; run bun run build:skill-runtime`);
    }
    await Promise.all([
      assertExecutable(RUNTIME_OUTPUT),
      assertExecutable(UPDATER_OUTPUT),
      assertNonExecutable(UPDATE_NOTICE_OUTPUT),
    ]);
    await checkMirrors(entries);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

const entries = await mirrors();
if (CHECK) {
  await checkDrift(entries);
  console.log("Skill runtime drift check: PASS");
} else {
  await mkdir(resolve(ROOT, "skill/bin"), { recursive: true });
  await buildBundle(RUNTIME_OUTPUT);
  await syncUpdater();
  await syncUpdateNotice();
  await syncMirrors(entries);
  console.log(`Built Skill runtime, Skills updater, update advisory, and ${entries.length} generated Skill mirrors`);
}
