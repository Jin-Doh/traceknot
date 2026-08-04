import { describe, expect, test } from "bun:test";
import { checkPublicationInventory, checkReadmeDocumentationLinks, checkReadmeLanguageNavigation, checkReadmeLocalLinks, checkReadmeSections, checkReadmeSharedCommands } from "../scripts/check-readme-contract";

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

  test("parses multiline reference-link destinations", () => {
    expect(() => checkReadmeLocalLinks({
      path: "README.md",
      content: "[guide][g]\n\n[g]:\n  docs/not-here.md",
    })).toThrow("docs/not-here.md");
  });

  test("rejects missing unquoted HTML targets", () => {
    expect(() => checkReadmeLocalLinks({ path: "README.md", content: "<img src=assets/not-here.png>" })).toThrow("local link does not exist");
  });

  test("parses balanced Markdown destinations and uppercase HTML attributes", () => {
    expect(() => checkReadmeLocalLinks({ path: "README.md", content: "[guide](docs/not-here(v2).md)" })).toThrow(
      "docs/not-here(v2).md",
    );
    expect(() => checkReadmeLocalLinks({ path: "README.md", content: '<IMG SRC="assets/not-here.png">' })).toThrow(
      "local link does not exist",
    );
  });

  test("accepts angle-bracket external links and ignores non-link Markdown grammar", () => {
    expect(() => checkReadmeLocalLinks({
      path: "README.md",
      content: "[site](<https://example.com>)\n`[literal](docs/not-here.md)`\n`` `[literal](docs/not-here.md)` ``\n\\](docs/not-here.md)",
    })).not.toThrow();
  });

  test("accepts case-insensitive external schemes", () => {
    expect(() => checkReadmeLocalLinks({
      path: "README.md",
      content: "[site](HTTPS://example.com) [mail](MAILTO:test@example.com)",
    })).not.toThrow();
  });

  test("accepts every syntactically valid external URI scheme", () => {
    expect(() => checkReadmeLocalLinks({ path: "README.md", content: "[archive](ftp://example.com/file)" })).not.toThrow();
  });

  test("requires rendered language-navigation links", () => {
    const commented = "<!-- [English](README.md) [한국어](README.ko.md) [简体中文](README.zh.md) -->";
    expect(() => checkReadmeLanguageNavigation("README.md", commented)).toThrow("missing language link");
    const visible = "[English](README.md) [한국어](README.ko.md) [简体中文](README.zh.md)";
    expect(() => checkReadmeLanguageNavigation("README.md", visible)).not.toThrow();
  });

  test("extracts HTML URL attributes only from visible tags", () => {
    expect(() => checkReadmeLocalLinks({
      path: "README.md",
      content: "The src=docs/not-here.md token is illustrative.\n<!-- <img src=docs/not-here.md> -->",
    })).not.toThrow();
    expect(() => checkReadmeLocalLinks({ path: "README.md", content: "<img\n src=docs/not-here.md>" })).toThrow(
      "docs/not-here.md",
    );
  });

  test.each([
    '<video poster="assets/not-here.png">',
    '<img srcset="assets/not-here.png 1x, assets/also-missing.png 2x">',
  ])("validates URL-bearing HTML attributes: %s", (content) => {
    expect(() => checkReadmeLocalLinks({ path: "README.md", content })).toThrow("local link does not exist");
  });

  test("ignores link-shaped text in nested and indented Markdown code", () => {
    const content = "> ```md\n> [literal](docs/not-here.md)\n> ```\n\n    [indented](docs/not-here.md)";
    expect(() => checkReadmeLocalLinks({ path: "README.md", content })).not.toThrow();
  });

  test("keeps indented paragraph-continuation links visible", () => {
    const content = "Paragraph text\n    [guide](docs/not-here.md)";
    expect(() => checkReadmeLocalLinks({ path: "README.md", content })).toThrow("docs/not-here.md");
  });

  test("masks multiline Markdown code spans before link validation", () => {
    const content = "`sample starts\n[literal](docs/not-here.md)\nends`";
    expect(() => checkReadmeLocalLinks({ path: "README.md", content })).not.toThrow();
  });

  test("parses srcset candidates after a data URL", () => {
    const content = '<img srcset="data:image/png;base64,AAAA 1x, assets/not-here.png 2x">';
    expect(() => checkReadmeLocalLinks({ path: "README.md", content })).toThrow("assets/not-here.png");
  });

  test("requires a real balanced Markdown label before validating a destination", () => {
    expect(() => checkReadmeLocalLinks({ path: "README.md", content: "[outer [inner]](docs/not-here.md)" })).toThrow(
      "docs/not-here.md",
    );
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

  test("rejects every bare or duplicate reserved shared-command marker", () => {
    const bare = "<!-- shared-command:translation-only -->";
    expect(() => checkReadmeSharedCommands([{ path: "README.md", content: bare }])).toThrow(
      "must be followed by a fenced block",
    );
    expect(() => checkReadmeSharedCommands([{ path: "README.md", content: `${bare}\n${bare}` }])).toThrow(
      "must appear exactly once",
    );
  });

  test("requires a line-anchored matching shared-command closing fence", () => {
    const malformed = "<!-- shared-command:ci -->\n\n```sh\necho ok\n```not-a-closing-fence";
    expect(() => checkReadmeSharedCommands([{ path: "README.md", content: malformed }])).toThrow(
      "must be followed by a fenced block",
    );
  });
});
