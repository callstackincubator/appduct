#!/usr/bin/env node
/**
 * Skill model check — the Skills table in AGENTS.md against each skill's frontmatter, no network.
 *
 * Fails when:
 *   - a skill in `.claude/skills/` has no row in the table;
 *   - a row names a skill found in neither `.claude/skills/` nor `skills/`;
 *   - a row's Model column differs from the skill's `model:` (`none` when it has none);
 *   - a row's Forked column is `yes` and the skill lacks `context: fork`, or the reverse.
 *
 * Usage: node scripts/check-skill-models.mjs   (always checks this repository)
 * Exit codes: 0 = table and frontmatter agree, 1 = at least one mismatch.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const SKILL_DIRS = [".claude/skills", "skills"];

/** The rows of the table under `## Skills` in AGENTS.md, as cells keyed by header. */
function tableRows() {
  const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
  const section = agents.split(/^## Skills$/m)[1]?.split(/^## /m)[0] ?? "";
  const lines = section.split("\n").filter((line) => line.startsWith("|"));
  const cells = (line) => line.split("|").slice(1, -1).map((cell) => cell.trim());
  const [header, , ...body] = lines.map(cells);
  if (!header) return [];
  return body.map((row) => Object.fromEntries(header.map((name, i) => [name, row[i] ?? ""])));
}

/** `model` and `context` from a SKILL.md's frontmatter, or undefined when a key is absent. */
function frontmatter(path) {
  const block = readFileSync(path, "utf8").match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const value = (key) => block.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1].trim();
  return { model: value("model"), context: value("context") };
}

const errors = [];
const rows = tableRows();
const listed = new Set();

for (const row of rows) {
  const name = row.Skill?.match(/`([^`]+)`/)?.[1];
  if (!name) {
    errors.push(`AGENTS.md: a Skills row has no skill name in backticks: ${JSON.stringify(row)}`);
    continue;
  }
  listed.add(name);
  const dir = SKILL_DIRS.find((d) => existsSync(join(ROOT, d, name, "SKILL.md")));
  if (!dir) {
    errors.push(`AGENTS.md: \`${name}\` is in the Skills table but not in ${SKILL_DIRS.join(" or ")}`);
    continue;
  }
  const path = `${dir}/${name}/SKILL.md`;
  const { model, context } = frontmatter(join(ROOT, path));
  const declaredModel = model ?? "none";
  if (row.Model !== declaredModel) {
    errors.push(`${path}: model is ${declaredModel}, AGENTS.md says ${row.Model || "nothing"}`);
  }
  const forked = context === "fork" ? "yes" : "no";
  if (row.Forked !== forked) {
    errors.push(
      `${path}: context is ${context ?? "none"} (Forked ${forked}), AGENTS.md says ${row.Forked || "nothing"}`,
    );
  }
}

for (const entry of readdirSync(join(ROOT, ".claude/skills"), { withFileTypes: true })) {
  if (entry.isDirectory() && !listed.has(entry.name)) {
    errors.push(`.claude/skills/${entry.name}: missing from the Skills table in AGENTS.md`);
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  console.error(`\n${errors.length} skill model mismatch(es).`);
  process.exit(1);
}
console.log(`Skill models agree with AGENTS.md (${rows.length} rows).`);
