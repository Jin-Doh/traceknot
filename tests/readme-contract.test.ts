import { describe, expect, test } from "bun:test";
import { checkPublicationInventory, checkReadmeDocumentationLinks, checkReadmeLocalLinks, checkReadmeSections, checkReadmeSharedCommands } from "../scripts/check-readme-contract";

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

  test("rejects a translation that drops or replaces a canonical documentation link", () => {
    const canonical = "[Architecture](docs/architecture.md) [Trust](docs/trust-model.md)";
    const translated = "[Architecture](https://example.com/architecture) [Trust](docs/trust-model.md)";
    expect(() => checkReadmeDocumentationLinks("README.md", canonical, "README.zh.md", translated)).toThrow(
      "missing documentation links from README.md: docs/architecture.md",
    );
  });

  test("accepts an explicitly declared localized documentation alternative", () => {
    expect(() =>
      checkReadmeDocumentationLinks("README.md", "[Brand](BRAND.md)", "README.ko.md", "[브랜드](BRAND.ko.md)"),
    ).not.toThrow();
  });

  test("rejects absolute and parent-relative links that escape the repository", () => {
    expect(() => checkReadmeLocalLinks({ path: "README.md", content: "[host file](/etc/passwd)" })).toThrow(
      "local link escapes repository",
    );
    expect(() => checkReadmeLocalLinks({ path: "README.md", content: "[parent](../../../../etc/passwd)" })).toThrow(
      "local link escapes repository",
    );
  });

  test("rejects missing reference-style and single-quoted HTML targets", () => {
    expect(() => checkReadmeLocalLinks({ path: "README.md", content: "[guide][g]\n\n[g]: docs/not-here.md" })).toThrow("local link does not exist");
    expect(() => checkReadmeLocalLinks({ path: "README.md", content: "<img src='assets/not-here.png'>" })).toThrow("local link does not exist");
  });

  test("rejects missing unquoted HTML targets", () => {
    expect(() => checkReadmeLocalLinks({ path: "README.md", content: "<img src=assets/not-here.png>" })).toThrow("local link does not exist");
  });

  test("rejects exclusions that narrow the publication inventory", () => {
    expect(() => checkPublicationInventory({ include: ["**/*.md"], exclude: ["docs/**"] })).toThrow(
      "cannot exclude Markdown files",
    );
  });

  test("rejects unpaired shared-command markers", () => {
    const block = (name: string) => `<!-- shared-command:${name} -->\n\n\`\`\`sh\necho ok\n\`\`\``;
    const canonical = ["skill-install", "full-toolkit-install", "full-toolkit-pinned-install", "full-toolkit-uninstall", "full-toolkit-custom-uninstall", "ci"].map(block).join("\n");
    expect(() => checkReadmeSharedCommands([
      { path: "README.md", content: canonical },
      { path: "README.ko.md", content: `${canonical}\n${block("translation-only")}` },
    ])).toThrow("shared command marker set differs");
  });
});
