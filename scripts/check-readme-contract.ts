import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";
import { toText } from "hast-util-to-text";
import type { Element, Root as HastRoot } from "hast";
import type { Code, Html, Parents, Root as MdastRoot } from "mdast";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";

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
const REQUIRED_RENDERED_BOUNDARIES = [
  "authoritative: false",
  "phase1Authorized: false",
] as const;
const REQUIRED_SKILL_INSTALL_COMMAND = "npx skills add Jin-Doh/traceknot --skill traceknot --global";
const REQUIRED_LIFECYCLE_LITERALS = [
  "npx skills update traceknot --global --yes",
  "npx skills update traceknot --yes",
  "skill/bin/traceknot",
  "$HOME/.agents/skills/traceknot/bin/traceknot",
  ".agents/skills/traceknot/bin/traceknot",
  ".agents/skills/traceknot/bin/traceknot self-check",
  ".agents/skills/traceknot/bin/traceknot board update",
  "Bun 1.3.14",
  "macOS",
  "Linux",
  "Windows",
  "TRACEKNOT_SKILLS_ROOT",
  "traceknot-update",
] as const;
const REQUIRED_OPERATIONAL_BLOCK_LITERALS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  "README.md": {
    "full-toolkit-install": ["curl -fsSL https://raw.githubusercontent.com/Jin-Doh/traceknot/main/install.sh | sh"],
    "full-toolkit-pinned-install": [
      "TRACEKNOT_REF=<tag-or-commit>",
      "https://raw.githubusercontent.com/Jin-Doh/traceknot/$TRACEKNOT_REF/install.sh",
      'TRACEKNOT_REF="$TRACEKNOT_REF" sh',
    ],
    "full-toolkit-uninstall": ["curl -fsSL https://raw.githubusercontent.com/Jin-Doh/traceknot/main/uninstall.sh | sh"],
    "full-toolkit-custom-uninstall": ["TRACEKNOT_SKILLS_ROOT=/absolute/skills sh -s -- --prefix /absolute/path"],
  },
  "docs/automatic-updates.md": {
    updater: [
      "$TRACEKNOT_PREFIX/current/bin/traceknot-update",
      "$TRACEKNOT_PREFIX/bin/traceknot-update",
      '"$TRACEKNOT_UPDATE" status --prefix "$TRACEKNOT_PREFIX"',
      '"$TRACEKNOT_UPDATE" check --prefix "$TRACEKNOT_PREFIX"',
      '"$TRACEKNOT_UPDATE" apply --prefix "$TRACEKNOT_PREFIX"',
      '"$TRACEKNOT_UPDATE" disable --prefix "$TRACEKNOT_PREFIX"',
      '"$TRACEKNOT_UPDATE" enable --prefix "$TRACEKNOT_PREFIX"',
      '"$TRACEKNOT_UPDATE" rollback --prefix "$TRACEKNOT_PREFIX"',
    ],
  },
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

const MARKDOWN_PROCESSOR = unified().use(remarkParse).use(remarkGfm);
const HTML_PROCESSOR = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw);

function markdownTree(content: string): MdastRoot {
  return MARKDOWN_PROCESSOR.parse(content) as MdastRoot;
}

function htmlTree(content: string): HastRoot {
  return HTML_PROCESSOR.runSync(HTML_PROCESSOR.parse(content)) as HastRoot;
}

function visibleHtmlTree(content: string, removePre = false): HastRoot {
  const tree = structuredClone(htmlTree(content));
  const prune = (node: HastRoot | Element): void => {
    node.children = node.children.filter((child) => child.type !== "element"
      || ((!removePre || child.tagName !== "pre") && child.properties.hidden == null));
    for (const child of node.children) {
      if (child.type === "element") prune(child);
    }
  };
  prune(tree);
  return tree;
}

export function renderedMarkdownText(content: string): string {
  return toText(visibleHtmlTree(content, true));
}

