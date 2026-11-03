// supervisor/src/slips.ts — the tiny strict parser for crew/taskslips/<date>.yml
// (decision D3: no js-yaml; the file is the crew's OWN contract, fix shape).
//
// Accepted shape (crew/taskslip.schema.md — "parser reality"):
//
//   slips:
//     - id: B-20261103-01
//       backlog_ref: BACKLOG-1
//       title: one line scalar
//       assignee: shift-worker-1
//       scope: >-
//         folded paragraph…
//       files_allowed:
//         - src/routes/pets.js
//       acceptance:
//         - POST /pets with empty name returns 400
//       time_budget_minutes: 20
//       notes: >-
//         optional folded paragraph
//
// Strictness: the first non-empty line must be `slips:`; items are `  - `
// at exactly 2 spaces; fields at exactly 4 spaces; folded scalars (`>-`,
// `|`) take deeper-indented lines; list values (`files_allowed`, `acceptance`)
// take deeper-indented `- item` lines; anything else is a parse error with a
// line number and the WHOLE file is rejected (night-lead gets re-asked).

export interface Slip {
  id: string;
  backlog_ref: string;
  title: string;
  assignee: string;
  scope: string;
  files_allowed: string[];
  acceptance: string[];
  time_budget_minutes: number;
  notes?: string;
}

export type SlipsParse =
  | { ok: true; slips: Slip[] }
  | { ok: false; errors: string[] };

/** required ids: found twice ⇒ whole file rejected */
const ID_RE = /^[A-Z]+-\d{8}-\d{2}$/;
const REF_RE = /^BACKLOG-\d+$/;
const KNOWN_FIELDS = [
  "id",
  "backlog_ref",
  "title",
  "assignee",
  "scope",
  "files_allowed",
  "acceptance",
  "time_budget_minutes",
  "notes",
] as const;

class SlipDoc {
  slips: Slip[] = [];
  errors: string[] = [];
}

export function parseSlips(text: string): SlipsParse {
  const doc = new SlipDoc();
  const lines = text.split("\n");

  // find the document anchor
  let i = 0;
  while (i < lines.length && (lines[i] as string).trim() === "") i += 1;
  const anchor = lines[i] ?? "";
  if (anchor.trim() !== "slips:") {
    doc.errors.push(`line ${i + 1}: expected the document anchor "slips:", got ${JSON.stringify(anchor.trim() || "<eof>")}`);
    return { ok: false, errors: doc.errors };
  }
  i += 1;

  while (i < lines.length) {
    const line = lines[i] as string;
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const m = /^ {2}- (.+)$/.exec(line);
    if (!m) {
      doc.errors.push(`line ${i + 1}: expected a list item ("  - id: …") at indent 2`);
      return { ok: false, errors: doc.errors };
    }
    // the first field rides on the - item line: "- id: …"
    const firstPair = /^id: (.+)$/.exec(m[1] ?? "");
    if (!firstPair) {
      doc.errors.push(`line ${i + 1}: first item field must be "id", got ${JSON.stringify((m[1] ?? "").slice(0, 40))}`);
      return { ok: false, errors: doc.errors };
    }
    const fields: Record<string, unknown> = { id: unquote(firstPair[1] ?? "") };
    i += 1;
    i = readFields(lines, i, fields, doc);
    if (doc.errors.length > 0) return { ok: false, errors: doc.errors };
    const slipResult = buildSlip(fields, doc);
    if (slipResult.ok) doc.slips.push(slipResult.slip);
  }

  if (doc.errors.length === 0 && doc.slips.length === 0) {
    doc.errors.push("no slips in the document");
  }
  const ids = doc.slips.map((s) => s.id);
  if (new Set(ids).size !== ids.length) {
    doc.errors.push(`duplicate slip ids: ${ids.filter((id, idx) => ids.indexOf(id) !== idx).join(", ")}`);
  }
  return doc.errors.length > 0 ? { ok: false, errors: doc.errors } : { ok: true, slips: doc.slips };
}

