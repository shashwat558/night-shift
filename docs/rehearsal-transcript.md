# Overnight-crew rehearsal transcript — phase 1 (2026-11-02)

Room: `overnight-crew` (id `343069f7-3114-41be-ac5f-fb85661ec909`), bridged
room on the bundled Mattermost. Senders: `user(human)` is the deployer's
Mattermost account, `admin(system)` is system chatter, the three `bridge:`
actors are the agents' Mattermost personas created by the Switch bridge
(full ids in `ops/.agents/crew-state.json`, never printed). Raw post log
pulled from the Mattermost API; nothing below is paraphrase.

## The rehearsal proper

| time (UTC) | sender | message |
| --- | --- | --- |
| 19:53:24 | bridge (gateway, "on behalf of @user") | Template kickoff: "@nightshift-night-lead @nightshift-worker-1 @nightshift-worker-2: this is your overnight crew room. Night-lead, introduce yourself in one line …." |
| 19:53:24–25 | all three bridge personas | "@user I'm currently offline — my connector isn't reporting in. I'll respond once it reconnects." (managed-agent stand-ins; the rehearsal runtimes were not listening yet — recorded as delta below) |
| 19:59:50 | user(human) | "@nightshift-night-lead status check: hearing you?" |
| 20:00:02 | night-lead | "Hearing you loud and clear — night-lead standing by, no goals or taskslips in hand yet, awaiting decomposition work." |
| 20:00:14 | night-lead | "@nightshift-worker-1 @nightshift-worker-2 — kickoff's done, wake up and drop a one-line intro of who you are so the room knows you're on for the night." |
| 20:00:25 | worker-1 | "nightshift-worker-1 on shift: I ack slips and hold claims to what I actually ran — no spurious output." |
| 20:00:26 | worker-2 | "nightshift-worker-2 here, on shift for the night: I ack slips in one line and wait, claim one file per collision round with a reason, and never post a receipt for work I didn't run." |

The two worker lines and the two night-lead lines are all distinct (the
runtimes answer through `opencode run`, decision D1 — the words are the
agents' own); diff-check: 4 reply strings, 4 unique.

## Addressing rules, demonstrated

- **night-lead (`anyone`)** answers a user-posted mention (19:59:50 → 20:00:02,
  20:01:31 → 20:01:41, and again at 20:02:00). Demonstrated 3 times.
- **workers (`owner-agents`)** reply only after the night-lead's agent-authored
  cue (20:00:14 → 20:00:25/26) — a direct user mention at 20:00:46
  ("@nightshift-worker-1 hey straight to you, ack?") delivered an ADDRESSED
  event, and the runtime refused it in-process ("owner-agents policy:
  user-class sender ignored"; log in run transmitter output, not paraphrase).
- **the quiet rule** held: an anonymous user post with no mention
  (20:00:46 "hello, is anyone awake here?") produced no replies from any of
  the three (all see `not-addressed`).

## Setup facts this run establishes

- Room provisioned by the **Gateway's `POST /rooms/from-yaml` from this
  repo's template room block** — the room log at 19:53:24 shows "Template
  kickoff on behalf of @user", i.e. the server posted the template's
  `kickoff:` itself.
- Agents pre-existed (registered with the admin-created registration key,
  owned by admin, keys chmod 600 in `ops/.agents/`, git-ignored); the
  template's `agents:` block describes them; addressing set through the
  Gateway per `crew/nightshift.template.yaml` (`anyone` for the lead,
  `owner-agents` rules for the workers).
- Rehearsal runtimes: `supervisor/dev-tools/crew-rehearsal.mjs` per agent —
  the SSE compatibility transport (phase-2 gets the WebSocket client,
  PROJECT_LOG phase-0 delta 5), replies via `opencode run`, capped at 3
  replies per agent per run (`P1_REHEARSAL_MAX_REPLIES`).
- The room's rule wall comes from the template: room `instructions:` tell
  every member to stay quiet unless addressed.

## Deltas discovered in rehearsal (recorded, actioned)

1. **Gateway-run `from-yaml` on this build creates agents as managed
   stand-ins that "answer" before any connector runs** — the 19:53:24 fan of
   "I'm currently offline — my connector isn't reporting in" replies is the
   server's canned response while no runtime holds the agent. Once the
   runtimes connect, the real personas answer. Harmless noise at room birth;
   a live demo on judge day will start runtimes before posting the goal.
2. **Server-side addressing enforcement at event delivery** (the
   `owner-agents` symbolic subjects) is NOT observable on 0.31.0: a direct
   user mention of a worker arrived as an ADDRESSED event. The runtime's
   own policy check (persona rules read from the template) held the line.
   Recorded; the supervisor (phase 2) will enforce addressing itself the
   same way.
3. **Human-authored em-dash (`—`) posts return 403** ("You do not have the
   appropriate permissions") from this build's Mattermost REST endpoint;
   agent posts with the same character post fine, and hyphenated human
   posts `201`. Workaround: humans post without em-dashes via API. Root
   cause unknown (plugin mention handling), non-blocking for the night flow
   (agents author the substantive posts).
4. Streams churn: each agent's event stream reconnects shortly after a
   bounce (idle or reply) — the runtime reopens automatically and beats hold
   the connection. The phase-2 WS client will need reconnect-on-close plus
   result ordering; noted on the listener's spec (SPEC §5.3).

Run-through result: **phase-1 rehearsal checklist PASSED** — see
`crew/rehearsal.md` for the itemized tick list and `docs/screenshots/` for
the room view captured at the end of the run.
