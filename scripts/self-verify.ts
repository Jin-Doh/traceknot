import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSelfHostingCacheParity } from "../system/runtime/self-hosting-parity";
import {
  buildCanonicalSelfHostingCommand,
  resolveSelfHostingRoot,
  SelfHostingCliError,
} from "../system/runtime/self-hosting-verification";


const actionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = resolveSelfHostingRoot(actionRoot, process.env.GITHUB_WORKSPACE);
const cacheRoot = await mkdtemp(join(tmpdir(), "traceknot-self-hosting-cache."));
try {
  try {
  const report = await runSelfHostingCacheParity(
      buildCanonicalSelfHostingCommand(
        rootDir,
        process.execPath,
        Bun.which("gh"),
        process.env.TRACEKNOT_EXPECTED_HEAD,
        process.env.TRACEKNOT_ASSURANCE === "local"
          ? "local"
          : process.env.TRACEKNOT_ASSURANCE === "release"
            ? "release"
            : undefined,
      ),
      cacheRoot,
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    if (error instanceof SelfHostingCliError && error.report !== undefined) {
      process.stdout.write(`${JSON.stringify(error.report)}\n`);
      process.exitCode = error.exitCode;
    } else {
      process.exitCode = 1;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
} finally {
  await rm(cacheRoot, { recursive: true, force: true });
}
