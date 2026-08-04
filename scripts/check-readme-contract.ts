import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const README_PATHS = ["README.md", "README.ko.md", "README.zh.md"] as const;
const LINKED_DOCUMENT_PATHS = [
  ...README_PATHS,
  "BRAND.md",
  "BRAND.ko.md",
  "assets/readme/README.md",
  "docs/architecture.md",
  "docs/automatic-updates.md",
  "docs/localization.md",
  "docs/qa-process.md",
  "docs/security-analysis.md",
  "docs/trust-model.md",
] as const;
const REQUIRED_SECTIONS = [
  "hero",
  "quick-start",
  "why",
  "outputs",
  "process",
  "status",
  "install",
  "documentation",
  "development",
] as const;
const REQUIRED_SHARED_COMMANDS = ["skill-install", "full-toolkit-install", "ci"] as const;
const REQUIRED_BOUNDARIES = [
  "npx skills add Jin-Doh/traceknot --skill traceknot --global",
  "authoritative: false",
  "phase1Authorized: false",
] as const;

interface ReadmeRecord {
  path: string;
  content: string;
  sections: Map<string, number>;
  sharedCommands: Map<string, string>;
}

function collectMarkers(content: string, pattern: RegExp): Map<string, number> {
  const markers = new Map<string, number>();
  for (const match of content.matchAll(pattern)) {
    const name = match[1];
    markers.set(name, (markers.get(name) ?? 0) + 1);
  }
  return markers;
}

function collectSharedCommands(content: string, path: string): Map<string, string> {
  const commands = new Map<string, string>();
  const pattern = /<!-- shared-command:([a-z0-9-]+) -->\s*\n+```[^\n]*\n([\s\S]*?)\n```/g;
  for (const match of content.matchAll(pattern)) {
    const name = match[1];
    if (commands.has(name)) throw new Error(`${path}: duplicate shared-command marker ${name}`);
    commands.set(name, match[2]);
  }
  return commands;
}

function loadReadmes(): ReadmeRecord[] {
  return README_PATHS.map((path) => {
    const absolute = resolve(ROOT, path);
    if (!existsSync(absolute)) throw new Error(`${path}: required README is missing`);
    const content = readFileSync(absolute, "utf8");
    return {
      path,
      content,
      sections: collectMarkers(content, /<!-- readme-section:([a-z0-9-]+) -->/g),
      sharedCommands: collectSharedCommands(content, path),
    };
  });
}

function checkSections(record: ReadmeRecord): void {
  for (const section of REQUIRED_SECTIONS) {
    const count = record.sections.get(section) ?? 0;
    if (count !== 1) throw new Error(`${record.path}: section ${section} must appear exactly once, found ${count}`);
  }
  const unexpected = [...record.sections.keys()].filter((section) => !REQUIRED_SECTIONS.includes(section as typeof REQUIRED_SECTIONS[number]));
  if (unexpected.length > 0) throw new Error(`${record.path}: unexpected sections: ${unexpected.join(", ")}`);
  const actualOrder = [...record.sections.keys()];
  if (actualOrder.some((section, index) => section !== REQUIRED_SECTIONS[index])) {
    throw new Error(`${record.path}: section order must be ${REQUIRED_SECTIONS.join(" -> ")}, found ${actualOrder.join(" -> ")}`);
  }
}

export function checkReadmeSections(path: string, content: string): void {
  checkSections({
    path,
    content,
    sections: collectMarkers(content, /<!-- readme-section:([a-z0-9-]+) -->/g),
    sharedCommands: new Map(),
  });
}

function checkLanguageNavigation(record: ReadmeRecord): void {
  for (const target of README_PATHS) {
    const markdownLink = `(${target})`;
    const htmlLink = `href="${target}"`;
    if (!record.content.includes(markdownLink) && !record.content.includes(htmlLink)) {
      throw new Error(`${record.path}: missing language link to ${target}`);
    }
  }
}

function checkBoundaries(record: ReadmeRecord): void {
  for (const boundary of REQUIRED_BOUNDARIES) {
    if (!record.content.includes(boundary)) throw new Error(`${record.path}: missing public boundary literal ${boundary}`);
  }
}

function checkSharedCommands(records: ReadmeRecord[]): void {
  const canonical = records[0];
  for (const name of REQUIRED_SHARED_COMMANDS) {
    const expected = canonical.sharedCommands.get(name);
    if (expected === undefined) throw new Error(`${canonical.path}: missing shared command ${name}`);
    for (const record of records.slice(1)) {
      const actual = record.sharedCommands.get(name);
      if (actual === undefined) throw new Error(`${record.path}: missing shared command ${name}`);
      if (actual !== expected) throw new Error(`${record.path}: shared command ${name} differs from ${canonical.path}`);
    }
  }
}

function localTargets(content: string): string[] {
  const targets: string[] = [];
  for (const match of content.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) targets.push(match[1].trim().split(/\s+["']/)[0]);
  for (const match of content.matchAll(/(?:href|src)="([^"]+)"/g)) targets.push(match[1]);
  return targets;
}

function checkLocalLinks(record: Pick<ReadmeRecord, "path" | "content">): void {
  for (const rawTarget of localTargets(record.content)) {
    if (/^(?:https?:|mailto:|data:|#)/.test(rawTarget)) continue;
    const withoutAnchor = rawTarget.split("#", 1)[0].split("?", 1)[0];
    if (!withoutAnchor) continue;
    const decoded = decodeURIComponent(withoutAnchor.replace(/^<|>$/g, ""));
    const target = resolve(ROOT, dirname(record.path), decoded);
    if (!existsSync(target)) throw new Error(`${record.path}: local link does not exist: ${rawTarget}`);
    const stat = statSync(target);
    if (!stat.isFile() && !stat.isDirectory()) throw new Error(`${record.path}: local link is not a file or directory: ${rawTarget}`);
  }
}

export function checkReadmeContract(): void {
  const records = loadReadmes();
  for (const record of records) {
    checkSections(record);
    checkLanguageNavigation(record);
    checkBoundaries(record);
  }
  checkSharedCommands(records);
  for (const path of LINKED_DOCUMENT_PATHS) {
    const content = readFileSync(resolve(ROOT, path), "utf8");
    checkLocalLinks({ path, content });
  }
}

if (import.meta.main) {
  try {
    checkReadmeContract();
    console.log(`README contract: PASS (${README_PATHS.length} languages, ${REQUIRED_SECTIONS.length} sections, ${REQUIRED_SHARED_COMMANDS.length} shared commands, ${LINKED_DOCUMENT_PATHS.length} linked documents)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`README contract: FAIL: ${message}`);
    process.exitCode = 1;
  }
}