function visibleAnchorTargets(content: string): string[] {
  const targets: string[] = [];
  visit(visibleHtmlTree(content), "element", (node: Element) => {
    const accessibleLabel = node.properties.ariaLabel;
    const hasAccessibleLabel = typeof accessibleLabel === "string" && accessibleLabel.trim().length > 0;
    const hasRenderedText = toText(node).trim().length > 0;
    const hasImageAlt = node.children.some((child) => child.type === "element"
      && child.tagName === "img" && typeof child.properties.alt === "string" && child.properties.alt.trim().length > 0);
    if (node.tagName === "a" && (hasRenderedText || hasAccessibleLabel || hasImageAlt)
      && (typeof node.properties.href === "string" || typeof node.properties.href === "number")) {
      targets.push(String(node.properties.href));
    }
  });
  return targets;
}

function collectSectionMarkers(content: string): Map<string, number> {
  const markers = new Map<string, number>();
  visit(markdownTree(content), "html", (node: Html) => {
    const match = node.value.match(/^\s*<!-- readme-section:([a-z0-9-]+) -->\s*$/u);
    if (!match) return;
    const name = match[1];
    markers.set(name, (markers.get(name) ?? 0) + 1);
  });
  return markers;
}

function isClosedFencedCode(content: string, block: Code): boolean {
  const start = block.position?.start.offset;
  const end = block.position?.end.offset;
  if (start === undefined || end === undefined) return false;
  const source = content.slice(start, end);
  const lines = source.split(/\r?\n/u);
  const opening = lines[0]?.match(/^[\t ]{0,3}(`{3,}|~{3,})/u)?.[1];
  if (!opening) return false;
  const closing = lines.at(-1)?.match(/^[\t ]{0,3}(`+|~+)[\t ]*$/u)?.[1];
  return Boolean(closing && closing[0] === opening[0] && closing.length >= opening.length);
}

function collectMarkedCommands(content: string, path: string, markerKind: "shared-command" | "operational-command"): Map<string, string> {
  const tree = markdownTree(content);
  const markers = new Map<string, Array<{ parent: Parents; index: number }>>();
  visit(tree, "html", (node: Html, index, parent) => {
    const match = markerKind === "shared-command"
      ? node.value.match(/^\s*<!-- shared-command:([a-z0-9-]+) -->\s*$/u)
      : node.value.match(/^\s*<!-- operational-command:([a-z0-9-]+) -->\s*$/u);
    if (!match || index === undefined || !parent) return;
    const occurrences = markers.get(match[1]) ?? [];
    occurrences.push({ parent, index });
    markers.set(match[1], occurrences);
  });
  const commands = new Map<string, string>();
  for (const [name, occurrences] of markers) {
    if (occurrences.length !== 1) {
      throw new Error(`${path}: ${markerKind} marker ${name} must appear exactly once, found ${occurrences.length}`);
    }
    const occurrence = occurrences[0];
    const block = occurrence.parent.children[occurrence.index + 1] as Code | undefined;
    if (block?.type !== "code" || !isClosedFencedCode(content, block)) {
      throw new Error(`${path}: ${markerKind} marker ${name} must be followed by a fenced block`);
    }
    commands.set(name, block.value);
  }
  return commands;
}

function collectSharedCommands(content: string, path: string): Map<string, string> {
  return collectMarkedCommands(content, path, "shared-command");
}

function collectOperationalCommands(content: string, path: string): Map<string, string> {
  return collectMarkedCommands(content, path, "operational-command");
}

