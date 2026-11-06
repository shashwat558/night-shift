# Messaging apps

Night Shift talks only to Switch. Slack, Discord, Teams, Telegram, and
Mattermost are Switch collaboration bridges, so every platform uses the same
receipts, policy, GitHub gates, and ledger.

## Slack quickstart

Switch Core already contains the Slack adapter. It uses outbound Socket Mode;
there is no Slack container and no public callback URL is required.

1. Start the existing Docker stack:

   ```sh
   docker compose -f ops/standalone-docker-compose.yml \
     --profile collab --profile gateway up -d --wait
   ```

2. Print the exact Slack app manifest for this Switch version:

   ```sh
   node scripts/connect-slack.mjs manifest
   ```

   In Slack API, create an app from that manifest. Generate an app token with
   `connections:write`, install the app, and copy its `xapp-` and `xoxb-`
   tokens.

3. Store the credentials locally:

   ```sh
   cp ops/slack.env.example ops/slack.env
   chmod 600 ops/slack.env
   ```

   Fill `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`. The real file is git-ignored.

4. Connect idempotently:

   ```sh
   node scripts/connect-slack.mjs connect
   node scripts/connect-slack.mjs status
   ```

   The connector validates both tokens with Slack through the live Gateway,
   derives the workspace id, refuses a world-readable secrets file, never
   prints tokens, and does not duplicate an existing named bridge.

5. In Slack, `/invite @Agent Switch` into the desired channel, then run
   `/invite-agent @shift-supervisor` there. Add the room UUID shown in Switch
   Console to `SWITCH_ROOM_IDS` in `supervisor/.env`:

   ```env
   SWITCH_ROOM_ID=<primary-mattermost-room>
   SWITCH_ROOM_IDS=<primary-mattermost-room>,<slack-room>
   ```

   Rebuild and restart the supervisor. Replies, decision cards, goals, and
   gate results return to the room that issued the command; scheduled reports
   continue to use the primary room.

## Other platforms

The same Switch Gateway exposes `discord`, `telegram`, and `teams` bridge
types. Discord and Telegram also connect outbound. Teams requires a public
HTTPS endpoint and Microsoft Entra/Azure Bot configuration. Add their room
UUIDs to `SWITCH_ROOM_IDS`; Night Shift itself needs no platform SDK.

Do not connect chat platforms directly to the supervisor with webhooks. That
would bypass Switch addressing, identity, ordered history, and the trust audit
trail.
