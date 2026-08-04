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
  const markers = collectMarkers(content, /<!-- shared-command:([a-z0-9-]+) -->/g);
  for (const [name, count] of markers) {
    if (count !== 1) throw new Error(`${path}: shared-command marker ${name} must appear exactly once, found ${count}`);
  }
  const commands = new Map<string, string>();
  const markerPattern = /<!-- shared-command:([a-z0-9-]+) -->/g;
  for (const match of content.matchAll(markerPattern)) {
    const name = match[1];
    const afterMarker = content.slice((match.index ?? 0) + match[0].length);
    const opening = afterMarker.match(/^[\t ]*(?:\r?\n[\t ]*)+(`{3,}|~{3,})([^\r\n]*)\r?\n/u);
    if (!opening) continue;
    const fence = opening[1];
    if (fence[0] === "`" && opening[2].includes("`")) continue;
    const commandStart = (match.index ?? 0) + match[0].length + opening[0].length;
    const closingPattern = new RegExp(`^[\\t ]{0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[\\t ]*$`, "gmu");
    closingPattern.lastIndex = commandStart;
    const closing = closingPattern.exec(content);
    if (!closing) continue;
    commands.set(name, content.slice(commandStart, closing.index).replace(/\r?\n$/, ""));
  }
  for (const name of markers.keys()) {
    if (!commands.has(name)) throw new Error(`${path}: shared-command marker ${name} must be followed by a fenced block`);
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
  const visibleTargets = new Set(localTargets(record.content).map((target) => target.split(/[?#]/, 1)[0]));
  for (const target of README_PATHS) {
    if (!visibleTargets.has(target)) {
      throw new Error(`${record.path}: missing language link to ${target}`);
    }
  }
}

export function checkReadmeLanguageNavigation(path: string, content: string): void {
  checkLanguageNavigation({ path, content, sections: new Map(), sharedCommands: new Map() });
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

function isEscaped(content: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && content[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function stripMarkdownContainerPrefix(value: string): string {
  let remaining = value;
  while (true) {
    const marker = remaining.match(/^[\t ]{0,3}(?:>[	 ]?|(?:[-+*]|\d+[.)])[	 ]+)/u)?.[0];
    if (!marker) return remaining;
    remaining = remaining.slice(marker.length);
  }
}

function markdownBlockquoteDepth(value: string): number {
  const content = stripMarkdownContainerPrefix(value);
  return (value.slice(0, value.length - content.length).match(/>/g) ?? []).length;
}

function maskMarkdownCode(content: string): string {
  const masked = content.split("");
  const lines = content.match(/.*(?:\r?\n|$)/g) ?? [];
  let offset = 0;
  let fence: { marker: string; length: number; blockquoteDepth: number } | undefined;
  let indentedCode = false;
  let canStartIndentedCode = true;
  const mask = (start: number, end: number) => {
    for (let index = start; index < end; index += 1) {
      if (masked[index] !== "\n" && masked[index] !== "\r") masked[index] = " ";
    }
  };
  for (const line of lines) {
    if (!line) continue;
    const body = line.replace(/\r?\n$/, "");
    const containerBody = stripMarkdownContainerPrefix(body);
    const blockquoteDepth = markdownBlockquoteDepth(body);
    const blank = /^[\t ]*$/u.test(containerBody);
    if (fence && blockquoteDepth < fence.blockquoteDepth) fence = undefined;
    if (fence) {
      mask(offset, offset + body.length);
      const close = containerBody.match(/^[\t ]{0,3}(`+|~+)[\t ]*$/u)?.[1];
      const closed = close?.[0] === fence.marker && close.length >= fence.length;
      if (closed) fence = undefined;
      offset += line.length;
      canStartIndentedCode = Boolean(closed);
      continue;
    }
    const opening = containerBody.match(/^[\t ]{0,3}(`{3,}|~{3,})/u)?.[1];
    if (opening) {
      fence = { marker: opening[0], length: opening.length, blockquoteDepth };
      mask(offset, offset + body.length);
      offset += line.length;
      indentedCode = false;
      canStartIndentedCode = false;
      continue;
    }
    if (/^(?: {4}|\t)/u.test(containerBody) && (indentedCode || canStartIndentedCode)) {
      mask(offset, offset + body.length);
      offset += line.length;
      indentedCode = true;
      canStartIndentedCode = true;
      continue;
    }
    if (!blank) indentedCode = false;
    offset += line.length;
    canStartIndentedCode = blank || /^(?:#{1,6}(?:[\t ]|$)|(?:[-*_][\t ]*){3,}$|<\/?[A-Za-z][^>]*>[\t ]*$)/u.test(containerBody);
  }
  let visible = masked.join("");
  for (let cursor = 0; cursor < visible.length;) {
    if (visible[cursor] !== "`" || isEscaped(visible, cursor)) {
      cursor += 1;
      continue;
    }
    let runEnd = cursor + 1;
    while (visible[runEnd] === "`") runEnd += 1;
    const run = visible.slice(cursor, runEnd);
    let close = visible.indexOf(run, runEnd);
    while (close >= 0 && (visible[close - 1] === "`" || visible[close + run.length] === "`")) {
      close = visible.indexOf(run, close + run.length);
    }
    if (close < 0) {
      cursor = runEnd;
      continue;
    }
    mask(cursor, close + run.length);
    visible = masked.join("");
    cursor = close + run.length;
  }
  return visible.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\r\n]/g, " "));
}

