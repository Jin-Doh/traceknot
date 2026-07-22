#!/usr/bin/env bun

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse, type ParserPlugin } from "@babel/parser";
import { collectCallsites } from "./generate-callsite-manifest.ts";

type Surface = "local" | "archive" | "sqlite" | "internal-url" | "conflict" | "acp-bridge" | "notebook" | "special" | "unknown";
type Row = Record<string, unknown>;
type Ast = { type: string; start?: number; end?: number; [key: string]: unknown };
type Proof = { kind: "namespace" | "method"; method?: string; module?: string; surface: Surface; proven: boolean };
type Candidate = { method: string; token: string; offset: number; module?: string; export?: string; operationClass: string; surface: Surface; scope: "single" | "multiple" | "unknown"; policyDisposition: "supported" | "unsupported"; decision: "ALLOW" | "BLOCK"; symbol: string; sourceFileHash: string; reason?: string };
type Fixture = { format?: string; cases?: Array<{ id?: string; source?: string; expected?: Array<Record<string, unknown>> }> };
type Declaration = { id: Ast; value?: Ast };
type OmissionProbe = { id: string; fixtureId: string; method: string; token: string; mutation: "row-delete" | "row-corrupt" | "producer-inventory-omission" | "producer-collector-omission" | "auditor-oracle-omission"; outcome: "killed" | "survived"; detail: string };
type AuditReport = { format: string; sourceCount: number; candidateCount: number; checked: number; failures: string[]; omissionProbes: OmissionProbe[]; passed: boolean; phase1Authorized: false; payloadSha256: string };

