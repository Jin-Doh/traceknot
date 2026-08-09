import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rename, rm, symlink, unlink, watch, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { Artifact } from "../core/qa-core";
import { LocalArtifactStore } from "./local-artifact-store";
import type { ArtifactStore } from "./verification-run";
import { LocalShellCollector, ShellCollectorError, type ShellObservationRequest } from "./local-shell-collector";

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const temporaryDirectory = async (): Promise<string> => mkdtemp(join(tmpdir(), "traceknot-shell-"));
async function waitForPathEvent(directory: string, filename: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    for await (const event of watch(directory, { signal: controller.signal })) {
      if (event.filename === filename) return;
    }
    throw new Error(`filesystem watcher closed before ${filename} was created`);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`timed out waiting for ${filename}`, { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
const requestFor = (root: string, snapshotId = "snapshot-shell-1"): ShellObservationRequest => ({
  requestId: "request-shell-1",
  snapshotId,
  executable: process.execPath,
  cwd: root,
});
const collectorFor = (root: string, store: LocalArtifactStore, snapshotId = "snapshot-shell-1") => new LocalShellCollector({
  rootDir: root,
  snapshotId,
  rootIdentity: "repo-shell-root",
  artifactStore: store,
  toolVersion: "bun-test",
  timeoutMs: 5_000,
});

async function cleanup(root: string, store?: LocalArtifactStore): Promise<void> {
  await store?.close();
  await rm(root, { recursive: true, force: true });
}

describe("LocalShellCollector", () => {
  test("uses explicit argv without shell interpolation, captures binary streams, and minimizes env", async () => {
    const root = await temporaryDirectory();
    const store = new LocalArtifactStore(join(root, "artifacts"));
    try {
      const request = {
        ...requestFor(root),
        argv: ["-e", "process.stdout.write(Buffer.from([0,255,1])); process.stderr.write(process.env.SECRET_TOKEN || 'secret-missing')", "literal;$(injection)"],
      } satisfies ShellObservationRequest;
      const observation = await collectorFor(root, store).collect(request);
      expect(observation.execution.exitStatus).toBe("passed");
      expect(observation.execution.exitCode).toBe(0);
      expect(observation.snapshotId).toBe("snapshot-shell-1");
      expect(observation.producer.independence).toBe("self-check");
      expect(observation.actualValues?.toolVersion).toBe("bun-test");
      const stdout = observation.artifacts.find(artifact => artifact.path === "stdout");
      const stderr = observation.artifacts.find(artifact => artifact.path === "stderr");
      expect(stdout).toBeDefined();
      expect(stderr).toBeDefined();
      expect(await store.readArtifact(stdout!.digest)).toEqual(new Uint8Array([0, 255, 1]));
      expect(new TextDecoder().decode(await store.readArtifact(stderr!.digest))).toBe("secret-missing");
    } finally {
      await cleanup(root, store);
    }
  });

  test("records nonzero exits and fails closed on bounded output", async () => {
    const root = await temporaryDirectory();
    const store = new LocalArtifactStore(join(root, "artifacts"));
    try {
      const observation = await collectorFor(root, store).collect({
        ...requestFor(root),
        argv: ["-e", "process.stdout.write(Buffer.alloc(128, 7)); process.exit(3)"],
        maxOutputBytes: 32,
      });
      expect(observation.execution.exitStatus).toBe("failed");
      expect(observation.execution.exitCode).toBe(3);
      expect(observation.actualValues?.outputLimitExceeded).toBe(true);
      const stdout = observation.artifacts.find(artifact => artifact.path === "stdout");
      expect(stdout).toBeDefined();
      expect((await store.readArtifact(stdout!.digest)).byteLength).toBe(32);
    } finally {
      await cleanup(root, store);
    }
  });

  test("terminates descendants on timeout and records timed-out lifecycle", async () => {
    const root = await temporaryDirectory();
    const store = new LocalArtifactStore(join(root, "artifacts"));
    try {
      const script = `
        const child = Bun.spawn([
          process.execPath,
          "-e",
          "process.stdout.write(String(process.pid)); setTimeout(() => {}, 10_000);",
        ], { detached: true, stdout: "inherit" });
        await child.exited;
      `;
      const observation = await collectorFor(root, store).collect({
        ...requestFor(root),
        argv: ["-e", script],
        timeoutMs: 100,
      });
      expect(observation.execution.exitStatus).toBe("timed-out");
      expect(observation.actualValues?.timedOut).toBe(true);
      const stdout = observation.artifacts.find(artifact => artifact.path === "stdout");
      const descendantPid = Number(new TextDecoder().decode(await store.readArtifact(stdout!.digest)));
      expect(Number.isSafeInteger(descendantPid)).toBe(true);
      expect(() => process.kill(descendantPid, 0)).toThrow();
    } finally {
      await cleanup(root, store);
    }
  });

  test("binds snapshot and root paths, and persists declared structured artifacts", async () => {
    const root = await temporaryDirectory();
    const store = new LocalArtifactStore(join(root, "artifacts"));
    try {
      const artifactPath = join(root, "result.json");
      const artifactBytes = Buffer.from('{"ok":true}\n');
      await writeFile(artifactPath, artifactBytes);
      const observation = await collectorFor(root, store).collect({
        ...requestFor(root),
        argv: ["-e", "process.stdout.write('ok')"],
        declaredArtifacts: [{ type: "structured-json", digest: digest(artifactBytes), path: "result.json" }],
      });
      const declared = observation.artifacts.find(artifact => artifact.type === "structured-json");
      expect(declared?.digest).toBe(digest(artifactBytes));
      expect(declared?.path).toBe(await realpath(artifactPath));
      expect(await store.readArtifact(declared!.digest)).toEqual(artifactBytes);
      await expect(collectorFor(root, store).collect({ ...requestFor(root, "other-snapshot"), argv: [] })).rejects.toMatchObject({ code: "SNAPSHOT_MISMATCH" });
      const link = join(root, "cwd-link");
      await symlink(root, link, "dir");
      await expect(collectorFor(root, store).collect({ ...requestFor(root), cwd: "cwd-link", argv: [] })).rejects.toMatchObject({ code: "PATH_INVALID" });
    } finally {
      await cleanup(root, store);
    }
  });

  test("returns deterministic failed observation for spawn errors", async () => {
    const root = await temporaryDirectory();
    const store = new LocalArtifactStore(join(root, "artifacts"));
    try {
      const observation = await collectorFor(root, store).collect({ ...requestFor(root), executable: join(root, "missing-executable") });
      expect(observation.execution.exitStatus).toBe("failed");
      expect(observation.execution.exitCode).toBeUndefined();
      expect(observation.artifacts).toEqual([]);
      expect(String(observation.actualValues?.spawnError)).toContain("missing-executable");
    } finally {
      await cleanup(root, store);
    }
  });

  test("rejects declared artifact mismatches and invalid limits", async () => {
    const root = await temporaryDirectory();
    const store = new LocalArtifactStore(join(root, "artifacts"));
    try {
      const path = join(root, "result.bin");
      await writeFile(path, Buffer.from("actual"));
      await expect(collectorFor(root, store).collect({ ...requestFor(root), argv: [], declaredArtifacts: [{ type: "structured", digest: "0".repeat(64), path: "result.bin" }] })).rejects.toMatchObject({ code: "DECLARED_ARTIFACT_MISMATCH" });
      await expect(collectorFor(root, store).collect({ ...requestFor(root), argv: [], timeoutMs: 0 })).rejects.toMatchObject({ code: "LIMIT_INVALID" });
    } finally {
      await cleanup(root, store);
    }
  });

  test("uses supplied clock for valid lifecycle timestamps", async () => {
    const root = await temporaryDirectory();
    const store = new LocalArtifactStore(join(root, "artifacts"));
    try {
      let tick = 0;
      const collector = new LocalShellCollector({ rootDir: root, snapshotId: "snapshot-shell-1", artifactStore: store, now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)), timeoutMs: 1_000 });
      const observation = await collector.collect({ ...requestFor(root), argv: ["-e", ""], observationId: "fixed-observation" });
      expect(observation.observationId).toBe("fixed-observation");
      expect(observation.execution.startedAt).toMatch(/^2026-01-01T00:00:00\.000Z$/);
      expect(observation.execution.finishedAt).toMatch(/^2026-01-01T00:00:01\.000Z$/);
    } finally {
      await cleanup(root, store);
    }
  });
  test("denies dangerous environment overrides and preserves the fixed executable path", async () => {
    const root = await temporaryDirectory();
    const store = new LocalArtifactStore(join(root, "artifacts"));
    try {
      const observation = await new LocalShellCollector({ rootDir: root, snapshotId: "snapshot-shell-1", artifactStore: store, envAllowlist: ["PATH", "LD_PRELOAD", "NODE_OPTIONS", "SAFE_MARK"] }).collect({
        ...requestFor(root),
        env: { PATH: "/tmp/attacker", LD_PRELOAD: "/tmp/attacker.dylib", NODE_OPTIONS: "--require /tmp/attacker.js", SAFE_MARK: "allowed" },
        argv: ["-e", "process.stdout.write(JSON.stringify({path:process.env.PATH,ld:process.env.LD_PRELOAD,node:process.env.NODE_OPTIONS,safe:process.env.SAFE_MARK}))"],
      });
      const stdout = observation.artifacts.find(artifact => artifact.path === "stdout");
      const values = JSON.parse(new TextDecoder().decode(await store.readArtifact(stdout!.digest))) as Record<string, string | undefined>;
      expect(values.path).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
      expect(values.ld).toBeUndefined();
      expect(values.node).toBeUndefined();
      expect(values.safe).toBe("allowed");
    } finally {
      await cleanup(root, store);
    }
  });

  test("pins cwd descriptors and rejects a root rename plus symlink replacement", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const moved = `${root}-moved`;
    const store = new LocalArtifactStore(join(root, "artifacts"));
    try {
      const ready = waitForPathEvent(root, "ready");
      const run = collectorFor(root, store).collect({
        ...requestFor(root),

        argv: ["-e", `require("node:fs").writeFileSync("ready", "ready"); setTimeout(() => require("node:fs").writeFileSync("cwd-marker", "pinned"), 250)`],
        timeoutMs: 2_000,
      });
      await ready;
      await rename(root, moved);
      await symlink(outside, root, "dir");
      await expect(run).rejects.toMatchObject({ code: "ROOT_CHANGED" });
      expect(await readFile(join(moved, "cwd-marker"), "utf8")).toBe("pinned");
      await expect(readFile(join(outside, "cwd-marker"), "utf8")).rejects.toBeDefined();
    } finally {
      await store.close();
      await unlink(root).catch(() => undefined);
      await rm(moved, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
  test("runs concurrent collectors with independent pinned cwd descriptors", async () => {
    const roots = await Promise.all([temporaryDirectory(), temporaryDirectory()]);
    const stores = roots.map(root => new LocalArtifactStore(join(root, "artifacts")));
    try {
      const observations = await Promise.all(roots.map((root, index) => collectorFor(root, stores[index]!, `snapshot-shell-${index}`).collect({
        ...requestFor(root, `snapshot-shell-${index}`),
        argv: ["-e", `require("node:fs").writeFileSync("concurrent-marker", ${JSON.stringify(String(index))})`],
      })));
      expect(observations.every(observation => observation.execution.exitStatus === "passed")).toBe(true);
      expect(await readFile(join(roots[0]!, "concurrent-marker"), "utf8")).toBe("0");
      expect(await readFile(join(roots[1]!, "concurrent-marker"), "utf8")).toBe("1");
    } finally {
      await Promise.all(stores.map(store => store.close()));
      await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
    }
  });

  test("rejects an artifact store that lies on readback", async () => {
    const root = await temporaryDirectory();
    const liar: ArtifactStore & { readArtifact: (digest: string) => Promise<Uint8Array> } = {
      storeArtifact: async (artifact: Artifact) => artifact,
      readArtifact: async () => new Uint8Array([99]),
    };
    try {
      await expect(new LocalShellCollector({ rootDir: root, snapshotId: "snapshot-shell-1", artifactStore: liar }).collect({ ...requestFor(root), argv: ["-e", ""] })).rejects.toMatchObject({ code: "ARTIFACT_STORE_FAILED" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
