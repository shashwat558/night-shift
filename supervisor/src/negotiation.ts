// File-collision detection and two-round negotiation.
import { exec } from "./exec.js";
import type { OpenTask } from "./gates.js";

export interface Collision { left: OpenTask; right: OpenTask; paths: string[] }
export interface Claim { taskId: string; first: string; paths: string[]; reason: string; round: 1 | 2 }
export type Decision = { kind: "order"; order: [string, string]; path: string } | { kind: "escalate"; reason: string; claims: Claim[] };

export async function changedFiles(cwd: string, branch: string): Promise<string[]> {
  const r = await exec("git", ["diff", "--name-only", `origin/main...origin/${branch}`], cwd, 60_000);
  if (!r.ok) throw new Error(`diff ${branch}: ${r.output}`);
  return [...new Set(r.output.split("\n").map(s => s.trim()).filter(Boolean))];
}
export function overlap(a: readonly string[], b: readonly string[]): string[] {
  const right = new Set(b);
  return [...new Set(a.filter(p => right.has(p)))].sort();
}
export async function scanCollisions(cwd: string, tasks: OpenTask[]): Promise<Collision[]> {
  const files = await Promise.all(tasks.map(t => changedFiles(cwd, t.branch)));
  const found: Collision[] = [];
  for (let i = 0; i < tasks.length; i++) for (let j = i + 1; j < tasks.length; j++) {
    const paths = overlap(files[i] ?? [], files[j] ?? []);
    if (paths.length) found.push({ left: tasks[i]!, right: tasks[j]!, paths });
  }
  return found;
}
export function parseClaim(body: string, taskId: string, round: 1 | 2): Claim | null {
  // One claim, three lines maximum; exact files and preferred first task.
  const lines = body.trim().split("\n");
  if (lines.length > 3) return null;
  const m = /(?:^|\s)claim\s+(\S+)\s+first\s+(\S+)\s+on\s+([^\n]+)$/i.exec(lines[0] ?? "");
  if (!m || m[1] !== taskId) return null;
  return { taskId, first: m[2]!, paths: m[3]!.split(",").map(s => s.trim()).filter(Boolean), reason: lines.slice(1).join(" ").trim(), round };
}
export function decideClaims(collision: Collision, claims: Claim[]): Decision {
  const ids = [collision.left.taskId, collision.right.taskId];
  const current = claims.filter(c => ids.includes(c.taskId));
  if (current.length !== 2 || new Set(current.map(c => c.taskId)).size !== 2)
    return { kind: "escalate", reason: "one claim per worker is required", claims: current };
  for (const c of current) {
    const invalid = c.paths.filter(p => !collision.paths.includes(p));
    if (invalid.length) return { kind: "escalate", reason: `${c.taskId} claimed files outside the actual overlap: ${invalid.join(", ")}`, claims: current };
    if (!c.paths.length || !c.paths.some(p => collision.paths.includes(p)))
      return { kind: "escalate", reason: `${c.taskId} did not name the actual shared path`, claims: current };
    if (!ids.includes(c.first)) return { kind: "escalate", reason: `${c.taskId} named unknown first task ${c.first}`, claims: current };
  }
  if (current[0]!.first !== current[1]!.first)
    return { kind: "escalate", reason: "workers gave contradictory landing orders", claims: current };
  const first = current[0]!.first;
  return { kind: "order", order: [first, ids.find(id => id !== first)!], path: collision.paths.join(", ") };
}
export function collisionPrompt(c: Collision, round: 1 | 2): string {
  return `@nightshift-worker-1 @nightshift-worker-2 file-collision on ${c.paths.join(", ")} — state your claim, ≤3 lines, round ${round}/2.\nEach worker: claim <your-task-id> first <task-id> on <shared-path>\n<one-line reason>. One claim each; the supervisor checks the actual diff.`;
}
