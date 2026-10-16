/**
 * Everything that talks to the sgrep and ripgrep binaries.
 *
 * Design constraints that shaped this file:
 *
 * - No shell. Arguments are passed as an argv array, so a model-supplied query
 *   or regex can never be interpreted as a shell command.
 * - Version tolerance. Released sgrep binaries expose only `QUERY [PATH] -n
 *   --json --model`; ranking ripgrep output through sgrep (`--stdin`) and
 *   `--cache-dir` exist on newer builds. Capabilities are probed once from
 *   `--help` and unknown flags are never passed.
 * - Cold starts. The first search downloads a ~32 MB embedding model and builds
 *   an index, so every call is bounded by a timeout and reports progress
 *   through stderr instead of hanging the agent turn.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HOME_DIR } from "./paths.ts";
import type { ModelChoice } from "./config.ts";

export interface SgrepCapabilities {
  version: string;
  /** Accepts ripgrep JSON on stdin (`--stdin`) or from a file (`--rg-json`). */
  supportsRankInput: boolean;
  /** Accepts `--cache-dir` for models and indexes. */
  supportsCacheDir: boolean;
  /** Accepts `--refresh-cache`. */
  supportsRefreshCache: boolean;
  /** Accepts `--explain` (adds score breakdowns to `--json`). */
  supportsExplain: boolean;
}

export type SgrepResolution =
  | { ok: true; binary: string; capabilities: SgrepCapabilities }
  | { ok: false; reason: "not-found" | "broken"; message: string; hint: string };

export interface SgrepChunk {
  /** Always relative to the search root sgrep used, never absolute. */
  path: string;
  /** First line of the passage, 1-based inclusive. */
  start: number;
  /** Last line of the passage, 1-based inclusive. */
  end: number;
  content: string;
  scores?: {
    bm25: number;
    semantic: number;
    bm25_relative: number;
    semantic_relative: number;
    fused: number;
    exact_identifier: boolean;
  };
}

export interface RunOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  /** True when a child exceeded the output cap and was stopped. */
  outputTruncated: boolean;
}

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  /** Written to the child's stdin, which is then closed. */
  stdin?: string;
  /** Refuse to buffer more than this many bytes of stdout or stderr. */
  maxOutputBytes?: number;
}

export interface RankOutcome extends RunOutcome {
  /** Exit code and stderr of the ripgrep child that produced the input. */
  ripgrep: { exitCode: number | null; stderr: string };
  /** Matches ripgrep reported, counted while streaming. */
  matchCount: number;
}

/** Default per-child output cap. Search results are far smaller than this. */
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;
/** `--version` and `--help` answer in milliseconds; a slow child is broken. */
const PROBE_TIMEOUT_MS = 2_000;
/** Total budget for locating binaries, so pi startup cannot stall. */
const RESOLVE_BUDGET_MS = 6_000;

export const INSTALL_HINT =
  "brew install ripgrep && cargo install --git https://github.com/context-dot-dev/sgrep --locked " +
  "(or download a release binary from https://github.com/context-dot-dev/sgrep/releases)";

/**
 * Locate the sgrep binary and read its feature set.
 *
 * Candidates are tried in order and each one is proven by running `--version`,
 * so a stale shim earlier on PATH cannot be mistaken for a working install.
 */
