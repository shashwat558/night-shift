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
