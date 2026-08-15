export type BoardOpenResult = "opened" | "unavailable" | "failed";

export type BoardOpenRunner = (command: readonly string[]) => Promise<number>;

export type BoardOpenOptions = Readonly<{
  platform?: string;
  run?: BoardOpenRunner;
}>;

function defaultRunner(command: readonly string[]): Promise<number> {
  const child = Bun.spawn([...command], { stdout: "ignore", stderr: "ignore" });
  return child.exited;
}

export async function openBoard(uri: string, options: BoardOpenOptions = {}): Promise<BoardOpenResult> {
  if (!uri.startsWith("file://")) return "unavailable";
  const platform = options.platform ?? process.platform;
  const command = platform === "darwin"
    ? ["open", uri]
    : platform === "linux"
      ? ["xdg-open", uri]
      : undefined;
  if (!command) return "unavailable";
  try {
    const status = await (options.run ?? defaultRunner)(command);
    return status === 0 ? "opened" : "failed";
  } catch {
    return "unavailable";
  }
}