export async function resolveSgrep(
  configuredBinary?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SgrepResolution> {
  const candidates = binaryCandidates(configuredBinary, env);
  const failures: string[] = [];
  const deadline = Date.now() + RESOLVE_BUDGET_MS;

  for (const binary of candidates) {
    if (configuredBinary !== undefined && binary !== configuredBinary) continue;

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    const version = await probe(binary, ["--version"], env, Math.min(PROBE_TIMEOUT_MS, remaining));
    if (version.kind === "ok") {
      const help = await probe(binary, ["--help"], env, Math.min(PROBE_TIMEOUT_MS, remaining));
      const helpText = help.kind === "ok" ? help.stdout : "";
      return {
        ok: true,
        binary,
        capabilities: {
          version: version.stdout.trim() || "unknown",
          supportsRankInput: /--(stdin|rg-json)/.test(helpText),
          supportsCacheDir: /--cache-dir/.test(helpText),
          supportsRefreshCache: /--refresh-cache/.test(helpText),
          supportsExplain: /--explain/.test(helpText),
        },
      };
    }

    if (version.kind === "timeout") {
      return {
        ok: false,
        reason: "broken",
        message: `Timed out running \`${binary} --version\`.`,
        hint: `Check that ${binary} is a working sgrep build, or set "binary" in pi-sgrep.json.`,
      };
    }
    failures.push(`${binary}: ${version.detail}`);
  }

  const timedOut = Date.now() >= deadline && failures.length > 0;
  return {
    ok: false,
    reason: timedOut ? "broken" : "not-found",
    message: timedOut
      ? `Stopped looking for sgrep after ${RESOLVE_BUDGET_MS / 1000}s (${failures.join("; ")}).`
      : configuredBinary === undefined
        ? "sgrep is not installed or not on PATH."
        : `Configured sgrep binary not runnable (${failures.join("; ") || "not found"}).`,
    hint: `Install it with: ${INSTALL_HINT}`,
  };
}

/** Locate ripgrep, which sgrep needs to enumerate files and `sgrep_rank` needs for input. */
export async function resolveRipgrep(
  configuredBinary?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true; binary: string } | { ok: false; message: string; hint: string }> {
  const candidates = [
    ...(configuredBinary ? [configuredBinary] : []),
    "rg",
    "/opt/homebrew/bin/rg",
    "/usr/local/bin/rg",
  ];
  const deadline = Date.now() + RESOLVE_BUDGET_MS;

  for (const binary of candidates) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const result = await probe(binary, ["--version"], env, Math.min(PROBE_TIMEOUT_MS, remaining));
    if (result.kind === "ok") return { ok: true, binary };
  }

  return {
    ok: false,
    message: "ripgrep (rg) is not installed or not on PATH.",
    hint: "brew install ripgrep  (sgrep uses rg to enumerate files and rank matches)",
  };
}

/**
 * Arguments for a plain semantic search.
 *
 * Flags come first so the positional QUERY and PATH are never mistaken for
 * option values by any clap version.
 */
export function buildSearchArgs(input: {
  query: string;
  target: string;
  limit: number;
  model: ModelChoice;
  cacheDir?: string | undefined;
  refreshCache?: boolean;
  capabilities: SgrepCapabilities;
  extraArgs: string[];
}): string[] {
  const args = ["--json", "-n", String(input.limit)];

  if (input.cacheDir && input.capabilities.supportsCacheDir) {
    args.push("--cache-dir", input.cacheDir);
  }
  if (input.refreshCache && input.capabilities.supportsRefreshCache) {
    args.push("--refresh-cache");
  }
  args.push("--model", input.model);
  args.push(...input.extraArgs);
  args.push(input.query, input.target);

  return args;
}

/** Arguments for ripgrep when its JSON output feeds sgrep's ranking mode. */
export function buildRipgrepArgs(input: { pattern: string; target: string; context: number }): string[] {
  return [
    "--json",
    "--no-config",
    "--color",
    "never",
    "-C",
    String(input.context),
    "--",
    input.pattern,
    input.target,
  ];
}

/** Arguments for ranking ripgrep output, including the positional scope. */
export function buildRankArgs(input: {
  query: string;
  target: string;
  limit: number;
  model: ModelChoice;
  cacheDir?: string | undefined;
  extraArgs: string[];
}): string[] {
  const args = ["--json", "-n", String(input.limit), "--stdin"];
  if (input.cacheDir) args.push("--cache-dir", input.cacheDir);
  args.push("--model", input.model);
  args.push(...input.extraArgs);
  args.push(input.query, input.target);

  return args;
}

/**
 * Identical in-flight searches share one child process.
 *
 * Models routinely issue the same search from parallel tool calls in one turn,
 * and each hit pays for a fresh process spawn and a full index read.
 */
const inFlight = new Map<string, Promise<RunOutcome>>();

export async function runSearch(
  binary: string,
  args: string[],
  options: RunOptions,
  dedupeKey?: string,
): Promise<RunOutcome> {
  const key = dedupeKey ?? JSON.stringify([binary, args, options.cwd]);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const running = runSgrep(binary, args, options).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, running);

  return running;
}

export async function runSgrep(
  binary: string,
  args: string[],
  options: RunOptions,
): Promise<RunOutcome> {
  return runProcess(binary, args, options);
}

/**
 * Pipe ripgrep JSON straight into sgrep's ranking mode.
 *
 * The payload is never buffered in this process: ripgrep's stdout is piped into
 * sgrep's stdin, and only sgrep's (small) JSON result is collected.
 */
