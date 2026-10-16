# pi-sgrep

A [pi](https://github.com/earendil-works/pi) extension that gives the agent **semantic code search** using [sgrep](https://github.com/context-dot-dev/sgrep).

Agents usually know what code should *do* before they know what it is *called*. That is the case ripgrep cannot help with: `grep` needs a string you do not have yet. sgrep ranks local passages by words and meaning, so `where do we retry a failed webhook delivery` finds the retry loop even though the word "webhook" appears nowhere in it.

Everything runs on your machine. No account, no hosted index, no per-query model call, and no source or query is uploaded. The first search downloads a ~32 MB static-embedding model; later searches run offline.

## Tools

### `sgrep`

Semantic search over a file or directory.

| Parameter | Default | Notes |
|---|---|---|
| `query` | required | Plain-English description of the behaviour. Identifiers (camelCase, snake_case, digits) are matched exactly and boosted, so names work too. |
| `path` | workspace root | File or directory to search. Narrow it when a result looks off-topic. |
| `limit` | 8 | Number of ranked passages to return. |
| `model` | `auto` | `auto` uses text embeddings for prose-only corpora and code embeddings otherwise. |

Results come back as line-numbered source with a `file:start-end` header, so the agent can jump straight to `read` with an offset.

### `sgrep_rank`

Rank ripgrep matches by meaning: one `rg` search for your pattern, then reorder the matches by how well each answers your question, keeping grep's exact-match guarantee.

| Parameter | Default | Notes |
|---|---|---|
| `pattern` | required | Regex passed straight to ripgrep. |
| `query` | `pattern` | What you are actually looking for, used for ranking. |
| `path` | workspace root | |
| `context` | 3 | Context lines kept around each match (0–20). |
| `limit` | 8 | |

This is the combination the sgrep README recommends: exact matches for recall, semantic ranking for order.

`sgrep_rank` is only registered when the installed sgrep build can read ripgrep JSON on stdin. Released v0.3.0 binaries cannot, so build from `main` to get it. The extension detects this from `sgrep --help` and tells you at session start.

## When the agent should use which tool

The extension ships prompt guidelines that encode this, because choosing wrongly is the expensive mistake:

- **You know the exact identifier or string** → `grep`. Faster and never approximate.
- **You know what the code does, not what it is called** → `sgrep`.
- **You have the right regex but too many hits** → `sgrep_rank`.

## Commands

- `/sgrep-health` — binary path and version, detected features, model and index cache state, and every resolved setting with its source.
- `/sgrep-warm [path] [--refresh]` — download the model and build the index for a path. `--refresh` rebuilds even when the index is current.

## Install

Requirements: pi, `sgrep`, and `ripgrep`.

### macOS (Apple Silicon)

A Homebrew formula is available. It pulls in `ripgrep` as a dependency:

```bash
brew install nhymxu/homebrew-tap/contextdev-sgrep
```

Upstream only publishes a macOS Apple Silicon binary, so the formula is `arm64` only.

### Anywhere else

```bash
brew install ripgrep
cargo install --git https://github.com/context-dot-dev/sgrep --locked
```

Or download a [release binary](https://github.com/context-dot-dev/sgrep/releases) manually.

The first search downloads the embedding model (~32 MB) and any code parsers; later searches run offline. `/sgrep-warm` does this ahead of the first agent turn.

### The pi extension

```bash
pi install npm:pi-sgrep
# or, while developing
pi install ./path/to/pi-sgrep
# or for one run
pi -e /path/to/pi-sgrep/src/index.ts
```

If the binary is missing, no tools are registered and pi shows the install command once per session.

### A note on the Homebrew binary

The formula ships the upstream v0.3.0 release binary, which does not support ranking ripgrep output (`--stdin`). `sgrep` works with it; `sgrep_rank` is only registered for builds from `main`:

```bash
cargo install --git https://github.com/context-dot-dev/sgrep --locked
```

Then point the extension at it with `"binary"` in `pi-sgrep.json`, or `PI_SGREP_BIN`. Run `/sgrep-health` to see which features the installed build has.

## Configuration

Create `pi-sgrep.json` in pi's agent directory (`~/.pi/agent/pi-sgrep.json` by default; `PI_CODING_AGENT_DIR` is respected):

```json
{
  "$schema": "https://raw.githubusercontent.com/nhymxu/pi-sgrep/main/pi-sgrep.schema.json",
  "model": "auto",
  "timeoutMs": 120000,
  "maxResults": 8
}
```

| Field | Type | Default |
|---|---|---|
| `binary` | string | `sgrep` on PATH, then `~/.cargo/bin`, Homebrew prefixes |
| `rgPath` | string | `rg` on PATH |
| `cacheDir` | string | sgrep's own defaults (`~/.cache/sgrep`, Hugging Face hub) |
| `model` | `auto` \| `code` \| `text` | `auto` |
| `timeoutMs` | 1000–3600000 | `120000` |
| `maxResults` | 1–50 | `8` |
| `maxResultsCap` | 1–50 | `50` |
| `maxLinesPerResult` | 1–2000 | `80` |
| `maxTotalLines` | 1–5000 | `240` |
| `maxLineLength` | 40–2000 | `500` |
| `allowLargeRoots` | boolean | `false` |
| `extraArgs` | string[] | none |

Unknown keys and out-of-range values stop the extension from loading and name the file, rather than being silently ignored.

### Flags and environment

CLI flags win over environment variables, which win over the config file.

| Flag | Environment | Setting |
|---|---|---|
| `--sgrep-timeout <ms>` | `PI_SGREP_TIMEOUT_MS` | `timeoutMs` |
| `--sgrep-model <model>` | `PI_SGREP_MODEL` | `model` |
| `--sgrep-limit <n>` | `PI_SGREP_MAX_RESULTS` | `maxResults` |
| `--sgrep-refresh-cache` | — | rebuild the index once per session |

```bash
pi --sgrep-limit 15 --sgrep-model code
```

`binary`, `rgPath` and `cacheDir` are file-and-environment only (`PI_SGREP_BIN`, `SGREP_BIN`), because they decide whether the extension can work at all and are resolved before flags exist.

## Safety properties

- **No shell.** Everything is spawned with an argv array, so a query or regex containing `$(...)` or backticks is passed through as data.
- **Bounded output.** Per-result, per-call, and per-line caps keep one search from filling the context window; every truncation states exactly what was cut and which `read` offset resumes it.
- **Bounded time.** Every child gets a timeout and is killed on turn cancellation.
- **No accidental indexing of `$HOME` or `/`.** Refused unless `allowLargeRoots` is set.
- **Deduplicated work.** Identical concurrent searches share one child process.

## Development

```bash
bun install
bun test          # unit + integration, with fake sgrep/ripgrep binaries
bun run typecheck
```

Integration tests spawn real processes against fake binaries in `test/helpers/`, so the CLI contract, exit codes, streaming pipeline, and timeout/abort paths are all exercised. `test/pi-load.test.ts` additionally loads the extension through pi's own loader.

Against a real sgrep build (downloads the embedding model):

```bash
# assertions
PI_SGREP_E2E=1 SGREP_E2E_BIN=/path/to/sgrep bun test test/e2e.test.ts

# print the exact text the model receives, for every tool and command
SGREP_BIN=/path/to/sgrep bun run test/manual-verify.ts
```

## Releasing

Publishing runs from GitHub Actions, so the staged tarball gets an npm provenance statement (a Sigstore attestation linking the package back to this repository).

`NPM_TOKEN` is a **stage-only** token, so the workflow submits to npm's staging area instead of going live. One approve step finishes the release:

```bash
npm version patch   # or minor / major
git push --follow-tags
gh release create v0.1.1
```

Then review and approve, with 2FA:

```bash
npm stage list            # find the stage id
npm stage view <stage-id> # inspect exactly what will be published
npm stage approve <stage-id>
```

or approve from the **Staged Packages** tab on npmjs.com. The workflow typechecks and runs the test suite before staging, so a red build never reaches the queue.

To publish without the approval step, regenerate `NPM_TOKEN` with the "Read and write (publish and stage)" permission and change the workflow's final step to `npm publish --provenance --access public`.

To check a tarball locally before it goes out — installs it into a throwaway consumer and loads it through pi's loader, exactly as `pi install` would:

```bash
npm pack
node scripts/verify-tarball.mjs pi-sgrep-0.1.0.tgz
```

## Layout

```text
src/
  index.ts    extension factory: tools, commands, flags, lifecycle
  sgrep.ts    binary discovery, capability probing, process execution
  paths.ts    scope resolution and workspace guards
  format.ts   line-numbered output with truncation notices
  render.ts   TUI/HTML transcript rendering
  config.ts   pi-sgrep.json parsing and flag/env/file precedence
scripts/
  verify-tarball.mjs  installs a packed tarball and loads it via pi
```