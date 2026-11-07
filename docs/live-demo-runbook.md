# Night Shift live demo runbook

Use this runbook for the submission recording. The rehearsal is deterministic,
posts through the real Switch room, and labels every message `[scripted demo]`.
It uses an isolated temporary Git remote and does not mutate `target/` or the
production ledger.

## Presentation tabs

Open these in this order:

1. Landing page: <http://127.0.0.1:4173/landing/>
2. Mattermost: <http://127.0.0.1:8065/> — open `overnight-crew`
3. Switch Gateway: <http://127.0.0.1:3100/>
4. GitHub repository: <https://github.com/shashwat558/night-shift>

If Mattermost asks you to sign in, use the configured demo user. Its email and
password are stored locally as `MATTERMOST_USER_EMAIL` and
`MATTERMOST_USER_PASSWORD` in `ops/.env`; never show that file while recording.

## Start the environment

From the repository root:

```sh
docker compose -f ops/standalone-docker-compose.yml \
  --profile collab --profile gateway up -d --wait

npm run build --prefix supervisor
node supervisor/dist/src/main.js
```

In a second terminal, start the landing page:

```sh
python3 -m http.server 4173
```

The supervisor is ready when its terminal says `connection UP` and
`listening for "tonight: …" messages`.

## Run the showpiece

Keep Mattermost visible, then run:

```sh
node demo/run.mjs demo/night.yml --live
```

The terminal finishes in a few seconds. The room receives the complete story:

1. One overnight goal and three bounded slips.
2. Real target tests, receipt validation, and draft demo PR results.
3. An independent reviewer challenge for a protected migration.
4. A genuine shared-file collision and negotiated landing order.
5. One exact-commit approval, one policy rollback, and one approval invalidated
   after rebase.
6. Refreshed evidence, the second merge, and a ledger-derived morning report.

## Recording order

- Begin on the landing page while delivering the personal hook.
- Move to Mattermost and show that the goal, agents, reviewer, gates, and report
  all occupy one Switch room.
- Run the live demo and pause on the protected-path decision card.
- Pause again on `approval expired` to explain exact-SHA binding.
- Finish on the morning report, then show the green verifier:

  ```sh
  ./scripts/verify.sh --offline
  ```

- Return to the landing-page headline for the closing line.

## Safe reset

The demo can be run again without cleaning the target repository. A second run
creates a new temporary Git environment and posts another clearly marked block
to the room. Avoid rerunning it immediately before recording unless you want two
copies in the channel.

To stop the local services after recording:

```sh
docker compose -f ops/standalone-docker-compose.yml \
  --profile collab --profile gateway down
```
