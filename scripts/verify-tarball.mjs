/**
 * Loads the packed tarball the way `pi install npm:pi-sgrep` does: from
 * node_modules, with only the pi host modules present.
 *
 *   node scripts/verify-tarball.mjs ./pi-sgrep-0.1.0.tgz
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tarball = process.argv[2];
if (!tarball) {
  console.error("usage: node scripts/verify-tarball.mjs <tarball>");
  process.exit(1);
}

const root = mkdtempSync(path.join(tmpdir(), "pi-sgrep-tarball-"));
const consumer = path.join(root, "consumer");
mkdirSync(consumer, { recursive: true });
writeFileSync(
  path.join(consumer, "package.json"),
  JSON.stringify({ name: "consumer", private: true, version: "1.0.0" }),
);
execFileSync("npm", ["install", path.resolve(tarball)], { cwd: consumer, stdio: "inherit" });

// The extension entry pi reads from package.json, resolved inside node_modules.
const manifest = JSON.parse(
  execFileSync("node", ["-p", `JSON.stringify(require(${JSON.stringify(path.join(consumer, "node_modules/pi-sgrep/package.json"))}))`]).toString(),
);
const entry = path.join(consumer, "node_modules/pi-sgrep", manifest.pi.extensions[0]);

// A fake sgrep so the probe succeeds without touching the network.
const fakeBin = path.join(root, "fake-sgrep");
writeFileSync(
  fakeBin,
  `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "sgrep 0.0.0-fake"; exit 0; fi\necho "help" | grep -q -- --stdin || exit 0\necho "[]"\n`,
);
execFileSync("chmod", ["+x", fakeBin]);

process.env.PI_SGREP_BIN = fakeBin;
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

const { discoverAndLoadExtensions } = await import(
  path.join(consumer, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")
);

const result = await discoverAndLoadExtensions([entry], consumer);

console.log("entry:", entry.replace(consumer, "<consumer>"));
console.log("load errors:", result.errors);
console.log(
  "tools:",
  result.extensions.flatMap((extension) => [...extension.tools.keys()]),
);
console.log(
  "commands:",
  result.extensions.flatMap((extension) => [...extension.commands.keys()]),
);

const failed =
  result.errors.length > 0 ||
  result.extensions.flatMap((extension) => [...extension.tools.keys()]).length === 0;
console.log(failed ? "FAIL" : "OK");
process.exit(failed ? 1 : 0);