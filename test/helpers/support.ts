import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const helpersDir = path.dirname(fileURLToPath(import.meta.url));

export const FAKE_SGREP = path.join(helpersDir, "fake-sgrep.mjs");
export const FAKE_RG = path.join(helpersDir, "fake-rg.mjs");

// Ensure both fixtures are executable even if the checkout lost the bit.
chmodSync(FAKE_SGREP, 0o755);
chmodSync(FAKE_RG, 0o755);

export interface Workspace {
  root: string;
  agentDir: string;
  /** Write a pi-sgrep.json into the agent dir and return its path. */
  writeConfig(config: Record<string, unknown>): string;
  /** Create a file below the workspace and return its absolute path. */
  writeFile(relativePath: string, contents: string): string;
  /** Serialize sgrep chunks to a fixture the fake binary can print. */
  writeChunks(chunks: unknown[]): string;
  cleanup(): void;
}

/** A throwaway workspace plus a pi agent directory, wired to the fake binaries. */
export function createWorkspace(config: Record<string, unknown> = {}): Workspace {
  const root = mkdtempSync(path.join(tmpdir(), "pi-sgrep-test-"));
  const agentDir = path.join(root, "agent");
  mkdirSync(agentDir, { recursive: true });

  return {
    root,
    agentDir,
    writeConfig(overrides: Record<string, unknown> = {}) {
      const configPath = path.join(agentDir, "pi-sgrep.json");
      writeFileSync(
        configPath,
        JSON.stringify({ binary: FAKE_SGREP, rgPath: FAKE_RG, ...config, ...overrides }, null, 2),
      );
      return configPath;
    },
    writeFile(relativePath, contents) {
      const target = path.join(root, relativePath);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, contents);
      return target;
    },
    writeChunks(chunks) {
      const target = path.join(root, `chunks-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(target, JSON.stringify(chunks));
      return target;
    },
    cleanup() {
      // mkdtemp directories are small; leaving them behind keeps failures
      // inspectable, so nothing is removed here on purpose.
    },
  };
}

/** Environment for a child process, with inherited PATH plus test overrides. */
export function childEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** Minimal `ExtensionContext` for tool and command execution. */
export function createContext(cwd: string) {
  const notifications: { message: string; type?: string }[] = [];
  const statuses: { key: string; text?: string }[] = [];

  return {
    ctx: {
      cwd,
      mode: "tui" as const,
      hasUI: true,
      ui: {
        notify(message: string, type?: string) {
          notifications.push({ message, type });
        },
        setStatus(key: string, text?: string) {
          statuses.push({ key, text });
        },
        setWorkingMessage() {},
        setWorkingVisible() {},
        setHiddenThinkingLabel() {},
        setWidget() {},
        setFooter() {},
        setHeader() {},
        setTitle() {},
        select: async () => undefined,
        confirm: async () => false,
        input: async () => undefined,
        onTerminalInput: () => () => {},
        custom: async () => undefined as never,
      },
      sessionManager: { getEntries: () => [], getBranch: () => [] },
      modelRegistry: {},
      model: undefined,
      scopedModels: [],
      isIdle: () => true,
      isProjectTrusted: () => true,
      signal: undefined,
      abort() {},
      hasPendingMessages: () => false,
      shutdown() {},
      getContextUsage: () => undefined,
      compact() {},
      getSystemPrompt: () => "",
      tools: [],
      executeTool: async () => {
        throw new Error("not used in tests");
      },
    },
    notifications,
    statuses,
  };
}