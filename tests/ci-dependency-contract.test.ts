import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

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

describe("CI dependency compatibility", () => {
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
        type: "object", required: ["value"], additionalProperties: false,
        properties: { value: { $ref: "https://example.test/ci-value" } },
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
