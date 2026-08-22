import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

export type SkillEgressViolationCode =
  | "MISSING_SKILL"
  | "MISSING_REFERENCE"
  | "MISSING_RUNTIME"
  | "MISSING_GENERATED_ASSET"
  | "UNSAFE_ENTRY_TYPE"
  | "UNSAFE_PATH_NAME"
  | "UNEXPECTED_DIRECTORY"
  | "UNEXPECTED_FILE"
  | "EXECUTABLE_FILE"
  | "NON_EXECUTABLE_RUNTIME"
  | "NORMALIZED_PATH_COLLISION";

export interface SkillEgressViolation {
  code: SkillEgressViolationCode;
  path: string;
  message: string;
}

const ALLOWED_MARKDOWN = /^skill\/(?:SKILL\.md|references\/[a-z0-9][a-z0-9._-]*\.md)$/u;
const ALLOWED_SCHEMA = /^skill\/contracts\/[a-z0-9][a-z0-9._-]*\.schema\.json$/u;
const ALLOWED_ADAPTER = /^skill\/adapters\/[a-z0-9][a-z0-9._-]*\/capability\.json$/u;
const RUNTIME_PATHS = new Set(["skill/bin/traceknot", "skill/bin/traceknot-skills-update"]);
const REFERENCE_LINK = /references\/([a-z0-9][a-z0-9._-]*\.md)/gu;
const LOCAL_REFERENCE_LINK = /\]\((?:\.\/)?([a-z0-9][a-z0-9._-]*\.md)(?:#[^)]+)?\)/gu;
const RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

export function normalizeRepositoryPath(path: string, platformSeparator: string = sep): string {
  return platformSeparator === "/" ? path : path.split(platformSeparator).join("/");
}

function repositoryPath(root: string, path: string): string {
  return normalizeRepositoryPath(relative(root, path));
}

function declaredArtifactFiles(projectRoot: string): ReadonlySet<string> {
  const declared = new Set<string>(["skill/SKILL.md", ...RUNTIME_PATHS]);
  const pending = ["skill/SKILL.md"];
  const scanned = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (scanned.has(path)) continue;
    scanned.add(path);
    let source: string;
    try {
      source = readFileSync(resolve(projectRoot, path), "utf8");
    } catch {
      if (path === "skill/SKILL.md") return declared;
      continue;
    }
    const links = path === "skill/SKILL.md" ? source.matchAll(REFERENCE_LINK) : source.matchAll(LOCAL_REFERENCE_LINK);
    for (const match of links) {
      const reference = `skill/references/${match[1]}`;
      if (!declared.has(reference)) pending.push(reference);
      declared.add(reference);
    }
  }
  try {
    for (const entry of readdirSync(resolve(projectRoot, "contracts"), { withFileTypes: true })) {
      if (entry.isFile() && /^[a-z0-9][a-z0-9._-]*\.schema\.json$/u.test(entry.name)) declared.add(`skill/contracts/${entry.name}`);
    }
  } catch {
    // A source checkout without public contracts cannot declare generated contract assets.
  }
  try {
    for (const entry of readdirSync(resolve(projectRoot, "adapters"), { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9._-]*$/u.test(entry.name)) continue;
      const capability = resolve(projectRoot, "adapters", entry.name, "capability.json");
      try {
        if (lstatSync(capability).isFile()) declared.add(`skill/adapters/${entry.name}/capability.json`);
      } catch {
        // Adapter support code without a public capability record is not distributed.
      }
    }
  } catch {
    // A source checkout without adapter declarations cannot declare generated adapter assets.
  }
  return declared;
}

function declaredArtifactDirectories(declaredFiles: ReadonlySet<string>): ReadonlySet<string> {
  const directories = new Set<string>(["skill", "skill/bin", "skill/references"]);
  for (const file of declaredFiles) {
    for (let directory = dirname(file); directory !== "." && directory !== "skill"; directory = dirname(directory)) directories.add(directory);
  }
  return directories;
}

function unsafePortablePath(path: string): boolean {
  return path.split("/").some((segment) =>
    segment.length === 0
    || segment.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(segment)
    || /[ .]$/u.test(segment)
    || RESERVED_BASENAME.test(segment)
    || segment.includes(":"),
  );
}

export function inspectSkillTree(root: string): readonly SkillEgressViolation[] {
  const projectRoot = resolve(root);
  const skillRoot = resolve(projectRoot, "skill");
  const declaredFiles = declaredArtifactFiles(projectRoot);
  const declaredDirectories = declaredArtifactDirectories(declaredFiles);
  const normalizedPaths = new Map<string, string>();
  const violations: SkillEgressViolation[] = [];
  let skillStat;
  try {
    skillStat = lstatSync(skillRoot);
  } catch {
    return [{ code: "MISSING_SKILL", path: "skill", message: "Skill directory is missing" }];
  }
  if (!skillStat.isDirectory() || skillStat.isSymbolicLink()) {
    return [{ code: "UNSAFE_ENTRY_TYPE", path: "skill", message: "Skill root must be a regular directory" }];
  }

  const visit = (absolutePath: string): void => {
    const path = repositoryPath(projectRoot, absolutePath);
    if (unsafePortablePath(path)) {
      violations.push({
        code: "UNSAFE_PATH_NAME",
        path,
        message: "Skill paths must use safe POSIX-compatible names",
      });
    }
    const normalized = path.normalize("NFC").toLocaleLowerCase("en-US");
    const previous = normalizedPaths.get(normalized);
    if (previous !== undefined && previous !== path) {
      violations.push({
        code: "NORMALIZED_PATH_COLLISION",
        path,
        message: `path collides with ${previous} after case and Unicode normalization`,
      });
    } else {
      normalizedPaths.set(normalized, path);
    }

    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      violations.push({ code: "UNSAFE_ENTRY_TYPE", path, message: "symlinks and special filesystem entries are forbidden" });
      return;
    }
    if (stat.isDirectory()) {
      if (!declaredDirectories.has(path)) {
        violations.push({ code: "UNEXPECTED_DIRECTORY", path, message: "Skill directories must contain only declared runtime, contract, adapter, or reference assets" });
      }
      for (const entry of readdirSync(absolutePath).sort()) visit(resolve(absolutePath, entry));
      return;
    }
    const runtime = RUNTIME_PATHS.has(path);
    const allowedFileType = ALLOWED_MARKDOWN.test(path) || ALLOWED_SCHEMA.test(path) || ALLOWED_ADAPTER.test(path) || runtime;
    if (!allowedFileType || !declaredFiles.has(path)) {
      violations.push({ code: "UNEXPECTED_FILE", path, message: "Skill artifacts must be declared references or generated runtime assets" });
    }
    const executable = (stat.mode & 0o111) !== 0;
    if (runtime && !executable) {
      violations.push({ code: "NON_EXECUTABLE_RUNTIME", path, message: "generated Skill runtime must be executable" });
    } else if (!runtime && executable) {
      violations.push({ code: "EXECUTABLE_FILE", path, message: "non-runtime Skill artifacts must not be executable" });
    }
  };

  for (const entry of readdirSync(skillRoot).sort()) visit(resolve(skillRoot, entry));
  for (const declaredFile of declaredFiles) {
    if (declaredFile === "skill/SKILL.md" || RUNTIME_PATHS.has(declaredFile)) continue;
    if (!normalizedPaths.has(declaredFile.toLocaleLowerCase("en-US"))) {
      const reference = declaredFile.startsWith("skill/references/");
      violations.push({
        code: reference ? "MISSING_REFERENCE" : "MISSING_GENERATED_ASSET",
        path: declaredFile,
        message: reference ? "declared Skill reference is missing from the artifact tree" : "generated Skill asset is missing from the artifact tree",
      });
    }
  }
  for (const runtimePath of RUNTIME_PATHS) {
    if (!normalizedPaths.has(runtimePath.toLocaleLowerCase("en-US"))) {
      violations.push({ code: "MISSING_RUNTIME", path: runtimePath, message: "generated Skill runtime is missing from the artifact tree" });
    }
  }
  if (!normalizedPaths.has("skill/SKILL.md".toLocaleLowerCase("en-US"))) {
    violations.push({ code: "MISSING_SKILL", path: "skill/SKILL.md", message: "portable Skill entrypoint is missing" });
  }
  return Object.freeze(violations.map((violation) => Object.freeze(violation)));
}

if (import.meta.main) {
  try {
    const root = process.argv[2] === undefined ? process.cwd() : resolve(process.argv[2]);
    const violations = inspectSkillTree(root);
    for (const violation of violations) {
      process.stderr.write(`SEC-P0-004 ${violation.code} ${violation.path}: ${violation.message}\n`);
    }
    if (violations.length > 0) {
      process.stderr.write(`Skill egress policy: FAIL violations=${violations.length}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write("Skill egress policy: PASS violations=0\n");
    }
  } catch (error) {
    process.stderr.write(`Skill egress policy: ERROR ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
