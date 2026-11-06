import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePolicy, evaluatePolicy, matchesPath } from "../src/policy.js";
import { reviewCandidate } from "../src/reviewer.js";
import { createEvidenceBundle, renderDecisionCard } from "../src/evidence.js";
import type { ReceiptCheck } from "../src/gates.js";

const POLICY = `version: 1
max_changed_files: 4
max_budget_minutes: 20
reviewer_required: true
blocked_paths:
  - migrations/**
  - .github/workflows/**
review_paths:
  - src/auth/**
`;

const receipt = (files: string[]): ReceiptCheck => ({
  ok: true,
  gaps: [],
  testPass: true,
  riskLevel: "low",
  declaredDeviations: false,
  filesTouched: files,
  budgetSpent: 4,
  budgetCap: 20,
});

test("policy parser and glob matcher enforce blocked and review paths", () => {
  const policy = parsePolicy(POLICY);
  assert.equal(matchesPath("migrations/**", "migrations/2026/add.sql"), true);
  assert.equal(matchesPath("src/auth/**", "src/routes/pets.js"), false);
  assert.equal(evaluatePolicy(policy, { files: ["migrations/2026/add.sql"], budgetMinutes: 5, risk: "low" }).status, "block");
  assert.equal(evaluatePolicy(policy, { files: ["src/auth/token.js"], budgetMinutes: 5, risk: "low" }).status, "needs_human");
  assert.equal(evaluatePolicy(policy, { files: ["src/routes/pets.js"], budgetMinutes: 5, risk: "low" }).status, "pass");
});

test("reviewer challenges receipt/diff mismatch and blocked paths", () => {
  const policy = parsePolicy(POLICY);
  const policyResult = evaluatePolicy(policy, { files: ["migrations/add.sql"], budgetMinutes: 5, risk: "low" });
  const verdict = reviewCandidate({ headSha: "abc123", actualFiles: ["migrations/add.sql"], receipt: receipt(["src/pets.js"]), policy, policyResult });
  assert.equal(verdict.verdict, "challenge");
  assert.match(verdict.findings.join(" "), /actual file missing from receipt/);
  assert.match(verdict.findings.join(" "), /blocked path/);
});

test("evidence fingerprint and Switch decision card bind the exact commit", () => {
  const policy = parsePolicy(POLICY);
  const checked = receipt(["src/pets.js"]);
  const policyResult = evaluatePolicy(policy, { files: ["src/pets.js"], budgetMinutes: 5, risk: "low" });
  const reviewer = reviewCandidate({ headSha: "0123456789abcdef", actualFiles: ["src/pets.js"], receipt: checked, policy, policyResult });
  const first = createEvidenceBundle({ taskId: "B-1", prNumber: 7, headSha: "0123456789abcdef", files: ["src/pets.js"], ci: { state: "green", detail: "1 check" }, receipt: checked, policy: policyResult, reviewer });
  const changed = createEvidenceBundle({ ...first, headSha: "fedcba9876543210" });
  assert.notEqual(first.fingerprint, changed.fingerprint);
  const card = renderDecisionCard(first);
  assert.match(card, /Trust decision/);
  assert.match(card, /0123456789ab/);
  assert.match(card, new RegExp(first.fingerprint));
  assert.match(card, /human may approve this exact commit/);
});
