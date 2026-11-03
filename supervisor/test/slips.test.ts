// test/slips.test.ts — the strict tiny parser, against the crew's own
// schema examples (crew/taskslip.schema.md § example + field rules).

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSlips } from "../src/slips.js";

const VALID = `slips:
  - id: B-20261103-01
    backlog_ref: BACKLOG-1
    title: Add input validation to POST /pets
    assignee: shift-worker-1
    scope: >-
      Validate POST /pets body: name required non-empty string,
      species optional one of cat/dog/bird. Return 400 JSON on invalid.
    files_allowed:
      - src/routes/pets.js
    acceptance:
      - POST /pets with empty name returns 400
      - POST /pets with species fish returns 400
      - existing tests still pass
      - new tests cover both failures
    time_budget_minutes: 20
    notes: >-
      BACKLOG-2 fixes this same file — expect a claim round if it goes
      out of order.
`;

test("the schema's own example parses exactly", () => {
  const r = parseSlips(VALID);
  assert.equal(r.ok, true, JSON.stringify(r.ok ? [] : (r as { errors: string[] }).errors));
  if (!r.ok) return;
  assert.equal(r.slips.length, 1);
  const s = (r.slips[0] as unknown) as { [k: string]: unknown };
  assert.equal(s.id, "B-20261103-01");
  assert.equal(s.backlog_ref, "BACKLOG-1");
  assert.equal(s.title, "Add input validation to POST /pets");
  assert.equal(s.assignee, "shift-worker-1");
  assert.match(s.scope as string, /Validate POST \/pets body/);
  assert.match(s.scope as string, /400 JSON on invalid\.$/, "folded scalar joins and strips");
  assert.deepEqual(s.files_allowed, ["src/routes/pets.js"]);
  assert.deepEqual(s.acceptance, [
    "POST /pets with empty name returns 400",
    "POST /pets with species fish returns 400",
    "existing tests still pass",
    "new tests cover both failures",
  ]);
  assert.equal(s.time_budget_minutes, 20);
  assert.match(s.notes as string, /BACKLOG-2/);
});

test("two slips in one night parse in order", () => {
  const r = parseSlips(
    VALID + `  - id: B-20261103-02
    backlog_ref: BACKLOG-3
    title: Fix the pagination off-by-one
    assignee: shift-worker-2
    scope: >-
      Fix safePage - 2 to safePage - 1 in the offset.
    files_allowed:
      - src/pagination.js
    acceptance:
      - GET /pets?page=2 returns page 2 items
    time_budget_minutes: 15
`,
  );
  assert.equal(r.ok, true, JSON.stringify(r.ok ? [] : (r as { errors: string[] }).errors));
  if (!r.ok) return;
  assert.equal(r.slips.length, 2);
  assert.equal(r.slips[1]?.title, "Fix the pagination off-by-one");
});

test("unknown field is a whole-file rejection", () => {
  const r = parseSlips(VALID.replace("    title: Add input validation to POST /pets\n", "    title: Add input validation to POST /pets\n    priority: high\n"));
  assert.equal(r.ok, false);
  assert.deepEqual((r as { errors: string[] }).errors.some((e) => e.includes('unknown field "priority"')), true);
});

test("missing required field is named exactly", () => {
  const r = parseSlips(`slips:
  - id: B-20261103-01
    backlog_ref: BACKLOG-1
    assignee: shift-worker-1
    scope: does the thing
    files_allowed: []
    acceptance:
      - works
    time_budget_minutes: 15
`);
  assert.equal(r.ok, false);
  assert.equal((r as { errors: string[] }).errors.join(" ").includes("missing required field(s): title"), true);
});

test("field law: illegal id, bad ref, budget range, empty acceptance rejected", () => {
  const cases: [string, string][] = [
    ["bad id", `slips:
  - id: task-one
    backlog_ref: BACKLOG-1
    title: t
    assignee: shift-worker-1
    scope: s
    files_allowed: []
    acceptance:
      - works
    time_budget_minutes: 15
`],
    ["bad ref", `slips:
  - id: B-20261103-01
    backlog_ref: ISSUE-7
    title: t
    assignee: shift-worker-1
    scope: s
    files_allowed: []
    acceptance:
      - works
    time_budget_minutes: 15
`],
    ["budget low", `slips:
  - id: B-20261103-01
    backlog_ref: BACKLOG-1
    title: t
    assignee: shift-worker-1
    scope: s
    files_allowed: []
    acceptance:
      - works
    time_budget_minutes: 4
`],
    ["budget high", `slips:
  - id: B-20261103-01
    backlog_ref: BACKLOG-1
    title: t
    assignee: shift-worker-1
    scope: s
    files_allowed: []
    acceptance:
      - works
    time_budget_minutes: 46
`],
    ["acceptance empty", `slips:
  - id: B-20261103-01
    backlog_ref: BACKLOG-1
    title: t
    assignee: shift-worker-1
    scope: s
    files_allowed: []
    acceptance: []
    time_budget_minutes: 15
`],
  ];
  for (const [label, text] of cases) {
    const r = parseSlips(text);
    assert.equal(r.ok, false, label);
  }
});

test("duplicate ids rejected", () => {
  const twice = VALID + VALID.split("slips:\n")[1]!;
  const r = parseSlips(twice);
  assert.equal(r.ok, false);
  assert.match((r as { errors: string[] }).errors.join(" "), /duplicate slip ids/);
});

test("nothing beyond the document anchor is allowed", () => {
  const r = parseSlips("version: 1\nslips:\n  - id: B-20261103-01\n");
  assert.equal(r.ok, false);
  assert.match((r as { errors: string[] }).errors.join(" "), /document anchor/);
});

test("off-indent fields rejected with the line number", () => {
  const r = parseSlips(`slips:
  - id: B-20261103-01
   backlog_ref: BACKLOG-1
`);
  assert.equal(r.ok, false);
  assert.match((r as { errors: string[] }).errors.join(" "), /line 3/);
});
