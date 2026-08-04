import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { LocalArtifactStore } from "./local-artifact-store";
import { LocalShellCollector, ShellCollectorError, type ShellObservationRequest } from "./local-shell-collector";

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const temporaryDirectory = async (): Promise<string> => mkdtemp(join(tmpdir(), "traceknot-shell-"));
const pause = (milliseconds: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
};
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
    const marker = join(root, "descendant-marker");
    try {
      const script = `const child=Bun.spawn([${JSON.stringify(process.execPath)},'-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'escaped'),4000)`) }],{detached:true}); setTimeout(()=>{},10000);`;
      const observation = await collectorFor(root, store).collect({
        ...requestFor(root),
        argv: ["-e", script],
        timeoutMs: 100,
      });
      expect(observation.execution.exitStatus).toBe("timed-out");
      expect(observation.actualValues?.timedOut).toBe(true);
      await pause(300);
      await expect(readFile(marker)).rejects.toBeDefined();
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
});
