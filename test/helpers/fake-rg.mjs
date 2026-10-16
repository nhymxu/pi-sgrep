#!/usr/bin/env node
/**
 * Fake ripgrep for the `sgrep_rank` tests. Emits a fixed ripgrep JSON stream so
 * the extension's streaming pipeline can be exercised without scanning a repo.
 *
 *   FAKE_RG_JSON      file with ripgrep JSONL to write to stdout
 *   FAKE_RG_STDERR    stderr text
 *   FAKE_RG_EXIT      exit code (default 0)
 *   FAKE_RG_SLEEP     milliseconds to wait before writing
 *   FAKE_RG_ARGS_FILE file that receives the argv array as JSON
 */

import { readFileSync, writeFileSync } from "node:fs";

if (process.env.FAKE_RG_ARGS_FILE) {
  writeFileSync(process.env.FAKE_RG_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
}

const sleep = Number(process.env.FAKE_RG_SLEEP ?? "0");
if (sleep > 0) await new Promise((resolve) => setTimeout(resolve, sleep));

if (process.env.FAKE_RG_JSON) {
  process.stdout.write(readFileSync(process.env.FAKE_RG_JSON, "utf8"));
}
if (process.env.FAKE_RG_STDERR) {
  process.stderr.write(`${process.env.FAKE_RG_STDERR}\n`);
}

process.exit(Number(process.env.FAKE_RG_EXIT ?? "0"));