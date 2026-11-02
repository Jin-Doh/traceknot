import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import uri from "ajv/dist/runtime/uri.js";

// js-yaml 3 still uses argparse's v1 aliases. Keep the targeted argparse 2
// override (which removes unpatched sprintf-js) honest at its actual consumer.
function cli(packagePath: string, args: readonly string[], input?: string) {
  const node = Bun.which("node");
  if (!node) throw new Error("Node is required to exercise the dependency CLIs");
  const result = Bun.spawnSync([node, Bun.resolveSync(packagePath, import.meta.dir), ...args], {
    stdin: input === undefined ? "ignore" : Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

// glob's post-timeout traversal fix (GHSA-3g3m-2fjr-6pw4) and minimatch's
// globpart amplification fix (GHSA-g3hv-75wg-m249) only land above the
// versions this tree used to hoist. `bun audit` runs in the canonical gate, so
// scan the lockfile for every resolution rather than trusting package.json.
const RESOLUTION_FLOORS: Readonly<Record<string, string>> = {
  glob: "14.0.2",
  minimatch: "11.0.1",
};

function lockedVersions(lock: string, name: string): string[] {
  const pattern = new RegExp(`"${name}@([0-9][^"]*)"`, "g");
  return [...new Set([...lock.matchAll(pattern)].map((match) => match[1]!))];
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

describe("CI dependency compatibility", () => {
  // Exercise AJV's actual resolver, not a separately installed fast-uri copy.
  test("keeps malformed URI schemes and hosts from becoming valid references", () => {
    for (const input of ["%68ttps://example.test/value", "ht%74ps://example.test/value"]) {
      expect(uri.parse(input).error).toBeDefined();
      expect(uri.normalize(input)).toBe(input);
      expect(() => uri.resolve("https://example.test/base/", input)).toThrow();
    }
    for (const input of ["https://a@b@evil.test/path", "https://ev\til.test/path"]) {
      expect(uri.parse(input).error).toBeDefined();
      expect(uri.normalize(input)).toBe(input);
      expect(() => uri.resolve("https://example.test/base/", input)).toThrow();
    }
    expect(uri.normalize("https://Example.TEST/value")).toBe("https://example.test/value");
    expect(uri.resolve("https://example.test/base/", "../value")).toBe("https://example.test/value");
  });

  test("preserves relative path meaning and keeps suffix references scheme-less", () => {
    const base = "https://example.test/schemas/nested/root.json";
    for (const reference of ["../value", "a/../value", "./a:b", "a/..//value"]) {
      expect(uri.resolve(base, uri.normalize(reference))).toBe(uri.resolve(base, reference));
    }
    expect(uri.equal("../value", "value")).toBe(false);
    expect(uri.equal("a/../value", "/value")).toBe(false);
    const options = { reference: "suffix", scheme: "x" };
    expect(uri.normalize("javascript:alert(1)", options)).toBe("javascript%3Aalert(1)");
    expect(uri.normalize("path/to/file", options)).toBe("path/to/file");
    expect(uri.normalize("a/b:c", options)).toBe("a/b:c");
  });

  // The AJV CLI glob below expands `{valid,also-valid}` through minimatch and
  // brace-expansion, so it also guards the resolver swap that removed the old
  // brace-expansion 1.x override.
  test("keeps every hoisted glob and minimatch past its traversal advisory", async () => {
    const lock = await Bun.file(join(import.meta.dir, "../bun.lock")).text();
    for (const [name, floor] of Object.entries(RESOLUTION_FLOORS)) {
      const versions = lockedVersions(lock, name);
      expect(versions.length).toBeGreaterThan(0);
      for (const version of versions) {
        expect({ name, version, floor, ok: compareVersions(version, floor) >= 0 })
          .toEqual({ name, version, floor, ok: true });
      }
    }
  });

  test("keeps js-yaml's legacy argparse CLI working without sprintf-js", async () => {
    const help = cli("js-yaml/bin/js-yaml.js", ["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--compact");
    expect(help.stdout).toContain("--trace");
    const version = cli("js-yaml/bin/js-yaml.js", ["--version"]);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe("3.15.2");
    const parsed = cli("js-yaml/bin/js-yaml.js", [], "value: 42\n");
    expect(parsed.status).toBe(0);
    expect(JSON.parse(parsed.stdout)).toEqual({ value: 42 });
    expect(cli("js-yaml/bin/js-yaml.js", ["--unknown-option"]).status).toBe(2);
    expect(cli("js-yaml/bin/js-yaml.js", ["--compact"], "value: [\n").status).toBe(1);
    expect(await Bun.file(join(import.meta.dir, "../bun.lock")).text()).not.toContain('"sprintf-js":');
  });

  test("preserves AJV schema references, data globs, YAML input, and rejection", async () => {
    const root = await mkdtemp(join(tmpdir(), "traceknot-ci-dependencies-"));
    try {
      const schema = join(root, "schema.json");
      const reference = join(root, "reference.json");
      await writeFile(reference, JSON.stringify({
        $id: "https://example.test/ci-value", type: "integer", minimum: 1,
      }));
      await writeFile(schema, JSON.stringify({
        $id: "https://example.test/schemas/root.json",
        type: "object", required: ["value"], additionalProperties: false,
        properties: { value: { $ref: "../ci-value" } },
      }));
      await writeFile(join(root, "valid.json"), '{"value":1}');
      await writeFile(join(root, "also-valid.json"), '{"value":2}');
      await writeFile(join(root, "valid.yaml"), "value: 3\n");
      await writeFile(join(root, "invalid.json"), '{"value":"wrong"}');
      await writeFile(join(root, "malformed.yaml"), "value: [\n");
      const args = ["--spec=draft2020", "-s", schema, "-r", reference];
      expect(cli("ajv-cli/dist/index.js", ["compile", ...args]).status).toBe(0);
      const glob = cli("ajv-cli/dist/index.js", ["validate", ...args, "-d", join(root, "{valid,also-valid}.json")]);
      expect(glob.status).toBe(0);
      expect(glob.stdout).toContain("valid.json valid");
      expect(glob.stdout).toContain("also-valid.json valid");
      expect(cli("ajv-cli/dist/index.js", ["validate", ...args, "-d", join(root, "valid.yaml")]).status).toBe(0);
      const invalid = cli("ajv-cli/dist/index.js", ["validate", ...args, "-d", join(root, "invalid.json")]);
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toContain("must be integer");
      expect(cli("ajv-cli/dist/index.js", ["validate", ...args, "-d", join(root, "malformed.yaml")]).status).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
