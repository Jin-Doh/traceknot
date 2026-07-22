#!/usr/bin/env bun

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse, type ParserPlugin } from "@babel/parser";

type Surface = "local" | "archive" | "sqlite" | "internal-url" | "conflict" | "acp-bridge" | "notebook" | "special" | "unknown";
type Disposition = "supported" | "unsupported";
type Decision = "ALLOW" | "BLOCK";
type BindingKind = "namespace" | "method";
type Node = { type: string; start?: number; end?: number; [key: string]: unknown };
type Binding = { kind: BindingKind; method?: string; module?: string; surface: Surface; proven: boolean };
type Callsite = {
  id: string;
  sourcePath: string;
  sourceFileHash: string;
  symbol: string;
  method: string;
  token: string;
  offset: number;
  module?: string;
  export?: string;
  operationClass: string;
  surface: Surface;
  scope: "single" | "multiple" | "unknown";
  policyDisposition: Disposition;
  decision: Decision;
  reason?: string;
};
type SourceFile = { relativePath: string; bytes: Buffer; hash: string };
type Fixture = { format?: string; cases?: Array<{ id?: string; source?: string; expected?: Array<Record<string, unknown>> }> };
type Declaration = { pattern: Node; init?: Node };

type CallInfo = { method: string; token: string; offset: number; binding?: Binding; dynamic: boolean };