const root = path.resolve(process.env.GJC_CANONICAL_ROOT ?? path.join(import.meta.dir, "../.."));
const contract = path.join(root, "quality-contract");
const manifestPath = path.join(contract, "generated/callsite-manifest.json");
const fixturePath = path.join(contract, "fixtures/callsite-audit-fixtures.json");
const reportPath = path.join(contract, "generated/callsite-audit-report.json");
const rawMutationMethods = new Set(["write", "writeFile", "writeFileSync", "writeSync", "writev", "writevSync", "appendFile", "appendFileSync", "chmod", "chmodSync", "chown", "chownSync", "close", "closeSync", "copyFile", "copyFileSync", "cp", "cpSync", "createWriteStream", "fchmod", "fchmodSync", "fchown", "fchownSync", "fsync", "fsyncSync", "ftruncate", "ftruncateSync", "futimes", "futimesSync", "link", "linkSync", "lchmod", "lchmodSync", "lutimes", "lutimesSync", "mkdir", "mkdirSync", "mkdtemp", "mkdtempSync", "open", "openSync", "rename", "renameSync", "rm", "rmSync", "rmdir", "rmdirSync", "symlink", "symlinkSync", "truncate", "truncateSync", "unlink", "unlinkSync", "utimes", "utimesSync"]);
const storageMutationMethods = new Set(["remove", "delete", "deleteSync", "ensureDirSync", "writeText", "writeTextSync", "writeTextAtomic", "writeLine", "writeLineSync", "writeTextFile", "deleteSessionWithArtifacts", "deleteSessionVerified", "executePatchSingle", "executeReplaceSingle", "executeHashlineSingle", "writeArchive", "writethrough", "requestWrite", "closeStrict", "insertRow", "updateRow", "deleteRow"]);
const mutationMethods = new Set([...rawMutationMethods, ...storageMutationMethods, "openWriter", "move", "moveSync", "flush", "run", "exec", "append", "save", "commit"]);
const completionMethods = new Set(["complete", "completeSimple", "finish", "finishTurn"]);
const reviewedAllowIdentityOracle: Readonly<Record<string, ReadonlySet<string>>> = {};
const knownSqliteModules = new Set(["bun:sqlite"]);
const reviewedMutationExports: Readonly<Record<string, ReadonlySet<string>>> = {
  "fs": new Set(["appendFile", "appendFileSync", "chmod", "chmodSync", "chown", "chownSync", "close", "closeSync", "copyFile", "copyFileSync", "cp", "cpSync", "createWriteStream", "fchmod", "fchmodSync", "fchown", "fchownSync", "fsync", "fsyncSync", "ftruncate", "ftruncateSync", "futimes", "futimesSync", "link", "linkSync", "lchmod", "lchmodSync", "lutimes", "lutimesSync", "mkdir", "mkdirSync", "mkdtemp", "mkdtempSync", "open", "openSync", "rename", "renameSync", "rm", "rmSync", "rmdir", "rmdirSync", "symlink", "symlinkSync", "truncate", "truncateSync", "unlink", "unlinkSync", "utimes", "utimesSync", "write", "writeFile", "writeFileSync", "writeSync", "writev", "writevSync"]),
  "node:fs": new Set(["appendFile", "appendFileSync", "chmod", "chmodSync", "chown", "chownSync", "close", "closeSync", "copyFile", "copyFileSync", "cp", "cpSync", "createWriteStream", "fchmod", "fchmodSync", "fchown", "fchownSync", "fsync", "fsyncSync", "ftruncate", "ftruncateSync", "futimes", "futimesSync", "link", "linkSync", "lchmod", "lchmodSync", "lutimes", "lutimesSync", "mkdir", "mkdirSync", "mkdtemp", "mkdtempSync", "open", "openSync", "rename", "renameSync", "rm", "rmSync", "rmdir", "rmdirSync", "symlink", "symlinkSync", "truncate", "truncateSync", "unlink", "unlinkSync", "utimes", "utimesSync", "write", "writeFile", "writeFileSync", "writeSync", "writev", "writevSync"]),
  "fs/promises": new Set(["appendFile", "chmod", "chown", "copyFile", "cp", "fchmod", "fchown", "ftruncate", "futimes", "link", "lutimes", "mkdir", "mkdtemp", "open", "rename", "rm", "rmdir", "symlink", "truncate", "unlink", "utimes", "writeFile"]),
  "node:fs/promises": new Set(["appendFile", "chmod", "chown", "copyFile", "cp", "fchmod", "fchown", "ftruncate", "futimes", "link", "lutimes", "mkdir", "mkdtemp", "open", "rename", "rm", "rmdir", "symlink", "truncate", "unlink", "utimes", "writeFile"]),
};
const nodeFsModules = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);
const readOnlyFsExports = new Set([
  "access", "accessSync", "constants", "exists", "existsSync", "fstat", "fstatSync",
  "lstat", "lstatSync", "read", "readFile", "readFileSync", "readlink", "readlinkSync",
  "readdir", "readdirSync", "realpath", "realpathSync", "stat", "statSync", "watch",
  "watchFile", "unwatchFile", "opendir", "opendirSync", "readv", "readvSync",
  "Dir", "Dirent", "Stats", "promises",
]);
function isNodeFsModule(moduleName: string | undefined): boolean { return Boolean(moduleName && nodeFsModules.has(moduleName)); }
function isStructurallyProvenFsMutation(proof: Proof | undefined, method: string | undefined): boolean {
  return Boolean(proof?.module && isNodeFsModule(proof.module) && method && !readOnlyFsExports.has(method));
}
function isReviewedMutationExport(proof: Proof | undefined, method: string): boolean {
  return Boolean(proof?.module && reviewedMutationExports[proof.module]?.has(method));
}

