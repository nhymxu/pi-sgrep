/**
 * pi-sgrep: semantic code search for pi, powered by sgrep.
 *
 * sgrep (https://github.com/context-dot-dev/sgrep) finds local passages by
 * words and meaning. It fills the gap ripgrep cannot: an agent that knows what
 * code should do but not what it is called. Everything runs locally — no
 * account, no hosted index, no per-query model call.
 *
 * Two tools are registered when the sgrep binary is available:
 *
 * - `sgrep`       semantic search over a file or directory.
 * - `sgrep_rank`  ranks ripgrep matches by meaning (needs a newer sgrep build
 *                 that can read ripgrep JSON on stdin).
 *
 * Plus `/sgrep-health` and `/sgrep-warm` for inspecting and preparing the
 * local caches.
 *
 * The extension factory is async on purpose: it probes the sgrep binary once
 * (`--version` and `--help`) so tools are only registered when they can work,
 * and only expose options the installed build understands.
 */

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  type ModelChoice,
  type ResolvedSettings,
  type SettingName,
  type SettingOrigin,
  loadConfig,
  MODEL_CHOICES,
  resolveSettings,
} from "./config.ts";
import { displayPath, describeTimeout, formatResults } from "./format.ts";
import { resolveScope } from "./paths.ts";
import { renderRankCall, renderSearchCall, renderSearchResult, type ThemeLike } from "./render.ts";
import {
  buildRankArgs,
  buildRipgrepArgs,
  buildSearchArgs,
  cacheLocations,
  CODE_MODEL_REPO,
  describeFailure,
  isModelCached,
  parseChunks,
  resolveRipgrep,
  resolveSgrep,
  runRankedSearch,
  runSearch,
  runSgrep,
  TEXT_MODEL_REPO,
  type RunOutcome,
  type SgrepCapabilities,
} from "./sgrep.ts";

const SEARCH_TOOL = "sgrep";
const RANK_TOOL = "sgrep_rank";
const STATUS_KEY = "sgrep";

/** Upper bound for ripgrep context lines in `sgrep_rank`. */
const RANK_CONTEXT_MAX = 20;
const RANK_CONTEXT_DEFAULT = 3;
/** `/sgrep-warm` may download the embedding model, so it gets its own budget. */
const WARM_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const modelParameter = Type.Optional(
  Type.Union(
    MODEL_CHOICES.map((choice) => Type.Literal(choice)),
    {
      description:
        "Embedding model. `auto` (default) uses text embeddings when every candidate passage is " +
        "prose (.md, .txt) and code embeddings otherwise. Use `code` for source and `text` for docs.",
    },
  ),
);

const limitParameter = Type.Optional(
  Type.Number({
    description: "Maximum number of ranked passages to return (default 8).",
  }),
);

const searchSchema = Type.Object({
  query: Type.String({
    description:
      "What the code does, in plain English: 'where do we retry a failed webhook delivery', " +
      "'how is the invoice total calculated'. Words a developer would write in the code itself " +
      "(nouns, verbs) work best. CamelCase, snake_case and digits are matched exactly and boosted, " +
      "so identifiers work too. Results are approximate: verify a hit by reading the cited lines.",
  }),
  path: Type.Optional(
    Type.String({
      description:
        "File or directory to search, relative to the workspace root. Defaults to the whole " +
        "workspace. Narrow it (path: 'src/billing') when the first answer is off-topic.",
    }),
  ),
  limit: limitParameter,
  model: modelParameter,
});

const rankSchema = Type.Object({
  pattern: Type.String({
    description:
      "Regex (or plain text) passed straight to ripgrep. Exact matches only, so include every " +
      "naming variant you expect: 'creditCost|shouldBill|chargeCustomer'.",
  }),
  query: Type.Optional(
    Type.String({
      description:
        "What you are actually looking for, used to rank the matches by meaning. Defaults to " +
        "`pattern`, which only reorders by text similarity.",
    }),
  ),
  path: Type.Optional(
    Type.String({
      description: "File or directory to search, relative to the workspace root.",
    }),
  ),
  context: Type.Optional(
    Type.Number({
      description: `Context lines kept around each match (0-${RANK_CONTEXT_MAX}, default ${RANK_CONTEXT_DEFAULT}).`,
    }),
  ),
  limit: limitParameter,
  model: modelParameter,
});

const searchOutputSchema = Type.Object({
  query: Type.String(),
  path: Type.String(),
  shown: Type.Number(),
  total: Type.Number(),
  hiddenLines: Type.Number(),
  durationMs: Type.Number(),
  results: Type.Array(
    Type.Object({
      path: Type.String(),
      start: Type.Number(),
      end: Type.Number(),
      lines: Type.Number(),
      passage: Type.String(),
    }),
  ),
});

