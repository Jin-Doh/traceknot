import { lstatSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

export type SkillEgressViolationCode =
  | "MISSING_SKILL"
  | "UNSAFE_ENTRY_TYPE"
  | "UNEXPECTED_DIRECTORY"
  | "UNEXPECTED_FILE"
  | "EXECUTABLE_FILE"
  | "NORMALIZED_PATH_COLLISION";

export interface SkillEgressViolation {
  code: SkillEgressViolationCode;
  path: string;
  message: string;
}

const ALLOWED_DIRECTORIES: Readonly<Record<string, true>> = {
  skill: true,
  "skill/references": true,
};
const ALLOWED_FILE = /^skill\/(?:SKILL\.md|references\/[^/]+\.md)$/u;

function repositoryPath(root: string, path: string): string {
  return relative(root, path).replaceAll("\\", "/");
}

export function inspectSkillTree(root: string): readonly SkillEgressViolation[] {
  const projectRoot = resolve(root);
  const skillRoot = resolve(projectRoot, "skill");
  const violations: SkillEgressViolation[] = [];
  const normalizedPaths = new Map<string, string>();
  let skillStat;
  try {
    skillStat = lstatSync(skillRoot);
  } catch {
    return [{ code: "MISSING_SKILL", path: "skill", message: "portable Skill directory is missing" }];
  }
  if (!skillStat.isDirectory() || skillStat.isSymbolicLink()) {
    return [{ code: "UNSAFE_ENTRY_TYPE", path: "skill", message: "portable Skill root must be a regular directory" }];
  }

  const visit = (absolutePath: string): void => {
    const path = repositoryPath(projectRoot, absolutePath);
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
      if (ALLOWED_DIRECTORIES[path] === undefined) {
        violations.push({ code: "UNEXPECTED_DIRECTORY", path, message: "only skill/references may exist below skill" });
      }
      for (const entry of readdirSync(absolutePath).sort()) visit(resolve(absolutePath, entry));
      return;
    }
    if (!ALLOWED_FILE.test(path)) {
      violations.push({ code: "UNEXPECTED_FILE", path, message: "portable Skill artifacts must be approved Markdown files" });
    }
    if ((stat.mode & 0o111) !== 0) {
      violations.push({ code: "EXECUTABLE_FILE", path, message: "portable Skill artifacts must not be executable" });
    }
  };

  for (const entry of readdirSync(skillRoot).sort()) visit(resolve(skillRoot, entry));
  if (!normalizedPaths.has("skill/skill.md")) {
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
