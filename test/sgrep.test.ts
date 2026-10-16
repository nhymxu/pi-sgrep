import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildRankArgs,
  buildRipgrepArgs,
  buildSearchArgs,
  cacheLocations,
  CODE_MODEL_REPO,
  describeFailure,
  isModelCached,
  parseChunks,
  resolveSgrep,
  runRankedSearch,
  runSearch,
  runSgrep,
  type SgrepCapabilities,
} from "../src/sgrep.ts";
import { FAKE_RG, FAKE_SGREP } from "./helpers/support.ts";

const FULL_CAPS: SgrepCapabilities = {
  version: "sgrep 9.9.9",
  supportsRankInput: true,
  supportsCacheDir: true,
  supportsRefreshCache: true,
  supportsExplain: true,
};

const MINIMAL_CAPS: SgrepCapabilities = {
  version: "sgrep 0.3.0",
  supportsRankInput: false,
  supportsCacheDir: false,
  supportsRefreshCache: false,
  supportsExplain: false,
};

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-sgrep-run-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const key of [
    "FAKE_SGREP_EXIT",
    "FAKE_SGREP_CHUNKS",
    "FAKE_SGREP_STDERR",
    "FAKE_SGREP_SLEEP",
    "FAKE_SGREP_ARGS_FILE",
    "FAKE_SGREP_STDIN_FILE",
    "FAKE_SGREP_HELP",
    "FAKE_SGREP_ARGS_APPEND",
    "FAKE_RG_JSON",
    "FAKE_RG_STDERR",
    "FAKE_RG_EXIT",
    "FAKE_RG_ARGS_FILE",
  ]) {
    delete process.env[key];
  }
});

describe("buildSearchArgs", () => {
  test("puts flags before the positionals and passes the query through untouched", () => {
    const args = buildSearchArgs({
      query: "when does a failed scrape consume credits",
      target: ".",
      limit: 8,
      model: "auto",
      capabilities: FULL_CAPS,
      extraArgs: [],
    });

    expect(args).toEqual([
      "--json",
      "-n",
      "8",
      "--model",
      "auto",
      "when does a failed scrape consume credits",
      ".",
    ]);
  });

  test("never leaks shell syntax into an argument", () => {
    const args = buildSearchArgs({
      query: "$(rm -rf /) && echo `whoami`",
      target: ".",
      limit: 1,
      model: "code",
      capabilities: MINIMAL_CAPS,
      extraArgs: [],
    });

    // The query stays one argv entry, so no shell ever sees it.
    expect(args[args.length - 2]).toBe("$(rm -rf /) && echo `whoami`");
    expect(args[args.length - 1]).toBe(".");
  });

  test("omits flags the installed build does not support", () => {
    const args = buildSearchArgs({
      query: "q",
      target: ".",
      limit: 3,
      model: "text",
      cacheDir: "/tmp/cache",
      refreshCache: true,
      capabilities: MINIMAL_CAPS,
      extraArgs: ["--explain"],
    });

    expect(args).not.toContain("--cache-dir");
    expect(args).not.toContain("--refresh-cache");
    expect(args).toContain("--explain");
    expect(args).toContain("text");
  });

  test("passes cache and refresh flags when supported", () => {
    const args = buildSearchArgs({
      query: "q",
      target: ".",
      limit: 3,
      model: "auto",
      cacheDir: "/tmp/cache",
      refreshCache: true,
      capabilities: FULL_CAPS,
      extraArgs: [],
    });

    expect(args.slice(0, 8)).toEqual([
      "--json",
      "-n",
      "3",
      "--cache-dir",
      "/tmp/cache",
      "--refresh-cache",
      "--model",
      "auto",
    ]);
  });
});

describe("buildRankArgs", () => {
  test("requests stdin ranking", () => {
    const args = buildRankArgs({
      query: "which check actually bills",
      target: ".",
      limit: 5,
      model: "auto",
      extraArgs: [],
    });

    expect(args).toEqual(["--json", "-n", "5", "--stdin", "--model", "auto", "which check actually bills", "."]);
  });
});

describe("buildRipgrepArgs", () => {
  test("keeps the pattern behind -- and disables config and colour", () => {
    expect(buildRipgrepArgs({ pattern: "a|b", target: ".", context: 3 })).toEqual([
      "--json",
      "--no-config",
      "--color",
      "never",
      "-C",
      "3",
      "--",
      "a|b",
      ".",
    ]);
  });
});

describe("parseChunks", () => {
  test("returns an empty array for empty output", () => {
    expect(parseChunks("")).toEqual([]);
    expect(parseChunks("[]")).toEqual([]);
  });

  test("keeps well-formed passages and drops malformed entries", () => {
    const chunks = parseChunks(
      JSON.stringify([
        { path: "a.ts", start: 1, end: 2, content: "a\nb\n" },
        { path: "b.ts" },
        "nope",
      ]),
    );
    expect(chunks).toEqual([{ path: "a.ts", start: 1, end: 2, content: "a\nb\n" }]);
  });

  test("explains non-JSON output instead of throwing a parse error", () => {
    expect(() => parseChunks("sgrep: boom")).toThrow(/not JSON: sgrep: boom/);
  });

  test("rejects a non-array payload", () => {
    expect(() => parseChunks('{"path":"a"}')).toThrow(/where a result array was expected/);
  });
});

