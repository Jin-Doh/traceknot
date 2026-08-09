import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSelfHostingCacheParity } from "../system/runtime/self-hosting-parity";
import {
  buildCanonicalSelfHostingCommand,
} from "../system/runtime/self-hosting-verification";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cacheRoot = await mkdtemp(join(tmpdir(), "traceknot-self-hosting-cache."));
try {
  const report = await runSelfHostingCacheParity(
    buildCanonicalSelfHostingCommand(rootDir),
    cacheRoot,
  );
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await rm(cacheRoot, { recursive: true, force: true });
}
