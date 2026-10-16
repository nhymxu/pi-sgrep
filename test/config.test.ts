import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_SETTINGS,
  loadConfig,
  resolveSettings,
  type SgrepConfig,
} from "../src/config.ts";

const created: string[] = [];

function agentDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-sgrep-config-"));
  created.push(dir);
  return dir;
}

function writeConfig(contents: string): string {
  const dir = agentDir();
  writeFileSync(path.join(dir, "pi-sgrep.json"), contents);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  test("returns an empty config when the file is missing", () => {
    expect(loadConfig(agentDir())).toEqual({});
  });

  test("rejects malformed JSON with the file path", () => {
    const dir = writeConfig("{ not json");
    expect(() => loadConfig(dir)).toThrow(/Invalid pi-sgrep config at .*pi-sgrep\.json: not valid JSON/);
  });

  test("rejects unknown keys so typos cannot be ignored", () => {
    const dir = writeConfig(JSON.stringify({ maxResults: 3, maxresult: 4 }));
    expect(() => loadConfig(dir)).toThrow(/unknown option "maxresult"/);
  });

  test("rejects an invalid model", () => {
    const dir = writeConfig(JSON.stringify({ model: "semantic" }));
    expect(() => loadConfig(dir)).toThrow(/"model" must be one of auto, code, text/);
  });

  test("rejects out-of-range numbers", () => {
    const dir = writeConfig(JSON.stringify({ timeoutMs: 10 }));
    expect(() => loadConfig(dir)).toThrow(/"timeoutMs" must be between 1000 and 3600000/);
  });

  test("rejects non-integer numbers", () => {
    const dir = writeConfig(JSON.stringify({ maxResults: 2.5 }));
    expect(() => loadConfig(dir)).toThrow(/"maxResults" must be an integer/);
  });

  test("rejects a non-boolean allowLargeRoots", () => {
    const dir = writeConfig(JSON.stringify({ allowLargeRoots: "yes" }));
    expect(() => loadConfig(dir)).toThrow(/"allowLargeRoots" must be a boolean/);
  });

  test("accepts a full config", () => {
    const dir = writeConfig(
      JSON.stringify({
        $schema: "https://example.test/schema.json",
        binary: "/usr/local/bin/sgrep",
        rgPath: "/usr/local/bin/rg",
        cacheDir: "/tmp/sgrep",
        model: "code",
        timeoutMs: 30_000,
        maxResults: 5,
        maxResultsCap: 20,
        maxLinesPerResult: 40,
        maxTotalLines: 120,
        maxLineLength: 200,
        allowLargeRoots: true,
        extraArgs: ["--explain"],
      }),
    );

    expect(loadConfig(dir)).toMatchObject({
      binary: "/usr/local/bin/sgrep",
      model: "code",
      timeoutMs: 30_000,
      extraArgs: ["--explain"],
    });
  });
});

describe("resolveSettings", () => {
  const noFlags = () => undefined;

  test("falls back to defaults", () => {
    const { settings, origins } = resolveSettings({}, { getFlag: noFlags, env: {} });
    expect(settings.maxResults).toBe(DEFAULT_SETTINGS.maxResults);
    expect(settings.model).toBe("auto");
    expect(origins.maxResults).toBe("default");
    expect(origins.binary).toBe("default");
  });

  test("file beats default", () => {
    const config: SgrepConfig = { maxResults: 3 };
    const { settings, origins } = resolveSettings(config, { getFlag: noFlags, env: {} });
    expect(settings.maxResults).toBe(3);
    expect(origins.maxResults).toBe("file");
  });

  test("environment beats file", () => {
    const config: SgrepConfig = { maxResults: 3 };
    const { settings, origins } = resolveSettings(config, {
      getFlag: noFlags,
      env: { PI_SGREP_MAX_RESULTS: "5" },
    });
    expect(settings.maxResults).toBe(5);
    expect(origins.maxResults).toBe("env");
  });

  test("flag beats environment and file", () => {
    const config: SgrepConfig = { maxResults: 3 };
    const { settings, origins } = resolveSettings(config, {
      getFlag: (name) => (name === "sgrep-max-results" ? "7" : undefined),
      env: { PI_SGREP_MAX_RESULTS: "5" },
    });
    expect(settings.maxResults).toBe(7);
    expect(origins.maxResults).toBe("flag");
  });

  test("ignores unparseable values instead of forwarding them", () => {
    const { settings, origins } = resolveSettings(
      { maxResults: 3 },
      { getFlag: () => "many", env: { PI_SGREP_TIMEOUT_MS: "soon" } },
    );
    expect(settings.maxResults).toBe(3);
    expect(settings.timeoutMs).toBe(DEFAULT_SETTINGS.timeoutMs);
    expect(origins.maxResults).toBe("file");
    expect(origins.timeoutMs).toBe("default");
  });

  test("clamps environment values into range", () => {
    const { settings } = resolveSettings({}, { getFlag: noFlags, env: { PI_SGREP_TIMEOUT_MS: "1" } });
    expect(settings.timeoutMs).toBe(1_000);
  });

  test("maxResults never exceeds the cap", () => {
    const { settings } = resolveSettings(
      { maxResults: 40, maxResultsCap: 10 },
      { getFlag: noFlags, env: {} },
    );
    expect(settings.maxResults).toBe(10);
  });

  test("parses booleans from flags and environment", () => {
    const fromEnv = resolveSettings({}, { getFlag: noFlags, env: { PI_SGREP_ALLOW_LARGE_ROOTS: "1" } });
    expect(fromEnv.settings.allowLargeRoots).toBe(true);

    const fromFlag = resolveSettings(
      {},
      { getFlag: (name) => (name === "sgrep-allow-large-roots" ? false : undefined), env: {} },
    );
    expect(fromFlag.settings.allowLargeRoots).toBe(false);
    expect(fromFlag.origins.allowLargeRoots).toBe("flag");
  });
});