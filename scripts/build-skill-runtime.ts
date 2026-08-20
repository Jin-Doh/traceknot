import { chmod, cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SOURCE = resolve(ROOT, "bin/traceknot");
const OUTPUT = resolve(ROOT, "skill/bin/traceknot");
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
    const source = await readFile(SOURCE, "utf8");
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

async function checkDrift(entries: readonly Mirror[]): Promise<void> {
  let expected: Buffer;
  try {
    expected = await readFile(OUTPUT);
  } catch {
    throw new Error(`generated Skill runtime is missing: ${OUTPUT}; run bun run build:skill-runtime`);
  }
  const temporaryRoot = await mkdtemp(join(tmpdir(), "traceknot-skill-runtime-"));
  const temporaryOutput = join(temporaryRoot, "traceknot");
  try {
    await buildBundle(temporaryOutput);
    const actual = await readFile(temporaryOutput);
    if (!expected.equals(actual)) {
      throw new Error(`generated Skill runtime is out of date: ${OUTPUT}; run bun run build:skill-runtime`);
    }
    const mode = (await Bun.file(OUTPUT).stat()).mode & 0o777;
    if ((mode & 0o111) === 0) throw new Error(`generated Skill runtime is not executable: ${OUTPUT}`);
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
  await buildBundle(OUTPUT);
  await syncMirrors(entries);
  console.log(`Built executable Skill runtime and ${entries.length} generated Skill mirrors`);
}
