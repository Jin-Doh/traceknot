#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const implementation = fileURLToPath(new URL("./verify-sqlite-node.ts", import.meta.url));
const result = spawnSync("node", [implementation], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: process.env,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
