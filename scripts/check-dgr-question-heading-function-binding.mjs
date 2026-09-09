#!/usr/bin/env node

/**
 * Fail-closed structural guard for question-item headings across the current
 * Function 7.1–7.10 production banks and EN review packages.
 *
 * The full readiness checker intentionally derives per-function populations
 * from structural Markdown headings. A canonical question heading that names
 * another function must therefore be rejected rather than silently falling
 * outside the expected-function set.
 *
 * This guard is structural only. It does not validate IATA DGR content,
 * source correctness, translation quality, human review, or ANAC/IATA
 * approval. Narrative cross-references to another function remain allowed;
 * only structural question-item headings are function-bound.
 */

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const functions = ["7.1", "7.2", "7.3", "7.4", "7.5", "7.6", "7.7", "7.8", "7.9", "7.10"];

function structuralQuestionHeadingToken(line) {
  const heading = line.match(/^#{2,4}\s+(.+)$/)?.[1]?.trim() ?? "";
  if (!/^Q-7\./i.test(heading)) return "";
  return heading.match(/^(Q-7\.[^\s—–]+)/i)?.[1] ?? "";
}

function canonicalQuestionId(token) {
  const match = token.match(/^Q-(7\.(?:10|[1-9]))-(\d{3})$/i);
  if (!match) return null;
  return {
    id: `Q-${match[1]}-${match[2]}`.toUpperCase(),
    fn: match[1],
  };
}

function duplicateValues(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
    .sort();
}

function inspectArtifact(text, expectedFn, artifactLabel) {
  const errors = [];
  const ids = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const token = structuralQuestionHeadingToken(lines[index]);
    if (!token) continue;

    const parsed = canonicalQuestionId(token);
    if (!parsed) {
      errors.push(`line ${index + 1}: malformed structural question ID heading "${token}"`);
      continue;
    }

    ids.push(parsed.id);
    if (parsed.fn !== expectedFn) {
      errors.push(
        `line ${index + 1}: foreign-function structural question heading ${parsed.id} appears in Function ${expectedFn} artifact`,
      );
    }
  }

  const duplicates = duplicateValues(ids);
  if (duplicates.length) {
    errors.push(`duplicate structural question heading(s): ${duplicates.join(", ")}`);
  }

  return { artifactLabel, errors, ids };
}

function assertFixture(name, condition, detail) {
  if (condition) return;
  console.error(`QUESTION-HEADING FUNCTION-BINDING REGRESSION: FAIL — ${name}: ${detail}`);
  process.exit(1);
}

function runRegressionFixtures() {
  const valid = inspectArtifact([
    "# Synthetic Function 7.2 bank",
    "Narrative cross-reference Q-7.1-001 is allowed.",
    "## Q-7.2-001 — First item",
    "### Q-7.2-002 — Second item",
  ].join("\n"), "7.2", "valid");
  assertFixture("valid artifact", valid.errors.length === 0, valid.errors.join("; "));

  const foreignHeading = inspectArtifact([
    "## Q-7.2-001 — Correct item",
    "## Q-7.3-001 — Wrong-function item",
  ].join("\n"), "7.2", "foreign");
  assertFixture(
    "foreign-function heading",
    foreignHeading.errors.some((error) => error.includes("foreign-function")),
    "foreign structural item did not fail closed",
  );

  const duplicateHeading = inspectArtifact([
    "## Q-7.4-001 — First copy",
    "### Q-7.4-001 — Duplicate copy",
  ].join("\n"), "7.4", "duplicate");
  assertFixture(
    "duplicate heading",
    duplicateHeading.errors.some((error) => error.includes("duplicate structural")),
    "duplicate structural ID did not fail closed",
  );

  const malformedHeading = inspectArtifact("## Q-7.5-01 — malformed", "7.5", "malformed");
  assertFixture(
    "malformed heading",
    malformedHeading.errors.some((error) => error.includes("malformed structural")),
    "malformed structural question ID did not fail closed",
  );

  const narrativeForeign = inspectArtifact([
    "## Q-7.10-001 — Valid item",
    "This rationale compares the result with Q-7.9-007; that prose reference is allowed.",
  ].join("\n"), "7.10", "narrative");
  assertFixture("foreign narrative cross-reference", narrativeForeign.errors.length === 0, narrativeForeign.errors.join("; "));

  console.log("QUESTION-HEADING FUNCTION-BINDING REGRESSION: PASS");
}

if (process.argv.includes("--test")) {
  runRegressionFixtures();
  process.exit(0);
}

let failed = false;
let totalHeadings = 0;

for (const fn of functions) {
  for (const kind of ["DGR_PRODUCTION_BANK", "DGR_EN_REVIEW_PACKAGE"]) {
    const relativePath = `docs/${kind}_${fn}.md`;
    const absolutePath = path.join(root, relativePath);
    if (!fs.existsSync(absolutePath)) {
      console.error(`ERROR: missing required artifact: ${relativePath}`);
      failed = true;
      continue;
    }

    const result = inspectArtifact(fs.readFileSync(absolutePath, "utf8"), fn, relativePath);
    totalHeadings += result.ids.length;
    for (const error of result.errors) {
      console.error(`ERROR: ${relativePath}: ${error}`);
      failed = true;
    }
  }
}

if (failed) {
  console.error("QUESTION-HEADING FUNCTION-BINDING CHECK: FAIL");
  console.error("This result is structural only; it does not decide regulatory correctness or approval.");
  process.exit(1);
}

console.log(`Question-heading function binding: ${totalHeadings} structural heading occurrence(s) checked across 20 artifacts.`);
console.log("QUESTION-HEADING FUNCTION-BINDING CHECK: PASS (structural provenance only)");
