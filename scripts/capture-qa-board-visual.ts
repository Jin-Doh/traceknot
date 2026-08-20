/// <reference types="bun" />

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (key === undefined || value === undefined || !key.startsWith("--")) throw new Error("expected --name value arguments");
  args.set(key, value);
}
const browserPath = args.get("--browser");
const inputDir = resolve(args.get("--input") ?? "preview");
const outputDir = resolve(args.get("--output") ?? inputDir);
const snapshotId = args.get("--snapshot");
if (browserPath === undefined || snapshotId === undefined || !/^[0-9a-f]{40,64}$/.test(snapshotId)) {
  throw new Error("usage: capture-qa-board-visual.ts --browser PATH --input DIR --output DIR --snapshot SHA");
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string } };
      if (message.id === undefined) return;
      const waiter = this.pending.get(message.id);
      if (waiter === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) waiter.reject(new Error(message.error.message ?? "CDP command failed"));
      else waiter.resolve(message.result);
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      socket.addEventListener("open", () => resolveOpen(), { once: true });
      socket.addEventListener("error", () => rejectOpen(new Error("Chrome DevTools websocket failed")), { once: true });
    });
    return new CdpClient(socket);
  }

  send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolveResult, rejectResult) => {
      this.pending.set(id, { resolve: value => resolveResult(value as T), reject: rejectResult });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    });
  }

  close(): void {
    this.socket.close();
  }
}

type CaptureCase = Readonly<{
  name: string;
  html: string;
  width: number;
  height: number;
  dark?: boolean;
}>;

const cases: readonly CaptureCase[] = [
  { name: "pass-en-desktop", html: "qa-board-pass-en.html", width: 1440, height: 1000 },
  { name: "mixed-en-desktop", html: "qa-board-mixed-en.html", width: 1440, height: 1000 },
  { name: "pass-en-mobile-390", html: "qa-board-pass-en.html", width: 390, height: 844 },
  { name: "mixed-en-mobile-390", html: "qa-board-mixed-en.html", width: 390, height: 844 },
  { name: "pass-en-reflow-320", html: "qa-board-pass-en.html", width: 320, height: 800 },
  { name: "pass-ko-dark-desktop", html: "qa-board-pass-ko.html", width: 1440, height: 1000, dark: true },
  { name: "pass-zh-CN-desktop", html: "qa-board-pass-zh-CN.html", width: 1440, height: 1000 },
];

const profileDir = await mkdtemp(join(tmpdir(), "traceknot-qa-board-chrome-"));
const port = 9300 + Math.floor(Math.random() * 500);
const browser = Bun.spawn([
  browserPath,
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--hide-scrollbars",
  "--allow-file-access-from-files",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  "about:blank",
], { stdout: "ignore", stderr: "ignore" });

