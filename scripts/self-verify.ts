import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCanonicalSelfHostingCommand,
  runSelfHostingVerification,
} from "../system/runtime/self-hosting-verification";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = await runSelfHostingVerification(buildCanonicalSelfHostingCommand(rootDir));

process.stdout.write(`${JSON.stringify(result.reportOnly)}\n`);