describe("resolveSgrep", () => {
  test("detects capabilities from --help", async () => {
    const result = await resolveSgrep(FAKE_SGREP);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.binary).toBe(FAKE_SGREP);
    expect(result.capabilities.version).toBe("sgrep 9.9.9-fake");
    expect(result.capabilities.supportsRankInput).toBe(true);
    expect(result.capabilities.supportsCacheDir).toBe(true);
  });

  test("detects an older build that cannot rank ripgrep input", async () => {
    process.env.FAKE_SGREP_HELP = "minimal";
    const result = await resolveSgrep(FAKE_SGREP);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.capabilities.supportsRankInput).toBe(false);
    expect(result.capabilities.supportsCacheDir).toBe(false);
  });

  test("reports a missing binary with an install hint", async () => {
    const result = await resolveSgrep(path.join(scratch(), "not-here"));
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.reason).toBe("not-found");
    expect(result.message).toContain("not runnable");
    expect(result.hint).toContain("cargo install --git https://github.com/context-dot-dev/sgrep");
  });
});

describe("runSearch", () => {
  const cwd = scratch();

  test("returns parsed stdout on success", async () => {
    const chunksFile = path.join(cwd, "chunks.json");
    writeFileSync(chunksFile, JSON.stringify([{ path: "a.ts", start: 1, end: 2, content: "x\ny\n" }]));
    process.env.FAKE_SGREP_CHUNKS = chunksFile;

    const outcome = await runSearch(FAKE_SGREP, ["--json", "q", "."], { cwd, timeoutMs: 10_000 });
    expect(outcome.exitCode).toBe(0);
    expect(parseChunks(outcome.stdout)).toHaveLength(1);
  });

  test("treats exit code 1 as an empty result, not a failure", async () => {
    process.env.FAKE_SGREP_EXIT = "1";
    const outcome = await runSearch(FAKE_SGREP, ["--json", "q", "."], { cwd, timeoutMs: 10_000 });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.timedOut).toBe(false);
  });

  test("surfaces exit code 2 with stderr", async () => {
    process.env.FAKE_SGREP_EXIT = "2";
    process.env.FAKE_SGREP_STDERR = "sgrep: query has no searchable words";
    const outcome = await runSearch(FAKE_SGREP, ["--json", "?", "."], { cwd, timeoutMs: 10_000 });

    expect(outcome.exitCode).toBe(2);
    expect(describeFailure(outcome)).toContain("query has no searchable words");
    expect(describeFailure(outcome)).toContain("Rephrase with concrete nouns");
  });

  test("times out a hung child and kills it", async () => {
    process.env.FAKE_SGREP_SLEEP = "5000";
    const started = Date.now();
    const outcome = await runSearch(FAKE_SGREP, ["--json", "q", "."], { cwd, timeoutMs: 300 });

    expect(outcome.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  test("aborts when the agent cancels the turn", async () => {
    process.env.FAKE_SGREP_SLEEP = "5000";
    const controller = new AbortController();
    const running = runSearch(FAKE_SGREP, ["--json", "q", "."], {
      cwd,
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);

    const outcome = await running;
    expect(outcome.aborted).toBe(true);
    expect(outcome.timedOut).toBe(false);
  });

  test("shares one child between identical concurrent searches", async () => {
    const argsFile = path.join(cwd, "argv-dedupe.jsonl");
    process.env.FAKE_SGREP_ARGS_FILE = argsFile;
    process.env.FAKE_SGREP_ARGS_APPEND = "1";

    const key = `dedupe-${Date.now()}`;
    const [first, second] = await Promise.all([
      runSearch(FAKE_SGREP, ["--json", "q", "."], { cwd, timeoutMs: 10_000 }, key),
      runSearch(FAKE_SGREP, ["--json", "q", "."], { cwd, timeoutMs: 10_000 }, key),
    ]);

    expect(readFileSync(argsFile, "utf8").trim().split("\n")).toHaveLength(1);
    expect(first.stdout).toBe(second.stdout);

    delete process.env.FAKE_SGREP_ARGS_APPEND;
  });

  test("reports a binary that cannot be executed instead of throwing", async () => {
    const outcome = await runSgrep(
      path.join(scratch(), "not-a-program"),
      ["--version"],
      { cwd, timeoutMs: 5_000 },
    );

    expect(outcome.exitCode).toBeNull();
    expect(outcome.stderr).toMatch(/Could not start .*: (ENOENT|EACCES)/);
  });

  test("does not dedupe different searches", async () => {
    const argsFile = path.join(cwd, "argv-distinct.jsonl");
    process.env.FAKE_SGREP_ARGS_FILE = argsFile;
    process.env.FAKE_SGREP_ARGS_APPEND = "1";

    await Promise.all([
      runSearch(FAKE_SGREP, ["--json", "one", "."], { cwd, timeoutMs: 10_000 }),
      runSearch(FAKE_SGREP, ["--json", "two", "."], { cwd, timeoutMs: 10_000 }),
    ]);

    const seen = readFileSync(argsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(seen).toContainEqual(["--json", "one", "."]);
    expect(seen).toContainEqual(["--json", "two", "."]);

    delete process.env.FAKE_SGREP_ARGS_APPEND;
  });
});

describe("runRankedSearch", () => {
  const cwd = scratch();

  test("streams ripgrep JSON into sgrep and reports the match count", async () => {
    const rgJson = path.join(cwd, "rg.jsonl");
    const match = (line: number) =>
      `${JSON.stringify({ type: "match", data: { path: { text: "a.ts" }, line_number: line, lines: { text: "hit\n" } } })}\n`;
    writeFileSync(rgJson, match(1) + match(2) + match(3));

    process.env.FAKE_RG_JSON = rgJson;
    process.env.FAKE_SGREP_CHUNKS = path.join(cwd, "chunks.json");
    writeFileSync(process.env.FAKE_SGREP_CHUNKS, "[]");

    const stdinFile = path.join(cwd, "stdin.json");
    process.env.FAKE_SGREP_STDIN_FILE = stdinFile;

    const outcome = await runRankedSearch({
      sgrepBinary: FAKE_SGREP,
      sgrepArgs: ["--json", "-n", "5", "--stdin", "why", "."],
      ripgrepBinary: FAKE_RG,
      ripgrepArgs: ["--json", "--", "hit", "."],
      cwd,
      timeoutMs: 10_000,
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.matchCount).toBe(3);
    expect(outcome.ripgrep.exitCode).toBe(0);

    const piped = JSON.parse(readFileSync(stdinFile, "utf8")) as { bytes: number; argv: string[] };
    expect(piped.bytes).toBe(readFileSync(rgJson).length);
    expect(piped.argv).toContain("--stdin");
  });

  test("keeps a ripgrep failure out of the sgrep exit status", async () => {
    process.env.FAKE_RG_EXIT = "2";
    process.env.FAKE_RG_STDERR = "regex parse error: unclosed group";

    const outcome = await runRankedSearch({
      sgrepBinary: FAKE_SGREP,
      sgrepArgs: ["--json", "--stdin", "q", "."],
      ripgrepBinary: FAKE_RG,
      ripgrepArgs: ["--json", "--", "(", "."],
      cwd,
      timeoutMs: 10_000,
    });

    expect(outcome.ripgrep.exitCode).toBe(2);
    expect(describeFailure(outcome)).toContain("regex parse error");
  });

  test("kills both children on abort", async () => {
    process.env.FAKE_RG_SLEEP = "5000";
    process.env.FAKE_SGREP_SLEEP = "5000";

    const controller = new AbortController();
    const running = runRankedSearch({
      sgrepBinary: FAKE_SGREP,
      sgrepArgs: ["--json", "--stdin", "q", "."],
      ripgrepBinary: FAKE_RG,
      ripgrepArgs: ["--json", "--", "hit", "."],
      cwd,
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);

    const outcome = await running;
    expect(outcome.aborted).toBe(true);
  });
});

describe("cache locations", () => {
  test("follows sgrep's own resolution order", () => {
    const explicit = cacheLocations("/data/sgrep", {});
    expect(explicit).toEqual({
      hub: path.join("/data/sgrep", "hub"),
      index: path.join("/data/sgrep", "index"),
      usesCacheDir: true,
    });

    // SGREP_CACHE_DIR names the index directory directly and does not move the
    // model hub, unlike --cache-dir.
    const fromEnv = cacheLocations(undefined, { SGREP_CACHE_DIR: "/env/sgrep" });
    expect(fromEnv.index).toBe("/env/sgrep");
    expect(fromEnv.hub).toContain(path.join("huggingface", "hub"));

    const fromXdg = cacheLocations(undefined, { XDG_CACHE_HOME: "/xdg" });
    expect(fromXdg.index).toBe(path.join("/xdg", "sgrep"));
    expect(fromXdg.hub).toBe(path.join("/xdg", "huggingface", "hub"));

    const fromHf = cacheLocations(undefined, { HF_HUB_CACHE: "/hf/hub" });
    expect(fromHf.hub).toBe("/hf/hub");
  });

  test("detects a downloaded model by its snapshot file", () => {
    const hub = scratch();
    expect(isModelCached(hub, CODE_MODEL_REPO)).toBe(false);

    const snapshot = path.join(hub, `models--${CODE_MODEL_REPO.replace("/", "--")}`, "snapshots", "abc");
    mkdirSync(snapshot, { recursive: true });
    writeFileSync(path.join(snapshot, "model.safetensors"), "weights");

    expect(isModelCached(hub, CODE_MODEL_REPO)).toBe(true);
  });
});