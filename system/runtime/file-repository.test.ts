import { mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { FileVerificationRepository, type VerificationStateMetadata } from "./file-repository";
import type { CanonicalRunState, DispatchClaim } from "./verification-run";

const metadata = (suffix: string): VerificationStateMetadata => ({ schemaVersion: "traceknot-cli-state/v1", rootIdentity: `root-${suffix}`, snapshotId: `snapshot-${suffix}`, manifestDigest: `manifest-${suffix}`, capabilities: ["command"] });

async function tempRoot(): Promise<string> { return mkdtemp(join(tmpdir(), "traceknot-file-repository-")); }

describe("FileVerificationRepository descriptor boundaries", () => {
  test("does not redirect writes when the configured root is renamed and replaced", async () => {
    const root = await tempRoot(); const moved = `${root}-moved`; const attacker = await tempRoot();
    const repository = new FileVerificationRepository(root);
    try {
      await repository.writeMetadata("run", metadata("before"));
      await rename(root, moved); await symlink(attacker, root);
      await expect(repository.readMetadata("run")).rejects.toThrow("root directory changed");
      await expect(readFile(join(attacker, "runs", "run", "metadata.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await repository.close(); await rm(root, { recursive: true, force: true }); await rm(moved, { recursive: true, force: true }); await rm(attacker, { recursive: true, force: true }); }
  });

  test("rejects corrupt state instead of accepting a torn JSON document", async () => {
    const root = await tempRoot(); const repository = new FileVerificationRepository(root);
    try {
      await repository.writeMetadata("run", metadata("corrupt"));
      await writeFile(join(root, "runs", "run", "state.json"), "{\"schemaVersion\":");
      await expect(repository.loadRun("run")).rejects.toThrow();
    } finally { await repository.close(); await rm(root, { recursive: true, force: true }); }
  });

  test("serializes concurrent writers and leaves one complete metadata document", async () => {
    const root = await tempRoot(); const first = new FileVerificationRepository(root); const second = new FileVerificationRepository(root);
    try {
      await Promise.all([first.writeMetadata("run", metadata("one")), second.writeMetadata("run", metadata("two"))]);
      const value = JSON.parse(await readFile(join(root, "runs", "run", "metadata.json"), "utf8")) as VerificationStateMetadata;
      expect(["manifest-one", "manifest-two"]).toContain(value.manifestDigest);
      expect(value.schemaVersion).toBe("traceknot-cli-state/v1");
    } finally { await first.close(); await second.close(); await rm(root, { recursive: true, force: true }); }
  });

  test("completes only the unreplaced dispatch generation after lease expiry", async () => {
    const root = await tempRoot(); const repository = new FileVerificationRepository(root);
    const run: CanonicalRunState = { schemaVersion: "verification-run/v1", runId: "run", requestId: "request", rootIdentity: "root", snapshotId: "snapshot", state: "PLANNED", observationIds: [], claimIds: [], evaluationIds: [], revision: 0, createdAt: "2026-08-03T00:00:00.000Z", updatedAt: "2026-08-03T00:00:00.000Z" };
    const firstClaim: DispatchClaim = { schemaVersion: "verification-dispatch-claim/v1", claimKey: "verification-dispatch:claim", acquisitionId: "00000000-0000-4000-8000-000000000001", runId: "run", requestId: "request", rootIdentity: "root", snapshotId: "snapshot", planDigest: "a".repeat(64), obligationId: "obligation", idempotencyKey: "verification-execution:key", ownerId: "worker-1", leaseGeneration: 1, leaseExpiresAt: "2026-08-03T00:00:30.000Z" };
    try {
      expect(repository.generationFencedDispatchCompletion).toBe(true);
      expect(await repository.commitTransition({ runId: "run", run })).toBe(true);
      expect((await repository.claimExecutionDispatch(firstClaim, "2026-08-03T00:00:00.000Z")).claimed).toBe(true);
      const secondClaim = { ...firstClaim, acquisitionId: "00000000-0000-4000-8000-000000000002", ownerId: "worker-2", leaseExpiresAt: "2026-08-03T00:01:01.000Z" };
      const takeover = await repository.claimExecutionDispatch(secondClaim, "2026-08-03T00:00:31.000Z");
      expect(takeover.claimed).toBe(true);
      expect(takeover.claim.leaseGeneration).toBe(2);
      expect(await repository.completeExecutionDispatch(firstClaim, undefined, "2026-08-03T00:00:31.000Z")).toBe(false);
      expect(await repository.completeExecutionDispatch({ ...takeover.claim, ownerId: "stale-owner" }, undefined, "2026-08-03T00:01:02.000Z")).toBe(false);
      expect(await repository.completeExecutionDispatch({ ...takeover.claim, leaseGeneration: 1 }, undefined, "2026-08-03T00:01:02.000Z")).toBe(false);
      expect(await repository.releaseExecutionDispatch({ ...takeover.claim, ownerId: "stale-owner" }, "2026-08-03T00:01:02.000Z")).toBe(false);
      expect(await repository.releaseExecutionDispatch({ ...takeover.claim, leaseGeneration: 1 }, "2026-08-03T00:01:02.000Z")).toBe(false);
      expect(await repository.completeExecutionDispatch(takeover.claim, undefined, "2026-08-03T00:01:02.000Z")).toBe(true);
    } finally { await repository.close(); await rm(root, { recursive: true, force: true }); }
  });
});
