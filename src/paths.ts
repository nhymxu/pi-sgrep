/**
 * Filesystem scope resolution for sgrep searches.
 *
 * sgrep takes a single positional PATH that must be an existing file or
 * directory. It also resolves its own root internally (`src/main.rs`:
 * `path.is_dir() ? path : path.parent()`) and reports every hit relative to
 * that root. Both the sgrep child process and the ripgrep child of
 * `sgrep_rank` therefore run with `cwd` set to that same root, so relative
 * paths coming out of ripgrep mean the same thing to sgrep.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Resolved once per process: os.homedir() hits the env/passwd on every call. */
export const HOME_DIR = path.resolve(os.homedir());

/** pi's agent directory; `PI_CODING_AGENT_DIR` is respected. */
export function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? path.join(HOME_DIR, ".pi", "agent");
}

/** A path that is its own parent, i.e. a filesystem root. */
export function isFsRoot(dir: string): boolean {
  const resolved = path.resolve(dir);
  return path.dirname(resolved) === resolved;
}

export interface Scope {
  /** Directory both sgrep and ripgrep run in. Always sgrep's internal root. */
  cwd: string;
  /** Positional PATH argument, relative to `cwd`. */
  target: string;
  /** Absolute path of the searched file or directory. */
  absolute: string;
  isDirectory: boolean;
  /**
   * `absolute` expressed relative to the workspace cwd, with forward slashes.
   * Empty when the scope *is* the workspace root, which is the common case.
   */
  fromCwd: string;
  /** Label for tool output: workspace-relative when the scope is inside it. */
  label: string;
}

export type ScopeResolution = { ok: true; scope: Scope } | { ok: false; error: string };

export interface ResolveScopeOptions {
  cwd: string;
  /** Allow searching $HOME or the filesystem root. Both are refused by default. */
  allowLargeRoots?: boolean;
}

/**
 * Turn the tool's optional `path` argument into a canonical search scope.
 *
 * Every failure returns an actionable message instead of throwing, because the
 * caller is a language model that can recover from a bad path.
 */
export function resolveScope(
  input: string | undefined,
  options: ResolveScopeOptions,
): ScopeResolution {
  const cwd = path.resolve(options.cwd);
  const raw = (input ?? "").trim();

  // Models sometimes pass `~/...`; shell-style expansion does not apply here
  // because arguments never go through a shell.
  const expanded =
    raw === "" || raw === "."
      ? cwd
      : raw === "~"
        ? HOME_DIR
        : raw.startsWith("~/")
          ? path.join(HOME_DIR, raw.slice(2))
          : raw;

  return buildScope(path.resolve(cwd, expanded), raw, options);
}

function buildScope(absolute: string, raw: string, options: ResolveScopeOptions): ScopeResolution {
  // `realpath` keeps sgrep and ripgrep agreeing: macOS resolves /tmp to
  // /private/tmp, and sgrep treats a path on the other side of that symlink as
  // outside the search scope (`src/rg_input.rs`).
  let canonical: string;
  try {
    canonical = fs.realpathSync(absolute);
  } catch {
    return {
      ok: false,
      error:
        `Path not found: ${raw}. Pass a path relative to the workspace root ` +
        `(${path.basename(options.cwd)}), an absolute path, or omit it to search everything.`,
    };
  }

  if (isFsRoot(canonical) && !options.allowLargeRoots) {
    return {
      ok: false,
      error:
        "Refusing to search the filesystem root: sgrep would index the whole disk. " +
        'Search a project directory instead, or set "allowLargeRoots": true in pi-sgrep.json.',
    };
  }

  if (canonical === HOME_DIR && !options.allowLargeRoots) {
    return {
      ok: false,
      error:
        "Refusing to search $HOME: sgrep would index every file under it, including " +
        "caches and toolchains. Search a project directory instead, or set " +
        '"allowLargeRoots": true in pi-sgrep.json.',
    };
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(canonical);
  } catch {
    return {
      ok: false,
      error: `Path is not readable: ${canonical}. Pick a file or directory inside the workspace.`,
    };
  }

  if (!stats.isDirectory() && !stats.isFile()) {
    return {
      ok: false,
      error: `Not a file or directory: ${canonical}. sgrep searches text files only.`,
    };
  }

  const isDirectory = stats.isDirectory();
  // sgrep's internal root: the directory itself, or the file's parent.
  const root = isDirectory ? canonical : path.dirname(canonical);
  const fromCwd = toPosix(path.relative(canonicalCwd(options.cwd), canonical));

  return {
    ok: true,
    scope: {
      cwd: root,
      target: isDirectory ? "." : path.basename(canonical),
      absolute: canonical,
      isDirectory,
      fromCwd,
      label: fromCwd === "" ? "." : fromCwd.startsWith("..") ? canonical : fromCwd,
    },
  };
}

/** The workspace root, canonicalized the same way the scope is. */
function canonicalCwd(cwd: string): string {
  try {
    return fs.realpathSync(path.resolve(cwd));
  } catch {
    return path.resolve(cwd);
  }
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}