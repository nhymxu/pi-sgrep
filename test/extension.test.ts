import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createContext, FAKE_RG, FAKE_SGREP } from "./helpers/support.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CHUNKS = [
  {
    path: "retry.ts",
    start: 10,
    end: 12,
    content: "export function retry(times: number) {\n  return times;\n}\n",
  },
  {
    path: "client.ts",
    start: 1,
    end: 3,
    content: "const client = 1;\nconst retries = 2;\nconst backoff = 3;\n",
  },
];

/** One loaded extension: the factory is async, so tests await `load()`. */
interface Loaded {
  pi: Record<string, any>;
  tools: Map<string, any>;
  commands: Map<string, any>;
  flags: Map<string, any>;
  events: Map<string, (...args: any[]) => unknown>;
}

async function load(options: {
  agentDir: string;
  flags?: Record<string, boolean | string>;
  env?: Record<string, string>;
}): Promise<Loaded> {
  const previous = { ...process.env };
  process.env.PI_CODING_AGENT_DIR = options.agentDir;
  for (const [key, value] of Object.entries(options.env ?? {})) process.env[key] = value;

  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const flags = new Map<string, any>();
  const events = new Map<string, (...args: any[]) => unknown>();
  const flagValues = new Map<string, boolean | string>(
    Object.entries(options.flags ?? {}),
  );

  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerFlag: (name: string, spec: any) => flags.set(name, spec),
    getFlag: (name: string) => (flags.has(name) ? flagValues.get(name) : undefined),
    getActiveTools: () => [],
    setActiveTools: () => {},
    getAllTools: () => [...tools.values()].map((tool) => ({ name: tool.name })),
    appendEntry: () => {},
    on: (event: string, handler: (...args: any[]) => unknown) => {
      events.set(event, handler);
      return () => events.delete(event);
    },
  } as unknown as ExtensionAPI;

  try {
    // A fresh module instance per test: the factory caches nothing, but the
    // factory itself must observe the agent dir set above.
    const module = await import(`../src/index.ts?case=${Math.random()}`);
    await module.default(pi);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  }

  return { pi, tools, commands, flags, events };
}

async function expectToolError(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await run();
    throw new Error("expected the tool to throw");
  } catch (error: unknown) {
    expect((error as Error).message).toMatch(pattern);
  }
}

const scratchDirs: string[] = [];

function agentDirWithConfig(config: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "pi-sgrep-agent-"));
  scratchDirs.push(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "pi-sgrep.json"),
    JSON.stringify({ binary: FAKE_SGREP, rgPath: FAKE_RG, ...config }),
  );
  return dir;
}

afterEach(() => {
  for (const key of [
    "FAKE_SGREP_EXIT",
    "FAKE_SGREP_CHUNKS",
    "FAKE_SGREP_STDERR",
    "FAKE_SGREP_SLEEP",
    "FAKE_SGREP_ARGS_FILE",
    "FAKE_SGREP_ARGS_APPEND",
    "FAKE_SGREP_STDIN_FILE",
    "FAKE_SGREP_HELP",
    "FAKE_RG_JSON",
    "FAKE_RG_EXIT",
    "FAKE_RG_STDERR",
  ]) {
    delete process.env[key];
  }
});