let client: CdpClient | undefined;
try {
  let websocketUrl: string | undefined;
  for (let attempt = 0; attempt < 100 && websocketUrl === undefined; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      const version = await response.json() as { webSocketDebuggerUrl?: string };
      websocketUrl = version.webSocketDebuggerUrl;
    } catch {
      await Bun.sleep(50);
    }
  }
  if (websocketUrl === undefined) throw new Error("Chrome DevTools endpoint did not become ready");
  client = await CdpClient.connect(websocketUrl);
  const observations: Array<Record<string, unknown>> = [];

  for (const capture of cases) {
    const created = await client.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const attached = await client.send<{ sessionId: string }>("Target.attachToTarget", { targetId: created.targetId, flatten: true });
    const session = attached.sessionId;
    await client.send("Page.enable", {}, session);
    await client.send("Runtime.enable", {}, session);
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: capture.width,
      height: capture.height,
      deviceScaleFactor: 1,
      mobile: capture.width <= 390,
    }, session);
    await client.send("Emulation.setEmulatedMedia", {
      media: "screen",
      features: [{ name: "prefers-color-scheme", value: capture.dark ? "dark" : "light" }],
    }, session);
    const url = pathToFileURL(resolve(inputDir, capture.html)).href;
    await client.send("Page.navigate", { url }, session);

    for (let attempt = 0; attempt < 100; attempt++) {
      const ready = await client.send<{ result: { value?: boolean } }>("Runtime.evaluate", {
        expression: "document.readyState === 'complete'",
        returnByValue: true,
      }, session);
      if (ready.result.value === true) break;
      if (attempt === 99) throw new Error(`${capture.name}: document did not finish loading`);
      await Bun.sleep(50);
    }
    await client.send("Runtime.evaluate", {
      expression: "document.fonts.ready",
      awaitPromise: true,
      returnByValue: true,
    }, session);

    const measured = await client.send<{ result: { value: Record<string, unknown> } }>("Runtime.evaluate", {
      expression: `(() => {
        const root = document.documentElement;
        const logo = document.querySelector('.brand-mark svg')?.getBoundingClientRect();
        const summary = document.querySelector('.summary-card')?.getBoundingClientRect();
        return {
          documentTitle: document.title,
          language: root.lang,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          clientWidth: root.clientWidth,
          scrollWidth: root.scrollWidth,
          scrollHeight: root.scrollHeight,
          snapshotId: document.querySelector('.summary-meta code')?.getAttribute('title') ?? null,
          pageOverflowX: root.scrollWidth > root.clientWidth,
          officialLogoPresent: document.querySelector('.brand-mark svg[viewBox="0 0 320 320"]') !== null,
          logoWidth: logo?.width ?? 0,
          logoHeight: logo?.height ?? 0,
          summary: summary ? { x: summary.x, y: summary.y + window.scrollY, width: summary.width, height: summary.height } : null,
          notoKoreanAvailable: document.fonts.check('16px "Noto Sans KR"', '추적'),
          notoCjkAvailable: document.fonts.check('16px "Noto Sans CJK KR"', '추적'),
        };
      })()`,
      returnByValue: true,
    }, session);
    const metrics = measured.result.value;
    if (metrics.pageOverflowX === true) throw new Error(`${capture.name}: page-level horizontal overflow (${metrics.scrollWidth} > ${metrics.clientWidth})`);
    if (metrics.officialLogoPresent !== true || metrics.logoWidth !== 32 || metrics.logoHeight !== 32) {
      throw new Error(`${capture.name}: official logo is missing or has unexpected geometry`);
    }
    if (metrics.snapshotId !== snapshotId) throw new Error(`${capture.name}: rendered snapshot ${metrics.snapshotId} does not match ${snapshotId}`);

    const layout = await client.send<{ cssContentSize: { width: number; height: number } }>("Page.getLayoutMetrics", {}, session);
    const full = await client.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: Math.ceil(layout.cssContentSize.width), height: Math.ceil(layout.cssContentSize.height), scale: 1 },
    }, session);
    await writeFile(resolve(outputDir, `${capture.name}-full.png`), Buffer.from(full.data, "base64"));

    const summary = metrics.summary as { x: number; y: number; width: number; height: number } | null;
    if (summary === null) throw new Error(`${capture.name}: summary region is missing`);
    const focused = await client.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: Math.max(0, summary.x), y: Math.max(0, summary.y), width: summary.width, height: summary.height, scale: 1 },
    }, session);
    await writeFile(resolve(outputDir, `${capture.name}-summary.png`), Buffer.from(focused.data, "base64"));
    observations.push({ name: capture.name, html: basename(capture.html), snapshotId, dark: capture.dark ?? false, ...metrics });
    await client.send("Target.closeTarget", { targetId: created.targetId });
  }

  await writeFile(resolve(outputDir, "visual-metrics.json"), `${JSON.stringify({ schemaVersion: "traceknot-qa-board-visual/v1", snapshotId, observations }, null, 2)}\n`);
  console.log(`Captured ${cases.length} QA Board visual scenarios for ${snapshotId}`);
} finally {
  client?.close();
  browser.kill();
  await browser.exited;
  await rm(profileDir, { recursive: true, force: true });
}
