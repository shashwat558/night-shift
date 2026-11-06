#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const command = process.argv[2] ?? "connect";
const gatewayEnv = parseEnv(readFileSync(resolve(root, "ops/.env"), "utf8"));
const gatewayBase = `http://127.0.0.1:${gatewayEnv.GATEWAY_HOST_PORT || "3100"}/gateway`;

function parseEnv(text) {
  return Object.fromEntries(text.split(/\r?\n/).filter(line => /^[A-Z][A-Z0-9_]*=/.test(line)).map(line => {
    const at = line.indexOf("=");
    return [line.slice(0, at), line.slice(at + 1)];
  }));
}

async function responseJson(response, label) {
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { detail: text.slice(0, 300) }; }
  if (!response.ok) throw new Error(`${label} failed (${response.status}): ${JSON.stringify(body.detail ?? body).slice(0, 500)}`);
  return body;
}

const login = await fetch(`${gatewayBase}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: gatewayEnv.GATEWAY_ADMIN_EMAIL, password: gatewayEnv.GATEWAY_ADMIN_PASSWORD }),
});
await responseJson(login, "Gateway login");
const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
if (!cookie) throw new Error("Gateway login returned no session cookie");
const headers = { cookie, "content-type": "application/json" };

if (command === "manifest") {
  const response = await fetch(`${gatewayBase}/collaborations/setup/slack`, { headers });
  const setup = await responseJson(response, "Slack manifest lookup");
  console.log(JSON.stringify(setup.manifest, null, 2));
  process.exit(0);
}

if (command === "status") {
  const response = await fetch(`${gatewayBase}/collaborations`, { headers });
  const bridges = await responseJson(response, "bridge list");
  const slack = bridges.filter(bridge => bridge.bridge_type === "slack").map(bridge => ({
    bridge_id: bridge.bridge_id,
    display_name: bridge.display_name,
    status: bridge.status,
    room_count: bridge.room_count,
  }));
  console.log(JSON.stringify(slack, null, 2));
  process.exit(0);
}

if (command !== "connect") throw new Error("usage: node scripts/connect-slack.mjs [manifest|connect|status]");

const slackEnvFile = process.env.NIGHTSHIFT_SLACK_ENV || resolve(root, "ops/slack.env");
let slackEnv;
try {
  const mode = statSync(slackEnvFile).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`${slackEnvFile} must be private; run chmod 600 ${slackEnvFile}`);
  slackEnv = parseEnv(readFileSync(slackEnvFile, "utf8"));
} catch (error) {
  if (String(error).includes("must be private")) throw error;
  throw new Error(`cannot read ${slackEnvFile}; copy ops/slack.env.example to ops/slack.env and chmod 600`);
}

const botToken = slackEnv.SLACK_BOT_TOKEN ?? "";
const appToken = slackEnv.SLACK_APP_TOKEN ?? "";
if (!botToken.startsWith("xoxb-") || !appToken.startsWith("xapp-")) {
  throw new Error("SLACK_BOT_TOKEN must start xoxb- and SLACK_APP_TOKEN must start xapp-");
}

const checkedResponse = await fetch(`${gatewayBase}/collaborations/setup/slack/check`, {
  method: "POST", headers, body: JSON.stringify({ bot_token: botToken, app_token: appToken }),
});
const checked = await responseJson(checkedResponse, "Slack credential check");
const displayName = slackEnv.SLACK_DISPLAY_NAME || `${checked.workspace_name} Slack`;

const listResponse = await fetch(`${gatewayBase}/collaborations`, { headers });
const bridges = await responseJson(listResponse, "bridge list");
const existing = bridges.find(bridge => bridge.bridge_type === "slack" && bridge.display_name === displayName);
if (existing) {
  console.log(JSON.stringify({ ok: true, existing: true, bridge_id: existing.bridge_id, display_name: existing.display_name, status: existing.status }, null, 2));
  process.exit(0);
}

const createResponse = await fetch(`${gatewayBase}/collaborations`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    bridge_type: "slack",
    display_name: displayName,
    connection_config: {
      bot_token: botToken,
      app_token: appToken,
      workspace_id: checked.workspace_id,
      agent_usergroups: slackEnv.SLACK_AGENT_USERGROUPS === "true",
    },
    set_as_default: false,
    channel_creation_enabled: true,
  }),
});
const bridge = await responseJson(createResponse, "Slack bridge creation");
console.log(JSON.stringify({ ok: true, existing: false, bridge_id: bridge.bridge_id, display_name: bridge.display_name, status: bridge.status, workspace: checked.workspace_name }, null, 2));