function srcsetTargets(value: string): string[] {
  const targets: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    while (/[\s,]/u.test(value[cursor] ?? "")) cursor += 1;
    const start = cursor;
    while (cursor < value.length && !/\s/u.test(value[cursor])) cursor += 1;
    const rawTarget = value.slice(start, cursor);
    const target = rawTarget.replace(/,+$/, "");
    if (target) targets.push(target);
    if (rawTarget.endsWith(",")) continue;
    while (cursor < value.length && value[cursor] !== ",") cursor += 1;
    if (value[cursor] === ",") cursor += 1;
  }
  return targets;
}

function visibleHtmlTags(content: string): string[] {
  const tags: string[] = [];
  for (let start = content.indexOf("<"); start >= 0; start = content.indexOf("<", start + 1)) {
    if (!/^\/?[A-Za-z]/u.test(content.slice(start + 1, start + 3))) continue;
    let quote = "";
    let cursor = start + 1;
    for (; cursor < content.length; cursor += 1) {
      const character = content[cursor];
      if (quote) {
        if (character === quote) quote = "";
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        tags.push(content.slice(start, cursor + 1));
        break;
      } else if (character === "<") {
        break;
      }
    }
    if (cursor > start) start = cursor;
  }
  return tags;
}

function localTargets(content: string): string[] {
  content = maskMarkdownCode(content);
  const targets: string[] = [];
  for (let opener = content.indexOf("["); opener >= 0; opener = content.indexOf("[", opener + 1)) {
    if (isEscaped(content, opener)) continue;
    let cursor = opener + 1;
    let labelDepth = 1;
    while (cursor < content.length && labelDepth > 0) {
      if (isEscaped(content, cursor)) {
        cursor += 1;
      } else if (content[cursor] === "[") {
        labelDepth += 1;
      } else if (content[cursor] === "]") {
        labelDepth -= 1;
      }
      cursor += 1;
    }
    if (labelDepth !== 0 || content[cursor] !== "(") continue;
    cursor += 1;
    while (/\s/.test(content[cursor] ?? "")) cursor += 1;
    if (content[cursor] === "<") {
      const end = content.indexOf(">", cursor + 1);
      if (end > cursor + 1) targets.push(content.slice(cursor + 1, end));
      continue;
    }
    const start = cursor;
    let depth = 0;
    while (cursor < content.length) {
      const character = content[cursor];
      if (character === "\\") {
        cursor += 2;
        continue;
      }
      if (character === "(") depth += 1;
      else if (character === ")") {
        if (depth === 0) break;
        depth -= 1;
      } else if (/\s/.test(character) && depth === 0) break;
      cursor += 1;
    }
    if (cursor > start) targets.push(content.slice(start, cursor).replace(/\\([()])/g, "$1"));
  }
  for (const match of content.matchAll(/^[\t ]{0,3}\[[^\]\r\n]+\]:[\t ]*(?:\r?\n[\t ]+)?(?:<([^>\r\n]+)>|([^\s\r\n]+))/gm)) targets.push(match[1] ?? match[2]);
  for (const tag of visibleHtmlTags(content)) {
    for (const match of tag.matchAll(/\s(href|src|poster|action|formaction|cite|data|background|manifest|profile|longdesc|usemap|srcset|ping)\s*=\s*(?:(["'])(.*?)\2|([^\s"'=<>`]+))/gi)) {
      const attribute = match[1].toLowerCase();
      const value = match[3] ?? match[4];
      if (attribute === "srcset") {
        targets.push(...srcsetTargets(value));
      } else if (attribute === "ping") {
        targets.push(...value.trim().split(/\s+/).filter(Boolean));
      } else {
        targets.push(value);
      }
    }
  }
  return targets;
}

function isExternalTarget(target: string): boolean {
  return target.startsWith("#") || target.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target);
}

function normalizedDocumentationTargets(content: string): Set<string> {
  const targets = new Set<string>();
  for (const rawTarget of localTargets(content)) {
    if (isExternalTarget(rawTarget)) continue;
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
    if (isExternalTarget(rawTarget)) continue;
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
