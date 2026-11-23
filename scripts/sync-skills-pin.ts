import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const UPDATER = resolve(ROOT, "bin/traceknot-skills-update");
const DOCS = resolve(ROOT, "docs/automatic-updates.md");
const CHECK = process.argv.slice(2).includes("--check");

const pkg = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8")) as {
  devDependencies?: Record<string, string>;
};
const expected = pkg.devDependencies?.skills;
if (expected === undefined || !/^\d+\.\d+\.\d+$/u.test(expected)) {
  throw new Error(`package.json devDependencies.skills must be an exact version, got ${String(expected)}`);
}

const updaterSource = await readFile(UPDATER, "utf8");
const pinPattern = /^SKILLS_CLI_VERSION=(\S+)$/mu;
const currentPin = pinPattern.exec(updaterSource)?.[1];
if (currentPin === undefined) throw new Error(`no SKILLS_CLI_VERSION line in ${UPDATER}`);

const docsSource = await readFile(DOCS, "utf8");
const docsPattern = /`skills@(\d+\.\d+\.\d+)`/u;
const docsVersion = docsPattern.exec(docsSource)?.[1];

const drift: string[] = [];
if (currentPin !== expected) drift.push(`${UPDATER}: SKILLS_CLI_VERSION=${currentPin} != ${expected}`);
if (docsVersion !== undefined && docsVersion !== expected) drift.push(`${DOCS}: skills@${docsVersion} != ${expected}`);

if (CHECK) {
  if (drift.length > 0) {
    console.error(`Skills CLI pin drift (run: bun run sync:skills-pin)\n${drift.join("\n")}`);
    process.exit(1);
  }
  console.log(`Skills CLI pin: ${expected} (aligned)`);
  process.exit(0);
}

await writeFile(UPDATER, updaterSource.replace(pinPattern, `SKILLS_CLI_VERSION=${expected}`));
await writeFile(DOCS, docsSource.replace(docsPattern, `\`skills@${expected}\``));
console.log(`Skills CLI pin -> ${expected}${drift.length > 0 ? ` (updated ${drift.length} file(s))` : " (already aligned)"}`);
