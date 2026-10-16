/**
 * Loads the extension through pi's own loader, the way `pi install` does.
 *
 * The mocked `pi` in extension.test.ts covers tool wiring; this covers the parts
 * only the real loader decides: that the async factory runs and is awaited,
 * that the tools land in the registry with a usable schema, and that a missing
 * binary degrades to no tools rather than a failed load.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions, type LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { FAKE_SGREP } from "./helpers/support.ts";

const EXTENSION_PATH = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const WORKSPACE = mkdtempSync(path.join(tmpdir(), "pi-sgrep-load-cwd-"));

async function loadWithAgentDir(config: Record<string, unknown>): Promise<LoadExtensionsResult> {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-sgrep-load-"));
  writeFileSync(
    path.join(dir, "pi-sgrep.json"),
    JSON.stringify({ binary: FAKE_SGREP, ...config }),
  );

  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    return await discoverAndLoadExtensions([EXTENSION_PATH], WORKSPACE);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

function names(result: LoadExtensionsResult, key: "tools" | "commands" | "flags"): string[] {
  return result.extensions.flatMap((extension) => [...extension[key].keys()]).sort();
}

/** The loader keys tools by name and stores `{ definition, sourceInfo }`. */
function toolNamed(result: LoadExtensionsResult, name: string) {
  for (const extension of result.extensions) {
    const tool = extension.tools.get(name);
    if (tool) return tool;
  }
  throw new Error(`no tool named ${name} was registered`);
}

describe("pi loader integration", () => {
  test("loads and registers both tools, both commands and all flags", async () => {
    const result = await loadWithAgentDir({});

    expect(result.errors).toEqual([]);
    expect(names(result, "tools")).toEqual(["sgrep", "sgrep_rank"]);
    expect(names(result, "commands")).toEqual(["sgrep-health", "sgrep-warm"]);
    expect(names(result, "flags")).toEqual([
      "sgrep-limit",
      "sgrep-model",
      "sgrep-refresh-cache",
      "sgrep-timeout",
    ]);
  }, 60_000);

  test("exposes a parameter schema the loader accepts", async () => {
    const result = await loadWithAgentDir({});
    const search = toolNamed(result, "sgrep");

    const parameters = search.definition.parameters as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(parameters.type).toBe("object");
    expect(Object.keys(parameters.properties ?? {}).sort()).toEqual([
      "limit",
      "model",
      "path",
      "query",
    ]);
    expect(parameters.required).toEqual(["query"]);
  }, 60_000);

  test("marks the tools read-only for permission extensions", async () => {
    const result = await loadWithAgentDir({});
    expect(toolNamed(result, "sgrep").definition.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(toolNamed(result, "sgrep_rank").definition.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
  }, 60_000);

  test("registers no tools when the binary is missing, without failing the load", async () => {
    const result = await loadWithAgentDir({ binary: "/nonexistent/sgrep" });

    expect(result.errors).toEqual([]);
    expect(names(result, "tools")).toEqual([]);
    // The commands stay registered so `/sgrep-health` can explain the problem.
    expect(names(result, "commands")).toEqual(["sgrep-health", "sgrep-warm"]);
  }, 60_000);

  test("surfaces a broken config as a load error naming the file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-sgrep-load-bad-"));
    writeFileSync(path.join(dir, "pi-sgrep.json"), JSON.stringify({ maxResultz: 4 }));

    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const result = await discoverAndLoadExtensions([EXTENSION_PATH], WORKSPACE);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.error).toContain('unknown option "maxResultz"');
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  }, 60_000);
});