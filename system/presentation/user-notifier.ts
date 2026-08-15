export type NotificationResult = "sent" | "unavailable" | "failed";

export type NotificationRunner = (command: readonly string[]) => Promise<number>;

export type UserNotifierOptions = Readonly<{
  platform?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  run?: NotificationRunner;
}>;

export type UserNotifierInput = Readonly<{
  title: string;
  message: string;
  boardUri: string;
}>;

const MACOS_SCRIPT = "on run argv\n display notification (item 2 of argv) with title (item 1 of argv)\nend run";

function defaultRunner(command: readonly string[]): Promise<number> {
  const child = Bun.spawn([...command], { stdout: "ignore", stderr: "ignore" });
  return child.exited;
}

function desktopAvailable(platform: string, environment: Readonly<Record<string, string | undefined>>): boolean {
  if (environment.CI || environment.SSH_CONNECTION || environment.SSH_TTY || environment.TERM === "dumb") return false;
  if (platform === "darwin") return true;
  if (platform !== "linux") return false;
  return Boolean(environment.DISPLAY || environment.WAYLAND_DISPLAY);
}

export async function notifyBoard(input: UserNotifierInput, options: UserNotifierOptions = {}): Promise<NotificationResult> {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  if (!desktopAvailable(platform, environment)) return "unavailable";
  const run = options.run ?? defaultRunner;
  const command = platform === "darwin"
    ? ["osascript", "-e", MACOS_SCRIPT, "--", input.title, input.message]
    : platform === "linux"
      ? ["notify-send", input.title, `${input.message}\n${input.boardUri}`]
      : undefined;
  if (!command) return "unavailable";
  try {
    const status = await run(command);
    return status === 0 ? "sent" : "failed";
  } catch {
    return "unavailable";
  }
}
