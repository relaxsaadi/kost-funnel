#!/usr/bin/env node

/**
 * Independent per-function Stage 2A blueprint presence/coverage guard.
 *
 * This is a structural governance check only. It does not validate IATA DGR
 * text, source correctness, reviewer qualifications, ANAC/IATA approval, or
 * production readiness.
 *
 * Invariants:
 * - Functions 7.1 through 7.10 each have their own dedicated Stage 2A
 *   blueprint artifact;
 * - each blueprint identifies its own function;
 * - every canonical official task ID from that function's dedicated official
 *   task-set artifact is represented in its blueprint.
 *
 * The guard deliberately does not require invented numeric ceilings. A
 * blueprint may preserve explicit SOURCE GAP / NOT RECOVERED states when a
 * historical source-yield value is unavailable.
 */

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const functions = ["7.1", "7.2", "7.3", "7.4", "7.5", "7.6", "7.7", "7.8", "7.9", "7.10"];

let failed = false;

function fail(message) {
  failed = true;
  console.error(`ERROR: ${message}`);
}

function read(relativePath) {
  const absolute = path.join(root, relativePath);
  if (!fs.existsSync(absolute)) {
    fail(`missing required artifact: ${relativePath}`);
    return "";
  }
  return fs.readFileSync(absolute, "utf8");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function officialTaskIds(text, fn, label) {
  const ids = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/);
    if (!match) continue;
    const functionCell = match[1].trim();
    const taskCell = match[2].trim();
    if (functionCell !== fn) continue;
    if (!/^\d+(?:\.\d+){1,2}$/.test(taskCell)) continue;
    ids.push(taskCell);
  }

  const unique = [...new Set(ids)];
  if (!unique.length) fail(`${label}: no canonical official task rows parsed for Function ${fn}`);
  if (unique.length !== ids.length) fail(`${label}: duplicate official task IDs detected for Function ${fn}`);
  return unique;
}

for (const fn of functions) {
  const taskPath = `docs/DGR_OFFICIAL_TASK_SET_${fn}.md`;
  const blueprintPath = `docs/DGR_STAGE2A_FUNCTION_${fn}_BLUEPRINT.md`;
  const taskText = read(taskPath);
  const blueprintText = read(blueprintPath);

  if (!taskText || !blueprintText) continue;

  if (!new RegExp(`Function\\s+${escapeRegExp(fn)}\\b`, "i").test(blueprintText)) {
    fail(`${blueprintPath}: does not identify itself as Function ${fn}`);
  }

  const taskIds = officialTaskIds(taskText, fn, taskPath);
  const missing = taskIds.filter((taskId) => {
    const escaped = escapeRegExp(taskId);
    return !new RegExp(`(^|[^0-9.])${escaped}(?=$|[^0-9.])`, "m").test(blueprintText);
  });

  if (missing.length) {
    fail(`${blueprintPath}: missing canonical Function ${fn} task ID(s): ${missing.join(", ")}`);
  } else {
    console.log(`Function ${fn}: blueprint covers ${taskIds.length} canonical task IDs`);
  }
}

if (failed) {
  console.error("DGR Stage 2A blueprint coverage gate: FAIL");
  process.exit(1);
}

console.log("DGR Stage 2A blueprint coverage gate: PASS");
