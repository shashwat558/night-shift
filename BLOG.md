<!--
SEO title: How I Built a Multi-Agent AI Engineering Team with Switch
Meta description: I built Night Shift with Switch Rooms: a multi-agent AI engineering crew that creates PRs, runs tests, handles collisions and waits for human approval.
Suggested slug: /multi-agent-ai-engineering-team-switch-night-shift
Primary query: how to build a multi-agent AI team with Switch
Secondary queries: Switch AI tutorial, AI coding agent collaboration, multi-agent software development, Switch Rooms example
Social title: I Made My AI Agent Work With My Whole Team—and Other Agents Too
Suggested OG image: 1200x630 screenshot of the Night Shift Switch room showing agents, a decision card and the morning report
Suggested hero alt text: Night Shift multi-agent AI engineering crew collaborating in a Switch room
-->

# How i built a multi-agent AI engineering team with Switch

*or: i made my agent have a polygamy relationship with my team and how you can too*

> **Quick answer:** i used [Switch Rooms](https://www.switchagents.ai/) and its agent protocol to build **Night Shift**, a multi-agent AI engineering crew. a night lead plans work, coding agents create tested pull requests, a supervisor checks evidence and file collisions, humans approve important actions, and the team receives a 9 AM report in one shared room.

**Night Shift at a glance:**

- **Problem:** AI coding agents work quickly but leave humans carrying context between private chats.
- **Solution:** put humans, specialist agents, approvals and evidence into one Switch room.
- **Stack:** Switch Core, Mattermost, TypeScript, GitHub, Codex or OpenCode, Docker and an append-only ledger.
- **Result:** a repeatable demo night with two merged changes, one policy rollback and one collision resolved safely.
- **Source code:** [explore the Night Shift multi-agent engineering project on GitHub](https://github.com/shashwat558/night-shift).

working with agents sometimes gets lonely. you are just there to approve the permission it asks you for and then it drifts off doing its work. You take tasks from your team and pass them down to your agent, and your team is probably doing the same.

and to be honest, i really got fed up with this. telling the agent what my team wants, waiting for it to finish, sending updates back to my team, waiting for them to review it and then going back to the agent again with changes.

at some point i realized i was not even doing the actual work anymore. i was just acting like a delivery boy between my team and my agent.

and the funny thing is that we are using AI agents to save time, but somehow spending that saved time explaining to other people what the agent did.

imagine you have a team of five developers and everyone has their own coding agent. one is using Claude Code, another is using Codex, somebody is using OpenCode and everyone is doing their own thing. sure, everyone is shipping code faster individually, but when it comes to working together, we are still doing the same old copy pasting.

**we made agents smarter but forgot to make them work together.**

to overcome this i made up my mind and thought now is the time to convert a restaurant into a cool food truck with multiple cooks.

instead of everyone sitting in their own private kitchen, why not bring all the cooks into one place where they can talk to each other, share ingredients, prepare orders and let the owner see what the heck is happening?

and that is where things started getting interesting.

## Why i chose Switch for AI agent collaboration

understanding more about this product made me realize this was exactly what i was looking for.

Switch lets companies manage, track and talk to their AI agents in one organized place. imagine Slack or Discord, but now instead of just your teammates talking about bugs and deadlines, your agents are also there doing the actual work.

and the best part is that you don't have to build some new fancy agent or force everyone on the team to use the same model.

your teammate can bring Claude Code, you can bring Codex, another person can bring OpenCode and all of them can work together in the same room.

Switch doesn't ship its own AI model or try to replace the messaging app your team already uses. it connects the agents you already have with the people who actually need their work.

as teams start using lots of different AI agents individually, things tend to get messy over time. different chats, different instructions, no shared context and nobody really knowing what the other agent is doing.

Switch solves this by working like the owner of a food truck who manages the workforce, makes sure everyone is using the same recipe, and keeps track of the bills and costs.

but reading about it was not enough for me. i wanted to see whether this idea could handle an actual engineering workflow.

so i built **Night Shift**.

## What is Night Shift, the multi-agent AI engineering crew?

Night Shift is an overnight engineering crew made of AI agents.

the idea came from a simple problem: coding agents can create a pile of pull requests while everyone is sleeping, but producing code is not the same as producing code that a team can safely merge.

in the morning somebody still has to ask:

- what was the original goal?
- which agent changed which file?
- did the tests really pass?
- did two agents edit the same thing?
- who approved the pull request?
- and why did the agent touch a production migration at 3 AM?

if the answers are spread across private agent chats, terminal windows and GitHub tabs, then our food truck is back to having five separate kitchens.

Night Shift puts the whole overnight process inside one Switch room.

a human gives the crew one goal. a night-lead turns it into small taskslips. worker agents take the slips, a supervisor runs the coding work and opens draft pull requests, and every result comes with receipts. if two tasks touch the same file, the workers negotiate the order. nothing merges until the tests are green and a human approves it. at 9 AM, the room gets one report explaining what merged, what rolled back and what still needs attention.

the flow looks like this:

**Human:** tonight: fix the pet API validation, pagination and missing error handling.

**Night lead:** breaks the goal into bounded taskslips with allowed files, acceptance criteria and a time budget.

**Worker 1 and Worker 2:** acknowledge their work and make claims when their tasks collide.

**Shift supervisor:** creates branches, runs a headless coding agent, executes the real tests, opens draft PRs, checks receipts and posts the results back into the room.

**Human:** approves, holds or rolls back each task from the same conversation.

**Shift supervisor:** posts the final morning report from an append-only ledger.

that was the food truck i wanted from the beginning. everyone has a job, everyone can see the order and nobody has to carry messages between buildings.

## How did i use Switch Rooms to build Night Shift?

the first thing i used was a Switch room called `overnight-crew`.

i connected it to Mattermost, which comes with the local Switch setup, and added three agent identities: a night lead and two workers. i also added my own protocol agent called `shift-supervisor`.

the night lead is allowed to respond to humans because it needs to receive the goal. the two workers use more restricted addressing because they are supposed to wake up only when another crew agent assigns work. this stopped the room from turning into four bots replying to every random message.

i described these roles in a reusable crew template. the template contains the room name, agent names, provider choice, working directory, instructions and kickoff message. this means another team can create the same crew without manually explaining every job again.

and this is where the shared room context became important.

the instructions did not belong only to Codex or only to OpenCode. the recipe belonged to the room and the repository. the agents could change, but the taskslip format, receipt rules and approval process stayed the same.

i defined a taskslip as a small work order containing:

- the task ID and backlog reference
- a short scope
- the exact files the worker is allowed to change
- testable acceptance criteria
- an assignee
- and a time budget

the worker's result also had to follow a receipt format. it included the real files touched, PASS or FAIL, the raw tail of the test log, a risk call, any deviation from the taskslip and the time spent.

the important word here is **raw**.

an agent saying “tests passed” is not proof. Night Shift runs the tests itself and places the actual output in the receipt. if a field is missing, the pull request becomes `needs-eyes`. if the receipt says FAIL, it cannot merge even if the explanation sounds very confident.

Switch carried the conversation, but i wanted the supervisor to react to room events instead of polling chat like an impatient human.

so i connected `shift-supervisor` through the Switch agent protocol. room events arrive through a WebSocket connection, and the supervisor sends its messages and actions back through HTTP operations. it stores its cursor so it can reconnect without treating old messages as new work.

this part taught me that connecting an agent is not just “send text to a model.” the supervisor had to answer heartbeat pings correctly, resume after disconnects, avoid duplicate connections and remember which Switch room started a command.

once the connection was stable, a human could post:

`@shift-supervisor tonight: finish these three petshop backlog tasks`

the supervisor would wake the night lead, wait for the taskslips, assign them, start a bounded coding run and report every draft PR in the same room.

no private chat. no copying the agent's summary into Mattermost. no teammate asking me which branch the agent used.

### Why is Night Shift more than a Slack or GitHub bot?

at first the project can sound like a bot which posts GitHub notifications into a chat room.

but a notification bot only tells you that something already happened. Night Shift uses the room as the place where the work is coordinated and where the important decisions are made.

the original goal enters through the room. the lead receives it there. assignments, worker acknowledgements and collision claims happen there. the human's approval or rollback command comes from there. the final report returns there.

the supervisor also remembers which room started the task. this matters because the same agent can serve more than one room without posting a private project's result into the wrong team's conversation.

GitHub still handles branches, pull requests and CI. the coding provider still writes the code. Mattermost still gives the human a chat interface. Switch is the layer which makes all of them behave like one team instead of a pile of unrelated tools.

that separation also made the system easier to reason about.

the model is responsible for proposing code. deterministic code is responsible for checking allowed files, running tests, measuring time and enforcing policy. the human is responsible for the final decision. Switch is responsible for making that process visible and carrying each handoff to the correct participant.

no single cook is secretly running the entire restaurant.

## How does Night Shift keep AI coding agents safe overnight?

getting multiple agents into one room was the fun part. making sure they did not burn down the kitchen was the serious part.

Night Shift has a repository policy file which says how many files a task may change, how long it may run, which paths require review and which paths are completely blocked during the night.

for example, changes under `migrations/**`, `.github/workflows/**` and `infra/production/**` cannot pass the overnight gate. auth and payment files require extra review.

i then added an independent reviewer which compares the worker's receipt with the actual pull request diff, CI status and repository policy. the supervisor posts a small decision card into the Switch room showing the commit, evidence fingerprint, policy result and reviewer result.

this matters because green tests are necessary, but they are not enough.

in my demo, one agent produced a migration which passed its tests. a normal “tests are green, ship it” bot might have merged it. Night Shift refused it because migrations were blocked by the repository policy, and the room showed the exact reason.

i also bound every approval to the exact commit that was reviewed.

if the branch changes after the human approves it, the old approval expires. the evidence runs again and a new decision card must be posted. the production path even asks GitHub to merge only if the branch head still matches that reviewed commit.

this avoids a very uncomfortable situation where a human approves one version of the code and the agent quietly pushes another version before merging.

all important events are added to an append-only JSONL ledger: goals, assignments, receipts, policy results, human decisions, merges, rollbacks, collisions and reports.

the room is what humans read. the ledger is what the system can replay without trusting a friendly chat summary.

## How do multiple AI coding agents resolve file collisions?

i did not want the project to look good only when every agent worked on completely separate files. real teams collide.

so i deliberately gave two workers tasks that touched the same file.

the supervisor inspected the actual branch diffs and found the overlap. it then opened a collision conversation in the Switch room and asked both workers to state their claim.

the workers agreed that the first change should land before the second one. the supervisor recorded that order, merged the first task, rebased the second task and ran the tests again.

the rebase changed the second branch's commit, so its earlier approval became stale. Night Shift rejected that approval, generated fresh evidence and only then allowed the second task to merge.

this little sequence ended up showing almost the whole reason Switch was useful:

- both agents could see the same problem
- the decision happened in the shared room
- the human could follow it without becoming the messenger
- the supervisor could enforce the agreed order
- and the final result remained recorded for the morning report

the agents were not simply sitting next to each other in a chat. they were participating in one visible workflow.

## How did i build and test the Switch agent workflow?

i built Night Shift in phases because trying to create the entire food truck in one command sounded like a good way to set it on fire.

first, i started the local Switch stack with Docker and verified the smallest possible loop: a human posted a message in Mattermost, Switch delivered it to an agent, and the agent's reply appeared back in the room.

then i provisioned the night lead and workers from the crew template and rehearsed their addressing rules. the night lead answered the human, the workers answered the lead, and unaddressed messages stayed quiet.

after that i built the TypeScript supervisor. it has no runtime npm dependencies. it handles the Switch connection, parses taskslips, launches headless workers, checks Git diffs, runs tests, creates pull requests, validates receipts, enforces gates and writes the ledger.

next came the human commands:

- `approve <task-id>` merges only when the receipts are complete and CI is green
- `rollback <task-id> <reason>` closes the PR, deletes its branch and records why
- `hold <task-id>` keeps the PR as a draft
- `inspect <task-id>` checks the live PR without changing it
- `shift report please` builds the current report

i originally liked the idea of approving work with emoji reactions. while testing the pinned Switch version, i found that human reaction events were not exposed to agents. instead of going around Switch and polling Mattermost directly, i kept the workflow inside the agent protocol and used typed commands.

that is one of those details that never appears in the nice architecture diagram, but it matters when you are building the real thing.

i also found connection problems. one scratch client reused the live supervisor's connection ID and Switch correctly evicted the old connection. another issue came from WebSocket heartbeat frames: replying with the wrong kind of pong caused the supervisor to disconnect after roughly 40 seconds. both problems became regression tests.

finally i added the 9 AM report. it does not ask a model to remember what happened. it deterministically reads the ledger and lists merged PRs, rollback reasons, blocked work, receipt gaps, worker statistics and one recommendation.

when i triggered it in the live room, the supervisor posted the report in around half a second. asking again reused the same report instead of posting duplicates.

## What happened during the Night Shift multi-agent demo?

for the final demo i created three tasks:

1. a clean change which should merge
2. a protected migration which should be rolled back
3. a change which collides with the first one and must rebase

the demo created isolated Git branches, ran the real target test suite, rendered the same receipts used by the production path and posted the whole story through the live Switch room.

the clean task merged. the migration had green tests but failed policy and rolled back. the colliding task negotiated its order, rebased, lost its stale approval, got reviewed again and then merged.

the final report showed two merges and one rollback.

the fast rehearsal is deterministic and clearly labels its messages as a scripted demo. it does not pretend that a model autonomously reasoned through every step. separate live rehearsals created real GitHub draft PRs, handled real human gate commands and merged the collision pair in the agreed order.

this honesty was important to me. an agent system which lies about what the agent actually did is already failing its own trust test.

if you want to inspect the implementation instead of trusting my summary, the repository includes the [Night Shift architecture](https://github.com/shashwat558/night-shift/blob/main/ARCHITECTURE.md), [live demo runbook](https://github.com/shashwat558/night-shift/blob/main/docs/live-demo-runbook.md), [trust-control rehearsal](https://github.com/shashwat558/night-shift/blob/main/docs/phase-7-live-test.md) and [credential-free room transcripts](https://github.com/shashwat558/night-shift/tree/main/docs). the main [Night Shift README and setup guide](https://github.com/shashwat558/night-shift#readme) explains how to reproduce the project.

### What problems did i encounter while building it?

the build was not one magical prompt where i asked an agent to “make a multi-agent company” and came back after lunch.

during the live rehearsals, some provider accounts ran out of free usage or did not have enough balance. for those phases, i prepared the scoped code with Codex and clearly recorded the assistance in the pull-request receipts and evidence documents. the Switch workflow, test runner, gates, GitHub actions, collision detection and room messages were still exercised for real, but i did not pretend the unavailable worker had written code it did not write.

the first crew kickoff also happened before the agent connectors were listening, so the room showed an offline response. later rehearsals started the runtimes before the goal.

and because the version i used did not expose human reactions to protocol agents, the nice idea of clicking a checkmark emoji became a typed approval command. honestly, typed commands ended up being less cute but more explicit. the ledger can record exactly who approved which task and why a rollback happened.

these limits made the project better. every annoying failure became either a documented boundary, a regression test or a safer rule.

by the end, the supervisor test suite covered the taskslip parser, receipts, connection recovery, budget cancellation, approval refusals, rollbacks, collision order and report replay. the full offline verifier could then run the complete deterministic story without spending model credits or depending on a network request.

that was useful for the demo, but it is also useful for a real team. agent workflows should not become impossible to test just because the model provider is having a bad day.

## Why is Switch central to Night Shift?

Switch is not just a notification wrapper in Night Shift.

it owns the shared room, agent identities, addressing, ordered events, connection transport and the human approval conversation. goals, assignments, collision claims, decisions and the morning report all pass through Switch.

remove the coding model and you can replace it with another provider.

remove Switch and the crew loses its shared world.

that difference is what made the project interesting to build.

the same supervisor can use OpenCode or Codex as its headless worker. changing the model does not change the receipts, repository policy or human gate. the team workflow stays stable even when the cook changes.

and because Switch can bridge messaging apps such as Slack, Discord, Teams, Telegram and Mattermost, the humans do not need to move into yet another private AI interface. Night Shift used Mattermost for the local build, but the room is the important part, not the logo on the chat app.

## How do Switch Rooms, Trust and ROI relate to Night Shift?

Switch has three main product areas: Rooms, Trust and ROI.

**Switch Rooms** is the part i directly built Night Shift on. it brought the humans, agent roles, instructions and project conversation into one place.

**Switch Trust** is designed to discover, scan, evaluate and monitor agents. it can look for risky permissions, prompt injection, leaked secrets, personal information and dangerous tool calls. this is especially useful when a company has agents spread across repositories and cloud environments.

Night Shift currently has its own repository-level trust controls for pull requests. it checks diffs, receipts, CI, blocked paths and exact commits. that is not the same as claiming i integrated the separate Switch Trust product. the two ideas fit together, though: Switch Trust can help govern the agent itself, while Night Shift governs what an overnight coding task is allowed to merge.

**Switch ROI** helps teams understand what agents cost and where tokens are being wasted. it can point at expensive model choices, unused tools, repeated context, long responses and retry loops.

Night Shift already records time budgets and per-worker outcomes, but it does not yet send a full cost pipeline into Switch ROI. that would be a natural next step. the morning report could show not only which worker completed a task, but what that result cost and whether a cheaper model could have handled it safely.

and the safely part matters.

**a cheaper agent that keeps breaking everything isn't really saving you money.**

## What would i add to the project next?

Night Shift already proves that the room can coordinate a complete overnight workflow, but there are a few obvious directions i would take it next.

first, i would connect the ledger and provider usage to ROI reporting. right now the morning report knows a worker's time budget and result. adding token and model cost would let the team compare cost with successful, rolled-back and blocked work instead of looking at one giant provider bill.

second, i would connect broader agent evaluations through Switch Trust. the repository gate can tell me that a migration is blocked, but an agent-level evaluation can test things such as prompt injection, unsafe tool access and secret handling before that agent joins the overnight crew.

third, i would add more team rooms. one room could handle small bug fixes, another could review dependency updates and another could prepare documentation. the same supervisor could participate without mixing their instructions or reports.

but i would keep the same rule: new automation must make the evidence clearer, not simply make the agents talk more.

## How can you build your own multi-agent AI team with Switch?

you do not need to build an overnight pull-request supervisor just to try this style of work.

start small:

1. **Install Switch Console.** Get the desktop app from the [official resources](https://www.wemakedevs.org/hackathons/switch/resources). for a local deployment, Docker runs the required services.

2. **Connect the agent you already use.** Bring Claude Code, Codex, OpenCode or another supported provider. Switch does not require everyone to use the same model.

3. **Connect one messaging app.** You can use Slack, Teams, Discord, Telegram or Mattermost. Mattermost is convenient for local experiments because it can run with the Switch stack.

4. **Create one room with a clear job.** Do not create a general room where five agents can do anything. give the room a purpose, instructions and a small set of roles.

5. **Define the handoff.** Decide what one agent gives to another. in Night Shift that handoff is a taskslip and the return value is a receipt.

6. **Keep a human gate.** Let agents prepare, test and review the work, but require a person for important actions such as merging or deploying.

7. **Try one boring task first.** a pull request review, a small bug or a missing test is enough. make sure the whole team can see what happened before giving the agents anything dangerous.

if you want to connect a custom agent, Switch provides an agent protocol for receiving room events and sending responses and operations back. the agent can run on your laptop, a teammate's machine or a server, as long as it is connected and has the right permissions.

and remember that a room reference is not a magic credential. telling an agent which GitHub repository matters does not automatically give it access. the agent still needs its own properly scoped credentials.

## When does a team actually need multi-agent collaboration?

i think this is a fair question.

if you are one developer using one coding agent and nobody else needs to see what it is doing, you probably do not need to turn your workflow into a food truck.

your private kitchen is doing just fine.

but things change when multiple people and agents work on the same project. context becomes a problem, communication becomes a problem, security becomes a problem and after some time the bill also becomes a problem.

that is the part i find interesting about Switch.

it does not try to make your agent more intelligent by giving it another giant model. it tries to solve the problems around the agent: shared context, visible work, permissions, handoffs and human decisions.

building Night Shift made this much clearer to me.

the hardest part was not asking a model to write an Express route. the hard part was deciding who could ask it, what it was allowed to touch, how another agent could challenge it, what counted as evidence and when a human approval should stop being valid.

those are team problems, not model problems.

Switch is not going to make a bad agent suddenly write perfect code. the agents still need the correct access, they still need to be online, and someone still needs to review important work.

but at least when something goes wrong, the team has one shared place to see what happened and fix it.

## Frequently asked questions about Switch and multi-agent AI teams

### What is Switch AI?

Switch is a collaboration and management layer for AI agents. it lets teams bring agents into shared rooms connected to messaging apps, keep project context visible and control how humans and agents interact. it works with existing agent providers instead of requiring every teammate to use one model.

### Can Claude Code, Codex and OpenCode work in the same Switch room?

yes. Switch Rooms can bring agents backed by different providers into the same team conversation. each agent still needs its own runtime, credentials and permissions. in Night Shift, the coding worker can use Codex or OpenCode without changing the taskslip, receipt or human-approval workflow.

### What is Night Shift?

Night Shift is an open-source, Switch-native multi-agent software development workflow. a human gives an overnight goal, a lead creates scoped taskslips, coding workers prepare tested pull requests, a supervisor checks policy and evidence, and the room receives a deterministic morning report.

### Does Switch write or merge the code itself?

no. the connected coding agent writes the proposed code, while Git and GitHub manage branches, pull requests and CI. Switch provides the shared room, identities, addressing and event transport. Night Shift's supervisor coordinates those tools and refuses a merge until its evidence and human-gate rules pass.

### How does human approval work in Night Shift?

a human sends a typed `approve`, `hold`, `rollback` or `inspect` command in the Switch room. approval is allowed only when receipts are complete, CI is green, policy passes and the reviewed commit still matches the branch. if the branch changes, the old approval expires.

### Does Night Shift use Switch Trust and Switch ROI?

Night Shift directly uses Switch Rooms and the Switch agent protocol. it currently implements its own repository-level trust controls and time budgets; it does not claim a direct Switch Trust or ROI integration. connecting those products for wider agent evaluation and cost reporting is a future direction.

### Is Night Shift open source?

yes. the complete [Night Shift source code, setup instructions and test evidence are available on GitHub](https://github.com/shashwat558/night-shift). Switch Rooms is also available through the [Switch GitHub repository](https://github.com/sandbox-quantum/switch).

## The future of AI agents is agents working together

we have already reached a point where almost every developer has some kind of AI assistant or coding agent helping them.

but most of these agents are still working alone.

one agent writes the code, another agent reviews something else, a human copies the response between them and somehow we call it automation.

i don't think that is how working with agents should look in the long run.

we do not really need 50 more cooks working in 50 different kitchens.

we need a food truck where everyone knows what they are cooking, what order came in, who is responsible for what and when the owner needs to step in.

Night Shift is my attempt at building that food truck for overnight engineering work.

Switch gave the crew a shared room. the taskslips gave them clear orders. the receipts gave the team evidence. the policy and human gates kept dangerous work from silently landing. and the morning report meant nobody had to wake up and reconstruct the night from five private chats.

**the goal isn't to have an agent that works for you. it's to have agents that can work with everyone.**

so yeah, i guess my agent is not in an exclusive relationship with me anymore.

it can talk to my teammates, collaborate with other agents and work in different rooms.

and surprisingly i am completely fine with this polygamy.

as long as everyone is shipping code and nobody burns down the kitchen.

---

you can explore [Switch AI](https://www.switchagents.ai/), follow its [quickstart documentation](https://docs.switchagents.ai/switch-rooms/getting-started), check out the [Flip the Switch Hackathon](https://www.wemakedevs.org/hackathons/switch), or view the [Night Shift source code](https://github.com/shashwat558/night-shift).

*because maybe the next big productivity improvement isn't another AI agent. it's finally letting the ones we already have talk to each other.*
