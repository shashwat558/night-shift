# Screenshots

## phase 1 — overnight-crew rehearsal

Not captured as images. The Mattermost login wall of this standalone deploy
has no credential-free path for an agent-driven browser: session cookies are
issued HttpOnly by `POST /users/login`, and pasting a token or password into
a tool-visible value would print a secret. Hard rule 4 (truth over optimism)
beats it: the machine truth for this phase is the raw post log in
[../rehearsal-transcript.md](../rehearsal-transcript.md), pulled from
`GET /channels/<id>/posts` — the same feed the room renders. On demo day
(human-run, phase 6), the room will be captured with the judge's own browser.
