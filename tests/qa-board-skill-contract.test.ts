import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const skill = readFileSync(resolve(root, "skill/SKILL.md"), "utf8");
const boardReference = readFileSync(resolve(root, "skill/references/qa-board.md"), "utf8");
const completionReport = readFileSync(resolve(root, "skill/references/completion-report.md"), "utf8");
const boardDocs = readFileSync(resolve(root, "docs/qa-board.md"), "utf8");
const readme = readFileSync(resolve(root, "README.md"), "utf8");

const boardUpdateCommand = "traceknot board update";
const requiredBoardFields = [
  "Board requested: yes",
  "Board status: generated | unavailable | disabled",
  "Board URI: file://... | unavailable",
  "Board manifest: path | unavailable",
  "Board session key: s-<sha256(sessionHost + NUL + sessionId)> | unavailable",
  "Board source revision: identifier | unavailable",
  "Board invocation ID: identifier | unavailable",
  "Board publisher: canonical-cli | host-integrated | none",
  "Board limitation: reason | none",
] as const;

function expectCanonicalSkillPayload(content: string): void {
  expect(content).toContain("npx skills add Jin-Doh/traceknot --skill traceknot --global");
  expect(content).toContain("npx skills update traceknot --global --yes");
  expect(content).toContain("skill/bin/traceknot");
  expect(content).toContain("$HOME/.agents/skills/traceknot/bin/traceknot");
  expect(content).toMatch(/(?:^|[\s`])\.agents\/skills\/traceknot\/bin\/traceknot/);
  expect(content).toContain("Bun 1.3.14");
  expect(content).toContain("traceknot self-check");
  expect(content).toContain(".agents/skills/traceknot/bin/traceknot self-check");
  expect(content).toContain("libc.so.6");
}

function expectCanonicalBoardInterface(content: string): void {
  expect(content).toContain(boardUpdateCommand);
  for (const flag of ["--input UPDATE.json", "--state-dir DIR", "[--artifact-dir DIR]", "[--open-board]", "[--no-notify]"]) {
    expect(content).toContain(flag);
  }
  expect(content).toContain("traceknot-session-board-update/v1");
  expect(content).toContain("session-key = s-<sha256(sessionHost + NUL + sessionId)>");
  expect(content).toContain("Traceknot Board: file://.../sessions/<session-key>/index.html");
  expect(content).toContain("authoritative: false");
  expect(content).toContain("boardMaxPerSession");
  expect(content).toContain("Board status: unavailable");
  expect(content).toContain("MUST NOT change the QA verdict");
  expect(content).toContain(".agents/skills/traceknot/bin/traceknot board update");
  expect(content).toContain("at least eight characters");
}

test("canonical Skill payload includes the runnable CLI and update path", () => {
  expectCanonicalSkillPayload(skill);
  expectCanonicalSkillPayload(boardReference);
});

test("canonical Board publication uses one session-scoped interface", () => {
  expectCanonicalBoardInterface(skill);
  expectCanonicalBoardInterface(boardReference);
});

test("Board publication preserves authority and unavailable behavior", () => {
  expect(skill).toContain("The Board declares `authoritative: false`");
  expect(boardReference).toContain("declares `authoritative: false`");
});

test("completion reports have exactly one Board field set", () => {
  for (const field of requiredBoardFields) expect(completionReport).toContain(field);
  for (const label of ["Board requested:", "Board URI:", "Board manifest:", "Board session key:", "Board source revision:", "Board invocation ID:", "Board publisher:", "Board limitation:"]) {
    expect(completionReport.match(new RegExp(label, "gu"))).toHaveLength(1);
  }
  expect(completionReport.match(/Board status:/gu)).toHaveLength(2);
  expect(completionReport).not.toContain("Board run ID:");
  expect(completionReport).not.toContain("Board location:");
  expect(completionReport).not.toContain("Board authority:");
  expect(completionReport).not.toContain("Portable Board");
});

test("canonical Board reference owns renderer requirements", () => {
  expect(boardReference).toContain("The stable manifest is the one Board manifest");
  expect(boardReference).toContain("The renderer MUST NOT create an alternate manifest, status namespace");
  expect(boardReference).not.toContain("traceknot-portable-board/v1");
  expect(boardReference).not.toContain("Portable Board status");
  expect(boardReference).not.toContain("Portable Board location");
  expect(boardReference).not.toContain("Portable Board manifest");
});

test("public documentation forbids split installation and Board modes", () => {
  const documents = [skill, boardReference, completionReport];
  for (const document of documents) {
    expect(document).not.toMatch(/Skills-only|Skill-only|Portable Board|portable Skill|Portable Skill|full-toolkit/iu);
    expect(document).not.toMatch(/Portable Board (?:status|location|manifest|publisher|authority|limitation)/iu);
  }
});

test("public docs mirror the canonical Skill and Board contracts", () => {
  expectCanonicalSkillPayload(readme);
  expectCanonicalBoardInterface(boardDocs);
  expect(boardDocs).toContain("The unavailable Board status does not change the QA verdict or evidence.");
  for (const document of [boardDocs, readme]) {
    expect(document).not.toMatch(/Skills-only|Skill-only|Portable Board|portable Skill|Portable Skill/iu);
    expect(document).not.toMatch(/Portable Board (?:status|location|manifest|publisher|authority|limitation)/iu);
  }
  expect(boardDocs).not.toContain("full-toolkit");
});

test("public Board privacy contract matches boundary-aware runtime semantics", () => {
  expect(skill).toContain("standalone value or boundary-delimited token");
  expect(skill).toContain("incidental substring embedded inside a larger");
  expect(boardReference).toContain("boundary-delimited identity token");
  expect(boardReference).toContain("incidental byte substring inside a larger");
  expect(boardDocs).toContain("identity token, not as a forbidden byte substring");
  expect(boardDocs).toContain("incidental occurrence embedded inside a larger");
  expect(skill).not.toContain("never stores the raw session ID");
  expect(boardReference).not.toContain("The raw session ID MUST NOT appear in a path, manifest, page, or log.");
  expect(boardDocs).not.toContain("The raw session ID is never stored in paths, manifests, HTML, or logs.");
});

test("public retention contract requires destructive reclaim preflight", () => {
  for (const document of [skill, boardReference, boardDocs]) expect(document).toMatch(/preflight/iu);
  expect(boardReference).toContain("before any selected revision is mutated");
  expect(boardDocs).toContain("before any selected revision is mutated");
});