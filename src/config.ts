/**
 * Configuration for pi-sgrep.
 *
 * Resolution order for every setting is the same, highest first:
 *   1. CLI flag      (--sgrep-timeout, --sgrep-model, --sgrep-limit)
 *   2. Environment   (PI_SGREP_*)
 *   3. pi-sgrep.json (pi's agent directory, e.g. ~/.pi/agent/pi-sgrep.json)
 *   4. Built-in default
 *
 * The file is parsed strictly: an unknown key or a malformed value stops the
 * extension from loading and reports the path, because a silently ignored
 * setting is worse than a loud failure.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { piAgentDir } from "./paths.ts";

export const CONFIG_FILE_NAME = "pi-sgrep.json";

export const MODEL_CHOICES = ["auto", "code", "text"] as const;
export type ModelChoice = (typeof MODEL_CHOICES)[number];

export interface SgrepConfig {
  $schema?: string;
  /** Path to the sgrep binary. Resolved through PATH when omitted. */
  binary?: string;
  /** ripgrep binary used by the `sgrep_rank` tool. Resolved through PATH when omitted. */
  rgPath?: string;
  /** Where sgrep stores models and indexes. Passed as `--cache-dir` when the binary supports it. */
  cacheDir?: string;
  /** Embedding model: auto picks text embeddings for prose-only corpora, code embeddings otherwise. */
  model?: ModelChoice;
  /** Per-search timeout in milliseconds. The first search also downloads the model. */
  timeoutMs?: number;
  /** Default number of ranked passages returned to the model. */
  maxResults?: number;
  /** Hard ceiling on `limit`, whatever the model asks for. */
  maxResultsCap?: number;
  /** Maximum source lines printed per result. */
  maxLinesPerResult?: number;
  /** Maximum source lines printed across all results of one call. */
  maxTotalLines?: number;
  /** Maximum characters kept per source line. */
  maxLineLength?: number;
  /** Allow searching $HOME or the filesystem root. */
  allowLargeRoots?: boolean;
  /** Extra arguments appended to every sgrep invocation. */
  extraArgs?: string[];
}

const CONFIG_KEYS: ReadonlySet<string> = new Set([
  "$schema",
  "binary",
  "rgPath",
  "cacheDir",
  "model",
  "timeoutMs",
  "maxResults",
  "maxResultsCap",
  "maxLinesPerResult",
  "maxTotalLines",
  "maxLineLength",
  "allowLargeRoots",
  "extraArgs",
]);

export interface ResolvedSettings {
  binary?: string;
  rgPath?: string;
  cacheDir?: string;
  model: ModelChoice;
  timeoutMs: number;
  maxResults: number;
  maxResultsCap: number;
  maxLinesPerResult: number;
  maxTotalLines: number;
  maxLineLength: number;
  allowLargeRoots: boolean;
  extraArgs: string[];
}

export type SettingName = keyof ResolvedSettings;
export type SettingOrigin = "flag" | "env" | "file" | "default";

export interface SettingsSources {
  /** Values of pi CLI flags registered by this extension. */
  getFlag: (name: string) => boolean | string | undefined;
  env?: NodeJS.ProcessEnv;
}

export const DEFAULT_SETTINGS: ResolvedSettings = {
  model: "auto",
  timeoutMs: 120_000,
  maxResults: 8,
  maxResultsCap: 50,
  maxLinesPerResult: 80,
  maxTotalLines: 240,
  maxLineLength: 500,
  allowLargeRoots: false,
  extraArgs: [],
};

export const SETTING_LIMITS = {
  timeoutMs: { min: 1_000, max: 3_600_000 },
  maxResults: { min: 1, max: 50 },
  maxResultsCap: { min: 1, max: 50 },
  maxLinesPerResult: { min: 1, max: 2_000 },
  maxTotalLines: { min: 1, max: 5_000 },
  maxLineLength: { min: 40, max: 2_000 },
} as const;

