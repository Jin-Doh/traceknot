import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { resolveQaBoardLocale, type QaBoardLocale } from "./qa-board";

type LocaleEnvironment = Readonly<{
  LC_ALL?: string;
  LC_MESSAGES?: string;
  LANGUAGE?: string;
  LANG?: string;
}>;

export type QaBoardLocaleDetectionInput = Readonly<{
  env?: LocaleEnvironment;
  platform?: NodeJS.Platform;
  runtimeLocale?: string;
  preferredLanguages?: readonly string[];
}>;

function languageList(value: string | undefined): string[] {
  return value?.split(":").map(item => item.trim()).filter(Boolean) ?? [];
}

export function parseMacPreferredLanguages(value: string): string[] {
  const quoted = [...value.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/gu)]
    .map(match => match[1]!.replaceAll('\\"', '"').trim())
    .filter(Boolean);
  if (quoted.length > 0) return quoted;
  return value
    .split(/[\s,()]+/u)
    .map(item => item.trim())
    .filter(item => /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*$/u.test(item));
}

function readMacPreference(key: "AppleLanguages" | "AppleLocale"): string[] {
  const result = spawnSync("/usr/bin/defaults", ["read", "-g", key], {
    encoding: "utf8",
    timeout: 750,
    maxBuffer: 16 * 1024,
    windowsHide: true,
    env: { HOME: homedir(), PATH: "/usr/bin:/bin", LANG: "C" },
  });
  if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== "string") return [];
  return parseMacPreferredLanguages(result.stdout);
}

export function readMacPreferredLanguages(): string[] {
  const languages = readMacPreference("AppleLanguages");
  return languages.length > 0 ? languages : readMacPreference("AppleLocale");
}

function defaultRuntimeLocale(): string | undefined {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

export function detectQaBoardLocale(input: QaBoardLocaleDetectionInput = {}): QaBoardLocale {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const preferredLanguages = input.preferredLanguages ?? (platform === "darwin" ? readMacPreferredLanguages() : []);
  return resolveQaBoardLocale(
    env.LC_ALL,
    env.LC_MESSAGES,
    ...languageList(env.LANGUAGE),
    ...preferredLanguages,
    env.LANG,
    input.runtimeLocale ?? defaultRuntimeLocale(),
  );
}
