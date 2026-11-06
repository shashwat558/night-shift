import { readFileSync } from "node:fs";

export interface NightPolicy {
  version: 1;
  maxChangedFiles: number;
  maxBudgetMinutes: number;
  reviewerRequired: boolean;
  blockedPaths: string[];
  reviewPaths: string[];
}

export type PolicySeverity = "block" | "review" | "info";
export interface PolicyFinding {
  severity: PolicySeverity;
  code: string;
  message: string;
}

export interface PolicyResult {
  status: "pass" | "needs_human" | "block";
  findings: PolicyFinding[];
}

const DEFAULT_POLICY: NightPolicy = {
  version: 1,
  maxChangedFiles: 8,
  maxBudgetMinutes: 30,
  reviewerRequired: true,
  blockedPaths: ["migrations/**", ".github/workflows/**", "infra/production/**"],
  reviewPaths: ["src/auth/**", "src/payments/**", "package-lock.json"],
};

export function parsePolicy(text: string): NightPolicy {
  const scalars = new Map<string, string>();
  const lists = new Map<string, string[]>();
  let list: string | null = null;
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const scalar = /^([a-z_]+):\s*(.*?)\s*$/.exec(line);
    if (scalar) {
      const key = scalar[1] as string;
      const value = scalar[2] as string;
      list = value === "" ? key : null;
      if (list) lists.set(list, []);
      else scalars.set(key, value);
      continue;
    }
    const item = /^  -\s+(.+?)\s*$/.exec(line);
    if (item && list) {
      lists.get(list)?.push(unquote(item[1] as string));
      continue;
    }
    throw new Error(`policy line ${index + 1}: unsupported syntax`);
  }

  const version = numberField(scalars, "version");
  if (version !== 1) throw new Error("policy version must be 1");
  const maxChangedFiles = numberField(scalars, "max_changed_files");
  const maxBudgetMinutes = numberField(scalars, "max_budget_minutes");
  if (!Number.isInteger(maxChangedFiles) || maxChangedFiles < 1 || maxChangedFiles > 100) throw new Error("max_changed_files must be 1..100");
  if (!Number.isInteger(maxBudgetMinutes) || maxBudgetMinutes < 1 || maxBudgetMinutes > 1440) throw new Error("max_budget_minutes must be 1..1440");
  const reviewer = scalars.get("reviewer_required");
  if (reviewer !== "true" && reviewer !== "false") throw new Error("reviewer_required must be true or false");
  for (const name of ["blocked_paths", "review_paths"]) {
    if (!lists.has(name)) throw new Error(`${name} list is required`);
    for (const pattern of lists.get(name) ?? []) validatePattern(pattern, name);
  }
  return {
    version: 1,
    maxChangedFiles,
    maxBudgetMinutes,
    reviewerRequired: reviewer === "true",
    blockedPaths: lists.get("blocked_paths") ?? [],
    reviewPaths: lists.get("review_paths") ?? [],
  };
}

export function loadPolicy(file: string): NightPolicy {
  try { return parsePolicy(readFileSync(file, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_POLICY;
    throw error;
  }
}

export function evaluatePolicy(
  policy: NightPolicy,
  input: { files: readonly string[]; budgetMinutes: number; risk: "low" | "medium" | "high" | null },
): PolicyResult {
  const findings: PolicyFinding[] = [];
  if (input.files.length > policy.maxChangedFiles) {
    findings.push({ severity: "block", code: "too_many_files", message: `${input.files.length} changed files exceeds the policy limit ${policy.maxChangedFiles}` });
  }
  if (input.budgetMinutes > policy.maxBudgetMinutes) {
    findings.push({ severity: "block", code: "budget_too_large", message: `${input.budgetMinutes} minute budget exceeds the policy limit ${policy.maxBudgetMinutes}` });
  }
  for (const file of input.files) {
    const blocked = policy.blockedPaths.find(pattern => matchesPath(pattern, file));
    if (blocked) findings.push({ severity: "block", code: "blocked_path", message: `${file} matches blocked path ${blocked}` });
    const reviewed = policy.reviewPaths.find(pattern => matchesPath(pattern, file));
    if (reviewed) findings.push({ severity: "review", code: "sensitive_path", message: `${file} requires explicit human review (${reviewed})` });
  }
  if (input.risk === "high") findings.push({ severity: "review", code: "high_risk", message: "receipt declares high risk" });
  const status = findings.some(f => f.severity === "block") ? "block" : findings.some(f => f.severity === "review") ? "needs_human" : "pass";
  return { status, findings };
}

export function matchesPath(pattern: string, path: string): boolean {
  let regex = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string;
    if (char === "*" && pattern[i + 1] === "*") { regex += ".*"; i += 1; }
    else if (char === "*") regex += "[^/]*";
    else regex += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${regex}$`).test(path.replace(/^\.\//, ""));
}

function numberField(fields: Map<string, string>, name: string): number {
  const value = Number(fields.get(name));
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function unquote(value: string): string {
  return (/^(['"]).*\1$/.test(value)) ? value.slice(1, -1) : value;
}

function validatePattern(pattern: string, field: string): void {
  if (!pattern || pattern.startsWith("/") || pattern.includes("..")) throw new Error(`${field} contains unsafe pattern ${JSON.stringify(pattern)}`);
}
