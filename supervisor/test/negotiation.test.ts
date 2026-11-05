import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { overlap, scanCollisions, parseClaim, decideClaims } from "../src/negotiation.js";
import type { OpenTask } from "../src/gates.js";
const task = (id: string): OpenTask => ({ taskId: id, branch: `shift/${id}`, prNumber: 1, prUrl: null });
test("fixture branch diffs detect only the actual shared path", async () => {
 const root = mkdtempSync(join(tmpdir(), "p4-scan-")); const origin = join(root,"origin.git"); const repo = join(root,"repo"); mkdirSync(repo);
 const git = (...args: string[]) => execFileSync("git",args,{cwd:repo,stdio:"ignore"});
 git("init","--bare",origin); git("init","-b","main"); git("config","user.name","test"); git("config","user.email","test@example.invalid");
 writeFileSync(join(repo,"app.js"),"base\n"); git("add","."); git("commit","-m","base"); git("remote","add","origin",origin); git("push","origin","main");
 for (const [id, extra] of [["A","a.js"],["B","b.js"]]) { git("switch","-c",`shift/${id}`,"main"); writeFileSync(join(repo,"app.js"),id!); writeFileSync(join(repo,extra!),id!); git("add","."); git("commit","-m",id!); git("push","origin",`shift/${id}`); git("switch","main"); }
 const c = await scanCollisions(repo,[task("A"),task("B")]); assert.deepEqual(c.map(x=>x.paths),[["app.js"]]);
});
test("consistent claims order landing; false files and contradictions escalate", () => {
 const collision={left:task("A"),right:task("B"),paths:["src/app.js"]};
 const a=parseClaim("claim A first A on src/app.js\nMy route mount should land first.","A",1)!;
 const b=parseClaim("claim B first A on src/app.js\nI can rebase after it.","B",1)!;
 assert.deepEqual(decideClaims(collision,[a,b]),{kind:"order",order:["A","B"],path:"src/app.js"});
 assert.equal(decideClaims(collision,[a,{...b,first:"B"}]).kind,"escalate");
 assert.equal(decideClaims(collision,[a,{...b,paths:["README.md"]}]).kind,"escalate");
 assert.deepEqual(overlap(["x","y"],["y","z"]),["y"]);
});
