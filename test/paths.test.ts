import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HOME_DIR, isFsRoot, piAgentDir, resolveScope } from "../src/paths.ts";

function workspace(): string {
  return mkdtempSync(path.join(tmpdir(), "pi-sgrep-scope-"));
}

describe("resolveScope", () => {
  test("defaults to the workspace root", () => {
    const cwd = workspace();
    const result = resolveScope(undefined, { cwd });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // macOS temp dirs are symlinked, so the scope must be the real path: sgrep
    // canonicalizes its own argument and ripgrep runs relative to it.
    expect(result.scope.cwd).toBe(fs_realpath(cwd));
    expect(result.scope.absolute).toBe(fs_realpath(cwd));
    expect(result.scope.target).toBe(".");
    expect(result.scope.isDirectory).toBe(true);
    expect(result.scope.label).toBe(".");
  });

  test("treats '.' as the workspace root", () => {
    const cwd = workspace();
    const result = resolveScope(".", { cwd });
    expect(result.ok && result.scope.target).toBe(".");
  });

  test("roots a directory search at that directory, as sgrep does", () => {
    const cwd = workspace();
    mkdirSync(path.join(cwd, "src", "billing"), { recursive: true });

    const result = resolveScope("src/billing", { cwd });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.scope.cwd).toBe(fs_realpath(path.join(cwd, "src", "billing")));
    expect(result.scope.target).toBe(".");
    expect(result.scope.fromCwd).toBe("src/billing");
    expect(result.scope.label).toBe("src/billing");
  });

  test("labels a scope outside the workspace as absolute", () => {
    const cwd = workspace();
    const other = workspace();
    mkdirSync(path.join(other, "lib"), { recursive: true });

    const result = resolveScope(path.join(other, "lib"), { cwd });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scope.label).toBe(fs_realpath(path.join(other, "lib")));
  });

  test("roots a file search at the file's parent", () => {
    const cwd = workspace();
    const file = path.join(cwd, "retry.ts");
    writeFileSync(file, "export const retry = 1;\n");

    const result = resolveScope("retry.ts", { cwd });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.scope.cwd).toBe(fs_realpath(cwd));
    expect(result.scope.target).toBe("retry.ts");
    expect(result.scope.isDirectory).toBe(false);
  });

  test("accepts absolute paths", () => {
    const cwd = workspace();
    const other = workspace();
    const result = resolveScope(other, { cwd });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scope.absolute).toBe(fs_realpath(other));
    expect(result.scope.label).toBe(fs_realpath(other));
  });

  test("expands ~ so the model does not have to spell out an absolute path", () => {
    // A literal "~" directory does not exist, so reaching the $HOME guard proves
    // expansion happened.
    const result = resolveScope("~/", { cwd: "/tmp" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Refusing to search $HOME");
  });

  test("reports a missing path with the workspace name", () => {
    const cwd = workspace();
    const result = resolveScope("does/not/exist", { cwd });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Path not found: does/not/exist");
    expect(result.error).toContain(path.basename(cwd));
  });

  test("refuses $HOME unless allowLargeRoots is set", () => {
    const refused = resolveScope(HOME_DIR, { cwd: "/tmp" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("Refusing to search $HOME");

    const allowed = resolveScope(HOME_DIR, { cwd: "/tmp", allowLargeRoots: true });
    expect(allowed.ok).toBe(true);
  });

  test("refuses the filesystem root unless allowLargeRoots is set", () => {
    const refused = resolveScope("/", { cwd: "/tmp" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("filesystem root");

    const allowed = resolveScope("/", { cwd: "/tmp", allowLargeRoots: true });
    expect(allowed.ok).toBe(true);
  });
});

describe("helpers", () => {
  test("isFsRoot only matches roots", () => {
    expect(isFsRoot("/")).toBe(true);
    expect(isFsRoot("/tmp")).toBe(false);
  });

  test("piAgentDir honours PI_CODING_AGENT_DIR", () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.PI_CODING_AGENT_DIR = "/custom/agent";
      expect(piAgentDir()).toBe("/custom/agent");
      delete process.env.PI_CODING_AGENT_DIR;
      expect(piAgentDir()).toBe(path.join(HOME_DIR, ".pi", "agent"));
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});

function fs_realpath(target: string): string {
  return realpathSync(target);
}