type SearchParams = Static<typeof searchSchema>;
type RankParams = Static<typeof rankSchema>;

const SEARCH_GUIDELINES = [
  `sgrep: use it when you know what the code DOES but not what it is CALLED. Describe the behaviour in plain English.`,
  `sgrep: scope with \`path\` (e.g. path: 'src/billing') and raise \`limit\` only after a result looks off-topic. Results are approximate: read the cited lines before acting on them.`,
  `sgrep_rank: use it when you already have the right regex but too many hits — it keeps only ripgrep matches and reorders them by meaning.`,
  `Prefer grep for exact identifiers and literals: it is faster and never approximate. sgrep costs an index read plus embeddings.`,
];

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default async function piSgrepExtension(pi: ExtensionAPI): Promise<void> {
  // A malformed config stops the extension from loading and names the file:
  // a silently ignored setting is worse than a loud failure.
  const config = loadConfig();

  // Flags are populated after extension load, so settings are resolved per call
  // instead of once here.
  const currentResolution = () => resolveSettings(config, { getFlag: (name) => pi.getFlag(name) });
  const currentSettings = (): ResolvedSettings => currentResolution().settings;

  const sgrep = await resolveSgrep(config.binary);
  const ripgrep = sgrep.ok
    ? await resolveRipgrep(config.rgPath)
    : { ok: false as const, message: "not checked", hint: "" };

  // --- flags ---

  pi.registerFlag("sgrep-timeout", {
    description: "Per-search timeout in milliseconds (also: PI_SGREP_TIMEOUT_MS). Default 120000.",
    type: "string",
  });
  pi.registerFlag("sgrep-model", {
    description: `Embedding model: ${MODEL_CHOICES.join(" | ")} (also: PI_SGREP_MODEL). Default auto.`,
    type: "string",
  });
  pi.registerFlag("sgrep-limit", {
    description: "Default number of passages returned per search (also: PI_SGREP_MAX_RESULTS).",
    type: "string",
  });
  pi.registerFlag("sgrep-refresh-cache", {
    description: "Rebuild the sgrep search index before the next search in this session.",
    type: "boolean",
  });

  // --- shared helpers ---

  function capabilities(): SgrepCapabilities {
    if (!sgrep.ok) throw new Error("sgrep is unavailable.");
    return sgrep.capabilities;
  }

  function binary(): string {
    if (!sgrep.ok) throw new Error(sgrep.message);
    return sgrep.binary;
  }

  function refreshRequested(): boolean {
    return pi.getFlag("sgrep-refresh-cache") === true;
  }

  function effectiveLimit(requested: number | undefined, settings: ResolvedSettings): number {
    if (requested === undefined || !Number.isFinite(requested)) return settings.maxResults;
    return Math.min(settings.maxResultsCap, Math.max(1, Math.round(requested)));
  }

  function effectiveModel(requested: string | undefined, settings: ResolvedSettings): ModelChoice {
    return requested !== undefined && MODEL_CHOICES.includes(requested as ModelChoice)
      ? (requested as ModelChoice)
      : settings.model;
  }

  /**
   * Whether the embedding model still has to be downloaded.
   *
   * sgrep reports no progress while it works, so a timeout is far easier to
   * interpret when we know whether it hit a cold cache. The answer only changes
   * the hint in the error, never the control flow.
   */
  function isColdStart(settings: ResolvedSettings): boolean {
    const { hub } = cacheLocations(settings.cacheDir);
    return !isModelCached(hub, CODE_MODEL_REPO) && !isModelCached(hub, TEXT_MODEL_REPO);
  }

  function assertUsableRun(outcome: RunOutcome, timeoutMs: number, settings: ResolvedSettings): void {
    if (outcome.aborted) throw new Error("sgrep search cancelled.");
    if (outcome.timedOut) throw new Error(describeTimeout(timeoutMs, isColdStart(settings)));
    if (outcome.outputTruncated) {
      throw new Error(
        "sgrep produced more output than this extension will buffer. Narrow `path` or lower `limit`.",
      );
    }
    // 0 = results, 1 = no results, 2 = failure (`src/main.rs`).
    if (outcome.exitCode !== 0 && outcome.exitCode !== 1) {
      throw new Error(describeFailure(outcome));
    }
  }

  // --- search tool ---

  if (sgrep.ok) {
    pi.registerTool({
      name: SEARCH_TOOL,
      label: SEARCH_TOOL,
      description:
        "Semantic code and documentation search. Describe what the code does in plain English and " +
        "get back the most relevant source passages (file, line range, code), ranked locally by " +
        "meaning. Use it when you do not know the identifier to search for. Runs entirely on this " +
        "machine: source and queries are never uploaded. Default limit 8.",
      promptSnippet: "Semantic code search by description",
      promptGuidelines: SEARCH_GUIDELINES,
      parameters: searchSchema,
      outputSchema: searchOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionToolContext) {
        const settings = currentSettings();
        const query = (params.query ?? "").trim();
        if (query === "") throw new Error("`query` must not be empty.");

        const scope = resolveScope(params.path, {
          cwd: ctx.cwd,
          allowLargeRoots: settings.allowLargeRoots,
        });
        if (!scope.ok) throw new Error(scope.error);

        const limit = effectiveLimit(params.limit, settings);
        const args = buildSearchArgs({
          query,
          target: scope.scope.target,
          limit,
          model: effectiveModel(params.model, settings),
          cacheDir: settings.cacheDir,
          refreshCache: refreshRequested(),
          capabilities: capabilities(),
          extraArgs: settings.extraArgs,
        });

        const outcome = await runSearch(binary(), args, {
          cwd: scope.scope.cwd,
          timeoutMs: settings.timeoutMs,
          signal,
        });
        assertUsableRun(outcome, settings.timeoutMs, settings);

        const chunks = parseChunks(outcome.stdout);
        const formatted = formatResults(
          chunks,
          { title: `sgrep: "${query}" in ${scope.scope.label} — ${chunks.length} result(s)` },
          {
            scope: scope.scope,
            maxLinesPerResult: settings.maxLinesPerResult,
            maxTotalLines: settings.maxTotalLines,
            maxLineLength: settings.maxLineLength,
          },
        );

        return {
          content: [{ type: "text", text: formatted.text }],
          details: {
            query,
            path: scope.scope.absolute,
            shown: formatted.shown,
            total: formatted.total,
            durationMs: outcome.durationMs,
          },
          structuredContent: {
            query,
            path: scope.scope.label,
            shown: formatted.shown,
            total: formatted.total,
            hiddenLines: formatted.hiddenLines,
            durationMs: outcome.durationMs,
            results: chunks.map((chunk) => ({
              path: displayPath(chunk.path, scope.scope),
              start: chunk.start,
              end: chunk.end,
              lines: chunk.end - chunk.start + 1,
              passage: chunk.content,
            })),
          },
        };
      },
      renderCall(args: SearchParams, theme: ThemeLike) {
        return renderSearchCall(args, theme, SEARCH_TOOL);
      },
      renderResult(result, options, theme) {
        return renderSearchResult(result, options, theme);
      },
    });

    // --- ranking tool ---
    //
    // Only available on sgrep builds that can read ripgrep JSON on stdin.
    // Released v0.3.0 binaries cannot, so the tool is not registered for them.

    if (sgrep.capabilities.supportsRankInput && ripgrep.ok) {
      pi.registerTool({
        name: RANK_TOOL,
        label: RANK_TOOL,
        description:
          "Rank ripgrep matches by meaning. Runs one ripgrep search with your pattern, then reorders " +
          "the matches by how well each one answers the query, keeping the exact-match guarantee of " +
          "grep. Use it when a regex returns too many hits to read. Runs locally. Default limit 8.",
        promptSnippet: "Rank grep matches by meaning",
        promptGuidelines: SEARCH_GUIDELINES,
        parameters: rankSchema,
        outputSchema: searchOutputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionToolContext) {
          const settings = currentSettings();
          const pattern = (params.pattern ?? "").trim();
          if (pattern === "") throw new Error("`pattern` must not be empty.");
          const query = (params.query ?? "").trim() || pattern;

          const scope = resolveScope(params.path, {
            cwd: ctx.cwd,
            allowLargeRoots: settings.allowLargeRoots,
          });
          if (!scope.ok) throw new Error(scope.error);

          const limit = effectiveLimit(params.limit, settings);
          const context = clampContext(params.context);
          const model = effectiveModel(params.model, settings);

          const outcome = await runRankedSearch({
            sgrepBinary: binary(),
            sgrepArgs: buildRankArgs({
              query,
              target: scope.scope.target,
              limit,
              model,
              cacheDir: settings.cacheDir,
              extraArgs: settings.extraArgs,
            }),
            ripgrepBinary: ripgrep.binary,
            ripgrepArgs: buildRipgrepArgs({
              pattern,
              target: scope.scope.target,
              context,
            }),
            cwd: scope.scope.cwd,
            timeoutMs: settings.timeoutMs,
            signal,
          });

          if (outcome.aborted) throw new Error("sgrep_rank cancelled.");
          if (outcome.timedOut) throw new Error(describeTimeout(settings.timeoutMs, false));
          // ripgrep exits 2 on a bad pattern or unreadable path; sgrep would
          // then report an empty result, hiding the real problem.
          if (outcome.ripgrep.exitCode !== null && outcome.ripgrep.exitCode > 1) {
            const detail = outcome.ripgrep.stderr.trim();
            throw new Error(
              `ripgrep failed on pattern /${pattern}/: ${detail === "" ? `exit ${outcome.ripgrep.exitCode}` : detail}`,
            );
          }
          if (outcome.exitCode !== 0 && outcome.exitCode !== 1) {
            throw new Error(describeFailure(outcome));
          }

          const chunks = parseChunks(outcome.stdout);
          const candidates =
            outcome.matchCount > 0 ? outcome.matchCount : chunks.length;
          const formatted = formatResults(
            chunks,
            {
              title:
                `sgrep_rank: ${candidates} ripgrep match(es) for /${pattern}/ in ${scope.scope.label}, ` +
                `ranked by "${query}" — ${chunks.length} shown`,
              subtitle: `context ${context} line${context === 1 ? "" : "s"} around each match`,
            },
            {
              scope: scope.scope,
              maxLinesPerResult: settings.maxLinesPerResult,
              maxTotalLines: settings.maxTotalLines,
              maxLineLength: settings.maxLineLength,
            },
          );

          return {
            content: [{ type: "text", text: formatted.text }],
            details: {
              pattern,
              query,
              path: scope.scope.absolute,
              matches: candidates,
              shown: formatted.shown,
              durationMs: outcome.durationMs,
            },
            structuredContent: {
              query,
              path: scope.scope.label,
              shown: formatted.shown,
              total: chunks.length,
              hiddenLines: formatted.hiddenLines,
              durationMs: outcome.durationMs,
              results: chunks.map((chunk) => ({
                path: displayPath(chunk.path, scope.scope),
                start: chunk.start,
                end: chunk.end,
                lines: chunk.end - chunk.start + 1,
                passage: chunk.content,
              })),
            },
          };
        },
        renderCall(args: RankParams, theme: ThemeLike) {
          return renderRankCall(args, theme, RANK_TOOL);
        },
        renderResult(result, options, theme) {
          return renderSearchResult(result, options, theme);
        },
      });
    }
  }

  // --- commands ---

  pi.registerCommand("sgrep-health", {
    description: "Show sgrep status: binary, features, models, indexes and resolved settings",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const { settings, origins } = currentResolution();
      const report = healthReport({ sgrep, ripgrep, settings, origins, cwd: ctx.cwd });
      ctx.ui.notify(report, sgrep.ok ? "info" : "warning");
    },
  });

  pi.registerCommand("sgrep-warm", {
    description: "Download the sgrep model and build the search index for a path: /sgrep-warm [path] [--refresh]",
    handler: async (args: string, ctx: ExtensionContext) => {
      if (!sgrep.ok) {
        ctx.ui.notify(`${sgrep.message}\n${sgrep.hint}`, "error");
        return;
      }

      const settings = currentSettings();
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const refresh = tokens.includes("--refresh");
      const target = tokens.filter((token) => token !== "--refresh").join(" ") || undefined;

      const scope = resolveScope(target, { cwd: ctx.cwd, allowLargeRoots: settings.allowLargeRoots });
      if (!scope.ok) {
        ctx.ui.notify(scope.error, "error");
        return;
      }

      const timeoutMs = Math.max(settings.timeoutMs, WARM_TIMEOUT_MS);
      ctx.ui.setStatus?.(STATUS_KEY, `sgrep: preparing ${scope.scope.label}...`);
      try {
        const outcome = await runSgrep(
          sgrep.binary,
          buildSearchArgs({
            query: "index this directory for semantic search",
            target: scope.scope.target,
            limit: 1,
            model: settings.model,
            cacheDir: settings.cacheDir,
            refreshCache: refresh,
            capabilities: sgrep.capabilities,
            extraArgs: settings.extraArgs,
          }),
          { cwd: scope.scope.cwd, timeoutMs },
        );

        const seconds = (outcome.durationMs / 1000).toFixed(1);
        if (outcome.timedOut) {
          ctx.ui.notify(`sgrep timed out after ${seconds}s while preparing ${scope.scope.label}.`, "error");
          return;
        }
        if (outcome.exitCode !== 0 && outcome.exitCode !== 1) {
          ctx.ui.notify(describeFailure(outcome), "error");
          return;
        }

        const { hub, index } = cacheLocations(settings.cacheDir);
        ctx.ui.notify(
          [
            `sgrep ready in ${seconds}s for ${scope.scope.label}`,
            `Results: ${parseChunks(outcome.stdout).length}`,
            `Models: ${hub}`,
            `Indexes: ${index}`,
            refresh ? "Index was rebuilt." : "",
          ]
            .filter(Boolean)
            .join("\n"),
          "info",
        );
      } finally {
        ctx.ui.setStatus?.(STATUS_KEY, undefined);
      }
    },
  });

  // --- lifecycle ---

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    if (!sgrep.ok) {
      ctx.ui.notify(`(sgrep): ${sgrep.message}\n(sgrep): ${sgrep.hint}`, "warning");
      return;
    }
    if (!sgrep.capabilities.supportsRankInput) {
      ctx.ui.notify(
        `(sgrep): ${sgrep.capabilities.version} cannot read ripgrep JSON, so ${RANK_TOOL} is not ` +
          "available. Build sgrep from main to enable it.",
        "info",
      );
    } else if (!ripgrep.ok) {
      ctx.ui.notify(`(sgrep): ${RANK_TOOL} is disabled — ${ripgrep.message}\n(sgrep): ${ripgrep.hint}`, "warning");
    }
  });

  pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
    ctx.ui.setStatus?.(STATUS_KEY, undefined);
  });
}

