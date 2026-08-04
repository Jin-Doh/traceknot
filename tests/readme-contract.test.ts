import { describe, expect, test } from "bun:test";
import { checkReadmeSections } from "../scripts/check-readme-contract";

const sections = [
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

function readmeWith(order: readonly string[]): string {
  return order.map((section) => `<!-- readme-section:${section} -->\n## ${section}`).join("\n");
}

describe("README localization section contract", () => {
  test("accepts the declared section order", () => {
    expect(() => checkReadmeSections("README.md", readmeWith(sections))).not.toThrow();
  });

  test("rejects a complete but reordered section sequence", () => {
    const reordered = [sections[0], sections[1], sections[6], ...sections.slice(2, 6), ...sections.slice(7)];
    expect(() => checkReadmeSections("README.zh.md", readmeWith(reordered))).toThrow("section order must be");
  });
});
