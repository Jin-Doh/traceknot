import { describe, expect, test } from "bun:test";
import { openBoard } from "./board-opener";

describe("Board opener", () => {
  test("opens only local file URIs with platform argv", async () => {
    const commands: string[][] = [];
    const result = await openBoard("file:///tmp/board/index.html", { platform: "darwin", run: async command => { commands.push([...command]); return 0; } });
    expect(result).toBe("opened");
    expect(commands).toEqual([["open", "file:///tmp/board/index.html"]]);
  });

  test("rejects non-file URIs without spawning", async () => {
    let called = false;
    expect(await openBoard("https://example.com", { platform: "darwin", run: async () => { called = true; return 0; } })).toBe("unavailable");
    expect(called).toBe(false);
  });

  test("reports unsupported platforms without spawning", async () => {
    let called = false;
    expect(await openBoard("file:///tmp/board/index.html", { platform: "win32", run: async () => { called = true; return 0; } })).toBe("unavailable");
    expect(called).toBe(false);
  });
});
