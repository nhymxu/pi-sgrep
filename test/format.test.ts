import { describe, expect, test } from "bun:test";
import { displayPath, formatResults } from "../src/format.ts";
import type { Scope } from "../src/paths.ts";
import type { SgrepChunk } from "../src/sgrep.ts";

const dirScope: Scope = {
  cwd: "/workspace",
  target: ".",
  absolute: "/workspace",
  isDirectory: true,
  fromCwd: "",
  label: ".",
};

const nestedScope: Scope = {
  cwd: "/workspace/src/billing",
  target: ".",
  absolute: "/workspace/src/billing",
  isDirectory: true,
  fromCwd: "src/billing",
  label: "src/billing",
};

const fileScope: Scope = {
  cwd: "/workspace",
  target: "retry.ts",
  absolute: "/workspace/retry.ts",
  isDirectory: false,
  fromCwd: "retry.ts",
  label: "retry.ts",
};

function chunk(overrides: Partial<SgrepChunk> = {}): SgrepChunk {
  return {
    path: "retry.ts",
    start: 10,
    end: 12,
    content: "function retry() {\n  return 1;\n}\n",
    ...overrides,
  };
}

function format(chunks: SgrepChunk[], scope: Scope = dirScope, overrides = {}) {
  return formatResults(chunks, { title: 'sgrep: "retry logic" — 1 result(s)' }, {
    scope,
    maxLinesPerResult: 80,
    maxTotalLines: 240,
    maxLineLength: 500,
    ...overrides,
  });
}

describe("displayPath", () => {
  test("leaves workspace-relative paths alone", () => {
    expect(displayPath("src/retry.ts", dirScope)).toBe("src/retry.ts");
  });

  test("re-adds the searched subdirectory", () => {
    expect(displayPath("retry.ts", nestedScope)).toBe("src/billing/retry.ts");
  });

  test("uses the filename for a single-file scope", () => {
    expect(displayPath("retry.ts", fileScope)).toBe("retry.ts");
  });

  test("falls back to the absolute scope when it is outside the workspace", () => {
    const outside: Scope = {
      cwd: "/elsewhere/lib",
      target: ".",
      absolute: "/elsewhere/lib",
      isDirectory: true,
      fromCwd: "../../elsewhere/lib",
      label: "/elsewhere/lib",
    };
    expect(displayPath("retry.ts", outside)).toBe("/elsewhere/lib/retry.ts");
  });
});

describe("formatResults", () => {
  test("prints line numbers relative to the passage start", () => {
    const output = format([chunk()]);
    expect(output.text).toContain("retry.ts:10-12 (3 lines)");
    expect(output.text).toContain("10  function retry() {");
    expect(output.text).toContain("11    return 1;");
    expect(output.text).toContain("12  }");
  });

  test("explains an empty result instead of returning nothing", () => {
    const output = format([]);
    expect(output.shown).toBe(0);
    expect(output.total).toBe(0);
    expect(output.text).toContain("No passages found");
    // sgrep ranks rather than filters, so the useful advice is about the scope.
    expect(output.text).toContain("no indexable text files");
  });

  test("truncates a long passage and says exactly where to resume", () => {
    const content = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n");
    const output = format([chunk({ start: 1, end: 50, content })], dirScope, {
      maxLinesPerResult: 5,
    });

    expect(output.text).toContain(" 5  line 5");
    expect(output.text).not.toContain("line 6");
    expect(output.text).toContain("45 more lines (to line 50)");
    expect(output.text).toContain("Read retry.ts at offset 6");
    expect(output.hiddenLines).toBe(45);
  });

  test("enforces the per-call budget across results", () => {
    const chunks = [
      chunk({ start: 1, end: 4, content: "a\nb\nc\nd\n" }),
      chunk({ start: 10, end: 13, content: "a\nb\nc\nd\n" }),
      chunk({ start: 20, end: 23, content: "a\nb\nc\nd\n" }),
    ];
    const output = format(chunks, dirScope, { maxTotalLines: 5 });

    // The first passage takes 4 of the 5 available lines, so the second gets a
    // single line plus its truncation notice, and the third is dropped.
    expect(output.shown).toBe(2);
    expect(output.text).toContain("retry.ts:1-4 (4 lines)\n1  a\n2  b\n3  c\n4  d");
    expect(output.text).toContain("3 more lines (to line 13)");
    expect(output.hiddenLines).toBe(7);
    expect(output.text).toContain("showing 2 of 3 passages");
    expect(output.text).toContain("raise `limit` to see more");
  });

  test("clips a single very long line", () => {
    const output = format(
      [chunk({ start: 1, end: 1, content: `${"x".repeat(60)}\n` })],
      dirScope,
      { maxLineLength: 20 },
    );
    expect(output.text).toContain("1  xxxxxxxxxxxxxxxxxxxx...");
  });

  test("counts the header lines of the passage without a trailing newline", () => {
    const output = format([chunk({ start: 7, end: 8, content: "one\ntwo" })]);
    expect(output.text).toContain("retry.ts:7-8 (2 lines)");
  });

  test("keeps a subtitle when one is provided", () => {
    const output = formatResults([chunk()], { title: "sgrep_rank: 3 matches", subtitle: "context 3 lines" }, {
      scope: dirScope,
      maxLinesPerResult: 80,
      maxTotalLines: 240,
      maxLineLength: 500,
    });
    expect(output.text).toContain("sgrep_rank: 3 matches\ncontext 3 lines");
  });
});