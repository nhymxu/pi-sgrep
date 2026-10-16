/**
 * Model-facing result formatting.
 *
 * Two things matter for the agent consuming this text:
 *
 * 1. Line numbers. sgrep returns whole source passages with absolute-free
 *    relative paths and a line range, but the content is bare text. Prefixing
 *    every line with its number lets the model go straight to `read` with an
 *    offset instead of grepping the excerpt again.
 * 2. A bounded budget. One passage can be a 400-line function; several can be
 *    megabytes of JSON. Output is capped per result and per call, and every
 *    truncation is stated explicitly with the exact follow-up to run.
 */

import path from "node:path";
import type { Scope } from "./paths.ts";
import type { SgrepChunk } from "./sgrep.ts";

export interface FormatOptions {
  scope: Scope;
  maxLinesPerResult: number;
  maxTotalLines: number;
  maxLineLength: number;
}

export interface FormattedResults {
  text: string;
  /** Passages printed. */
  shown: number;
  /** Passages returned by sgrep. */
  total: number;
  /** Source lines suppressed by the per-call budget. */
  hiddenLines: number;
}

export interface FormatHeader {
  /** First line of the tool output, e.g. `sgrep: "retry logic" in src/`. */
  title: string;
  /** Note about how the passages were selected, e.g. ranked ripgrep matches. */
  subtitle?: string;
}

/**
 * Rebase a chunk path onto the workspace.
 *
 * sgrep reports paths relative to its own search root (`src/main.rs` strips the
 * root in `rg_input.rs` and `index.rs`), which is `scope.cwd`. For a directory
 * scope the caller's subdirectory has to be prepended again; for a single-file
 * scope sgrep already returns the bare filename.
 */
export function displayPath(chunkPath: string, scope: Scope): string {
  const normalized = chunkPath.split(path.sep).join("/").replace(/^\.\//, "");

  if (!scope.isDirectory) return scope.label === "." ? normalized : scope.label;

  // `scope.label` is workspace-relative when the scope is inside the workspace
  // and absolute otherwise, which avoids `../../..` chains in tool output.
  return scope.label === "." ? normalized : `${scope.label}/${normalized}`;
}

export function formatResults(
  chunks: SgrepChunk[],
  header: FormatHeader,
  options: FormatOptions,
): FormattedResults {
  if (chunks.length === 0) {
    // sgrep ranks rather than filters, so an empty result almost always means
    // the scope holds no indexable text, not that the query was wrong.
    return {
      text:
        `${header.title}\n\nNo passages found. The scope may contain no indexable text files ` +
        `(binary or empty files are skipped). Confirm the path exists and holds source, then retry.\n`,
      shown: 0,
      total: 0,
      hiddenLines: 0,
    };
  }

  const lines: string[] = [header.title];
  if (header.subtitle) lines.push(header.subtitle);
  lines.push("");

  let budget = options.maxTotalLines;
  let shown = 0;
  let hiddenLines = 0;

  for (const chunk of chunks) {
    if (budget <= 0) {
      hiddenLines += chunk.end - chunk.start + 1;
      continue;
    }

    const sourceLines = chunk.content.split("\n");
    // A trailing newline in the passage is not a source line.
    if (sourceLines.length > 0 && sourceLines[sourceLines.length - 1] === "") sourceLines.pop();

    const width = String(Math.max(chunk.start, chunk.end)).length;
    const available = Math.min(budget, options.maxLinesPerResult);
    const emitted = sourceLines.slice(0, available);

    lines.push(
      `${displayPath(chunk.path, options.scope)}:${chunk.start}-${chunk.end}` +
        ` (${sourceLines.length} lines)`,
    );
    for (const [index, text] of emitted.entries()) {
      lines.push(`${String(chunk.start + index).padStart(width)}  ${clipLine(text, options.maxLineLength)}`);
    }

    if (emitted.length < sourceLines.length) {
      const nextLine = chunk.start + emitted.length;
      const remaining = sourceLines.length - emitted.length;
      hiddenLines += remaining;
      lines.push(
        `  ... ${remaining} more line${remaining === 1 ? "" : "s"} (to line ${chunk.end}). ` +
          `Read ${displayPath(chunk.path, options.scope)} at offset ${nextLine} for the rest.`,
      );
    }

    budget -= emitted.length;
    shown += 1;
    lines.push("");
  }

  const notices: string[] = [];

  if (shown < chunks.length) {
    notices.push(
      `showing ${shown} of ${chunks.length} passages (raise \`limit\` to see more, or narrow \`path\`)`,
    );
  }
  if (hiddenLines > 0) {
    notices.push(`${hiddenLines} source lines suppressed by the output budget`);
  }

  if (notices.length > 0) lines.push(`[${notices.join("; ")}]`);

  return { text: `${lines.join("\n").trimEnd()}\n`, shown, total: chunks.length, hiddenLines };
}

/**
 * Make a sgrep failure readable for the model.
 *
 * `describeFailure` handles the stderr side; this adds the operational advice
 * that depends on what the run was doing.
 */
export function describeTimeout(timeoutMs: number, cold: boolean): string {
  const hint = cold
    ? "The first search in a directory downloads the embedding model (~32 MB) and builds an index. " +
      "Run /sgrep-warm once, or raise --sgrep-timeout."
    : "Raise --sgrep-timeout, narrow `path`, or use grep for an exact string.";
  return `sgrep did not finish within ${Math.round(timeoutMs / 1000)}s. ${hint}`;
}

function clipLine(line: string, maxLength: number): string {
  const trimmed = line.replace(/\s+$/, "");
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength)}...`;
}