export function loadConfig(agentDir: string = piAgentDir()): SgrepConfig {
  const configPath = path.join(agentDir, CONFIG_FILE_NAME);

  let contents: string;
  try {
    contents = readFileSync(configPath, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Could not read pi-sgrep config at ${configPath}: ${errorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error: unknown) {
    throw invalidConfig(configPath, `not valid JSON (${errorMessage(error)})`);
  }

  if (!isRecord(parsed)) throw invalidConfig(configPath, "expected a JSON object");

  for (const key of Object.keys(parsed)) {
    if (!CONFIG_KEYS.has(key)) throw invalidConfig(configPath, `unknown option "${key}"`);
  }

  for (const key of ["$schema", "binary", "rgPath", "cacheDir"] as const) {
    const value = parsed[key];
    if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
      throw invalidConfig(configPath, `"${key}" must be a non-empty string`);
    }
  }

  const model = parsed.model;
  if (model !== undefined && !MODEL_CHOICES.includes(model as ModelChoice)) {
    throw invalidConfig(configPath, `"model" must be one of ${MODEL_CHOICES.join(", ")}`);
  }

  for (const key of ["timeoutMs", "maxResults", "maxResultsCap"] as const) {
    assertIntegerInRange(configPath, parsed, key, SETTING_LIMITS[key]);
  }
  for (const key of ["maxLinesPerResult", "maxTotalLines"] as const) {
    assertIntegerInRange(configPath, parsed, key, SETTING_LIMITS[key]);
  }
  assertIntegerInRange(configPath, parsed, "maxLineLength", SETTING_LIMITS.maxLineLength);

  const allowLargeRoots = parsed.allowLargeRoots;
  if (allowLargeRoots !== undefined && typeof allowLargeRoots !== "boolean") {
    throw invalidConfig(configPath, `"allowLargeRoots" must be a boolean`);
  }

  const extraArgs = parsed.extraArgs;
  if (
    extraArgs !== undefined &&
    (!Array.isArray(extraArgs) || extraArgs.some((item) => typeof item !== "string"))
  ) {
    throw invalidConfig(configPath, `"extraArgs" must be an array of strings`);
  }

  return parsed as SgrepConfig;
}

/**
 * Merge flags, environment, file and defaults. Runs per tool call rather than
 * once at startup: flags are populated after extension load, and the cost is a
 * handful of map lookups.
 */
export function resolveSettings(
  config: SgrepConfig,
  sources: SettingsSources,
): { settings: ResolvedSettings; origins: Record<SettingName, SettingOrigin> } {
  const env = sources.env ?? {};
  const origins = {} as Record<SettingName, SettingOrigin>;

  /**
   * Highest-precedence defined value wins. `pi.getFlag` returns undefined for
   * flags this extension never registered, so a single lookup path covers the
   * settings that are file/environment only (binary, rgPath, cacheDir).
   */
  function pick(name: SettingName, parse: (value: unknown) => unknown, fileValue: unknown): unknown {
    const fromFlag = parseOrUndefined(sources.getFlag(flagName(name)), parse);
    if (fromFlag !== undefined) {
      origins[name] = "flag";
      return fromFlag;
    }
    const fromEnv = parseOrUndefined(env[envName(name)], parse);
    if (fromEnv !== undefined) {
      origins[name] = "env";
      return fromEnv;
    }
    if (fileValue !== undefined) {
      origins[name] = "file";
      return fileValue;
    }
    origins[name] = "default";
    return DEFAULT_SETTINGS[name];
  }

  const settings: ResolvedSettings = {
    binary: pick("binary", parseString, config.binary) as string | undefined,
    rgPath: pick("rgPath", parseString, config.rgPath) as string | undefined,
    cacheDir: pick("cacheDir", parseString, config.cacheDir) as string | undefined,
    model: pick("model", parseModel, config.model) as ModelChoice,
    timeoutMs: pick("timeoutMs", parseInteger(SETTING_LIMITS.timeoutMs), config.timeoutMs) as number,
    maxResults: pick("maxResults", parseInteger(SETTING_LIMITS.maxResults), config.maxResults) as number,
    maxResultsCap: pick(
      "maxResultsCap",
      parseInteger(SETTING_LIMITS.maxResultsCap),
      config.maxResultsCap,
    ) as number,
    maxLinesPerResult: pick(
      "maxLinesPerResult",
      parseInteger(SETTING_LIMITS.maxLinesPerResult),
      config.maxLinesPerResult,
    ) as number,
    maxTotalLines: pick(
      "maxTotalLines",
      parseInteger(SETTING_LIMITS.maxTotalLines),
      config.maxTotalLines,
    ) as number,
    maxLineLength: pick(
      "maxLineLength",
      parseInteger(SETTING_LIMITS.maxLineLength),
      config.maxLineLength,
    ) as number,
    allowLargeRoots: pick("allowLargeRoots", parseBoolean, config.allowLargeRoots) as boolean,
    extraArgs: pick("extraArgs", parseStringArray, config.extraArgs) as string[],
  };

  // `maxResultsCap` is a ceiling on `maxResults`, not an independent knob.
  if (settings.maxResultsCap < settings.maxResults) {
    settings.maxResults = settings.maxResultsCap;
  }

  return { settings, origins };
}

function flagName(name: SettingName): string {
  return `sgrep-${kebab(name)}`;
}

function envName(name: SettingName): string {
  return `PI_SGREP_${kebab(name).replaceAll("-", "_").toUpperCase()}`;
}

function kebab(name: SettingName): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function parseOrUndefined<T>(value: unknown, parse: (value: unknown) => T | undefined): T | undefined {
  if (value === undefined || value === null) return undefined;
  return parse(value);
}

function parseString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return undefined;
}

function parseModel(value: unknown): ModelChoice | undefined {
  return typeof value === "string" && MODEL_CHOICES.includes(value as ModelChoice)
    ? (value as ModelChoice)
    : undefined;
}

function parseInteger(
  limits: { min: number; max: number },
): (value: unknown) => number | undefined {
  return (value: unknown) => {
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string" && /^\d+$/.test(value.trim())
          ? Number(value.trim())
          : Number.NaN;
    if (!Number.isFinite(parsed)) return undefined;
    const clamped = Math.min(limits.max, Math.max(limits.min, Math.round(parsed)));
    return clamped;
  };
}

function assertIntegerInRange(
  configPath: string,
  config: Record<string, unknown>,
  key: "timeoutMs" | "maxResults" | "maxResultsCap" | "maxLinesPerResult" | "maxTotalLines" | "maxLineLength",
  limits: { min: number; max: number },
): void {
  const value = config[key];
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalidConfig(configPath, `"${key}" must be an integer`);
  }
  if (value < limits.min || value > limits.max) {
    throw invalidConfig(configPath, `"${key}" must be between ${limits.min} and ${limits.max}`);
  }
}

function invalidConfig(configPath: string, reason: string): Error {
  return new Error(`Invalid pi-sgrep config at ${configPath}: ${reason}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}