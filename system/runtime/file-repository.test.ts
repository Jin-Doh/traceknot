import { mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { FileVerificationRepository, type VerificationStateMetadata } from "./file-repository";

const metadata = (suffix: string): VerificationStateMetadata => ({ schemaVersion: "traceknot-cli-state/v1", rootIdentity: `root-${suffix}`, snapshotId: `snapshot-${suffix}`, manifestDigest: `manifest-${suffix}`, capabilities: ["command"] });

async function tempRoot(): Promise<string> { return mkdtemp(join(tmpdir(), "traceknot-file-repository-")); }

describe("FileVerificationRepository descriptor boundaries", () => {
  test("does not redirect writes when the configured root is renamed and replaced", async () => {
    const root = await tempRoot(); const moved = `${root}-moved`; const attacker = await tempRoot();
    const repository = new FileVerificationRepository(root);
    try {
      await repository.writeMetadata("run", metadata("before"));
      await rename(root, moved); await symlink(attacker, root);
      expect(JSON.parse(await readFile(join(moved, "runs", "run", "metadata.json"), "utf8")).manifestDigest).toBe("manifest-before");
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
});
