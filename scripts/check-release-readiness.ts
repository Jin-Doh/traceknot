import { randomUUID } from "node:crypto";
import { mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  assertReleaseReadiness,
  canonicalReleaseReadinessReport,
  runReleaseReadinessBenchmark,
} from "../system/benchmarks/release-readiness";

const USAGE = "usage: bun run benchmark:release [--report ABSOLUTE_PATH]";
class UsageError extends Error {}
type CliOptions = Readonly<{ help: boolean; reportPath?: string }>;

function parseArgs(argv: readonly string[]): CliOptions {
  if (argv.length === 0) return { help: false };
  if (argv.length === 1 && argv[0] === "--help") return { help: true };
  if (argv.length !== 2 || argv[0] !== "--report" || !argv[1]) {
    throw new UsageError(USAGE);
  }
  if (!isAbsolute(argv[1])) {
    throw new UsageError(`benchmark report path must be absolute\n${USAGE}`);
  }
  return { help: false, reportPath: argv[1] };
}

async function removeTemporary(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

async function main(argv: readonly string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 64;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const cacheRoot = await mkdtemp(join(tmpdir(), "traceknot-release-benchmark-"));
  let temporary: string | undefined;
  try {
    const report = await runReleaseReadinessBenchmark(cacheRoot);
    const output = canonicalReleaseReadinessReport(report);
    process.stdout.write(output);
    if (options.reportPath !== undefined) {
      temporary = join(dirname(options.reportPath), `.${randomUUID()}.tmp`);
      await writeFile(temporary, output, { mode: 0o600 });
      await rename(temporary, options.reportPath);
      temporary = undefined;
    }
    assertReleaseReadiness(report);
    return 0;
  } finally {
    if (temporary !== undefined) await removeTemporary(temporary);
    await rm(cacheRoot, { recursive: true, force: true });
  }
}

process.exit(await main(process.argv.slice(2)));
