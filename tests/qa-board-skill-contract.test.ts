import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const skill = readFileSync(resolve(root, "skill/SKILL.md"), "utf8");
const boardReference = readFileSync(resolve(root, "skill/references/qa-board.md"), "utf8");
const completionReport = readFileSync(resolve(root, "skill/references/completion-report.md"), "utf8");
const boardDocs = readFileSync(resolve(root, "docs/qa-board.md"), "utf8");

test("portable Skill enables Board publication by default", () => {
  expect(skill).toContain("Every Traceknot QA run has Board publication enabled by default");
  expect(skill).toContain("It MUST NOT silently use `not-requested`");
  expect(skill).toContain("`--no-board` is the explicit opt-out");
  expect(boardReference).toContain("Every Traceknot QA run has Board publication enabled by default.");
  expect(boardReference).toContain("A missing prerequisite produces `Board status: unavailable`");
  expect(boardReference).toContain("Do not hand-author a canonical Board manifest or fabricate a `file://` URI.");
  expect(boardReference).toContain("A Board publisher failure MUST NOT change a completed verification verdict.");
});

test("completion reports require Board publication status on every QA run", () => {
  expect(completionReport).toContain("17. Board publication status for every Traceknot QA run.");
  expect(completionReport).toContain("Board requested: yes");
  expect(completionReport).toContain("Board status: generated | unavailable | disabled");
  expect(completionReport).toContain("do not downgrade it to `not-requested`");
  expect(completionReport).toContain("Board publication failure MUST NOT change the QA verdict");
});

test("canonical Board documentation describes default publication", () => {
  expect(boardDocs).toContain("Every Traceknot QA run has Board publication enabled by default.");
  expect(boardDocs).toContain("reserve `disabled` for an explicit `--no-board`");
  expect(boardDocs).toContain("A Board remains `authoritative: false`");
});
