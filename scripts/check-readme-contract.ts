import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

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
const REQUIRED_SHARED_COMMANDS = ["skill-install", "full-toolkit-install", "full-toolkit-pinned-install", "full-toolkit-uninstall", "full-toolkit-custom-uninstall", "ci"] as const;
const REQUIRED_BOUNDARIES = [
  "npx skills add Jin-Doh/traceknot --skill traceknot --global",
  "authoritative: false",
  "phase1Authorized: false",
] as const;
const REQUIRED_OPERATIONAL_LITERALS: Readonly<Record<string, readonly string[]>> = {
  "README.md": [
    "curl -fsSL https://raw.githubusercontent.com/Jin-Doh/traceknot/main/install.sh | sh",
    "curl -fsSL https://raw.githubusercontent.com/Jin-Doh/traceknot/main/uninstall.sh | sh",
    "TRACEKNOT_REF=<tag-or-commit>",
    "https://raw.githubusercontent.com/Jin-Doh/traceknot/$TRACEKNOT_REF/install.sh",
    'TRACEKNOT_REF="$TRACEKNOT_REF" sh',
    "TRACEKNOT_SKILLS_ROOT=/absolute/skills sh -s -- --prefix /absolute/path",
  ],
  "docs/automatic-updates.md": [
    "$TRACEKNOT_PREFIX/current/bin/traceknot-update",
    "$TRACEKNOT_PREFIX/bin/traceknot-update",
    '"$TRACEKNOT_UPDATE" status --prefix "$TRACEKNOT_PREFIX"',
    '"$TRACEKNOT_UPDATE" check --prefix "$TRACEKNOT_PREFIX"',
    '"$TRACEKNOT_UPDATE" apply --prefix "$TRACEKNOT_PREFIX"',
    '"$TRACEKNOT_UPDATE" disable --prefix "$TRACEKNOT_PREFIX"',
    '"$TRACEKNOT_UPDATE" enable --prefix "$TRACEKNOT_PREFIX"',
    '"$TRACEKNOT_UPDATE" rollback --prefix "$TRACEKNOT_PREFIX"',
  ],
};
const LOCALIZED_DOCUMENT_ALTERNATIVES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "README.ko.md": { "BRAND.md": "BRAND.ko.md" },
};

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
  const expectedNames = [...canonical.sharedCommands.keys()].sort();
  for (const name of REQUIRED_SHARED_COMMANDS) {
    const expected = canonical.sharedCommands.get(name);
    if (expected === undefined) throw new Error(`${canonical.path}: missing shared command ${name}`);
  }
  for (const record of records.slice(1)) {
    const actualNames = [...record.sharedCommands.keys()].sort();
    if (actualNames.join("\u0000") !== expectedNames.join("\u0000")) {
      throw new Error(`${record.path}: shared command marker set differs from ${canonical.path}`);
    }
    for (const name of expectedNames) {
      if (record.sharedCommands.get(name) !== canonical.sharedCommands.get(name)) {
        throw new Error(`${record.path}: shared command ${name} differs from ${canonical.path}`);
      }
    }
  }
}

export function checkReadmeSharedCommands(records: Array<{ path: string; content: string }>): void {
  checkSharedCommands(records.map((record) => ({
    ...record,
    sections: new Map(),
    sharedCommands: collectSharedCommands(record.content, record.path),
  })));
}