/** Read this item's fields until the next "  - " item or EOF. */
function readFields(
  lines: string[],
  start: number,
  fields: Record<string, unknown>,
  doc: SlipDoc,
): number {
  let i = start;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    if (/^ {2}- /.test(line)) return i; // next item
    if (!/^ {4}/.test(line)) {
      doc.errors.push(`line ${i + 1}: fields sit at indent 4`);
      return i;
    }
    const fm = /^ {4}([a-z_]+):(.*)$/.exec(line);
    if (!fm) {
      doc.errors.push(`line ${i + 1}: expected "field:" at indent 4`);
      return i;
    }
    const key = fm[1] as string;
    if (!(KNOWN_FIELDS as readonly string[]).includes(key)) {
      doc.errors.push(`line ${i + 1}: unknown field "${key}"`);
      return i;
    }
    const rest = (fm[2] ?? "").trim();
    if (rest === ">-" || rest === "-" || rest === ">") {
      // folded/block scalar: gather deeper-indented lines (>= 6 spaces)
      i += 1;
      const parts: string[] = [];
      while (i < lines.length) {
        const l = lines[i] as string;
        if (l.trim() === "") {
          parts.push("");
          i += 1;
          continue;
        }
        if (/^ {6,}/.test(l)) {
          parts.push(l.trim());
          i += 1;
        } else {
          break;
        }
      }
      fields[key] = foldLines(parts);
      continue;
    }
    if (rest === "") {
      if (key === "files_allowed" || key === "acceptance") {
        i += 1;
        const items: string[] = [];
        while (i < lines.length) {
          const l = lines[i] as string;
          if (l.trim() === "") {
            i += 1;
            continue;
          }
          const im = /^ {6}- (.+)$/.exec(l);
          if (!im) break;
          items.push(unquote(im[1] ?? ""));
          i += 1;
        }
        if (items.length === 0) fields[key] = [];
        else fields[key] = items;
        continue;
      }
      doc.errors.push(`line ${i + 1}: scalar "${key}" expected on the same line, or ">-" / "|" block`);
      return i;
    }
    if (key === "files_allowed" || key === "acceptance") {
      if (/^\[\s*\]$/.test(rest)) {
        // an inline empty list is the schema's documented way to say "none"
        fields[key] = [];
        i += 1;
        continue;
      }
      doc.errors.push(`line ${i + 1}: "${key}" is a block list ("  - items below, indent 6") or [] empty`);
      return i;
    }
    fields[key] = unquote(rest);
    i += 1;
  }
  return i;
}

/** YAML plain-single-quoted/unquoted scalar in our tiny subset. */
function unquote(s: string): string {
  const t = s.trim();
  if (/^".*"$/.test(t) || /^'.*'$/.test(t)) return t.slice(1, -1);
  return t;
}

/** Fold: joins non-blank lines with spaces, keeps at most one blank as \n. */
function foldLines(parts: string[]): string {
  const out: string[] = [];
  let pendingBlank = false;
  for (const p of parts) {
    if (p === "") {
      if (out.length > 0) pendingBlank = true;
      continue;
    }
    if (pendingBlank) {
      out.push("");
      pendingBlank = false;
    }
    out.push(p);
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

function buildSlip(
  f: Record<string, unknown>,
  doc: SlipDoc,
): { ok: true; slip: Slip } | { ok: false } {
  const err = (s: string) => doc.errors.push(`slip ${f.id ?? "<no id>"}: ${s}`);
  const str = (k: string) => (typeof f[k] === "string" ? (f[k] as string) : undefined);
  const id = typeof f.id === "string" && f.id !== "" ? f.id : undefined;
  if (!id) {
    err("missing required field: id");
    return { ok: false };
  }
  const missing = (["backlog_ref", "title", "assignee", "scope", "files_allowed", "acceptance", "time_budget_minutes"] as const).filter(
    (k) => f[k] === undefined,
  );
  if (missing.length > 0) {
    err(`missing required field(s): ${missing.join(", ")}`);
    return { ok: false };
  }
  if (!ID_RE.test(id)) {
    err(`illegal id (want <backlog-ref>-<YYYYMMDD>-<NN>, e.g. B-20261103-01): "${id}"`);
    return { ok: false };
  }
  const backlog_ref = str("backlog_ref") as string;
  if (!REF_RE.test(backlog_ref)) {
    err(`backlog_ref must be BACKLOG-<n>, got "${backlog_ref}"`);
    return { ok: false };
  }
  const assignee = str("assignee") as string;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(assignee)) {
    err(`assignee must match the server name rule, got "${assignee}"`);
    return { ok: false };
  }
  const title = str("title") as string;
  if (title.length === 0 || title.includes("\n")) {
    err("title must be one line");
    return { ok: false };
  }
  const scope = str("scope") as string;
  const files_allowed = f.files_allowed as string[];
  if (!Array.isArray(files_allowed)) {
    err("files_allowed is a list");
    return { ok: false };
  }
  if (files_allowed.some((p) => !/^[A-Za-z0-9][A-Za-z0-9/._-]*$/.test(p) || p.includes(".."))) {
    err(`files_allowed paths must be plain relative paths inside target/, got: ${files_allowed.join(", ")}`);
    return { ok: false };
  }
  const acceptance = f.acceptance as string[];
  if (!Array.isArray(acceptance) || acceptance.length < 1 || acceptance.length > 5) {
    err("acceptance takes 1–5 lines");
    return { ok: false };
  }
  const budgetRaw = f.time_budget_minutes;
  const budget = typeof budgetRaw === "number" ? budgetRaw : typeof budgetRaw === "string" && /^\d+$/.test(budgetRaw) ? Number(budgetRaw) : NaN;
  if (!Number.isFinite(budget) || budget < 5 || budget > 45 || !Number.isInteger(budget)) {
    err(`time_budget_minutes must be an int 5–45, got ${JSON.stringify(budgetRaw)}`);
    return { ok: false };
  }
  const notes = str("notes");
  return {
    ok: true,
    slip: {
      id,
      backlog_ref,
      title,
      assignee,
      scope,
      files_allowed,
      acceptance,
      time_budget_minutes: budget,
      ...(notes ? { notes } : {}),
    },
  };
}
