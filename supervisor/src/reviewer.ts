import type { ReceiptCheck } from "./gates.js";
import type { NightPolicy, PolicyResult } from "./policy.js";

export interface ReviewVerdict {
  verdict: "clear" | "needs_human" | "challenge";
  findings: string[];
  summary: string;
}

/** Independent deterministic reviewer. It compares the receipt to GitHub's
 * actual PR state and the repository-owned policy; it never trusts prose for
 * files, CI, or the commit identity. */
export function reviewCandidate(input: {
  headSha: string | null;
  actualFiles: readonly string[];
  receipt: ReceiptCheck;
  policy: NightPolicy;
  policyResult: PolicyResult;
}): ReviewVerdict {
  const findings: string[] = [];
  if (!input.headSha) findings.push("GitHub did not return a head commit SHA");
  if (!input.receipt.ok) findings.push(...input.receipt.gaps.map(gap => `receipt: ${gap}`));
  if (input.receipt.testPass !== true) findings.push("receipt does not prove passing tests");
  const declared = new Set(input.receipt.filesTouched ?? []);
  const actual = new Set(input.actualFiles);
  for (const file of actual) if (!declared.has(file)) findings.push(`actual file missing from receipt: ${file}`);
  for (const file of declared) if (!actual.has(file)) findings.push(`receipt names file absent from PR diff: ${file}`);
  findings.push(...input.policyResult.findings.filter(f => f.severity === "block").map(f => `policy: ${f.message}`));

  if (findings.length) return { verdict: "challenge", findings, summary: `${findings.length} trust challenge(s) must be resolved` };
  const reviewFindings = input.policyResult.findings.filter(f => f.severity === "review").map(f => f.message);
  if (reviewFindings.length) return { verdict: "needs_human", findings: reviewFindings, summary: "sensitive change requires explicit human review" };
  if (input.policy.reviewerRequired) return { verdict: "clear", findings: [], summary: "independent receipt, diff, policy, and commit checks are clear" };
  return { verdict: "clear", findings: [], summary: "repository policy allows the change" };
}