function localTargets(content: string): string[] {
  const targets: string[] = [];
  for (const match of content.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) targets.push(match[1].trim().split(/\s+["']/)[0]);
  for (const match of content.matchAll(/^[\t ]{0,3}\[[^\]\r\n]+\]:[\t ]*(?:<([^>\r\n]+)>|([^\s\r\n]+))/gm)) targets.push(match[1] ?? match[2]);
  for (const match of content.matchAll(/(?:href|src)\s*=\s*(?:(["'])(.*?)\1|([^\s"'=<>`]+))/g)) {
    targets.push(match[2] ?? match[3]);
  }
  return targets;
}

function normalizedDocumentationTargets(content: string): Set<string> {
  const targets = new Set<string>();
  for (const rawTarget of localTargets(content)) {
    if (/^(?:https?:|mailto:|data:|#)/.test(rawTarget)) continue;
    const target = rawTarget.split("#", 1)[0].split("?", 1)[0].replace(/^<|>$/g, "");
    if (target.startsWith("docs/") || target.startsWith("skill/") || /^BRAND(?:\.[a-z-]+)?\.md$/i.test(target)) {
      targets.add(target);
    }
  }
  return targets;
}

export function checkReadmeDocumentationLinks(
  canonicalPath: string,
  canonicalContent: string,
  translatedPath: string,
  translatedContent: string,
): void {
  const canonicalTargets = normalizedDocumentationTargets(canonicalContent);
  const actualTargets = normalizedDocumentationTargets(translatedContent);
  const alternatives = LOCALIZED_DOCUMENT_ALTERNATIVES[translatedPath] ?? {};
  const missing = [...canonicalTargets]
    .map((target) => alternatives[target] ?? target)
    .filter((target) => !actualTargets.has(target));
  if (missing.length > 0) {
    throw new Error(`${translatedPath}: missing documentation links from ${canonicalPath}: ${missing.join(", ")}`);
  }
}

function remainsInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

export function checkReadmeLocalLinks(record: Pick<ReadmeRecord, "path" | "content">): void {
  const canonicalRoot = realpathSync(ROOT);
  for (const rawTarget of localTargets(record.content)) {
    if (/^(?:https?:|mailto:|data:|#)/.test(rawTarget)) continue;
    const withoutAnchor = rawTarget.split("#", 1)[0].split("?", 1)[0];
    if (!withoutAnchor) continue;
    const decoded = decodeURIComponent(withoutAnchor.replace(/^<|>$/g, ""));
    const target = resolve(ROOT, dirname(record.path), decoded);
    if (!remainsInside(ROOT, target)) throw new Error(`${record.path}: local link escapes repository: ${rawTarget}`);
    if (!existsSync(target)) throw new Error(`${record.path}: local link does not exist: ${rawTarget}`);
    if (!remainsInside(canonicalRoot, realpathSync(target))) throw new Error(`${record.path}: local link escapes repository: ${rawTarget}`);
    const stat = statSync(target);
    if (!stat.isFile() && !stat.isDirectory()) throw new Error(`${record.path}: local link is not a file or directory: ${rawTarget}`);
  }
}

export function checkPublicationInventory(config: { include?: unknown; exclude?: unknown }): void {
  if (!Array.isArray(config.include) || config.include.length !== 1 || config.include[0] !== "**/*.md") {
    throw new Error("prose-quality.config.json: repository publication coverage must remain **/*.md");
  }
  if (!Array.isArray(config.exclude) || config.exclude.length !== 0) {
    throw new Error("prose-quality.config.json: repository publication coverage cannot exclude Markdown files");
  }
}

function checkPublicationContracts(): void {
  const config = JSON.parse(readFileSync(resolve(ROOT, "prose-quality.config.json"), "utf8")) as { include?: unknown; exclude?: unknown };
  checkPublicationInventory(config);
  for (const [path, literals] of Object.entries(REQUIRED_OPERATIONAL_LITERALS)) {
    const content = readFileSync(resolve(ROOT, path), "utf8");
    const missing = literals.filter((literal) => !content.includes(literal));
    if (missing.length > 0) throw new Error(`${path}: missing operational contract literals: ${missing.join(", ")}`);
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
  for (const record of records.slice(1)) {
    checkReadmeDocumentationLinks(records[0].path, records[0].content, record.path, record.content);
  }
  for (const path of LINKED_DOCUMENT_PATHS) {
    const content = readFileSync(resolve(ROOT, path), "utf8");
    checkReadmeLocalLinks({ path, content });
  }
  checkPublicationContracts();
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
