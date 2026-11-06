import { createHash } from "node:crypto";
import type { CiState } from "./prs.js";
import type { ReceiptCheck } from "./gates.js";
import type { PolicyResult } from "./policy.js";
import type { ReviewVerdict } from "./reviewer.js";

export interface EvidenceBundle {
  taskId: string;
  prNumber: number;
  headSha: string;
  files: string[];
  ci: { state: CiState; detail: string };
  receipt: ReceiptCheck;
  policy: PolicyResult;
  reviewer: ReviewVerdict;
  fingerprint: string;
}

export function createEvidenceBundle(input: Omit<EvidenceBundle, "fingerprint">): EvidenceBundle {
  const canonical = JSON.stringify({
    taskId: input.taskId,
    prNumber: input.prNumber,
    headSha: input.headSha,
    files: [...input.files].sort(),
    ci: input.ci,
    receipt: input.receipt,
    policy: input.policy,
    reviewer: input.reviewer,
  });
  return { ...input, files: [...input.files].sort(), fingerprint: createHash("sha256").update(canonical).digest("hex").slice(0, 16) };
}

export function renderDecisionCard(bundle: EvidenceBundle): string {
  const mark = (ok: boolean): string => ok ? "✅" : "⛔";
  const findings = [...bundle.policy.findings.map(f => `${f.severity}: ${f.message}`), ...bundle.reviewer.findings.map(f => `reviewer: ${f}`)];
  return [
    `### Trust decision — ${bundle.taskId}`,
    `PR #${bundle.prNumber} · commit \`${bundle.headSha.slice(0, 12)}\` · evidence \`${bundle.fingerprint}\``,
    `${mark(bundle.receipt.ok && bundle.receipt.testPass === true)} receipts · ${mark(bundle.ci.state === "green")} CI ${bundle.ci.state} · ${mark(bundle.policy.status !== "block")} policy ${bundle.policy.status} · ${mark(bundle.reviewer.verdict !== "challenge")} reviewer ${bundle.reviewer.verdict}`,
    `Changed: ${bundle.files.length ? bundle.files.map(file => `\`${file}\``).join(", ") : "none"}`,
    ...(findings.length ? ["Findings:", ...findings.map(finding => `- ${finding}`)] : ["Findings: none"]),
    `Decision: ${bundle.reviewer.verdict === "challenge" || bundle.policy.status === "block" ? "hold or rollback; approval is refused" : `human may approve this exact commit with \`@shift-supervisor approve ${bundle.taskId}\``}.`,
  ].join("\n");
}
