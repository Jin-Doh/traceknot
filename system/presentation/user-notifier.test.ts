import { describe, expect, test } from "bun:test";
import { notifyBoard, type UserNotifierInput } from "./user-notifier";

const input: UserNotifierInput = { title: "Traceknot QA finished", message: "FAIL: one mandatory check", boardUri: "file:///tmp/board/index.html" };

describe("Board notifier", () => {
  test("suppresses notifications in CI and SSH environments", async () => {
    const commands: Array<readonly string[]> = [];
    const run = async (command: readonly string[]): Promise<number> => { commands.push([...command]); return 0; };
    expect(await notifyBoard(input, { platform: "darwin", environment: { CI: "true" }, run })).toBe("unavailable");
    expect(await notifyBoard(input, { platform: "linux", environment: { SSH_CONNECTION: "present", DISPLAY: ":0" }, run })).toBe("unavailable");
    expect(commands).toEqual([]);
  });

  test("passes macOS user values as argv instead of AppleScript source", async () => {
    const commands: string[][] = [];
    const result = await notifyBoard({ ...input, title: "title; do not execute", message: "message && do not execute" }, { platform: "darwin", environment: {}, run: async command => { commands.push([...command]); return 0; } });
    expect(result).toBe("sent");
    expect(commands[0]).toEqual(expect.arrayContaining(["--", "title; do not execute", "message && do not execute"]));
    expect(commands[0]?.[2]).toBe("on run argv\n display notification (item 2 of argv) with title (item 1 of argv)\nend run");
  });

  test("reports unsupported platforms without spawning", async () => {
    let called = false;
    expect(await notifyBoard(input, { platform: "win32", environment: {}, run: async () => { called = true; return 0; } })).toBe("unavailable");
    expect(called).toBe(false);
  });
});