function sha256(value: crypto.BinaryLike): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function isAst(value: unknown): value is Ast { return Boolean(value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string"); }
function asAst(value: unknown): Ast | undefined { return isAst(value) ? value : undefined; }
function astName(value: unknown): string | undefined {
  const item = asAst(value); if (!item) return undefined;
  if (item.type === "Identifier" || item.type === "StringLiteral") return typeof item.name === "string" ? item.name : typeof item.value === "string" ? item.value : undefined;
  return undefined;
}
function moduleProof(name: string, method?: string): Proof {
  const module = name;
  const exports = reviewedAllowIdentityOracle[module];
  const known = Boolean(method && reviewedMutationExports[module]?.has(method)) || Boolean(knownSqliteModules.has(module) && (!method || method === "Database" || method === "run" || method === "exec"));
  const proven = known || (method ? exports?.has(method) ?? false : exports !== undefined);
  return { kind: method ? "method" : "namespace", ...(method ? { method } : {}), module, surface: proven ? "local" : "unknown", proven };
}
function unknownProof(method?: string): Proof { return { kind: "method", ...(method ? { method } : {}), surface: "unknown", proven: false }; }
function resolvesToReviewedAllowIdentity(row: Row): boolean {
  const module = typeof row.module === "string" ? row.module : "";
  const exportName = typeof row.export === "string" ? row.export : "";
  return Boolean(module && exportName && reviewedAllowIdentityOracle[module]?.has(exportName));
}
function descendants(value: Ast): Ast[] {
  const output: Ast[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (key === "loc" || key === "start" || key === "end" || key === "type" || key.endsWith("Comments") || key === "extra" || key === "errors") continue;
    if (Array.isArray(child)) {
      for (const element of child) if (isAst(element)) output.push(element);
    } else if (isAst(child)) {
      output.push(child);
    }
  }
  return output;
}
function visitTree(rootNode: Ast, callback: (node: Ast, pathNodes: Ast[]) => void): void {
  const pending: Array<{ node: Ast; parents: Ast[] }> = [{ node: rootNode, parents: [] }];
  while (pending.length) {
    const item = pending.pop()!; callback(item.node, item.parents);
    const nextParents = [...item.parents, item.node];
    const kids = descendants(item.node);
    for (let index = kids.length - 1; index >= 0; index--) pending.push({ node: kids[index]!, parents: nextParents });
  }
}
function parseAst(source: string, label: string): Ast {
  try {
    const extension = path.extname(label).toLowerCase();
    const plugins: ParserPlugin[] = [...(extension === ".ts" || extension === ".tsx" ? ["typescript" as const] : []), ...(extension === ".tsx" || extension === ".jsx" || extension === ".js" ? ["jsx" as const] : []), "decorators-legacy", "classProperties", "classPrivateProperties", "classPrivateMethods", "topLevelAwait", "importAttributes", "explicitResourceManagement"];
    return parse(source, { sourceType: "unambiguous", errorRecovery: false, allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true, plugins }) as unknown as Ast;
  } catch (error) { throw new Error(`${label}: Babel parser rejected source: ${error instanceof Error ? error.message : String(error)}`); }
}
function namesInPattern(value: Ast): string[] {
  if (value.type === "Identifier" && typeof value.name === "string") return [value.name];
  if (value.type === "AssignmentPattern" || value.type === "RestElement") return value.argument || value.left ? namesInPattern(asAst(value.argument ?? value.left)!) : [];
  if (value.type === "ArrayPattern") return ((value.elements as unknown[] | undefined) ?? []).flatMap(item => isAst(item) ? namesInPattern(item) : []);
  if (value.type === "ObjectPattern") return ((value.properties as unknown[] | undefined) ?? []).flatMap(item => { const property = asAst(item); return property ? namesInPattern(asAst(property.value ?? property.argument)!) : []; });
  return [];
}
function memberParts(value: Ast): { object?: Ast; name?: string; dynamic: boolean } | undefined {
  if (value.type !== "MemberExpression" && value.type !== "OptionalMemberExpression") return undefined;
  const object = asAst(value.object); const property = asAst(value.property);
  if (!value.computed) return { object, name: property ? astName(property) : undefined, dynamic: false };
  if (property?.type === "StringLiteral" && typeof property.value === "string") return { object, name: property.value, dynamic: false };
  if (property?.type === "TemplateLiteral" && Array.isArray(property.expressions) && property.expressions.length === 0) {
    const quasi = asAst((property.quasis as unknown[] | undefined)?.[0]); const cooked = asAst(quasi?.value)?.cooked;
    if (typeof cooked === "string") return { object, name: cooked, dynamic: false };
  }
  return { object, dynamic: true };
}
function sameProof(a: Proof, b: Proof): boolean { return a.kind === b.kind && a.method === b.method && a.module === b.module && a.surface === b.surface && a.proven === b.proven; }
function resolveProofs(ast: Ast): Map<string, Proof> {
  const imports = new Map<string, Proof>(); const declarations: Declaration[] = []; const blockedNames = new Set<string>();
  visitTree(ast, (current) => {
    if (current.type === "ImportDeclaration" && current.importKind !== "type") {
      const module = asAst(current.source); const moduleName = module?.type === "StringLiteral" && typeof module.value === "string" ? module.value : undefined;
      if (!moduleName) return;
      for (const raw of ((current.specifiers as unknown[] | undefined) ?? [])) {
        const spec = asAst(raw); const local = astName(spec?.local); if (!spec || !local || spec.importKind === "type") continue;
        const proof = spec.type === "ImportSpecifier" ? moduleProof(moduleName, astName(spec.imported)) : moduleProof(moduleName);
        const prior = imports.get(local);
        imports.set(local, prior && !sameProof(prior, proof) ? unknownProof(proof.method) : proof);
      }
    }
    if (current.type === "VariableDeclarator") { const id = asAst(current.id); if (id) declarations.push({ id, value: asAst(current.init) }); }
    if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(current.type)) { for (const param of ((current.params as unknown[] | undefined) ?? [])) for (const name of namesInPattern(asAst(param)!)) blockedNames.add(name); const own = astName(current.id); if (own) blockedNames.add(own); }
    if (["ClassDeclaration", "ClassExpression"].includes(current.type)) { const name = astName(current.id); if (name) blockedNames.add(name); }
  });
  const values = new Map<number, Proof>();
  const current = new Map(imports);
  for (const name of blockedNames) current.delete(name);
  const lookup = (name: string): Proof | undefined => current.get(name);
  const expressionProof = (value: Ast | undefined): Proof | undefined => {
    if (!value) return undefined;
    if (value.type === "Identifier" && typeof value.name === "string") return lookup(value.name);
    if (value.type === "CallExpression" && asAst(value.callee)?.type === "Identifier" && (asAst(value.callee) as Ast).name === "require") {
      const module = asAst((value.arguments as unknown[] | undefined)?.[0]); return module?.type === "StringLiteral" && typeof module.value === "string" ? moduleProof(module.value) : undefined;
    }
    const member = memberParts(value);
    if (member?.name) {
      const receiver = member.object?.type === "Identifier" && typeof member.object.name === "string" ? lookup(member.object.name) : undefined;
      return receiver?.kind === "namespace" && (receiver.proven || isNodeFsModule(receiver.module)) ? moduleProof(receiver.module ?? "", member.name) : unknownProof(member.name);
    }
    return undefined;
  };
  const derive = (pattern: Ast, value?: Ast): Array<[string, Proof]> => {
    if (pattern.type === "Identifier" && typeof pattern.name === "string") {
      const direct = expressionProof(value); if (direct) return [[pattern.name, direct]];
      const member = value ? memberParts(value) : undefined; return member?.name ? [[pattern.name, unknownProof(member.name)]] : [];
    }
    if (pattern.type === "ObjectPattern") {
      const parent = value ? expressionProof(value) : undefined;
      return ((pattern.properties as unknown[] | undefined) ?? []).flatMap(raw => {
        const prop = asAst(raw); if (!prop || prop.type === "RestElement") return [];
        const imported = astName(prop.key); const local = prop.value ? namesInPattern(asAst(prop.value)!).at(0) : undefined;
        if (!imported || !local) return [];
        return [[local, parent?.kind === "namespace" && (parent.proven || isNodeFsModule(parent.module)) ? moduleProof(parent.module ?? "", imported) : unknownProof(imported)]];
      });
    }
    return namesInPattern(pattern).map(name => [name, unknownProof(name)]);
  };
  for (let pass = 0; pass <= declarations.length + 1; pass++) {
    let changed = false;
    declarations.forEach((declaration, index) => {
      for (const [name, proof] of derive(declaration.id, declaration.value)) {
        const prior = values.get(index); if (!prior || !sameProof(prior, proof)) { values.set(index, proof); changed = true; }
        const existing = current.get(name); if (!existing || sameProof(existing, proof)) current.set(name, proof); else current.set(name, unknownProof(proof.method));
      }
    });
    if (!changed) break;
  }
  return current;
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
function semantics(method: string, proof: Proof | undefined, dynamic: boolean): Pick<Candidate, "operationClass" | "surface" | "scope" | "policyDisposition" | "decision" | "reason"> {
  if (dynamic) return { operationClass: "unknown.dynamic-mutation", surface: "unknown", scope: "unknown", policyDisposition: "unsupported", decision: "BLOCK", reason: "dynamic or computed mutation target cannot be proven" };
  if (completionMethods.has(method)) return { operationClass: "transport.completion", surface: "special", scope: "unknown", policyDisposition: "unsupported", decision: "BLOCK", reason: "transport completion is outside the single-file mutation proof" };
  const operation = operationClass(method); const allowed = Boolean(proof?.proven && proof?.module && proof?.method && reviewedAllowIdentityOracle[proof.module]?.has(proof.method) && operation.startsWith("local.single.regular-file."));
  return { operationClass: operation, surface: allowed ? "local" : "unknown", scope: allowed ? "single" : "unknown", policyDisposition: allowed ? "supported" : "unsupported", decision: allowed ? "ALLOW" : "BLOCK", ...(allowed ? {} : { reason: "mutation receiver or import has no exact approved module/export identity" }) };
}
function inspectCall(source: string, call: Ast, proofs: Map<string, Proof>): { method: string; token: string; offset: number; proof?: Proof; dynamic: boolean } | undefined {
  const callee = asAst(call.callee); if (!callee) return undefined;
  if (callee.type === "Identifier" && typeof callee.name === "string") {
    const proof = proofs.get(callee.name); const method = proof?.method ?? callee.name;
    if (!mutationMethods.has(method) && !isReviewedMutationExport(proof, method) && !isStructurallyProvenFsMutation(proof, method) && !completionMethods.has(method)) return undefined;
    return { method, token: callee.name, offset: callee.start ?? call.start ?? 0, proof, dynamic: false };
  }
  const member = memberParts(callee); if (!member) return undefined;
  const proof = member.object?.type === "Identifier" && typeof member.object.name === "string" ? proofs.get(member.object.name) : undefined;
  if (member.dynamic) {
    const start = callee.start ?? call.start ?? 0; const finish = callee.end ?? call.end ?? start;
    return { method: `${source.slice(member.object?.start ?? start, member.object?.end ?? start)}[dynamic]`, token: source.slice(start, finish), offset: start, proof, dynamic: true };
  }
  if (!member.name) return undefined;
  const method = member.name;
  if (!mutationMethods.has(method) && !isReviewedMutationExport(proof, method) && !isStructurallyProvenFsMutation(proof, method) && !completionMethods.has(method)) return undefined;
  const resolved = proof?.kind === "namespace" && proof.module ? moduleProof(proof.module, method) : unknownProof(method);
  return { method, token: member.name, offset: asAst(callee.property)?.start ?? callee.start ?? call.start ?? 0, proof: resolved, dynamic: false };
}
function symbolFromPath(pathNodes: Ast[]): string {
  const name = (value: unknown): string | undefined => astName(value);
  for (let index = pathNodes.length - 1; index >= 0; index--) {
    const current = pathNodes[index]!; const parent = index > 0 ? pathNodes[index - 1] : undefined;
    if (["ClassMethod", "ClassPrivateMethod", "ObjectMethod"].includes(current.type)) { const key = name(current.key); if (key) return key; }
    if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "TSDeclareFunction"].includes(current.type)) {
      const own = name(current.id); if (own) return own;
      if (parent?.type === "VariableDeclarator" && parent.init === current) { const variable = namesInPattern(asAst(parent.id)!).at(0); if (variable) return variable; }
      if (parent?.type === "ObjectProperty" && parent.value === current) { const key = name(parent.key); if (key) return key; }
    }
    if (["ClassDeclaration", "ClassExpression"].includes(current.type)) { const own = name(current.id); if (own) return own; }
  }
  return "<module>";
}
function enumerate(source: string, sourceHash = sha256(source), label = "audit-input.ts"): Candidate[] {
  const ast = parseAst(source, label); const proofs = resolveProofs(ast); const output: Candidate[] = []; const seen = new Set<string>();
  visitTree(ast, (current, parents) => {
    if (current.type !== "CallExpression" && current.type !== "OptionalCallExpression") return;
    const info = inspectCall(source, current, proofs); if (!info) return;
    const key = `${info.offset}\0${info.token}\0${info.method}`; if (seen.has(key)) return; seen.add(key);
    output.push({ method: info.method, token: info.token, offset: info.offset, module: info.proof?.module, export: info.proof?.method, ...semantics(info.method, info.proof, info.dynamic), symbol: symbolFromPath([...parents, current]), sourceFileHash: sourceHash });
  });
  return output;
}
function walkSourceFiles(): string[] {
  const packagesRoot = path.join(root, "packages");
  if (!fs.existsSync(packagesRoot)) return [];
  const result: string[] = [];
  for (const packageEntry of fs.readdirSync(packagesRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => compare(a.name, b.name))) {
    const sourceRoot = path.join(packagesRoot, packageEntry.name, "src");
    const pending = [sourceRoot];
    while (pending.length) {
      const directory = pending.pop()!;
      if (!fs.existsSync(directory)) continue;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) pending.push(absolute);
        else if (entry.isFile() && /\.(?:ts|tsx|js|jsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts") && !/\.min\.js$|\.generated\.ts$/.test(entry.name)) result.push(absolute);
      }
    }
  }
  return [...new Set(result)].map(file => path.relative(root, file).replaceAll("\\", "/")).sort(compare);
}
const comparedFields = ["method", "token", "offset", "module", "export", "operationClass", "surface", "scope", "policyDisposition", "decision", "symbol", "sourceFileHash", "reason"] as const;
function compareCandidate(candidate: Candidate, row: Row): string[] {
  return comparedFields.filter(field => String(row[field]) !== String(candidate[field])).map(field => `${field} expected ${String(candidate[field])} got ${String(row[field])}`);
}
function compareIndependentCandidate(candidate: Candidate, rows: Row[]): string[] {
  const key = `${candidate.offset}\0${candidate.token}\0${candidate.method}`;
  const matches = rows.filter(row => `${String(row.offset)}\0${String(row.token)}\0${String(row.method)}` === key);
  if (matches.length !== 1) return [`manifest does not contain exactly one semantic row for ${candidate.method}`];
  return compareCandidate(candidate, matches[0]!);
}
function verifyProducerMutation(candidate: Candidate, row: Row, sourcePath: string, field: "module" | "decision" | "surface", value: string, failures: string[]): void {
  const mutated = { ...row, [field]: value };
  if (compareCandidate(candidate, mutated).length === 0) failures.push(`${sourcePath}:${String(row.offset)}: producer ${field} mutation probe was accepted`);
  if (field === "module" && resolvesToReviewedAllowIdentity(mutated)) failures.push(`${sourcePath}:${String(row.offset)}: producer module mutation remained oracle-approved`);
}
function verifyProducerAllowRows(rowsBySource: Map<string, Row[]>, failures: string[]): void {
  for (const [sourcePath, rows] of rowsBySource) {
    for (const row of rows) {
      if (row.decision === "ALLOW" && !resolvesToReviewedAllowIdentity(row)) failures.push(`${sourcePath}:${String(row.offset)}: producer ALLOW row is not an exact reviewed module/export identity`);
    }
  }
}
function verifyFixtures(failures: string[]): number {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Fixture;
  if (fixture.format !== "quality-contract.callsite-audit-fixtures.v1" || !Array.isArray(fixture.cases)) { failures.push("reviewed fixture format is invalid"); return 0; }
  let count = 0;
  for (const item of fixture.cases) {
    const found = enumerate(String(item.source ?? ""), undefined, `fixture/${String(item.id ?? "unknown")}.ts`); count += found.length; const expected = item.expected ?? [];
    if (found.length !== expected.length) failures.push(`fixture ${String(item.id)} candidate count mismatch`);
    for (const expectedRow of expected) {
      const candidate = found.find(row => row.method === String(expectedRow.method) && (expectedRow.token === undefined || row.token === String(expectedRow.token)));
      if (!candidate) { failures.push(`fixture ${String(item.id)} omitted ${String(expectedRow.method)}`); continue; }
      for (const field of comparedFields.filter(name => name !== "offset" && name !== "symbol" && name !== "sourceFileHash" && name !== "reason")) if (expectedRow[field] !== undefined && String(candidate[field]) !== String(expectedRow[field])) failures.push(`fixture ${String(item.id)} ${field} mismatch`);
    }
  }
  return count;
}
const omissionProbeIds = ["producer-create-write-stream-row-delete", "producer-create-write-stream-row-corrupt", "producer-create-write-stream-inventory-omission", "producer-create-write-stream-collector-omission"] as const;
const omissionMutationKinds = ["row-delete", "row-corrupt", "producer-inventory-omission", "producer-collector-omission"] as const;
const commonModeFsFixture = {
  id: "unknown-future-fs-writer",
  source: [
    'import * as fs from "fs";',
    'import { futureWriter as directWriter } from "node:fs";',
    'import { futureWriter as promiseWriter } from "fs/promises";',
    'import * as fsp from "node:fs/promises";',
    'const { futureWriter: destructuredWriter } = fs;',
    "fs.futureWriter('namespace');",
    "directWriter('direct');",
    "promiseWriter('promise');",
    "destructuredWriter('destructured');",
    "fsp.futureWriter('aliased-namespace');",
  ].join("\n"),
};
function disposableArtifactFailures(manifest: Row, sourcePath: string, source: string): string[] {
  const candidates = enumerate(source, sha256(source), sourcePath);
  const rows = (Array.isArray(manifest.callsites) ? manifest.callsites : []) as Row[];
  return candidates.flatMap(candidate => compareIndependentCandidate(candidate, rows));
}
function verifyOmissionMutants(failures: string[]): OmissionProbe[] {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Fixture;
  const target = fixture.cases?.find(item => item.id === "raw-create-write-stream-forms");
  if (!target) { failures.push("executable omission fixture raw-create-write-stream-forms is missing"); return []; }
  const fixtureId = String(target.id);
  const source = String(target.source ?? "");
  const sourcePath = `fixture/${fixtureId}.ts`;
  const temporaryRoot = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "quality-contract-callsite-"));
  const artifactPath = path.join(temporaryRoot, "producer-manifest.json");
  const probes: OmissionProbe[] = [];
  const record = (id: typeof omissionProbeIds[number], mutation: typeof omissionMutationKinds[number], rows: Row[]): void => {
    const manifest = { sourceFiles: [{ path: sourcePath, sha256: sha256(source) }], callsites: rows };
    fs.writeFileSync(artifactPath, `${JSON.stringify(manifest)}\n`, "utf8");
    const observed = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as Row;
    const mismatches = disposableArtifactFailures(observed, sourcePath, source);
    const killed = mismatches.length > 0;
    const detail = mismatches[0] ?? `producer mutation ${id} crossed no auditor boundary`;
    probes.push({ id, fixtureId, method: "createWriteStream", token: "createWriteStream", mutation, outcome: killed ? "killed" : "survived", detail });
    if (!killed) failures.push(`${fixtureId}: ${id} survived`);
  };
  fs.mkdirSync(path.dirname(path.join(temporaryRoot, sourcePath)), { recursive: true });
  fs.writeFileSync(path.join(temporaryRoot, sourcePath), source, "utf8");
  const disposableSource = fs.readFileSync(path.join(temporaryRoot, sourcePath), "utf8");
  try {
    const producerRows = collectCallsites(sourcePath, disposableSource) as unknown as Row[];
    if (!producerRows.some(row => row.method === "createWriteStream")) failures.push(`${fixtureId}: producer emitted no createWriteStream rows`);
    record(omissionProbeIds[0], omissionMutationKinds[0], producerRows.filter(row => row.method !== "createWriteStream"));
    record(omissionProbeIds[1], omissionMutationKinds[1], producerRows.map(row => row.method === "createWriteStream" ? { ...row, decision: row.decision === "BLOCK" ? "ALLOW" : "BLOCK" } : row));
    const producerWithoutInventory = new Set([...rawMutationMethods].filter(method => method !== "createWriteStream"));
    const producerMutationMethods = new Set([...mutationMethods].filter(method => method !== "createWriteStream"));
    record(omissionProbeIds[2], omissionMutationKinds[2], collectCallsites(sourcePath, disposableSource, { rawMutationMethods: producerWithoutInventory, mutationMethods: producerMutationMethods }) as unknown as Row[]);
    record(omissionProbeIds[3], omissionMutationKinds[3], collectCallsites(sourcePath, disposableSource, { omitCollectedRows: true }) as unknown as Row[]);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  return probes;
}
function verifyFsCommonModeOmission(failures: string[]): { probe: OmissionProbe; count: number } {
  const source = commonModeFsFixture.source;
  const sourcePath = `fixture/${commonModeFsFixture.id}.ts`;
  const candidates = enumerate(source, sha256(source), sourcePath);
  const expectedModules = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);
  if (candidates.length !== 5 || candidates.some(candidate => candidate.decision !== "BLOCK" || !candidate.module || !expectedModules.has(candidate.module))) {
    failures.push(`${commonModeFsFixture.id}: namespace/direct/destructured/aliased future fs exports were not all BLOCK candidates`);
  }
  const rows = collectCallsites(sourcePath, source, { omitFsUnknownExports: true }) as unknown as Row[];
  const mismatches = disposableArtifactFailures({ callsites: rows }, sourcePath, source);
  const killed = mismatches.length > 0;
  const probe: OmissionProbe = {
    id: "auditor-oracle-unknown-fs-writer",
    fixtureId: commonModeFsFixture.id,
    method: "futureWriter",
    token: "futureWriter",
    mutation: "auditor-oracle-omission",
    outcome: killed ? "killed" : "survived",
    detail: mismatches[0] ?? "common-mode finite fs mutator oracle omission crossed no independent auditor boundary",
  };
  if (!killed) failures.push(`${commonModeFsFixture.id}: ${probe.id} survived`);
  return { probe, count: candidates.length };
}
export function runAudit(): AuditReport {
  const failures: string[] = [];
  const files = walkSourceFiles();
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Row;
  if (manifest.phase1Authorized !== false) failures.push("callsite manifest phase1Authorized must remain false");
  const listedRows = (Array.isArray(manifest.sourceFiles) ? manifest.sourceFiles : []) as Row[];
  const listed = listedRows.map(row => String(row.path)).sort(compare);
  if (listed.length !== files.length || listed.some((file, index) => file !== files[index])) failures.push("manifest source enumeration is incomplete or differs from independent walk");
  const sourceRows = new Map(listedRows.map(row => [String(row.path), row]));
  for (const sourcePath of files) {
    const bytes = fs.readFileSync(path.join(root, sourcePath));
    const row = sourceRows.get(sourcePath);
    if (!row) continue;
    if (Number(row.bytes) !== bytes.byteLength) failures.push(`${sourcePath}: manifest byte count differs from source`);
    if (String(row.sha256) !== sha256(bytes)) failures.push(`${sourcePath}: manifest source hash differs from source`);
  }
  const rowsBySource = new Map<string, Row[]>();
  for (const row of (Array.isArray(manifest.callsites) ? manifest.callsites : []) as Row[]) {
    const sourcePath = String(row.sourcePath); const rows = rowsBySource.get(sourcePath) ?? []; rows.push(row); rowsBySource.set(sourcePath, rows);
  }
  for (const sourcePath of rowsBySource.keys()) if (!files.includes(sourcePath)) failures.push(`${sourcePath}: manifest contains a callsite for an unenumerated source`);
  verifyProducerAllowRows(rowsBySource, failures);
  let checked = 0; let detected = 0;
  for (const sourcePath of files) {
    const source = fs.readFileSync(path.join(root, sourcePath), "utf8"); const independent = enumerate(source, sha256(source), sourcePath); const rows = rowsBySource.get(sourcePath) ?? []; detected += independent.length; checked += independent.length;
    const byKey = new Map<string, Row[]>();
    for (const row of rows) { const key = `${String(row.offset)}\0${String(row.token)}\0${String(row.method)}`; byKey.set(key, [...(byKey.get(key) ?? []), row]); }
    const confirmed = new Set<string>();
    for (const candidate of independent) {
      const key = `${candidate.offset}\0${candidate.token}\0${candidate.method}`; const matches = byKey.get(key) ?? [];
      if (matches.length !== 1) { failures.push(`${sourcePath}:${candidate.offset}: manifest does not contain exactly one semantic row for ${candidate.method}`); continue; }
      confirmed.add(key); const row = matches[0]!;
      for (const mismatch of compareCandidate(candidate, row)) failures.push(`${sourcePath}:${candidate.offset}: ${mismatch}`);
      if (row.decision === "ALLOW") {
        verifyProducerMutation(candidate, row, sourcePath, "module", "fake-session-writer", failures);
        verifyProducerMutation(candidate, row, sourcePath, "decision", "BLOCK", failures);
        verifyProducerMutation(candidate, row, sourcePath, "surface", "archive", failures);
      }
    }
    for (const [key, matches] of byKey) if (!confirmed.has(key)) for (const row of matches) failures.push(`${sourcePath}:${String(row.offset)}: manifest contains an unconfirmed callsite row`);
  }
  const omissionProbes = [...verifyOmissionMutants(failures)];
  const commonMode = verifyFsCommonModeOmission(failures); omissionProbes.push(commonMode.probe); detected += commonMode.count; checked += commonMode.count;
  const fixtureCount = verifyFixtures(failures); detected += fixtureCount; checked += fixtureCount;
  const sortedFailures = [...failures].sort(compare);
  const payload = JSON.stringify({ files, detected, checked, failures: sortedFailures, omissionProbes, manifestSha256: sha256(manifestBytes) });
  return { format: "quality-contract.callsite-audit-report.v3", sourceCount: files.length, candidateCount: detected, checked, failures: sortedFailures, omissionProbes, passed: failures.length === 0, phase1Authorized: false, payloadSha256: sha256(payload) };
}
function main(): void { const report = runAudit(); fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"); process.stdout.write(`${JSON.stringify(report)}\n`); if (!report.passed) process.exitCode = 1; }
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main();
