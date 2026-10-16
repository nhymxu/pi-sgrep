/**
 * Manual smoke test against a real sgrep binary.
 *
 *   SGREP_BIN=/path/to/sgrep bun run test/manual-verify.ts
 *
 * Prints the exact text the model would receive for the interesting cases.
 * Excluded from `bun test` because it downloads the embedding model.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";

const sgrep = process.env.SGREP_BIN;
if (!sgrep) {
  console.error("Set SGREP_BIN to a real sgrep binary.");
  process.exit(1);
}

const root = mkdtempSync(path.join(tmpdir(), "pi-sgrep-manual-"));
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

const agentDir = mkdtempSync(path.join(tmpdir(), "pi-sgrep-manual-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_SGREP_BIN = sgrep;

const extensionPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const loaded = await discoverAndLoadExtensions([extensionPath], root);
if (loaded.errors.length > 0) {
  console.error("load errors:", loaded.errors);
  process.exit(1);
}

const extension = loaded.extensions[0]!;
const notifications: string[] = [];
const ctx = {
  cwd: root,
  ui: {
    notify: (message: string) => notifications.push(message),
    setStatus: (key: string, text?: string) => notifications.push(`[status ${key}] ${text ?? ""}`),
  },
} as unknown as ExtensionToolContext;

console.log("registered tools:", [...extension.tools.keys()]);

async function call(toolName: string, args: Record<string, unknown>): Promise<void> {
  const definition = extension.tools.get(toolName)?.definition;
  if (!definition) {
    console.log(`\n=== ${toolName}: not registered ===`);
    return;
  }

  const started = Date.now();
  console.log(`\n=== ${toolName} ${JSON.stringify(args)} ===`);
  try {
    const result = await definition.execute("manual", args, undefined, undefined, ctx);
    console.log(result.content.find((block) => block.type === "text")?.text);
  } catch (error: unknown) {
    console.log(`THREW: ${(error as Error).message}`);
  }
  console.log(`(${Date.now() - started}ms)`);
}

await call("sgrep", { query: "deciding whether a customer should be charged", limit: 3 });
await call("sgrep", { query: "exponential delay between attempts", path: "src", limit: 2 });
await call("sgrep", { query: "the is of it" });
await call("sgrep", { query: "billing", path: "does/not/exist" });
await call("sgrep", { query: "anything", path: "~/", limit: 1 });
await call("sgrep_rank", {
  pattern: "function|export",
  query: "which function decides whether to charge a customer",
  limit: 3,
});

for (const name of ["sgrep-health", "sgrep-warm"]) {
  console.log(`\n=== /${name} ===`);
  await extension.commands.get(name)!.handler("", ctx as never);
}

console.log("\n=== notifications ===");
for (const message of notifications) console.log(message);