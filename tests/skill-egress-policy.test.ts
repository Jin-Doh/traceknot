import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectSkillTree, normalizeRepositoryPath } from "../scripts/check-skill-egress";

function writeValidSkillTree(root: string): void {
  mkdirSync(join(root, "skill", "bin"), { recursive: true });
  mkdirSync(join(root, "skill", "references"), { recursive: true });
  writeFileSync(join(root, "skill", "SKILL.md"), "# Skill\n");
  writeFileSync(join(root, "skill", "bin", "traceknot"), "#!/usr/bin/env bun\n");
  chmodSync(join(root, "skill", "bin", "traceknot"), 0o755);
}
test("normalizes Windows repository paths to POSIX policy paths", () => {
  expect(normalizeRepositoryPath("skill\\references\\windows.md", "\\")).toBe("skill/references/windows.md");
});

describe("Skill egress artifact policy", () => {
  test("accepts the repository Skill tree", () => {
    expect(inspectSkillTree(process.cwd())).toEqual([]);
  });

  test("allows only the generated executable runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "traceknot-skill-egress-"));
    try {
      writeValidSkillTree(root);
      writeFileSync(join(root, "skill", "payload.sh"), "#!/bin/sh\n");
      chmodSync(join(root, "skill", "payload.sh"), 0o755);
      writeFileSync(join(root, "skill", "references", "payload.txt"), "data\n");
      const violations = inspectSkillTree(root);
      expect(violations.map(({ code, path }) => `${code}:${path}`)).toEqual([
        "UNEXPECTED_FILE:skill/payload.sh",
        "EXECUTABLE_FILE:skill/payload.sh",
        "UNEXPECTED_FILE:skill/references/payload.txt",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a non-executable generated runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "traceknot-skill-egress-"));
    try {
      writeValidSkillTree(root);
      chmodSync(join(root, "skill", "bin", "traceknot"), 0o644);
      expect(inspectSkillTree(root)).toContainEqual(expect.objectContaining({
        code: "NON_EXECUTABLE_RUNTIME",
        path: "skill/bin/traceknot",
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("requires every generated public contract and capability record", () => {
    const root = mkdtempSync(join(tmpdir(), "traceknot-skill-egress-"));
    try {
      writeValidSkillTree(root);
      mkdirSync(join(root, "contracts"), { recursive: true });
      mkdirSync(join(root, "adapters", "omp"), { recursive: true });
      writeFileSync(join(root, "contracts", "example.schema.json"), "{}\n");
      writeFileSync(join(root, "adapters", "omp", "capability.json"), "{}\n");
      expect(inspectSkillTree(root)).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "MISSING_GENERATED_ASSET", path: "skill/contracts/example.schema.json" }),
        expect.objectContaining({ code: "MISSING_GENERATED_ASSET", path: "skill/adapters/omp/capability.json" }),
      ]));

      mkdirSync(join(root, "skill", "contracts"), { recursive: true });
      mkdirSync(join(root, "skill", "adapters", "omp"), { recursive: true });
      writeFileSync(join(root, "skill", "contracts", "example.schema.json"), "{}\n");
      writeFileSync(join(root, "skill", "adapters", "omp", "capability.json"), "{}\n");
      expect(inspectSkillTree(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects POSIX backslash names and undeclared artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "traceknot-skill-egress-"));
    try {
      writeValidSkillTree(root);
      writeFileSync(join(root, "skill", "references\\payload.md"), "data\n");
      writeFileSync(join(root, "skill", "references", "orphan.md"), "data\n");
      const violations = inspectSkillTree(root);
      expect(violations).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "UNSAFE_PATH_NAME", path: "skill/references\\payload.md" }),
        expect.objectContaining({ code: "UNEXPECTED_FILE", path: "skill/references\\payload.md" }),
        expect.objectContaining({ code: "UNEXPECTED_FILE", path: "skill/references/orphan.md" }),
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects symlinks and special Skill roots", () => {
    const root = mkdtempSync(join(tmpdir(), "traceknot-skill-egress-"));
    try {
      writeValidSkillTree(root);
      symlinkSync("SKILL.md", join(root, "skill", "references", "link.md"));
      const violations = inspectSkillTree(root);
      expect(violations).toContainEqual(expect.objectContaining({
        code: "UNSAFE_ENTRY_TYPE",
        path: "skill/references/link.md",
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails when the Skill entrypoint is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "traceknot-skill-egress-"));
    try {
      mkdirSync(join(root, "skill", "references"), { recursive: true });
      expect(inspectSkillTree(root)).toContainEqual(expect.objectContaining({
        code: "MISSING_SKILL",
        path: "skill/SKILL.md",
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
