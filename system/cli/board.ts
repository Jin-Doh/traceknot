import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LocalArtifactStore } from "../runtime/local-artifact-store";
import { openBoard } from "../presentation/board-opener";
import { markProjectSupportSeen, parseSessionBoardUpdate, publishSessionBoardUpdate, verifySessionBoardPublication } from "../presentation/qa-board-store";
import { notifyBoard } from "../presentation/user-notifier";

export const BOARD_EXIT_CODES = Object.freeze({ OK: 0, USAGE: 64, INTERNAL: 70 });
const MAX_INPUT_BYTES = 4 * 1024 * 1024;

type BoardRuntime = Readonly<{
  openBoard: typeof openBoard;
  notifyBoard: typeof notifyBoard;
  markProjectSupportSeen: typeof markProjectSupportSeen;
}>;

type BoardOptions = Readonly<{
  inputPath: string;
  stateDir: string;
  artifactDir: string;
  openBoard: boolean;
  noNotify: boolean;
  help: boolean;
}>;

function usage(): string {
  return [
    "traceknot board update --input UPDATE.json --state-dir DIR [options]",
    "",
    "Options:",
    "  --input FILE          Session Board update JSON",
    "  --state-dir DIR      Durable Board state root",
    "  --artifact-dir DIR   Content-addressed artifact root (default: STATE_DIR/artifacts)",
    "  --open-board         Open the stable Board landing page",
    "  --no-notify          Suppress desktop notification (enabled by default)",
    "  --help               Show this message",
  ].join("\n");
}

function fail(message: string): never {
  throw new Error(message);
}

function parseArgs(argv: readonly string[]): BoardOptions {
  if (argv[0] !== "update") fail("board requires the update subcommand");
  let inputPath: string | undefined;
  let stateDir: string | undefined;
  let artifactDir: string | undefined;
  let open = false;
  let noNotify = false;
  let help = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = (): string => {
      const value = argv[++index];
      if (!value || value.startsWith("--")) fail(`${arg} requires a value`);
      return value;
    };
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--input") inputPath = next();
    else if (arg === "--state-dir") stateDir = next();
    else if (arg === "--artifact-dir") artifactDir = next();
    else if (arg === "--open-board") open = true;
    else if (arg === "--no-notify") noNotify = true;
    else fail(`unknown board option: ${arg}`);
  }
  if (help) return { inputPath: inputPath ?? "", stateDir: stateDir ?? "", artifactDir: artifactDir ?? "", openBoard: open, noNotify, help };
  if (!inputPath || !stateDir) fail("--input and --state-dir are required");
  const absoluteState = resolve(stateDir);
  return { inputPath: resolve(inputPath), stateDir: absoluteState, artifactDir: resolve(artifactDir ?? join(absoluteState, "artifacts")), openBoard: open, noNotify, help };
}

async function readInput(path: string): Promise<unknown> {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) | ((constants as Record<string, number | undefined>).O_CLOEXEC ?? 0);
  let handle: FileHandle;
  try { handle = await open(path, flags); } catch { fail("Board update input must be a regular file and must not be a symlink"); }
  try {
    const information = await handle.stat();
    if (!information.isFile()) fail("Board update input must be a regular file");
    if (information.size > MAX_INPUT_BYTES) fail("Board update input exceeds the maximum size");
    const bytes = new Uint8Array(information.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const probe = new Uint8Array(1);
    const { bytesRead: extraBytes } = await handle.read(probe, 0, 1, offset);
    if (extraBytes !== 0) fail("Board update input changed while being read");
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset))) as unknown;
    } catch (error) {
      fail(`Board update input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    await handle.close();
  }
}

export async function runBoardUpdate(
  argv: readonly string[],
  stdout: (text: string) => void = text => process.stdout.write(text),
  stderr: (text: string) => void = text => process.stderr.write(text),
  runtime: BoardRuntime = { openBoard, notifyBoard, markProjectSupportSeen },
): Promise<number> {
  let options: BoardOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n${usage()}\n`);
    return BOARD_EXIT_CODES.USAGE;
  }
  if (options.help) {
    stdout(`${usage()}\n`);
    return BOARD_EXIT_CODES.OK;
  }
  let artifactStore: LocalArtifactStore | undefined;
  try {
    const update = parseSessionBoardUpdate(await readInput(options.inputPath));
    artifactStore = new LocalArtifactStore(options.artifactDir);
    const publication = await publishSessionBoardUpdate({ update, stateDir: options.stateDir, artifactReader: artifactStore });
    await verifySessionBoardPublication(options.stateDir, publication);
    stderr(`Traceknot Board: ${publication.entrypointUri}\n`);
    if (!options.noNotify) {
      const notification = await runtime.notifyBoard({ title: "Traceknot QA finished", message: `${publication.manifest.verdict}: ${publication.manifest.counts.failed} failed`, boardUri: publication.entrypointUri });
      if (notification === "failed") stderr("Traceknot Board: desktop notification failed\n");
    }
    if (options.openBoard) {
      const opened = await runtime.openBoard(publication.entrypointUri);
      if (opened === "failed") stderr("Traceknot Board: browser opener failed\n");
      if (opened === "opened" && publication.projectSupportIncluded) await runtime.markProjectSupportSeen(options.stateDir).catch(error => stderr(`Traceknot Board support marker unavailable: ${error instanceof Error ? error.message : String(error)}\n`));
    }
    return BOARD_EXIT_CODES.OK;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`Traceknot Board unavailable: ${message}\n`);
    return /invalid|not valid|required|unknown|unsafe|must|malformed|unsupported|inconsistent|exceeds/.test(message) ? BOARD_EXIT_CODES.USAGE : BOARD_EXIT_CODES.INTERNAL;
  } finally {
    await artifactStore?.close().catch(error => stderr(`Traceknot Board cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`));
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  return runBoardUpdate(argv);
}

if (import.meta.main) process.exit(await main());