export async function runRankedSearch(input: {
  sgrepBinary: string;
  sgrepArgs: string[];
  ripgrepBinary: string;
  ripgrepArgs: string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  maxOutputBytes?: number;
}): Promise<RankOutcome> {
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const startedAt = Date.now();

  const sgrep = spawn(input.sgrepBinary, input.sgrepArgs, {
    cwd: input.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  let ripgrep: ChildProcess;
  try {
    ripgrep = spawn(input.ripgrepBinary, input.ripgrepArgs, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
  } catch (error: unknown) {
    sgrep.kill("SIGKILL");
    throw new Error(
      `Could not run ripgrep (${input.ripgrepBinary}): ` +
        `${(error as NodeJS.ErrnoException).code ?? String(error)}`,
    );
  }

  const ripgrepStderr = collect(ripgrep.stderr ?? null, maxOutputBytes);
  const ripgrepStdout = ripgrep.stdout;
  // Count matches while streaming so the model learns how much was discarded.
  const readMatches = countRipgrepMatches(ripgrepStdout);
  if (ripgrepStdout) ripgrepStdout.pipe(sgrep.stdin!, { end: true });
  else sgrep.stdin!.end();

  const sgrepStdout = collect(sgrep.stdout, maxOutputBytes);
  const sgrepStderr = collect(sgrep.stderr, maxOutputBytes);

  const state = watch({ children: [sgrep, ripgrep], timeoutMs: input.timeoutMs, signal: input.signal });
  const [sgrepExit, ripgrepExit, sgrepOut, sgrepErr, rgErr] = await Promise.all([
    exited(sgrep),
    exited(ripgrep),
    sgrepStdout,
    sgrepStderr,
    ripgrepStderr,
  ]);

  const outcome: RankOutcome = {
    exitCode: sgrepExit.code,
    signal: sgrepExit.signal,
    stdout: sgrepOut.text(),
    stderr: sgrepErr.text(),
    durationMs: Date.now() - startedAt,
    timedOut: state.timedOut,
    aborted: state.aborted,
    outputTruncated: sgrepOut.truncated || sgrepErr.truncated,
    ripgrep: {
      exitCode: ripgrepExit.code,
      stderr: rgErr.text(),
    },
    matchCount: readMatches(),
  };

  return outcome;
}

/**
 * Count `{"type":"match"` events in a ripgrep JSON stream.
 *
 * Listening alongside `pipe()` is safe: both receive every chunk, so the payload
 * is never buffered here.
 */
function countRipgrepMatches(stream: NodeJS.ReadableStream | null): () => number {
  const NEEDLE = '"type":"match"';
  let count = 0;
  let carry = "";

  stream?.on("data", (chunk: Buffer | string) => {
    const text = carry + (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    for (let at = text.indexOf(NEEDLE); at !== -1; at = text.indexOf(NEEDLE, at + 1)) count += 1;
    // Keep enough context that a needle split across two chunks still matches.
    carry = text.slice(-NEEDLE.length + 1);
  });

  return () => count;
}

/** Parse `--json` output. sgrep writes one JSON array per successful run. */
export function parseChunks(stdout: string): SgrepChunk[] {
  const trimmed = stdout.trim();
  if (trimmed === "") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`sgrep returned output that is not JSON: ${clip(trimmed, 200)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`sgrep returned ${describeJson(parsed)} where a result array was expected.`);
  }

  return parsed.flatMap((entry) => (isChunk(entry) ? [entry] : []));
}

/**
 * Turn a failed run into an instruction the model can act on.
 *
 * sgrep writes `sgrep: <message>` to stderr and exits 2 (src/main.rs).
 */
export function describeFailure(outcome: RunOutcome | RankOutcome): string {
  const stderr = outcome.stderr.trim();
  const detail = stderr.replace(/^sgrep:\s*/gm, "").trim();
  const parts: string[] = [];

  if (detail !== "") parts.push(`sgrep: ${detail}`);

  // ripgrep failures arrive on its own stderr and would otherwise look like
  // "no results".
  if ("ripgrep" in outcome && outcome.ripgrep.exitCode !== null && outcome.ripgrep.exitCode > 1) {
    const rgDetail = outcome.ripgrep.stderr.trim();
    parts.push(`ripgrep: ${rgDetail === "" ? `exit ${outcome.ripgrep.exitCode}` : rgDetail}`);
  }

  if (parts.length === 0) parts.push(`sgrep exited with code ${outcome.exitCode}.`);

  const hint = failureHint(detail);
  return hint === "" ? parts.join("\n") : `${parts.join("\n")}\n${hint}`;
}

function failureHint(detail: string): string {
  if (detail.includes("query has no searchable words")) {
    return "Rephrase with concrete nouns: stop words like 'the', 'where', 'is' are dropped. " +
      'Example: "retry failed webhook delivery" instead of "where is the retry logic?".';
  }
  if (detail.includes("not a file or directory")) {
    return "The search path no longer exists. Pick a directory that is still in the workspace.";
  }
  if (detail.includes("source changed") || detail.includes("does not match current source")) {
    return "Files changed mid-search. Repeat the call once.";
  }
  if (detail.includes("is not cached") || detail.includes("HF_HUB_OFFLINE")) {
    return "The embedding model is missing and downloads are disabled. Run /sgrep-warm once online.";
  }
  if (detail.includes("ripgrep is required")) {
    return `Install ripgrep: brew install ripgrep (or ${INSTALL_HINT}).`;
  }
  if (detail.includes("No such file or directory") || detail.includes("not found")) {
    return `Check the configured binary path. ${INSTALL_HINT}`;
  }
  return "";
}

type ProbeResult =
  | { kind: "ok"; stdout: string }
  | { kind: "missing"; detail: string }
  | { kind: "error"; detail: string }
  | { kind: "timeout" };

async function probe(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  try {
    const outcome = await runProcess(binary, args, {
      cwd: HOME_DIR,
      timeoutMs,
      env,
      maxOutputBytes: 1024 * 1024,
    });

    if (outcome.timedOut) return { kind: "timeout" };
    if (outcome.exitCode === 0) return { kind: "ok", stdout: outcome.stdout };
    if (outcome.exitCode === null && outcome.signal !== null) {
      return { kind: "missing", detail: `killed by ${outcome.signal}` };
    }
    return { kind: "error", detail: clip(outcome.stderr.trim() || `exit ${outcome.exitCode}`, 120) };
  } catch (error: unknown) {
    return { kind: "missing", detail: (error as NodeJS.ErrnoException).code ?? String(error) };
  }
}

interface InternalRunOptions extends RunOptions {
  env?: NodeJS.ProcessEnv;
}

async function runProcess(
  binary: string,
  args: string[],
  options: InternalRunOptions,
): Promise<RunOutcome> {
  const startedAt = Date.now();
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  let child: ChildProcess;
  try {
    child = spawn(binary, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env ?? process.env,
    });
  } catch (error: unknown) {
    return {
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: `Could not start ${binary}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`,
      durationMs: Date.now() - startedAt,
      timedOut: false,
      aborted: false,
      outputTruncated: false,
    };
  }

  const stdout = collect(child.stdout, maxOutputBytes);
  const stderr = collect(child.stderr, maxOutputBytes);
  const state = watch({ children: [child], timeoutMs: options.timeoutMs, signal: options.signal });

  // `spawn` reports a missing or non-executable binary through `error` rather
  // than by throwing, and `child.pid` is undefined in exactly that case.
  if (child.pid === undefined) {
    const spawnError = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
      child.once("error", resolve);
      if (child.exitCode !== null) resolve(undefined);
    });

    return {
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: `Could not start ${binary}: ${spawnError?.code ?? spawnError?.message ?? "spawn failed"}`,
      durationMs: Date.now() - startedAt,
      timedOut: state.timedOut,
      aborted: state.aborted,
      outputTruncated: false,
    };
  }

  if (typeof options.stdin === "string") {
    child.stdin?.on("error", () => {
      // A child that exits before reading its input closes the pipe; the exit
      // status below is the real signal, not this EPIPE.
    });
    child.stdin?.end(options.stdin);
  } else {
    child.stdin?.end();
  }

  const exit = await exited(child);
  const outValue = await stdout;
  const errValue = await stderr;

  return {
    exitCode: exit.code,
    signal: exit.signal,
    stdout: outValue.text(),
    stderr: errValue.text(),
    durationMs: Date.now() - startedAt,
    timedOut: state.timedOut,
    aborted: state.aborted,
    outputTruncated: outValue.truncated || errValue.truncated,
  };
}

function binaryCandidates(configuredBinary: string | undefined, env: NodeJS.ProcessEnv): string[] {
  const exe = process.platform === "win32" ? ".exe" : "";
  const candidates: string[] = [];

  if (configuredBinary) candidates.push(configuredBinary);
  const fromEnv = env.PI_SGREP_BIN ?? env.SGREP_BIN;
  if (fromEnv) candidates.push(fromEnv);
  candidates.push(`sgrep${exe}`);
  if (process.platform !== "win32") {
    candidates.push(
      path.join(HOME_DIR, ".cargo", "bin", `sgrep${exe}`),
      `/opt/homebrew/bin/sgrep${exe}`,
      `/usr/local/bin/sgrep${exe}`,
    );
  }

  return [...new Set(candidates)];
}

/**
 * Bound a run: kill on timeout or abort.
 *
 * SIGTERM first so a well-behaved child can clean up its lock files, SIGKILL
 * after a grace period so a wedged child cannot wedge the agent turn.
 */
function watch(input: {
  children: ChildProcess[];
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}): { timedOut: boolean; aborted: boolean } {
  const state = { timedOut: false, aborted: false };
  const children = input.children;

  const killAll = (signal: NodeJS.Signals) => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill(signal);
        } catch {
          // Already gone.
        }
      }
    }
  };

  const timer = setTimeout(() => {
    state.timedOut = true;
    killAll("SIGTERM");
    setTimeout(() => killAll("SIGKILL"), KILL_GRACE_MS).unref?.();
  }, input.timeoutMs);
  timer.unref?.();

  const onAbort = () => {
    state.aborted = true;
    killAll("SIGTERM");
    setTimeout(() => killAll("SIGKILL"), KILL_GRACE_MS).unref?.();
  };

  if (input.signal) {
    if (input.signal.aborted) onAbort();
    else input.signal.addEventListener("abort", onAbort, { once: true });
  }

  // Release timers and listeners once every child has been reaped.
  void Promise.all(children.map((child) => exited(child))).then(() => {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  });

  return state;
}

function exited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: child.exitCode, signal: child.signalCode }));
  });
}

interface Sink {
  text(): string;
  truncated: boolean;
}

/** Collect a stream into a string, stopping the child once the cap is passed. */
function collect(stream: NodeJS.ReadableStream | null, maxBytes: number): Promise<Sink> {
  const state = { text: "", truncated: false };

  if (!stream) {
    return Promise.resolve({
      text: () => state.text,
      get truncated() {
        return state.truncated;
      },
    });
  }

  const chunks: Buffer[] = [];
  let size = 0;

  return new Promise<Sink>((resolve) => {
    stream.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      if (state.truncated) return;
      size += buffer.length;
      if (size > maxBytes) {
        state.truncated = true;
        chunks.push(buffer.subarray(0, Math.max(0, maxBytes - (size - buffer.length))));
        return;
      }
      chunks.push(buffer);
    });
    stream.once("end", () => {
      state.text = Buffer.concat(chunks).toString("utf8");
      resolve({
        text: () => state.text,
        get truncated() {
          return state.truncated;
        },
      });
    });
    stream.once("error", () => {
      state.text = Buffer.concat(chunks).toString("utf8");
      resolve({
        text: () => state.text,
        get truncated() {
          return state.truncated;
        },
      });
    });
  });
}

function isChunk(value: unknown): value is SgrepChunk {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.path === "string" &&
    typeof entry.start === "number" &&
    typeof entry.end === "number" &&
    typeof entry.content === "string"
  );
}

function describeJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

function clip(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}...`;
}

/**
 * sgrep's own caches, mirroring `src/cache.rs`.
 *
 * Note the asymmetry: `--cache-dir` puts models under `<dir>/hub` and indexes
 * under `<dir>/index`, while `SGREP_CACHE_DIR` names the index directory itself
 * and leaves the model hub on the Hugging Face defaults.
 */
export function cacheLocations(cacheDir?: string | undefined, env: NodeJS.ProcessEnv = process.env) {
  const xdg = env.XDG_CACHE_HOME ?? path.join(HOME_DIR, ".cache");

  const hub = cacheDir
    ? path.join(cacheDir, "hub")
    : (env.HF_HUB_CACHE ??
      env.HUGGINGFACE_HUB_CACHE ??
      path.join(env.HF_HOME ?? path.join(xdg, "huggingface"), "hub"));

  const index = cacheDir
    ? path.join(cacheDir, "index")
    : (env.SGREP_CACHE_DIR ?? path.join(xdg, "sgrep"));

  return { hub, index, usesCacheDir: cacheDir !== undefined };
}

/** Whether a static-embedding model is already downloaded, by repo name. */
export function isModelCached(hubDir: string, repo: string): boolean {
  const repoDir = path.join(hubDir, `models--${repo.replace("/", "--")}`, "snapshots");
  try {
    for (const entry of fs.readdirSync(repoDir)) {
      const weights = path.join(repoDir, entry, "model.safetensors");
      try {
        if (fs.statSync(weights).size > 0) return true;
      } catch {
        // Snapshot without a weights file yet.
      }
    }
  } catch {
    return false;
  }
  return false;
}

export const CODE_MODEL_REPO = "minishlab/potion-code-16M-v2";
export const TEXT_MODEL_REPO = "minishlab/potion-base-8M";