function loadReadmes(): ReadmeRecord[] {
  return README_PATHS.map((path) => {
    const absolute = resolve(ROOT, path);
    if (!existsSync(absolute)) throw new Error(`${path}: required README is missing`);
    const content = readFileSync(absolute, "utf8");
    return {
      path,
      content,
      sections: collectSectionMarkers(content),
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
    sections: collectSectionMarkers(content),
    sharedCommands: new Map(),
  });
}

function checkLanguageNavigation(record: ReadmeRecord): void {
  const visibleTargets = new Set(visibleAnchorTargets(record.content)
    .filter((target) => !isExternalTarget(target))
    .map(normalizedRepositoryRelativeTarget));
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
  if (record.sharedCommands.get("skill-install")?.trim() !== REQUIRED_SKILL_INSTALL_COMMAND) {
    throw new Error(`${record.path}: skill-install command must be ${REQUIRED_SKILL_INSTALL_COMMAND}`);
  }
  const prose = renderedMarkdownText(record.content);
  for (const boundary of REQUIRED_RENDERED_BOUNDARIES) {
    if (!prose.includes(boundary)) throw new Error(`${record.path}: missing rendered public boundary literal ${boundary}`);
  }
}

export function checkReadmeBoundaries(path: string, content: string): void {
  checkBoundaries({ path, content, sections: new Map(), sharedCommands: collectSharedCommands(content, path) });
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

function localTargets(content: string): string[] {
  const targets: string[] = [];
  const targetProperties = new Set([
    "href", "xLinkHref", "src", "poster", "action", "formAction", "cite", "data", "background",
    "manifest", "profile", "longDesc", "useMap",
  ]);
  visit(htmlTree(content), "element", (node: Element) => {
    for (const [property, rawValue] of Object.entries(node.properties ?? {})) {
      if (property === "srcSet" && typeof rawValue === "string") {
        targets.push(...srcsetTargets(rawValue));
      } else if (property === "ping") {
        const values = Array.isArray(rawValue) ? rawValue : String(rawValue ?? "").trim().split(/\s+/u);
        targets.push(...values.map(String).filter(Boolean));
      } else if (targetProperties.has(property) && (typeof rawValue === "string" || typeof rawValue === "number")) {
        targets.push(String(rawValue));
      }
    }
  });
  return targets;
}

function isExternalTarget(target: string): boolean {
  return target.startsWith("#") || target.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target);
}

function normalizedRepositoryRelativeTarget(rawTarget: string): string {
  return posix.normalize(decodeURIComponent(rawTarget.split("#", 1)[0].split("?", 1)[0].replace(/^<|>$/g, "")));
}

function normalizedDocumentationTargets(content: string): Set<string> {
  const targets = new Set<string>();
  for (const rawTarget of visibleAnchorTargets(content)) {
    if (isExternalTarget(rawTarget)) continue;
    const target = normalizedRepositoryRelativeTarget(rawTarget);
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

export function checkOperationalCommandBlocks(path: string, content: string, requirements: Readonly<Record<string, readonly string[]>>): void {
  const blocks = path === "README.md" ? collectSharedCommands(content, path) : collectOperationalCommands(content, path);
  for (const [name, literals] of Object.entries(requirements)) {
    const block = blocks.get(name);
    const missing = literals.filter((literal) => !block?.includes(literal));
    if (missing.length > 0) throw new Error(`${path}: operational command block ${name} is missing: ${missing.join(", ")}`);
  }
}
export function checkReadmeLifecycleContract(path: string, content: string): void {
  const missing = REQUIRED_LIFECYCLE_LITERALS.filter(literal => !content.includes(literal));
  if (missing.length > 0) throw new Error(`${path}: canonical installation lifecycle is missing: ${missing.join(", ")}`);
}


function checkPublicationContracts(): void {
  const config = JSON.parse(readFileSync(resolve(ROOT, "prose-quality.config.json"), "utf8")) as { include?: unknown; exclude?: unknown };
  checkPublicationInventory(config);
  for (const [path, requirements] of Object.entries(REQUIRED_OPERATIONAL_BLOCK_LITERALS)) {
    const content = readFileSync(resolve(ROOT, path), "utf8");
    checkOperationalCommandBlocks(path, content, requirements);
  }
}

export function checkReadmeContract(): void {
  const records = loadReadmes();
  for (const record of records) {
    checkSections(record);
    checkLanguageNavigation(record);
    checkBoundaries(record);
  }
  for (const record of records) checkReadmeLifecycleContract(record.path, record.content);
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