function clampContext(context: number | undefined): number {
  if (context === undefined || !Number.isFinite(context)) return RANK_CONTEXT_DEFAULT;
  return Math.min(RANK_CONTEXT_MAX, Math.max(0, Math.round(context)));
}

// ---------------------------------------------------------------------------
// /sgrep-health
// ---------------------------------------------------------------------------

interface HealthInput {
  sgrep: Awaited<ReturnType<typeof resolveSgrep>>;
  ripgrep: Awaited<ReturnType<typeof resolveRipgrep>>;
  settings: ResolvedSettings;
  origins: Record<string, SettingOrigin>;
  cwd: string;
}

function healthReport(input: HealthInput): string {
  const { sgrep, ripgrep, settings, origins } = input;
  const lines: string[] = [];

  if (!sgrep.ok) {
    return [`sgrep: NOT AVAILABLE — ${sgrep.message}`, `Hint: ${sgrep.hint}`].join("\n");
  }

  const features = [
    "semantic search",
    sgrep.capabilities.supportsRankInput ? `rank ripgrep input (${RANK_TOOL})` : null,
    sgrep.capabilities.supportsCacheDir ? "--cache-dir" : null,
    sgrep.capabilities.supportsRefreshCache ? "--refresh-cache" : null,
  ].filter((feature): feature is string => feature !== null);

  lines.push(
    `sgrep: ${sgrep.binary}`,
    `Version: ${sgrep.capabilities.version}`,
    `Features: ${features.join(", ")}`,
    `ripgrep: ${ripgrep.ok ? ripgrep.binary : `unavailable — ${ripgrep.message}`}`,
  );

  const { hub, index } = cacheLocations(settings.cacheDir);
  lines.push(
    `Models: code ${isModelCached(hub, CODE_MODEL_REPO) ? "cached" : "missing"}, ` +
      `text ${isModelCached(hub, TEXT_MODEL_REPO) ? "cached" : "missing"}`,
    `Model cache: ${hub}`,
    `Index cache: ${index}${describeIndexCache(index)}`,
  );

  const rendered = (Object.keys(settings) as SettingName[])
    .filter((name) => {
      const value = settings[name];
      return value !== undefined && !(Array.isArray(value) && value.length === 0);
    })
    .map((name) => {
      const value = settings[name];
      const shown = Array.isArray(value) ? JSON.stringify(value) : String(value);
      return `${name}=${shown} (${origins[name] ?? "default"})`;
    });

  lines.push(
    `Settings: ${rendered.join(", ")}`,
    `Workspace: ${input.cwd}`,
    "Scope: whole workspace by default; $HOME and / are refused unless allowLargeRoots is set.",
  );

  return lines.join("\n");
}

/** Append the size of a warm index cache, so `/sgrep-health` shows where it went. */
function describeIndexCache(indexDir: string): string {
  try {
    const entries = readdirSync(indexDir).filter((name) => name.startsWith("index-") && name.endsWith(".bin"));
    if (entries.length === 0) return " (empty)";
    const bytes = entries.reduce(
      (total, name) => total + (statSync(path.join(indexDir, name)).size || 0),
      0,
    );
    return ` (${entries.length} index(es), ${formatBytes(bytes)})`;
  } catch {
    return "";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}