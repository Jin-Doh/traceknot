import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkOperationalCommandBlocks, checkPublicationInventory, checkReadmeBoundaries, checkReadmeDocumentationLinks, checkReadmeLanguageNavigation, checkReadmeLifecycleContract, checkReadmeLocalLinks, checkReadmeSections, checkReadmeSharedCommands, renderedMarkdownText } from "../scripts/check-readme-contract";

const root = resolve(import.meta.dir, "..");
const localizedReadmes = [
  readFileSync(resolve(root, "README.md"), "utf8"),
  readFileSync(resolve(root, "README.ko.md"), "utf8"),
  readFileSync(resolve(root, "README.zh.md"), "utf8"),
] as const;
const automaticUpdates = readFileSync(resolve(root, "docs/automatic-updates.md"), "utf8");

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

  test("requires authority boundaries in rendered prose rather than comments or fenced examples", () => {
    const command = "<!-- shared-command:skill-install -->\n```sh\nnpx skills add Jin-Doh/traceknot --skill traceknot --global\n```";
    expect(() => checkReadmeBoundaries("README.md", `${command}\n\`authoritative: false\`\n\`phase1Authorized: false\``)).not.toThrow();
    expect(() => checkReadmeBoundaries(
      "README.md",
      `${command}\n<!-- authoritative: false -->\n\`phase1Authorized: false\``,
    )).toThrow("missing rendered public boundary literal authoritative: false");
    expect(() => checkReadmeBoundaries(
      "README.md",
      `${command}\n\`authoritative: false\`\n\`\`\`text\nphase1Authorized: false\n\`\`\``,
    )).toThrow("missing rendered public boundary literal phase1Authorized: false");
    expect(() => checkReadmeBoundaries(
      "README.md",
      `${command}\n<span hidden>authoritative: false phase1Authorized: false</span>`,
    )).toThrow("missing rendered public boundary literal authoritative: false");
    expect(() => checkReadmeBoundaries(
      "README.md",
      `${command}\nauthoritative: false<br>phase1Authorized: false`,
    )).not.toThrow();
  });

  test("requires the public install command in the parsed shared block", () => {
    const hidden = "<!-- npx skills add Jin-Doh/traceknot --skill traceknot --global -->";
    const wrongBlock = "<!-- shared-command:skill-install -->\n```sh\necho hidden\n```";
    expect(() => checkReadmeBoundaries(
      "README.md",
      `${hidden}\n${wrongBlock}\n\`authoritative: false\`\n\`phase1Authorized: false\``,
    )).toThrow("skill-install command must be");
  });

  test.each([
    "```md\n<!-- readme-section:hero -->\n```",
    "`<!-- readme-section:hero -->`",
  ])("does not count section markers inside code: %s", (hiddenMarker) => {
    const visible = readmeWith(sections.slice(1));
    expect(() => checkReadmeSections("README.md", `${hiddenMarker}\n${visible}`)).toThrow(
      "section hero must appear exactly once, found 0",
    );
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
    expect(() => checkReadmeLocalLinks({ path: "README.md", content: "<img src=not-here.png>" })).toThrow("local link does not exist");
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

  test("accepts scheme-relative network targets", () => {
    expect(() => checkReadmeLocalLinks({
      path: "README.md",
      content: "[site](//example.com/path) <img src=//cdn.example.com/image.png>",
    })).not.toThrow();
  });

  test("requires rendered language-navigation links", () => {
    const commented = "<!-- [English](README.md) [한국어](README.ko.md) [简体中文](README.zh.md) -->";
    expect(() => checkReadmeLanguageNavigation("README.md", commented)).toThrow("missing language link");
    const visible = "[English](README.md) [한국어](README.ko.md) [简体中文](README.zh.md)";
    expect(() => checkReadmeLanguageNavigation("README.md", visible)).not.toThrow();
  });

  test("normalizes repository-relative language-navigation targets", () => {
    const visible = "[English](./README.md) [한국어](README.%6Bo.md) [简体中文](./README.zh.md?view=1#top)";
    expect(() => checkReadmeLanguageNavigation("README.md", visible)).not.toThrow();
  });

  test("does not accept hidden raw-HTML language navigation", () => {
    const content = "[English](README.md) [한국어](README.ko.md) <a hidden href=\"README.zh.md\">简体中文</a>";
    expect(() => checkReadmeLanguageNavigation("README.md", content)).toThrow("missing language link to README.zh.md");
  });

  test("requires usable content in language-navigation anchors", () => {
    const empty = "[English](README.md) [한국어](README.ko.md) <a href=\"README.zh.md\"></a>";
    const hiddenOnly = "[English](README.md) [한국어](README.ko.md) <a href=\"README.zh.md\"><span hidden>简体中文</span></a>";
    expect(() => checkReadmeLanguageNavigation("README.md", empty)).toThrow("missing language link to README.zh.md");
    expect(() => checkReadmeLanguageNavigation("README.md", hiddenOnly)).toThrow("missing language link to README.zh.md");
  });

  test("does not accept hidden documentation links for translation parity", () => {
    const canonical = "[Architecture](docs/architecture.md)";
    const translated = '<a hidden href="docs/architecture.md">Architecture</a>';
    expect(() => checkReadmeDocumentationLinks("README.md", canonical, "README.zh.md", translated))
      .toThrow("missing documentation links");
  });

  test("normalizes repository-relative documentation paths for translation parity", () => {
    const canonical = "[Architecture](./docs/architecture.md)";
    const translated = "[Trust](docs/trust-model.md)";
    expect(() => checkReadmeDocumentationLinks("README.md", canonical, "README.zh.md", translated))
      .toThrow("docs/architecture.md");
  });

  test("requires operational literals in their marked parsed command block", () => {
    const content = "<!-- required --><!-- operational-command:updater -->\n```sh\necho unrelated\n```";
    expect(() => checkOperationalCommandBlocks("docs/automatic-updates.md", content, { updater: ["required"] }))
      .toThrow("operational command block updater is missing");
  });

  test("extracts HTML URL attributes only from visible tags", () => {
    expect(() => checkReadmeLocalLinks({
      path: "README.md",
      content: "The src=docs/not-here.md token is illustrative.\n<!-- <img src=docs/not-here.md> -->",
    })).not.toThrow();
    expect(() => checkReadmeLocalLinks({ path: "README.md", content: "<img\n src=not-here.md>" })).toThrow(
      "not-here.md",
    );
  });

  test.each([
    '<video poster="assets/not-here.png">',
    '<img srcset="assets/not-here.png 1x, assets/also-missing.png 2x">',
    '<svg><image xlink:href="assets/not-here.png" /></svg>',
  ])("validates URL-bearing HTML attributes: %s", (content) => {
    expect(() => checkReadmeLocalLinks({ path: "README.md", content })).toThrow("local link does not exist");
  });

  test("ignores link-shaped text in nested and indented Markdown code", () => {
    const content = "> ```md\n> [literal](docs/not-here.md)\n> ```\n\n    [indented](docs/not-here.md)";
    expect(() => checkReadmeLocalLinks({ path: "README.md", content })).not.toThrow();
  });

  test("stops a nested fence when its blockquote container ends", () => {
    const content = "> ```md\n[guide](docs/not-here.md)\n> ```";
    expect(() => checkReadmeLocalLinks({ path: "README.md", content })).toThrow("docs/not-here.md");
  });

  test("stops a nested fence when its list container ends", () => {
    const content = "- ```md\n[guide](docs/not-here.md)";
    expect(() => checkReadmeLocalLinks({ path: "README.md", content })).toThrow("docs/not-here.md");
  });

  test("keeps blockquote-shaped content inside a list-contained fence", () => {
    const content = "- ```md\n  > [literal](docs/not-here.md)\n  ```";
    expect(() => checkReadmeLocalLinks({ path: "README.md", content })).not.toThrow();
  });

  test("does not mask invalid backtick fence openers", () => {
    const content = "```sh`bad`\n[guide](docs/not-here.md)";
    expect(() => checkReadmeLocalLinks({ path: "README.md", content })).toThrow("docs/not-here.md");
  });

  test("keeps indented paragraph-continuation links visible", () => {
    const content = "Paragraph text\n    [guide](docs/not-here.md)";
    expect(() => checkReadmeLocalLinks({ path: "README.md", content })).toThrow("docs/not-here.md");
  });

  test.each([
    "# Example\n    [literal](docs/not-here.md)",
    "Example\n===\n    [literal](docs/not-here.md)",
    "Example\n--\n    [literal](docs/not-here.md)",
    "---\n    [literal](docs/not-here.md)",
    "<section>\n    [literal](docs/not-here.md)",
  ])("recognizes indented code after a non-paragraph block: %s", (content) => {
    expect(() => checkReadmeLocalLinks({ path: "README.md", content })).not.toThrow();
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

  test("rejects backticks in backtick-fence info strings", () => {
    const malformed = "<!-- shared-command:ci -->\n\n```sh`bad`\necho ok\n```";
    expect(() => checkReadmeSharedCommands([{ path: "README.md", content: malformed }])).toThrow(
      "must be followed by a fenced block",
    );
  });
  test("requires one canonical Skill payload and update lifecycle in every locale", () => {
    for (const content of localizedReadmes) {
      expect(content).toContain("npx skills add Jin-Doh/traceknot --skill traceknot --global");
      expect(content).toContain("npx skills update traceknot --global --yes");
      expect(content).toContain("skill/bin/traceknot");
      expect(content).toContain("$HOME/.agents/skills/traceknot/bin/traceknot");
      expect(content).toMatch(/(?:^|[\s`])\.agents\/skills\/traceknot\/bin\/traceknot/);
      expect(content).toContain("Traceknot Board: file://.../sessions/<session-key>/index.html");
      expect(content).toContain("Bun 1.3.14");
      expect(content).toContain("traceknot self-check");
      expect(content).toContain(".agents/skills/traceknot/bin/traceknot self-check");
      expect(content).toContain(".agents/skills/traceknot/bin/traceknot board update");
      const rendered = renderedMarkdownText(content);
      expect(rendered).not.toMatch(/Skills-only|Skill-only|portable Skill|Portable Skill|full-toolkit/iu);
      expect(content).toContain("bun run build:skill-runtime");
      expect(content).toContain("bun run check:skill-runtime");
      expect(rendered).not.toMatch(/Portable Board (?:status|location|manifest|publisher|authority|limitation)/iu);
    }
  });
  test("documents global and project-local Verify executables where the Verify section exists", () => {
    for (const content of localizedReadmes.slice(0, 2)) {
      expect(content).toContain("$HOME/.agents/skills/traceknot/bin/traceknot verify");
      expect(content).toContain(".agents/skills/traceknot/bin/traceknot verify");
    }
  });

  test("keeps global and project-local update commands scope-bound", () => {
    expect(automaticUpdates).toContain("$HOME/.agents/skills/traceknot/bin/traceknot self-check");
    expect(automaticUpdates).toContain(".agents/skills/traceknot/bin/traceknot self-check");
    expect(automaticUpdates).toContain("Never substitute an unrelated global executable");
    expect(automaticUpdates).toContain("npx skills update traceknot --yes");
    expect(automaticUpdates).toContain("run the structural and installed-runtime self-checks; persist active state; then mark committed");
  });

  test("states the bundled CLI platform boundary in every locale", () => {
    for (const content of localizedReadmes) {
      expect(content).toContain("macOS");
      expect(content).toContain("Linux");
      expect(content).toMatch(/Windows/u);
    }
  });

  test("standalone README checker rejects lifecycle drift in every locale", () => {
    for (const [index, content] of localizedReadmes.entries()) {
      const drifted = content.replace("npx skills update traceknot --yes", "npx skills update traceknot --global --yes");
      expect(() => checkReadmeLifecycleContract(`README-${index}`, drifted)).toThrow("canonical installation lifecycle is missing");
      const globalOnly = content.replaceAll(".agents/skills/traceknot/bin/traceknot", "$HOME/.agents/skills/traceknot/bin/traceknot");
      expect(() => checkReadmeLifecycleContract(`README-global-only-${index}`, globalOnly)).toThrow("project-local");
      const hiddenOnly = `${globalOnly}\n<!-- .agents/skills/traceknot/bin/traceknot verify; .agents/skills/traceknot/bin/traceknot self-check; .agents/skills/traceknot/bin/traceknot board update -->`;
      expect(() => checkReadmeLifecycleContract(`README-hidden-${index}`, hiddenOnly)).toThrow("project-local");
    }
  });
  test("documents the curl path only as an optional non-owning launcher", () => {
    const canonical = localizedReadmes[0];
    expect(canonical).toContain("optional prefix launcher/updater");
    expect(canonical).toContain("does not create, replace, retarget, update, or remove a Skills CLI-owned registration");
    expect(canonical).toContain("The two can coexist");
    expect(canonical).toContain("npx skills add`/`npx skills update");
  });
});