describe("registration", () => {
  test("registers sgrep and sgrep_rank on a current build", async () => {
    const loaded = await load({ agentDir: agentDirWithConfig({}) });
    expect([...loaded.tools.keys()].sort()).toEqual(["sgrep", "sgrep_rank"]);
  });

  test("skips sgrep_rank when the build cannot read ripgrep JSON", async () => {
    process.env.FAKE_SGREP_HELP = "minimal";
    const loaded = await load({ agentDir: agentDirWithConfig({}) });
    expect([...loaded.tools.keys()]).toEqual(["sgrep"]);
  });

  test("registers the CLI flags and both commands", async () => {
    const loaded = await load({ agentDir: agentDirWithConfig({}) });
    expect([...loaded.flags.keys()].sort()).toEqual([
      "sgrep-limit",
      "sgrep-model",
      "sgrep-refresh-cache",
      "sgrep-timeout",
    ]);
    expect([...loaded.commands.keys()].sort()).toEqual(["sgrep-health", "sgrep-warm"]);
  });

  test("declares tools as read-only and prompt-visible", async () => {
    const loaded = await load({ agentDir: agentDirWithConfig({}) });
    const search = loaded.tools.get("sgrep");

    expect(search.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(search.promptSnippet).toBeTruthy();
    expect(search.promptGuidelines.join(" ")).toContain("sgrep_rank");
    expect(search.outputSchema).toBeDefined();
  });

  test("refuses to load with a broken config file", async () => {
    const dir = mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "pi-sgrep-bad-"));
    writeFileSync(path.join(dir, "pi-sgrep.json"), JSON.stringify({ nope: 1 }));

    const pi = {
      registerTool: () => {},
      registerCommand: () => {},
      registerFlag: () => {},
      getFlag: () => undefined,
      on: () => () => {},
    } as unknown as ExtensionAPI;

    const module = await import(`../src/index.ts?case=${Math.random()}`);
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      await expect(module.default(pi)).rejects.toThrow(/unknown option "nope"/);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});

describe("sgrep tool", () => {
  async function setup(chunks = CHUNKS, overrides: Record<string, unknown> = {}) {
    const agentDir = agentDirWithConfig(overrides);
    const chunksFile = path.join(agentDir, "chunks.json");
    writeFileSync(chunksFile, JSON.stringify(chunks));
    process.env.FAKE_SGREP_CHUNKS = chunksFile;

    const loaded = await load({ agentDir });
    const ctx = createContext(process.cwd());
    return { loaded, ctx: ctx.ctx as any, tool: loaded.tools.get("sgrep") };
  }

  test("returns numbered passages the model can read directly", async () => {
    const { tool, ctx } = await setup();

    const result = await tool.execute("call-1", { query: "retry helper" }, undefined, undefined, ctx);
    const text = (result.content[0] as { text: string }).text;

    expect(text).toContain('sgrep: "retry helper" in . — 2 result(s)');
    expect(text).toContain("retry.ts:10-12 (3 lines)");
    expect(text).toContain("10  export function retry(times: number) {");
    expect(text).toContain("client.ts:1-3");
    expect(result.details).toMatchObject({ query: "retry helper", shown: 2, total: 2 });
    expect((result.structuredContent as any).results[0]).toMatchObject({
      path: "retry.ts",
      start: 10,
      end: 12,
      lines: 3,
    });
  });

  test("passes flags and limits through to the binary", async () => {
    const agentDir = agentDirWithConfig({});
    const argsFile = path.join(agentDir, "argv.json");
    process.env.FAKE_SGREP_ARGS_FILE = argsFile;
    const loaded = await load({ agentDir, flags: { "sgrep-limit": "3", "sgrep-model": "code" } });
    const ctx = createContext(process.cwd());

    await loaded.tools
      .get("sgrep")
      .execute("call", { query: "billing", limit: 2 }, undefined, undefined, ctx.ctx as any);

    const argv = JSON.parse(readFileSync(argsFile, "utf8"));
    expect(argv).toEqual(["--json", "-n", "2", "--model", "code", "billing", "."]);
  });

  test("caps a requested limit at maxResultsCap", async () => {
    const agentDir = agentDirWithConfig({ maxResultsCap: 4 });
    const argsFile = path.join(agentDir, "argv.json");
    process.env.FAKE_SGREP_ARGS_FILE = argsFile;
    const loaded = await load({ agentDir });
    const ctx = createContext(process.cwd());

    await loaded.tools
      .get("sgrep")
      .execute("call", { query: "billing", limit: 100 }, undefined, undefined, ctx.ctx as any);

    expect(JSON.parse(readFileSync(argsFile, "utf8"))).toContain("4");
  });

  test("reports an empty result set without treating it as an error", async () => {
    process.env.FAKE_SGREP_EXIT = "1";
    const { tool, ctx } = await setup([]);

    const result = await tool.execute("call", { query: "nothing here" }, undefined, undefined, ctx);
    expect((result.content[0] as { text: string }).text).toContain("No passages found");
    expect(result.details).toMatchObject({ shown: 0, total: 0 });
  });

  test("turns an sgrep failure into an actionable message", async () => {
    const { tool, ctx } = await setup();
    process.env.FAKE_SGREP_EXIT = "2";
    process.env.FAKE_SGREP_STDERR = "sgrep: query has no searchable words";

    await expectToolError(
      () => tool.execute("call", { query: "how does it work" }, undefined, undefined, ctx),
      /query has no searchable words[\s\S]*Rephrase with concrete nouns/,
    );
  });

  test("rejects an empty query before spawning anything", async () => {
    const { tool, ctx } = await setup();
    await expectToolError(
      () => tool.execute("call", { query: "   " }, undefined, undefined, ctx),
      /`query` must not be empty/,
    );
  });

  test("rejects a path that does not exist", async () => {
    const { tool, ctx } = await setup();
    await expectToolError(
      () => tool.execute("call", { query: "x", path: "nope/missing" }, undefined, undefined, ctx),
      /Path not found: nope\/missing/,
    );
  });

  test("applies the per-call output budget", async () => {
    const many = Array.from({ length: 5 }, (_, index) => ({
      path: `file${index}.ts`,
      start: 1,
      end: 30,
      content: Array.from({ length: 30 }, (_, line) => `line ${line + 1}`).join("\n"),
    }));
    const { tool, ctx } = await setup(many, { maxTotalLines: 40, maxLinesPerResult: 20 });

    const result = await tool.execute("call", { query: "x", limit: 5 }, undefined, undefined, ctx);
    const text = (result.content[0] as { text: string }).text;

    // 40 source lines of budget, 20 per passage: two passages are partially
    // printed and the rest is dropped.
    expect(result.details.shown).toBe(2);
    expect(text).toContain("10 more lines (to line 30)");
    expect(text).toContain("Read file0.ts at offset 21 for the rest.");
    expect(text).toContain("source lines suppressed by the output budget");
  });

  test("refuses to index $HOME unless allowLargeRoots is set", async () => {
    const { tool, ctx } = await setup();
    await expectToolError(
      () => tool.execute("call", { query: "x", path: "~/" }, undefined, undefined, ctx),
      /Refusing to search \$HOME/,
    );
  });
});

describe("sgrep_rank tool", () => {
  async function setup() {
    const agentDir = agentDirWithConfig({});
    const chunksFile = path.join(agentDir, "chunks.json");
    writeFileSync(chunksFile, JSON.stringify([CHUNKS[0]!]));
    process.env.FAKE_SGREP_CHUNKS = chunksFile;
    process.env.FAKE_SGREP_ARGS_FILE = path.join(agentDir, "argv.json");
    process.env.FAKE_SGREP_STDIN_FILE = path.join(agentDir, "stdin.json");

    const rgJson = path.join(agentDir, "rg.jsonl");
    const event = (line: number) =>
      `${JSON.stringify({ type: "match", data: { path: { text: "retry.ts" }, line_number: line, lines: { text: "hit\n" } } })}\n`;
    writeFileSync(rgJson, event(10) + event(11) + event(12));
    process.env.FAKE_RG_JSON = rgJson;

    const loaded = await load({ agentDir });
    return { loaded, tool: loaded.tools.get("sgrep_rank"), ctx: createContext(process.cwd()).ctx as any };
  }

  test("pipes ripgrep output into sgrep and reports the candidate count", async () => {
    const { tool, ctx } = await setup();

    const result = await tool.execute(
      "call",
      { pattern: "retry", query: "how many attempts are made" },
      undefined,
      undefined,
      ctx,
    );
    const text = (result.content[0] as { text: string }).text;

    expect(text).toContain("3 ripgrep match(es) for /retry/");
    expect(text).toContain('ranked by "how many attempts are made"');
    expect(text).toContain("context 3 lines");
    expect(result.details).toMatchObject({ pattern: "retry", matches: 3, shown: 1 });

    const argv = JSON.parse(readFileSync(process.env.FAKE_SGREP_ARGS_FILE!, "utf8"));
    expect(argv).toContain("--stdin");
    expect(argv.slice(-2)).toEqual(["how many attempts are made", "."]);

    const piped = JSON.parse(readFileSync(process.env.FAKE_SGREP_STDIN_FILE!, "utf8"));
    expect(piped.bytes).toBeGreaterThan(0);
  });

  test("defaults the ranking query to the pattern", async () => {
    const { tool, ctx } = await setup();
    await tool.execute("call", { pattern: "retry" }, undefined, undefined, ctx);

    const argv = JSON.parse(readFileSync(process.env.FAKE_SGREP_ARGS_FILE!, "utf8"));
    expect(argv.slice(-2)).toEqual(["retry", "."]);
  });

  test("surfaces a broken ripgrep pattern instead of reporting no results", async () => {
    const { tool, ctx } = await setup();
    process.env.FAKE_RG_EXIT = "2";
    process.env.FAKE_RG_STDERR = "regex parse error: unclosed group";

    await expectToolError(
      () => tool.execute("call", { pattern: "(" }, undefined, undefined, ctx),
      /ripgrep failed on pattern \/\(\/: regex parse error/,
    );
  });

  test("clamps the context window", async () => {
    const { tool, ctx } = await setup();
    await tool.execute("call", { pattern: "retry", context: 500 }, undefined, undefined, ctx);

    const sgrepArgv = JSON.parse(readFileSync(process.env.FAKE_SGREP_ARGS_FILE!, "utf8"));
    expect(sgrepArgv).toBeDefined();
    const result = await tool.execute("call", { pattern: "retry", context: 500 }, undefined, undefined, ctx);
    expect((result.content[0] as { text: string }).text).toContain("context 20 lines");
  });
});

describe("commands", () => {
  test("/sgrep-health reports the binary, features and caches", async () => {
    const loaded = await load({ agentDir: agentDirWithConfig({}) });
    const { ctx, notifications } = createContext(process.cwd());

    await loaded.commands.get("sgrep-health").handler("", ctx as any);
    const message = notifications.at(-1)!.message;

    expect(message).toContain("sgrep 9.9.9-fake");
    expect(message).toContain("rank ripgrep input (sgrep_rank)");
    expect(message).toContain("Model cache:");
    expect(message).toContain("maxResults=8 (default)");
  });

  test("/sgrep-health explains a missing binary", async () => {
    const loaded = await load({ agentDir: agentDirWithConfig({ binary: "/nonexistent/sgrep" }) });
    const { ctx, notifications } = createContext(process.cwd());

    await loaded.commands.get("sgrep-health").handler("", ctx as any);
    expect(notifications.at(-1)!.message).toContain("NOT AVAILABLE");
    expect(notifications.at(-1)!.message).toContain("cargo install --git");
  });

  test("/sgrep-warm runs a search and clears the footer status", async () => {
    const agentDir = agentDirWithConfig({});
    const chunksFile = path.join(agentDir, "chunks.json");
    writeFileSync(chunksFile, JSON.stringify([CHUNKS[0]!]));
    process.env.FAKE_SGREP_CHUNKS = chunksFile;

    const loaded = await load({ agentDir });
    const { ctx, notifications, statuses } = createContext(process.cwd());

    await loaded.commands.get("sgrep-warm").handler("src --refresh", ctx as any);
    const message = notifications.at(-1)!.message;

    expect(message).toContain("sgrep ready in");
    expect(message).toContain("Index was rebuilt.");
    expect(statuses[0]?.text).toContain("preparing");
    expect(statuses.at(-1)?.text).toBeUndefined();
  });

  test("/sgrep-warm refuses to index $HOME", async () => {
    const loaded = await load({ agentDir: agentDirWithConfig({}) });
    const { ctx, notifications } = createContext(process.cwd());

    await loaded.commands.get("sgrep-warm").handler("~/", ctx as any);
    expect(notifications.at(-1)!.message).toContain("Refusing to search $HOME");
    expect(notifications.at(-1)!.type).toBe("error");
  });
});

describe("session lifecycle", () => {
  test("warns once when sgrep is missing and registers no tools", async () => {
    const loaded = await load({ agentDir: agentDirWithConfig({ binary: "/nonexistent/sgrep" }) });
    expect(loaded.tools.size).toBe(0);

    const { ctx, notifications } = createContext(process.cwd());
    await loaded.events.get("session_start")!({ reason: "startup" }, ctx as any);

    expect(notifications.at(-1)!.type).toBe("warning");
    expect(notifications.at(-1)!.message).toContain("cargo install --git");
  });

  test("notes when ranking is unavailable on an older build", async () => {
    process.env.FAKE_SGREP_HELP = "minimal";
    const loaded = await load({ agentDir: agentDirWithConfig({}) });

    const { ctx, notifications } = createContext(process.cwd());
    await loaded.events.get("session_start")!({ reason: "startup" }, ctx as any);

    expect(notifications.at(-1)!.message).toContain("sgrep_rank is not available");
  });
});