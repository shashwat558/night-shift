# Night Shift demo shot list and submission checklist

Primary track: **Best Business Workflow**. Night Shift is a practical workflow
for a person and AI agents to ship reviewed engineering work through Switch.
Optional side tracks (`Best Blog`, `#HowISwitch`) should be selected only if
the corresponding article or social post is actually submitted.

Official deadline: **November 7, 2026 at 11:59 PM IST**. The event requires
the repo, demo video, and README before that cutoff:
https://www.wemakedevs.org/hackathons/switch/schedule

## Rubric-mapped recording

Target length: 3–4 minutes. Use terminal and raw room transcript evidence;
do not imply autonomous work where the evidence says assisted or scripted.

| Time | Shot | Narration point | Rubric |
| --- | --- | --- | --- |
| 0:00–0:20 | README problem statement | Overnight AI output is easy; trustworthy morning decisions are hard. | Creativity and impact |
| 0:20–0:45 | Mattermost `overnight-crew` plus Switch Gateway | Switch owns the room, identities, addressing, and event transport. | Use of Switch |
| 0:45–1:15 | Run `node demo/run.mjs demo/night.yml --live` | One bounded goal becomes three slips; every demo post is visibly labelled. | Technical execution |
| 1:15–1:50 | Green migration receives a reviewer challenge and policy-blocked decision card | Tests alone are insufficient; repo policy names protected work. | Business workflow |
| 1:50–2:25 | Collision prompt, agreed order, then “approval expired” after rebase | The supervisor checks actual diffs, binds review to a SHA, then requires refreshed evidence. | Use of Switch / execution |
| 2:25–2:50 | Final ledger-derived report | Two merged, one rolled back, worker trust and recommendation are replayable. | Impact / execution |
| 2:50–3:20 | `./scripts/verify.sh --offline` and evidence links | Fresh-clone commands, deterministic fixtures, and honest limitations. | Reproducibility / presentation |

## Capture checklist

- [ ] Hide `ops/.env`, `supervisor/.env`, API keys, cookies, and terminal history containing secrets.
- [ ] Start with all four services healthy and the supervisor connected.
- [ ] Keep `[scripted demo]` visible on rehearsal posts.
- [ ] Show the exact receipt PASS, rollback reason, shared path, landing order, and final totals.
- [ ] Keep the blocked-path finding, commit SHA, evidence fingerprint, and expired-approval message readable.
- [ ] Show the verifier's final green line without cutting away from failures.
- [ ] Use the transcript files under `docs/` for machine truth; do not claim browser screenshots as evidence.
- [ ] State the provider-availability and assisted-preparation limitations aloud.

## Submission checklist

- [ ] Registration/team details are correct (solo or up to four people).
- [ ] Track selected: **Best Business Workflow**.
- [ ] Optional categories/side tracks selected only when their extra artifact exists.
- [ ] Public repo URL points to the final `phase/6` commit and tag.
- [ ] README quickstart and architecture render correctly on GitHub.
- [ ] Public demo video link opens without requesting access.
- [ ] Submission includes the repo URL, demo video, and README.
- [ ] No secrets or private user data appear in repository history, video, or transcripts.
- [ ] Final `./scripts/verify.sh --offline` output is green from a fresh clone.
- [ ] Submit before **November 7, 2026 at 11:59 PM IST**.
- [ ] Re-open the submitted entry once and verify every link.
