/**
 * End-to-end check against the real sgrep binary.
 *
 * Skipped unless `PI_SGREP_E2E=1` and an sgrep binary is available, because it
 * downloads the embedding model (~32 MB) on the first run. Point it at a build
 * with a different directory to compare versions:
 *
 *   PI_SGREP_E2E=1 SGREP_E2E_BIN=/path/to/sgrep bun test test/e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildRankArgs,
  buildRipgrepArgs,
  buildSearchArgs,
  parseChunks,
  resolveRipgrep,
  resolveSgrep,
  runRankedSearch,
  runSearch,
} from "../src/sgrep.ts";
import { resolveScope } from "../src/paths.ts";
import { formatResults } from "../src/format.ts";

const enabled = process.env.PI_SGREP_E2E === "1";

/** Older releases cannot rank ripgrep input, so that test skips itself. */
const binary = await resolveSgrep(process.env.SGREP_E2E_BIN).catch(() => null);
const rankSupport = binary !== null && binary.ok && binary.capabilities.supportsRankInput;

/** A tiny corpus with one obviously relevant passage. */
function corpus() {
  const root = mkdtempSync(path.join(tmpdir(), "pi-sgrep-e2e-"));
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(
    path.join(root, "src", "billing.ts"),
    [
      "export function chargeCustomer(amountCents: number) {",
      "  if (amountCents <= 0) throw new Error('invalid amount');",
      "  return ledger.post({ amountCents, currency: 'usd' });",
      "}",
      "",
      "export function shouldBill(subscription: Subscription) {",
      "  return subscription.status === 'active' && subscription.plan !== 'free';",
      "}",
    ].join("\n"),
  );
  writeFileSync(
    path.join(root, "src", "retry.ts"),
    [
      "export function retryWithBackoff(attempt: number) {",
      "  return Math.min(1000 * 2 ** attempt, 30_000);",
      "}",
    ].join("\n"),
  );
  return root;
}

describe.skipIf(!enabled)("real sgrep binary", () => {
  test("resolves and reports its capabilities", async () => {
    const resolved = await resolveSgrep(process.env.SGREP_E2E_BIN);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    console.log(`[e2e] ${resolved.binary} (${resolved.capabilities.version})`);
  });

  test("finds a passage described only in English", async () => {
    const resolved = await resolveSgrep(process.env.SGREP_E2E_BIN);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const root = corpus();
    const scope = resolveScope(root, { cwd: process.cwd() });
    expect(scope.ok).toBe(true);
    if (!scope.ok) return;

    const outcome = await runSearch(
      resolved.binary,
      buildSearchArgs({
        query: "deciding whether a customer is charged for their subscription",
        target: scope.scope.target,
        limit: 3,
        model: "code",
        capabilities: resolved.capabilities,
        extraArgs: [],
      }),
      { cwd: scope.scope.cwd, timeoutMs: 300_000 },
    );

    expect(outcome.exitCode).toBe(0);
    const chunks = parseChunks(outcome.stdout);
    expect(chunks.length).toBeGreaterThan(0);

    // The English query has no shared words with the identifier, so landing on
    // the billing module is the whole point of the extension.
    expect(chunks[0]!.path).toContain("billing.ts");

    const formatted = formatResults(
      chunks,
      { title: 'sgrep: "when is a customer charged" — 3 result(s)' },
      {
        scope: scope.scope,
        maxLinesPerResult: 80,
        maxTotalLines: 240,
        maxLineLength: 500,
      },
    );
    expect(formatted.text).toContain("billing.ts:");
    console.log(`[e2e] ${outcome.durationMs}ms\n${formatted.text}`);
  }, 300_000);

  test("handles a nonsense query without crashing, on any version", async () => {
    const resolved = await resolveSgrep(process.env.SGREP_E2E_BIN);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const root = corpus();
    const scope = resolveScope(root, { cwd: process.cwd() });
    if (!scope.ok) throw new Error(scope.error);

    const outcome = await runSearch(
      resolved.binary,
      buildSearchArgs({
        query: "zzzzz qqqqq nonexistent concept",
        target: scope.scope.target,
        limit: 3,
        model: "code",
        capabilities: resolved.capabilities,
        extraArgs: [],
      }),
      { cwd: scope.scope.cwd, timeoutMs: 300_000 },
    );

    // The two sgrep builds differ here, and the extension must handle both:
    // released v0.3.0 returns nothing (exit 1) for a query with no usable
    // terms, while main ranks by meaning alone and always returns the nearest
    // passages. Either way it is a clean exit with parseable JSON, never a
    // failure.
    expect([0, 1]).toContain(outcome.exitCode ?? 0);
    expect(() => parseChunks(outcome.stdout)).not.toThrow();
    expect(outcome.exitCode === 1).toBe(parseChunks(outcome.stdout).length === 0);
  }, 300_000);

  test("returns nothing for a directory with no text files", async () => {
    const resolved = await resolveSgrep(process.env.SGREP_E2E_BIN);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const root = mkdtempSync(path.join(tmpdir(), "pi-sgrep-e2e-empty-"));
    const scope = resolveScope(root, { cwd: process.cwd() });
    if (!scope.ok) throw new Error(scope.error);

    const outcome = await runSearch(
      resolved.binary,
      buildSearchArgs({
        query: "anything at all",
        target: scope.scope.target,
        limit: 3,
        model: "code",
        capabilities: resolved.capabilities,
        extraArgs: [],
      }),
      { cwd: scope.scope.cwd, timeoutMs: 300_000 },
    );

    expect([0, 1]).toContain(outcome.exitCode ?? 0);
    expect(parseChunks(outcome.stdout)).toEqual([]);
  }, 300_000);

  test("turns an unusable query into an actionable message", async () => {
    const resolved = await resolveSgrep(process.env.SGREP_E2E_BIN);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const root = corpus();
    const scope = resolveScope(root, { cwd: process.cwd() });
    if (!scope.ok) throw new Error(scope.error);

    const outcome = await runSearch(
      resolved.binary,
      buildSearchArgs({
        query: "the is of it",
        target: scope.scope.target,
        limit: 1,
        model: "code",
        capabilities: resolved.capabilities,
        extraArgs: [],
      }),
      { cwd: scope.scope.cwd, timeoutMs: 300_000 },
    );

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("query has no searchable words");
  }, 300_000);

  // Older releases cannot rank ripgrep input, so this test asserts the skip
  // rather than failing when that is the version under test.
  test.skipIf(!rankSupport)("ranks ripgrep matches", async () => {
    const resolved = await resolveSgrep(process.env.SGREP_E2E_BIN);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const rg = await resolveRipgrep();
    expect(rg.ok).toBe(true);
    if (!rg.ok) return;

    const root = corpus();
    const scope = resolveScope(root, { cwd: process.cwd() });
    if (!scope.ok) throw new Error(scope.error);

    const outcome = await runRankedSearch({
      sgrepBinary: resolved.binary,
      sgrepArgs: buildRankArgs({
        query: "which function decides whether to charge someone",
        target: scope.scope.target,
        limit: 3,
        model: "code",
        extraArgs: [],
      }),
      ripgrepBinary: rg.binary,
      ripgrepArgs: buildRipgrepArgs({
        pattern: "function",
        target: scope.scope.target,
        context: 1,
      }),
      cwd: scope.scope.cwd,
      timeoutMs: 300_000,
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.matchCount ?? 0).toBeGreaterThan(0);
    expect(parseChunks(outcome.stdout).length).toBeGreaterThan(0);
    console.log(`[e2e] ranked ${outcome.matchCount} matches in ${outcome.durationMs}ms`);
  }, 300_000);
});