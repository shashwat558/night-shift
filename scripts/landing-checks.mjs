import { existsSync, readFileSync } from "node:fs";

let status = 0;
const pass = message => console.log(`PASS ${message}`);
const fail = message => { console.error(`FAIL ${message}`); status = 1; };

for (const file of ["landing/index.html", "landing/styles.css", "landing/app.js"]) {
  existsSync(file) ? pass(`${file} present`) : fail(`${file} missing`);
}

const html = readFileSync("landing/index.html", "utf8");
const css = readFileSync("landing/styles.css", "utf8");
const js = readFileSync("landing/app.js", "utf8");

for (const phrase of ["Switch-native engineering crew", "Trust control tower", "WORKER_PROVIDER=codex", "9 AM report"]) {
  html.includes(phrase) ? pass(`landing explains ${phrase}`) : fail(`landing missing ${phrase}`);
}

html.includes('meta name="viewport"') ? pass("landing has responsive viewport") : fail("landing missing viewport");
html.includes("data-theme-toggle") && js.includes("night-shift-theme") ? pass("landing theme toggle wired") : fail("landing theme toggle incomplete");
html.includes('role="tablist"') && js.includes("ArrowRight") ? pass("landing preview tabs keyboard accessible") : fail("landing tabs missing keyboard behavior");
css.includes("prefers-reduced-motion") ? pass("landing respects reduced motion") : fail("landing missing reduced-motion mode");
css.includes("@media(max-width:760px)") ? pass("landing has mobile layout") : fail("landing missing mobile layout");

process.exitCode = status;