const repoRoot = path.resolve(process.env.GJC_CANONICAL_ROOT ?? path.join(import.meta.dir, "../.."));
const outputPath = path.join(repoRoot, "quality-contract/generated/callsite-manifest.json");
const fixturePath = path.join(repoRoot, "quality-contract/fixtures/callsite-audit-fixtures.json");
const rawMutationMethods = new Set(["write", "writeFile", "writeFileSync", "writeSync", "writev", "writevSync", "appendFile", "appendFileSync", "chmod", "chmodSync", "chown", "chownSync", "close", "closeSync", "copyFile", "copyFileSync", "cp", "cpSync", "createWriteStream", "fchmod", "fchmodSync", "fchown", "fchownSync", "fsync", "fsyncSync", "ftruncate", "ftruncateSync", "futimes", "futimesSync", "link", "linkSync", "lchmod", "lchmodSync", "lutimes", "lutimesSync", "mkdir", "mkdirSync", "mkdtemp", "mkdtempSync", "openSync", "open", "rename", "renameSync", "rm", "rmSync", "rmdir", "rmdirSync", "symlink", "symlinkSync", "truncate", "truncateSync", "unlink", "unlinkSync", "utimes", "utimesSync"]);
const unmistakableStorageMethods = new Set(["remove", "delete", "deleteSync", "ensureDirSync", "writeText", "writeTextSync", "writeTextAtomic", "writeLine", "writeLineSync", "writeTextFile", "deleteSessionWithArtifacts", "deleteSessionVerified", "executePatchSingle", "executeReplaceSingle", "executeHashlineSingle", "writeArchive", "writethrough", "requestWrite", "closeStrict", "insertRow", "updateRow", "deleteRow"]);
const completionMethods = new Set(["complete", "completeSimple", "finish", "finishTurn"]);
const sqliteMutationMethods = new Set(["run", "exec"]);
const nodeFsModules = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);
const readOnlyFsExports = new Set([
  "access", "accessSync", "constants", "exists", "existsSync", "fstat", "fstatSync",
  "lstat", "lstatSync", "read", "readFile", "readFileSync", "readlink", "readlinkSync",
  "readdir", "readdirSync", "realpath", "realpathSync", "stat", "statSync", "watch",
  "watchFile", "unwatchFile", "opendir", "opendirSync", "readv", "readvSync",
  "Dir", "Dirent", "Stats", "promises",
]);
function isNodeFsModule(moduleName: string | undefined): boolean { return Boolean(moduleName && nodeFsModules.has(moduleName)); }
function isReadOnlyFsExport(method: string): boolean { return readOnlyFsExports.has(method); }
const knownSqliteModules = new Set(["bun:sqlite"]);
const mutationMethods = new Set([...rawMutationMethods, ...unmistakableStorageMethods, "openWriter", "move", "moveSync", "flush", "run", "exec", "append", "save", "commit"]);
const approvedAllowIdentities: Readonly<Record<string, ReadonlySet<string>>> = {};
type ProducerOptions = {
  rawMutationMethods?: ReadonlySet<string>;
  mutationMethods?: ReadonlySet<string>;
  omitCollectedRows?: boolean;
  omitFsUnknownExports?: boolean;
};
const producerDefaults: Required<Pick<ProducerOptions, "rawMutationMethods" | "mutationMethods">> = { rawMutationMethods, mutationMethods };
function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function approvedExport(moduleName: string, method: string): boolean {
  return approvedAllowIdentities[moduleName]?.has(method) ?? false;
}
function rawMethodsFor(moduleName: string, options: ProducerOptions = producerDefaults): ReadonlySet<string> | undefined {
  return ["fs", "node:fs", "fs/promises", "node:fs/promises"].includes(moduleName) ? options.rawMutationMethods ?? producerDefaults.rawMutationMethods : undefined;
}
function fsMutationExport(moduleName: string | undefined, method: string | undefined, options: ProducerOptions = producerDefaults): boolean {
  if (!isNodeFsModule(moduleName) || !method || isReadOnlyFsExport(method)) return false;
  const inventory = rawMethodsFor(moduleName!, options);
  if (inventory?.has(method)) return true;
  if (rawMutationMethods.has(method)) return false;
  return !options.omitFsUnknownExports;
}
function walkFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const output: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) output.push(absolute);
    }
  };
  visit(root);
  return output.sort(compare);
}
function sourcePaths(): string[] {
  const packages = fs.existsSync(path.join(repoRoot, "packages")) ? fs.readdirSync(path.join(repoRoot, "packages"), { withFileTypes: true }) : [];
  return packages
    .filter(entry => entry.isDirectory())
    .flatMap(entry => walkFiles(path.join(repoRoot, "packages", entry.name, "src")))
    .filter(file => /\.(?:ts|tsx|js|jsx)$/.test(file) && !file.endsWith(".d.ts") && !/\.min\.js$|\.generated\.ts$/.test(file))
    .map(file => path.relative(repoRoot, file).replaceAll("\\", "/"))
    .sort(compare);
}
function node(value: unknown): Node | undefined { return value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string" ? value as Node : undefined; }
function children(value: Node): Node[] {
  const result: Node[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (["loc", "start", "end", "type", "leadingComments", "innerComments", "trailingComments", "extra", "errors"].includes(key)) continue;
    if (Array.isArray(child)) for (const item of child) { const itemNode = node(item); if (itemNode) result.push(itemNode); }
    else { const childNode = node(child); if (childNode) result.push(childNode); }
  }
  return result;
}
function walk(value: Node, parents: Node[], visit: (current: Node, ancestors: Node[]) => void): void {
  visit(value, parents);
  for (const child of children(value)) walk(child, [...parents, value], visit);
}
function parseSource(source: string, label: string): Node {
  try {
    const extension = path.extname(label).toLowerCase();
    const plugins: ParserPlugin[] = [...(extension === ".ts" || extension === ".tsx" ? ["typescript" as const] : []), ...(extension === ".tsx" || extension === ".jsx" || extension === ".js" ? ["jsx" as const] : []), "decorators-legacy", "classProperties", "classPrivateProperties", "classPrivateMethods", "topLevelAwait", "importAttributes", "explicitResourceManagement"];
    return parse(source, { sourceType: "unambiguous", errorRecovery: false, allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true, plugins }) as unknown as Node;
  } catch (error) {
    throw new Error(`${label}: Babel parser rejected source: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function identifierName(value: unknown): string | undefined {
  const item = node(value);
  if (!item) return undefined;
  if (item.type === "Identifier") return typeof item.name === "string" ? item.name : undefined;
  if (item.type === "StringLiteral") return typeof item.value === "string" ? item.value : undefined;
  return undefined;
}
function stringValue(value: unknown): string | undefined {
  const item = node(value);
  return item?.type === "StringLiteral" && typeof item.value === "string" ? item.value : undefined;
}
function propertyName(value: Node): string | undefined {
  const direct = identifierName(value);
  if (direct !== undefined) return direct;
  if (value.type === "TemplateLiteral" && Array.isArray(value.expressions) && value.expressions.length === 0) {
    const quasi = node((value.quasis as unknown[] | undefined)?.[0]);
    const cooked = node(quasi?.value)?.cooked;
    return typeof cooked === "string" ? cooked : undefined;
  }
  return undefined;
}
function bindingForModule(moduleName: string, method?: string, options: ProducerOptions = producerDefaults): Binding {
  const known = fsMutationExport(moduleName, method, options) || (knownSqliteModules.has(moduleName) && (!method || sqliteMutationMethods.has(method) || method === "Database"));
  const proven = known || (method ? approvedExport(moduleName, method) : Object.hasOwn(approvedAllowIdentities, moduleName));
  return { kind: method ? "method" : "namespace", ...(method ? { method } : {}), module: moduleName, surface: proven ? "local" : "unknown", proven };
}
function knownBindingMutation(binding: Binding | undefined, method: string, options: ProducerOptions = producerDefaults): boolean {
  return Boolean(binding?.module && (fsMutationExport(binding.module, method, options) || (knownSqliteModules.has(binding.module) && sqliteMutationMethods.has(method))));
}
function unknownBinding(kind: BindingKind, method?: string): Binding { return { kind, ...(method ? { method } : {}), surface: "unknown", proven: false }; }
function patternNames(pattern: Node): string[] {
  if (pattern.type === "Identifier" && typeof pattern.name === "string") return [pattern.name];
  if (pattern.type === "RestElement") return pattern.argument ? patternNames(node(pattern.argument) as Node) : [];
  if (pattern.type === "AssignmentPattern") return pattern.left ? patternNames(node(pattern.left) as Node) : [];
  if (pattern.type === "ObjectPattern") return (pattern.properties as unknown[] | undefined)?.flatMap(item => {
    const property = node(item); if (!property) return [];
    return property.type === "RestElement" ? patternNames(node(property.argument) as Node) : patternNames(node(property.value) as Node);
  }) ?? [];
  if (pattern.type === "ArrayPattern") return (pattern.elements as unknown[] | undefined)?.flatMap(item => item ? patternNames(node(item) as Node) : []) ?? [];
  return [];
}
function staticMember(value: Node): { object?: Node; property?: string; dynamic: boolean } | undefined {
  if (value.type !== "MemberExpression" && value.type !== "OptionalMemberExpression") return undefined;
  const object = node(value.object);
  const property = node(value.property);
  if (!value.computed) return { object, property: property ? propertyName(property) : undefined, dynamic: false };
  if (property?.type === "StringLiteral" && typeof property.value === "string") return { object, property: property.value, dynamic: false };
  if (property?.type === "TemplateLiteral" && Array.isArray(property.expressions) && property.expressions.length === 0) {
    const quasi = node((property.quasis as unknown[] | undefined)?.[0]);
    const cooked = node(quasi?.value)?.cooked;
    if (typeof cooked === "string") return { object, property: cooked, dynamic: false };
  }
  return { object, dynamic: true };
}
function collectBindings(ast: Node, options: ProducerOptions = producerDefaults): Map<string, Binding> {
  const bindings = new Map<string, Binding>();
  const declarations: Declaration[] = [];
  const shadowed = new Set<string>();
  const set = (name: string, value: Binding): void => { if (!name || shadowed.has(name)) return; const prior = bindings.get(name); if (prior && JSON.stringify(prior) !== JSON.stringify(value)) bindings.set(name, unknownBinding(value.kind, value.method)); else bindings.set(name, value); };
  walk(ast, [], (current, ancestors) => {
    if (current.type === "ImportDeclaration") {
      const moduleName = stringValue(current.source); if (!moduleName || current.importKind === "type") return;
      for (const item of (current.specifiers as unknown[] | undefined) ?? []) {
        const specifier = node(item); const local = identifierName(specifier?.local); if (!specifier || !local || specifier.importKind === "type") continue;
        if (specifier.type === "ImportSpecifier") set(local, bindingForModule(moduleName, identifierName(specifier.imported), options));
        else set(local, bindingForModule(moduleName, undefined, options));
      }
    }
    if (current.type === "VariableDeclarator") declarations.push({ pattern: node(current.id) as Node, init: node(current.init) });
    if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(current.type)) {
      for (const parameter of (current.params as unknown[] | undefined) ?? []) for (const name of patternNames(node(parameter) as Node)) shadowed.add(name);
      const id = identifierName(current.id);
      if (id) shadowed.add(id);
    }
    if (["ClassDeclaration", "ClassExpression"].includes(current.type)) { const id = identifierName(current.id); if (id) shadowed.add(id); }
    void ancestors;
  });
  for (const name of shadowed) bindings.delete(name);
  const resolved = new Map<number, Binding>();
  const lookup = (name: string): Binding | undefined => bindings.get(name);
  const resolveExpression = (expression: Node | undefined): Binding | undefined => {
    if (!expression) return undefined;
    if (expression.type === "NewExpression") {
      const callee = node(expression.callee);
      const constructor = callee?.type === "Identifier" && typeof callee.name === "string" ? lookup(callee.name) : undefined;
      if (constructor?.module && knownSqliteModules.has(constructor.module)) return bindingForModule(constructor.module, undefined, options);
    }
    if (expression.type === "Identifier" && typeof expression.name === "string") return lookup(expression.name);
    if (expression.type === "CallExpression" && node(expression.callee)?.type === "Identifier" && (expression.callee as Node).name === "require") {
      const moduleName = stringValue(node((expression.arguments as unknown[] | undefined)?.[0]));
      return moduleName ? bindingForModule(moduleName, undefined, options) : undefined;
    }
    const member = staticMember(expression);
    if (member && !member.dynamic && member.property) {
      const source = member.object?.type === "Identifier" && typeof member.object.name === "string" ? lookup(member.object.name) : resolveExpression(member.object);
      if (source?.kind === "namespace" && (source.proven || isNodeFsModule(source.module)) ) return bindingForModule(source.module ?? "", member.property, options);
      if (member.object?.type === "CallExpression" && source?.module && knownSqliteModules.has(source.module) && member.property === "prepare") return bindingForModule(source.module, undefined, options);
      return unknownBinding("method", member.property);
    }
    return undefined;
  };
  const resolvePattern = (pattern: Node, init: Node | undefined): Array<[string, Binding]> => {
    if (pattern.type === "Identifier" && typeof pattern.name === "string") {
      const value = resolveExpression(init);
      if (value) return [[pattern.name, value]];
      const member = init ? staticMember(init) : undefined;
      return member && !member.dynamic && member.property ? [[pattern.name, unknownBinding("method", member.property)]] : [];
    }
    if (pattern.type === "ObjectPattern") {
      const source = init ? resolveExpression(init) : undefined;
      return ((pattern.properties as unknown[] | undefined) ?? []).flatMap(item => {
        const property = node(item); if (!property) return [];
        if (property.type === "RestElement") return [];
        const key = node(property.key); const value = node(property.value); const imported = key ? propertyName(key) : undefined;
        const local = value ? patternNames(value)[0] : undefined;
        if (!imported || !local || property.type === "ObjectMethod") return [];
        if (source?.kind === "namespace" && (source.proven || isNodeFsModule(source.module))) return [[local, bindingForModule(source.module ?? "", imported, options)]];
        return [[local, unknownBinding("method", imported)]];
      });
    }
    return patternNames(pattern).map(name => [name, unknownBinding("method", name)]);
  };
  for (let pass = 0; pass < declarations.length + 2; pass++) {
    let changed = false;
    for (let index = 0; index < declarations.length; index++) {
      const values = resolvePattern(declarations[index]!.pattern, declarations[index]!.init);
      for (const [name, value] of values) {
        const prior = resolved.get(index);
        if (!prior || JSON.stringify(prior) !== JSON.stringify(value)) { resolved.set(index, value); changed = true; }
        set(name, value);
      }
    }
    if (!changed) break;
  }
  return bindings;
}
function operationClass(method: string): string {
  const lower = method.toLowerCase();
  if (/unlink|^rm(?:sync)?$|delete|remove/.test(lower)) return "local.single.regular-file.unlink";
  if (/rename|^move/.test(lower)) return "local.single.regular-file.rename";
  if (/^(?:cp|copy)/.test(lower)) return "local.single.regular-file.copy";
  if (/ensuredir|mkdir/.test(lower)) return "local.directory.create";
  if (/open/.test(lower) || /close|flush|fsync/.test(lower)) return "storage.writer.lifecycle";
  if (/writeline|append/.test(lower)) return "storage.session.append";
  if (/executepatch|executereplace|executehashline|patch|replace/.test(lower)) return "local.single.regular-file.edit";
  if (/^(?:run|insert|update)/.test(lower)) return "sqlite.row";
  if (/writetextfile/.test(lower)) return "acp-bridge.write";
  return "local.single.regular-file.write";
}
function classify(method: string, binding: Binding | undefined, dynamic: boolean): Omit<Callsite, "id" | "sourcePath" | "sourceFileHash" | "symbol" | "method" | "token" | "offset"> {
  const authority = binding?.module || binding?.method ? { ...(binding.module ? { module: binding.module } : {}), ...(binding.method ? { export: binding.method } : {}) } : {};
  if (dynamic) return { ...authority, operationClass: "unknown.dynamic-mutation", surface: "unknown", scope: "unknown", policyDisposition: "unsupported", decision: "BLOCK", reason: "dynamic or computed mutation target cannot be proven" };
  if (completionMethods.has(method)) return { ...authority, operationClass: "transport.completion", surface: "special", scope: "unknown", policyDisposition: "unsupported", decision: "BLOCK", reason: "transport completion is outside the single-file mutation proof" };
  const proven = Boolean(binding?.proven && binding.module && binding.method && approvedExport(binding.module, binding.method));
  const operation = operationClass(method);
  const supported = proven && operation.startsWith("local.single.regular-file.");
  return { ...authority, operationClass: operation, surface: supported ? "local" : "unknown", scope: supported ? "single" : "unknown", policyDisposition: supported ? "supported" : "unsupported", decision: supported ? "ALLOW" : "BLOCK", ...(supported ? {} : { reason: "mutation receiver or import has no exact approved module/export identity" }) };
}
function callInfo(source: string, call: Node, bindings: Map<string, Binding>, options: ProducerOptions = producerDefaults): CallInfo | undefined {
  const callee = node(call.callee); if (!callee) return undefined;
  if (callee.type === "Identifier" && typeof callee.name === "string") {
    const binding = bindings.get(callee.name); const method = binding?.method ?? callee.name;
    if (!(options.mutationMethods ?? producerDefaults.mutationMethods).has(method) && !knownBindingMutation(binding, method, options) && !completionMethods.has(method)) return undefined;
    return { method, token: callee.name, offset: callee.start ?? call.start ?? 0, binding };
  }
  const member = staticMember(callee); if (!member) return undefined;
  const object = member.object; const receiver = object?.type === "Identifier" && typeof object.name === "string" ? bindings.get(object.name) : undefined;
  if (member.dynamic) return { method: `${object?.start === undefined ? "unknown" : source.slice(object.start, object.end)}[dynamic]`, token: source.slice(callee.start ?? call.start ?? 0, callee.end ?? call.end ?? 0), offset: callee.start ?? call.start ?? 0, binding: receiver, dynamic: true };
  const method = member.property; if (!method) return undefined;
  const canonical = method;
  if (!(options.mutationMethods ?? producerDefaults.mutationMethods).has(method) && !knownBindingMutation(receiver, method, options) && !completionMethods.has(method)) return undefined;
  const property = node(callee.property); const token = method;
  const binding = receiver?.kind === "namespace" && receiver.module ? bindingForModule(receiver.module, method, options) : unknownBinding("method", method);
  return { method: canonical, token, offset: property?.start ?? callee.start ?? call.start ?? 0, binding };
}
function symbolFor(ancestors: Node[]): string {
  const nameOf = (value: unknown): string | undefined => identifierName(value);
  for (let index = ancestors.length - 1; index >= 0; index--) {
    const current = ancestors[index]!; const parent = index > 0 ? ancestors[index - 1] : undefined;
    if (["ClassMethod", "ClassPrivateMethod", "ObjectMethod"].includes(current.type)) { const name = current.key ? nameOf(current.key) : undefined; if (name) return name; }
    if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "TSDeclareFunction"].includes(current.type)) {
      const name = nameOf(current.id); if (name) return name;
      if (parent?.type === "VariableDeclarator" && parent.init === current) { const variable = patternNames(node(parent.id) as Node)[0]; if (variable) return variable; }
      if (parent?.type === "ObjectProperty" && parent.value === current) { const key = parent.key ? nameOf(parent.key) : undefined; if (key) return key; }
    }
    if (["ClassDeclaration", "ClassExpression"].includes(current.type)) { const name = nameOf(current.id); if (name) return name; }
  }
  return "<module>";
}
function collect(sourceFile: SourceFile, options: ProducerOptions = producerDefaults): Callsite[] {
  const source = sourceFile.bytes.toString("utf8"); const ast = parseSource(source, sourceFile.relativePath); const bindings = collectBindings(ast, options); const results: Callsite[] = []; const seen = new Set<string>();
  walk(ast, [], (current, ancestors) => {
    if (current.type !== "CallExpression" && current.type !== "OptionalCallExpression") return;
    const info = callInfo(source, current, bindings, options); if (!info) return;
    const classified = classify(info.method, info.binding, Boolean(info.dynamic)); const key = `${info.offset}:${info.method}:${info.token}`; if (seen.has(key)) return; seen.add(key);
    results.push({ id: sha256(`${sourceFile.relativePath}\0${sourceFile.hash}\0${info.offset}\0${info.method}`), sourcePath: sourceFile.relativePath, sourceFileHash: sourceFile.hash, symbol: symbolFor([...ancestors, current]), method: info.method, token: info.token, offset: info.offset, ...classified });
  });
return results;
}
export function collectCallsites(relativePath: string, bytes: Buffer | string, options: ProducerOptions = producerDefaults): Callsite[] {
  if (options.omitCollectedRows) return [];
  const buffer = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
  return collect({ relativePath, bytes: buffer, hash: sha256(buffer) }, options);
}
function validateFixtures(): void {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Fixture;
  if (fixture.format !== "quality-contract.callsite-audit-fixtures.v1" || !Array.isArray(fixture.cases)) throw new Error("synthetic fixture format is invalid");
  const fields = ["method", "token", "operationClass", "surface", "scope", "policyDisposition", "decision"] as const;
  for (const item of fixture.cases) {
    const source = String(item.source ?? ""); const rows = collect({ relativePath: `fixture/${String(item.id ?? "unknown")}.ts`, bytes: Buffer.from(source), hash: sha256(source) });
    for (const expected of item.expected ?? []) {
      const found = rows.find(row => row.method === String(expected.method) && (expected.token === undefined || row.token === String(expected.token)));
      if (!found) throw new Error(`fixture ${String(item.id)} omitted ${String(expected.method)}`);
      for (const field of fields) if (expected[field] !== undefined && String(found[field]) !== String(expected[field])) throw new Error(`fixture ${String(item.id)} ${field} mismatch`);
    }
    if (rows.length !== (item.expected ?? []).length) throw new Error(`fixture ${String(item.id)} has unexpected callsites`);
  }
}
function pinnedCodexEvidence(): { sourceRoot: string; cacheClaimsTrusted: false; capabilities: Array<{ capability: string; status: "observed" | "unsupported"; files: string[]; sha256: string[] }> } {
  const paths = [
    "quality-contract/evidence/official/openai-codex-hooks.v1.json",
    "quality-contract/evidence/official/openai-codex-app-server.v1.json",
  ];
  const files = paths.map(relativePath => {
    const bytes = fs.readFileSync(path.join(repoRoot, relativePath));
    return { relativePath, hash: sha256(bytes) };
  });
  return {
    sourceRoot: "quality-contract/evidence/official",
    cacheClaimsTrusted: false,
    capabilities: [
      { capability: "hooks", status: "observed", files: [files[0]!.relativePath], sha256: [files[0]!.hash] },
      { capability: "app-server", status: "observed", files: [files[1]!.relativePath], sha256: [files[1]!.hash] },
      { capability: "skills", status: "unsupported", files: [], sha256: [] },
    ],
  };
}
function main(): void {
  if (process.env.CODEX_CANONICAL_ROOT) throw new Error("CODEX_CANONICAL_ROOT is forbidden during hermetic freeze");
  validateFixtures();
  const sources: SourceFile[] = sourcePaths().map(relativePath => { const bytes = fs.readFileSync(path.join(repoRoot, relativePath)); return { relativePath, bytes, hash: sha256(bytes) }; });
  if (sources.length === 0) throw new Error("No runtime source files found under packages/*/src");
  const callsites = sources.flatMap(source => collect(source)).sort((a, b) => compare(a.sourcePath, b.sourcePath) || a.offset - b.offset || compare(a.id, b.id));
  const manifest = {
    schemaVersion: "callsite-manifest/v2",
    generator: "quality-contract/scripts/generate-callsite-manifest.ts",
    generatorVersion: "phase0-callsite-structural-v7",
    sourceRoot: "canonical-gajae-code",
    sourceEnumeration: "all packages/*/src runtime TypeScript/JavaScript files, excluding declarations/minified/generated files",
    phase1Authorized: false,
    sourceFiles: sources.map(source => ({ path: source.relativePath, bytes: source.bytes.byteLength, sha256: source.hash })),
    callsites,
    codexEvidence: pinnedCodexEvidence(),
    invariants: ["Every runtime source byte is hash-bound.", "Supported ALLOW rows require an exact approved module/export identity from the closed allowlist.", "Unknown, indirect, dynamic, computed, and unsupported mutation calls are represented as BLOCK rows.", "Structurally proven calls through fs, node:fs, fs/promises, and node:fs/promises are BLOCK unless explicitly classified read-only, including unknown future exports.", "Codex capability evidence is read only from pinned official records; no external checkout or cache is consulted.", "The reviewed fixture corpus is checked by the producer and independently traversed by the auditor."],
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true }); fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
