import { describe, expect, test } from "bun:test";
import { discoverClaudeCodeCapabilities } from "./claude-code/adapter";
import { discoverCodexCapabilities } from "./codex/adapter";
import { discoverGajaeCodeCapabilities } from "./gajae-code/adapter";
import { discoverOmpCapabilities } from "./omp/adapter";
import { discoverOpenCodeCapabilities } from "./opencode/adapter";

const adapters = [
  ["omp", discoverOmpCapabilities],
  ["opencode", discoverOpenCodeCapabilities],
  ["gajae-code", discoverGajaeCodeCapabilities],
  ["codex", discoverCodexCapabilities],
  ["claude-code", discoverClaudeCodeCapabilities],
] as const;

describe("host adapter contract", () => {
  test.each(adapters)("loads the conservative %s record without a handshake", async (host, discover) => {
    const record = await discover(undefined);
    expect(record.host).toBe(host);
    expect(Object.values(record.capabilities).every((enabled) => !enabled)).toBe(true);
    expect(record.limitations.length).toBeGreaterThan(0);
  });
});
