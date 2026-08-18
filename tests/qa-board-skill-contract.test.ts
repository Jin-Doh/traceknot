import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const skill = readFileSync(resolve(root, "skill/SKILL.md"), "utf8");
const boardReference = readFileSync(resolve(root, "skill/references/qa-board.md"), "utf8");
const completionReport = readFileSync(resolve(root, "skill/references/completion-report.md"), "utf8");
const boardDocs = readFileSync(resolve(root, "docs/qa-board.md"), "utf8");

test("portable Skill exposes conditional Board publication guidance", () => {
  expect(skill).toContain("references/qa-board.md");
  expect(skill).toContain("Board publication is separate from QA evaluation");
  expect(boardReference).toContain("Board status: generated | unavailable | disabled | not-requested");
  expect(boardReference).toContain("Do not hand-author a canonical Board manifest or fabricate a `file://` URI.");
  expect(boardReference).toContain("A Board publisher failure MUST NOT change a completed verification verdict.");
});

test("completion reports preserve Board publication separately from QA verdict", () => {
  expect(completionReport).toContain("17. Board publication status");
  expect(completionReport).toContain("Board URI: file://... | unavailable");
  expect(completionReport).toContain("Board publication failure MUST NOT change the QA verdict");
});

test("canonical Board documentation describes the Portable Skill boundary", () => {
  expect(boardDocs).toContain("## Portable Skill publication");
  expect(boardDocs).toContain("A Board remains `authoritative: false`");
  expect(boardDocs).toContain("report `unavailable`");
});
