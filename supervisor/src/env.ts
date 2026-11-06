// supervisor/src/env.ts — the configuration contract (SPEC §6).
// Runtime config lives in supervisor/.env (git-ignored, chmod 600, written by
// the provisioner). No dotenv library: parse it the same way the dev-tools do.
// Secrets are never logged; callers print [set]/[missing] only.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// When compiled: file is at dist/src/env.js; two levels up reaches supervisor/.
// When run as source (ts-node): file is at src/env.ts; two levels up still OK.
export const SUPERVISOR_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// The supervisor sits at <repo>/supervisor; the monorepo root is one level up.
export const REPO_ROOT = resolve(SUPERVISOR_DIR, "..");

export type Provider = "opencode" | "claude";

export interface Config {
  /** Switch agent-bridge base URL (NOT the gateway). */
  apiBase: string;
  /** Gateway admin surface base (owner-path addressing, provision only). */
  gatewayBase: string;
  /** This agent's registered name (SPEC §3: shift-supervisor). */
  agentName: string;
  /** Registered id (from provision). */
  agentId: string;
  /** The agent's own API key. Secret. Never printed. */
  agentKey: string;
  /** Room the crew lives in. */
  room: string;
  /** Room id; resolved from the server at runtime when null. */
  roomId: string | null;
  /** Every Switch room this process serves; roomId remains the primary room. */
  roomIds: string[];
  /** Crew template team prefix (agent handles: {crewPrefix}-night-lead …). */
  crewPrefix: string;
  /** The crew's git repo (the simulated company). */
  targetDir: string;
  /** Monorepo root, where crew/ and docs/ live. */
  repoRoot: string;
  /** owner/name on GitHub (used by gh pr create / CI reads). */
  ghRepo: string | null;
  /** Worker provider behind the spawner (decision D1: opencode default). */
  provider: Provider;
  /** Stable connection identity reused across reconnects AND restarts. */
  connectionId: string;
}

const ENV_RE = /^[A-Z][A-Z0-9_]*=/;

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !ENV_RE.test(t)) continue;
    const eq = t.indexOf("=");
    out[t.slice(0, eq)] = t.slice(eq + 1);
  }
  return out;
}

export function parseCrewState(text: string): { team?: string; room: { id: string; name: string } } | null {
  try {
    const s = JSON.parse(text) as {
      team?: string;
      room?: { id?: string; name?: string };
    };
    if (!s?.room?.id || !s?.room?.name) return null;
    return { team: s.team, room: { id: s.room.id as string, name: s.room.name as string } };
  } catch {
    return null;
  }
}

export function envFileCandidates(): string[] {
  // supervisor/.env is the runtime contract; ops/.env carries the stack ports
  // (provision writes the resolved values into supervisor/.env, so the
  // runtime works ledger-only from its own file).
  return process.env.SUPERVISOR_ENV
    ? [process.env.SUPERVISOR_ENV]
    : [join(SUPERVISOR_DIR, ".env")];
}

export function loadConfig(rawEnv: Record<string, string>): Config {
  const crewStatePath = join(REPO_ROOT, "ops", ".agents", "crew-state.json");
  let crewState: { team?: string; room: { id: string; name: string } } | null = null;
  try {
    crewState = parseCrewState(readFileSync(crewStatePath, "utf8"));
  } catch {
    crewState = null;
  }

  const agentName = rawEnv.SWITCH_AGENT_NAME ?? "shift-supervisor";
  const agentKey = rawEnv.SWITCH_AGENT_KEY ?? "";
  const agentId = rawEnv.SWITCH_AGENT_ID ?? "";
  const missing = [
    ["SWITCH_AGENT_KEY", agentKey],
    ["SWITCH_AGENT_ID", agentId],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const room = rawEnv.SWITCH_ROOM ?? crewState?.room.name ?? "overnight-crew";
  const configuredRoomIds = (rawEnv.SWITCH_ROOM_IDS ?? "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  const roomId = rawEnv.SWITCH_ROOM_ID || configuredRoomIds[0] || crewState?.room.id || null;
  const roomIds = [...new Set([...(roomId ? [roomId] : []), ...configuredRoomIds])];
  const targetDir = rawEnv.TARGET_REPO
    ? resolve(SUPERVISOR_DIR, rawEnv.TARGET_REPO)
    : resolve(SUPERVISOR_DIR, "..", "target");

  const providerRaw = (rawEnv.WORKER_PROVIDER ?? "opencode").toLowerCase();
  const provider: Provider = providerRaw === "claude" ? "claude" : "opencode";

  const apiPort = rawEnv.SWITCH_API_PORT ?? rawEnv.API_HOST_PORT ?? "8000";
  const gwPort = rawEnv.SWITCH_GATEWAY_PORT ?? rawEnv.GATEWAY_HOST_PORT ?? "3100";

  const config: Config = {
    apiBase: rawEnv.SWITCH_API ?? `http://127.0.0.1:${apiPort}`,
    gatewayBase: rawEnv.SWITCH_GATEWAY ?? `http://127.0.0.1:${gwPort}/gateway`,
    agentName,
    agentId,
    agentKey,
    room,
    roomId,
    roomIds,
    crewPrefix: rawEnv.CREW_TEAM ?? crewState?.team ?? "nightshift",
    targetDir,
    repoRoot: REPO_ROOT,
    ghRepo: rawEnv.GH_REPO || null,
    provider,
    connectionId: rawEnv.SWITCH_CONNECTION_ID || randomUUID(),
  };

  if (missing.length > 0) {
    const err = new Error(
      `supervisor config missing required values: ${missing.join(", ")} ` +
        `(supervisor/.env must hold SWITCH_AGENT_KEY + SWITCH_AGENT_ID; run the provisioner first)`,
    );
    err.name = "ConfigError";
    throw err;
  }
  return config;
}

export function configFromFile(envPath = join(SUPERVISOR_DIR, ".env")): Config {
  const raw = parseEnvFile(readFileSync(envPath, "utf8"));
  return loadConfig(raw);
}

/** For offline tests: synthesize a full Config without touching any file. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  const config: Config = {
    apiBase: "http://127.0.0.1:1",
    gatewayBase: "http://127.0.0.1:1/gateway",
    agentName: "shift-supervisor",
    agentId: "test-agent-id",
    agentKey: "test-agent-key",
    room: "overnight-crew",
    roomId: "00000000-0000-0000-0000-000000000000",
    roomIds: ["00000000-0000-0000-0000-000000000000"],
    crewPrefix: "nightshift",
    targetDir: resolve(SUPERVISOR_DIR, "..", "target"),
    repoRoot: REPO_ROOT,
    ghRepo: "shashwat558/nightshift-target",
    provider: "opencode",
    connectionId: randomUUID(),
    ...overrides,
  };
  if (overrides.roomId !== undefined && overrides.roomIds === undefined) {
    config.roomIds = overrides.roomId ? [overrides.roomId] : [];
  }
  return config;
}
