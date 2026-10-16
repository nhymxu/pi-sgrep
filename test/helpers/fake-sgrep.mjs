#!/usr/bin/env node
/**
 * Fake sgrep used by the pi-sgrep test-suite.
 *
 * It speaks the real CLI contract (arguments, exit codes, stderr prefix, JSON
 * on stdout) while reading its behaviour from environment variables, so tests
 * can drive failure modes that are hard to produce with a real binary:
 *
 *   FAKE_SGREP_EXIT        exit code for a search (0 results, 1 empty, 2 error)
 *   FAKE_SGREP_CHUNKS      path to a JSON file printed as the result array
 *   FAKE_SGREP_STDERR      stderr text for a search
 *   FAKE_SGREP_SLEEP       milliseconds to wait before answering
 *   FAKE_SGREP_ARGS_FILE   file that receives the argv array as JSON
 *   FAKE_SGREP_STDIN_FILE  file that receives the stdin byte count
 *   FAKE_SGREP_HELP        "full" (main branch flags) or "minimal" (v0.3.0)
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);

if (argv.includes("--version")) {
  process.stdout.write("sgrep 9.9.9-fake\n");
  process.exit(0);
}

if (argv.includes("--help")) {
  const help =
    process.env.FAKE_SGREP_HELP === "minimal"
      ? [
          "Search code and text with ripgrep and local static embeddings.",
          "",
          "Usage: sgrep [OPTIONS] <QUERY> [PATH]",
          "",
          "Options:",
          "  -n <COUNT>           [default: 5]",
          "      --json",
          "      --model <MODEL>  [default: auto] [possible values: auto, code, text]",
        ]
      : [
          "Search code and text with ripgrep and local static embeddings.",
          "",
          "Usage: sgrep [OPTIONS] <QUERY> [PATH]",
          "",
          "Options:",
          "      --cache-dir <DIR>       Store models, parsers and search indexes under this directory.",
          "      --refresh-cache         Recompute and replace this corpus's search index before searching.",
          "      --json",
          "      --explain               Include lexical, semantic and fused scores in JSON output.",
          "      --stdin                 Rank only ripgrep --json passages read from standard input.",
          "  -n <COUNT>           [default: 5]",
          "      --model <MODEL>  [possible values: auto, code, text]",
        ];
  process.stdout.write(`${help.join("\n")}\n`);
  process.exit(0);
}

if (process.env.FAKE_SGREP_ARGS_FILE) {
  // Appending lets a test count how many processes actually ran.
  const record = `${JSON.stringify(argv)}\n`;
  if (process.env.FAKE_SGREP_ARGS_APPEND === "1") {
    appendFileSync(process.env.FAKE_SGREP_ARGS_FILE, record);
  } else {
    writeFileSync(process.env.FAKE_SGREP_ARGS_FILE, record);
  }
}

if (argv.includes("--stdin")) {
  // Consume stdin so the writer can finish, and report how much arrived.
  let bytes = 0;
  for await (const chunk of process.stdin) bytes += chunk.length;
  if (process.env.FAKE_SGREP_STDIN_FILE) {
    writeFileSync(process.env.FAKE_SGREP_STDIN_FILE, JSON.stringify({ bytes, argv }));
  }
}

const sleep = Number(process.env.FAKE_SGREP_SLEEP ?? "0");
if (sleep > 0) await new Promise((resolve) => setTimeout(resolve, sleep));

const exitCode = Number(process.env.FAKE_SGREP_EXIT ?? "0");
const chunksFile = process.env.FAKE_SGREP_CHUNKS;

if (chunksFile) {
  process.stdout.write(readFileSync(chunksFile, "utf8"));
} else if (exitCode === 0) {
  process.stdout.write("[]\n");
} else if (exitCode === 1) {
  process.stdout.write("[]\n");
}

if (process.env.FAKE_SGREP_STDERR) {
  process.stderr.write(`${process.env.FAKE_SGREP_STDERR}\n`);
}

process.exit(exitCode);