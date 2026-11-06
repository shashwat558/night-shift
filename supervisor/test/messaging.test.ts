import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/env.js";

test("SWITCH_ROOM_IDS keeps a primary room and de-duplicates rooms", () => {
  const cfg = loadConfig({
    SWITCH_AGENT_KEY: "key",
    SWITCH_AGENT_ID: "agent",
    SWITCH_ROOM_ID: "mattermost-room",
    SWITCH_ROOM_IDS: "mattermost-room, slack-room, discord-room, slack-room",
  });
  assert.equal(cfg.roomId, "mattermost-room");
  assert.deepEqual(cfg.roomIds, ["mattermost-room", "slack-room", "discord-room"]);
});

test("SWITCH_ROOM_IDS first entry becomes primary when SWITCH_ROOM_ID is absent", () => {
  const cfg = loadConfig({
    SWITCH_AGENT_KEY: "key",
    SWITCH_AGENT_ID: "agent",
    SWITCH_ROOM_IDS: "slack-room,discord-room",
  });
  assert.equal(cfg.roomId, "slack-room");
  assert.deepEqual(cfg.roomIds, ["slack-room", "discord-room"]);
});

test("WORKER_PROVIDER accepts both OpenCode and Codex", () => {
  const required = { SWITCH_AGENT_KEY: "key", SWITCH_AGENT_ID: "agent" };
  assert.equal(loadConfig({ ...required, WORKER_PROVIDER: "opencode" }).provider, "opencode");
  assert.equal(loadConfig({ ...required, WORKER_PROVIDER: "CODEX" }).provider, "codex");
});

test("WORKER_PROVIDER rejects typos instead of silently using OpenCode", () => {
  assert.throws(
    () => loadConfig({
      SWITCH_AGENT_KEY: "key",
      SWITCH_AGENT_ID: "agent",
      WORKER_PROVIDER: "codxe",
    }),
    (error: unknown) => error instanceof Error && error.name === "ConfigError" && /codxe/.test(error.message),
  );
});
