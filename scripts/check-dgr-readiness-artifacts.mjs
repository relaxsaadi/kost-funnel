#!/usr/bin/env node

/**
 * Deterministic DGR/CBTA readiness artifact guard.
 *
 * This script deliberately does not decide regulatory correctness. It checks
 * durable repository invariants that must be true before the 7.1–7.10
 * question-bank program can be described as ready:
 *
 * 1. required per-function governance artifacts exist;
 * 2. every drafted production-bank question ID has exactly one EN review
 *    package entry, with no extra EN-only IDs;
 * 3. a currently FROZEN item fails readiness when its durable provenance says
 *    only a representative sample was checked or its own citation was not
 *    independently re-read; historical notes on truthfully downgraded items
 *    remain auditable without blocking readiness merely by existing;
 * 4. overlapping FR-bank / EN-package items must mirror the same current FR
 *    governance state (FROZEN/GAP/PARTIAL/CONFLICT/DRAFT/etc.); presence of an
 *    EN draft must never preserve a stale blanket FR status;
 * 5. an APPROVED item must carry a non-pending named reviewer and an ISO
 *    review date in the same item block, and table-based status registers may
 *    not bypass that requirement.
 *
 * It does NOT:
 * - validate licensed IATA DGR text;
 * - infer ANAC/IATA approval;
 * - mark any question APPROVED;
 * - equate FR source verification with EN bilingual review completion.
 *
 * Run from repository root:
 *   node scripts/check-dgr-readiness-artifacts.mjs
 */

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const functions = ["7.1", "7.2", "7.3", "7.4", "7.5", "7.6", "7.7", "7.8", "7.9", "7.10"];

let failed = false;
const rows = [];

function fail(message) {
  failed = true;
  console.error(`ERROR: ${message}`);
}

function warn(message) {
  console.warn(`WARN: ${message}`);
}

function readRequired(relativePath) {
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

function headingIds(text, fn) {
  const escaped = escapeRegExp(fn);
  const re = new RegExp(`^#{2,4}\\s+(Q-${escaped}-\\d{3})\\b`, "gmi");
  const ids = [];
  for (const match of text.matchAll(re)) ids.push(match[1]);
  return ids;
}

function allIds(text, fn) {
  const escaped = escapeRegExp(fn);
  const re = new RegExp(`\\bQ-${escaped}-\\d{3}\\b`, "gi");
  return [...text.matchAll(re)].map((m) => m[0]);
}

function duplicates(ids) {
  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort();
}

function uniqueSorted(ids) {
  return [...new Set(ids)].sort();
}

function difference(left, right) {
  const rightSet = new Set(right);
  return left.filter((id) => !rightSet.has(id));
}

function itemBlocks(text, fn) {
  const escaped = escapeRegExp(fn);
  const re = new RegExp(`^#{2,4}\\s+(Q-${escaped}-\\d{3})\\b.*$`, "gmi");
  const matches = [...text.matchAll(re)];
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? text.length) : text.length;
    return { id: match[1], text: text.slice(start, end) };
  });
}

function assertApprovedHasReviewerAndDate(text, fn, artifactLabel) {
  for (const block of itemBlocks(text, fn)) {
    if (!/^\s*\*\*Approval:\*\*\s*APPROVED\b/im.test(block.text)) continue;

    const reviewerMatch = block.text.match(/^\s*\*\*(?:Qualified reviewer|Reviewer|Reviewed by):\*\*\s*(.+)$/im);
    const reviewDateMatch = block.text.match(/^\s*\*\*(?:Review date|Reviewed on):\*\*\s*(\d{4}-\d{2}-\d{2})\b/im);
    const reviewer = reviewerMatch?.[1]?.trim() ?? "";
    const reviewerLooksPending = !reviewer || /pending|tbd|todo|reviewer\s*\+\s*date/i.test(reviewer);

    if (reviewerLooksPending || !reviewDateMatch) {
      fail(`${artifactLabel}: ${block.id} is APPROVED without a non-pending named reviewer and ISO review date`);
    }
  }
}

function markdownTableCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return [];
  return trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
}

function assertTableApprovalsHaveReviewerAndDate(text, artifactLabel) {
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const headers = markdownTableCells(lines[i]);
    if (!headers.length) continue;

    const idIndex = headers.findIndex((header) => /^ID$/i.test(header));
    const approvalIndex = headers.findIndex((header) => /^Approval$/i.test(header));
    if (idIndex < 0 || approvalIndex < 0) continue;

    const reviewerIndex = headers.findIndex((header) => /^(?:Qualified reviewer|Reviewer|Reviewed by)$/i.test(header));
    const reviewDateIndex = headers.findIndex((header) => /^(?:Review date|Reviewed on)$/i.test(header));

    // Skip the Markdown separator row, then inspect the contiguous table body.
    for (let j = i + 2; j < lines.length; j += 1) {
      const cells = markdownTableCells(lines[j]);
      if (!cells.length) break;

      const id = cells[idIndex] ?? "";
      const approval = cells[approvalIndex] ?? "";
      if (!/^Q-7\.(?:10|[1-9])-\d{3}\b/i.test(id) || !/^APPROVED\b/i.test(approval)) continue;

      const reviewer = reviewerIndex >= 0 ? (cells[reviewerIndex] ?? "").trim() : "";
      const reviewDate = reviewDateIndex >= 0 ? (cells[reviewDateIndex] ?? "").trim() : "";
      const reviewerLooksPending = !reviewer || /pending|tbd|todo|reviewer\s*\+\s*date/i.test(reviewer);
      const hasIsoDate = /^\d{4}-\d{2}-\d{2}\b/.test(reviewDate);

      if (reviewerLooksPending || !hasIsoDate) {
        fail(`${artifactLabel}: ${id} table row is APPROVED without explicit named reviewer + ISO review date columns`);
      }
    }
  }
}

function hasRepresentativeEvidenceCaveat(text) {
  return (
    /(?:item['’]s\s+)?own specific citation was not independently re-read/i.test(text) ||
    /representative sample(?: of this citation pattern)?/i.test(text)
  );
}

function latestFrStatus(blockText) {
  const matches = [...blockText.matchAll(/^\s*\*\*FR status:\*\*\s*(.+)$/gmi)];
  return matches.length ? matches.at(-1)[1].trim() : "";
}

function frStatusClass(value) {
  const normalized = value
    .replace(/[`*_]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

  if (!normalized) return "";
  if (/FROZEN FR\s*\/\s*SOURCE VERIFIED/.test(normalized)) return "FROZEN FR / SOURCE VERIFIED";
  if (/SOURCE CONFLICT/.test(normalized)) return "SOURCE CONFLICT";
  if (/SOURCE GAP/.test(normalized)) return "SOURCE GAP";
  if (/PARTIALLY CONFIRMED|PARTIAL(?:LY)? CONFIRMED/.test(normalized)) return "PARTIALLY CONFIRMED";
  if (/STALE CITATION/.test(normalized)) return "STALE CITATION";
  if (/NOT ATTEMPTED|UNATTEMPTED/.test(normalized)) return "NOT ATTEMPTED";
  if (/\bDRAFT\b|SOURCE REQUIRED/.test(normalized)) return "DRAFT";
  return "";
}

function frStatusById(text, fn) {
  const result = new Map();
  for (const block of itemBlocks(text, fn)) {
    result.set(block.id, frStatusClass(latestFrStatus(block.text)));
  }
  return result;
}

function frStatusDriftItems(bankText, enText, fn) {
  const bankStatuses = frStatusById(bankText, fn);
  const enStatuses = frStatusById(enText, fn);
  const drift = [];

  for (const [id, bankStatus] of bankStatuses) {
    if (!enStatuses.has(id)) continue;
    const enStatus = enStatuses.get(id) ?? "";

    if (!bankStatus) {
      drift.push(`${id} (bank FR status unclassified/missing)`);
      continue;
    }
    if (!enStatus) {
      drift.push(`${id} (EN package FR status unclassified/missing; bank=${bankStatus})`);
      continue;
    }
    if (bankStatus !== enStatus) {
      drift.push(`${id} (bank=${bankStatus}; EN=${enStatus})`);
    }
  }

  return drift;
}

function frozenRepresentativeEvidenceItems(text, fn) {
  return itemBlocks(text, fn)
    .filter((block) => /^FROZEN FR\s*\/\s*SOURCE VERIFIED\b/i.test(latestFrStatus(block.text)))
    .filter((block) => hasRepresentativeEvidenceCaveat(block.text))
    .map((block) => block.id);
}

// Presence checks. Function 7.1 has a recovered Stage 2A/pilot history rather
// than the later per-function Stage 1 naming convention; 7.2–7.10 use their
// own Stage 1 draft/cross-validation + Stage 2A blueprint artifacts.
for (const relativePath of [
  "docs/DGR_STAGE_2B_STATUS.md",
  "docs/DGR_SOURCE_REGISTER.md",
  "docs/RECOVERED_STAGE2A_CONTEXT.md",
]) {
  readRequired(relativePath);
}

for (const fn of functions.slice(1)) {
  for (const relativePath of [
    `docs/DGR_STAGE1_FUNCTION_${fn}_DRAFT.md`,
    `docs/DGR_STAGE1_FUNCTION_${fn}_CROSSVALIDATION.md`,
    `docs/DGR_STAGE2A_FUNCTION_${fn}_BLUEPRINT.md`,
  ]) {
    readRequired(relativePath);
  }
}

const stage71 = readRequired("docs/DGR_STAGE_2B_STATUS.md");
assertTableApprovalsHaveReviewerAndDate(stage71, "docs/DGR_STAGE_2B_STATUS.md");

let totalBank = 0;
let totalEn = 0;
let totalMissing = 0;
let totalExtra = 0;
let totalProvenanceBlockers = 0;
let totalFrStatusDrift = 0;

for (const fn of functions) {
  const bankPath = `docs/DGR_PRODUCTION_BANK_${fn}.md`;
  const enPath = `docs/DGR_EN_REVIEW_PACKAGE_${fn}.md`;
  const bank = readRequired(bankPath);
  const en = readRequired(enPath);

  const bankHeadingList = headingIds(bank, fn);
  const enHeadingList = headingIds(en, fn);

  // Function 7.1's production-bank file is an expansion file (Q013–Q019).
  // The frozen pilot Q001–Q012 is durably enumerated in DGR_STAGE_2B_STATUS.
  const canonicalBankIds = uniqueSorted(
    fn === "7.1" ? [...bankHeadingList, ...allIds(stage71, fn)] : bankHeadingList,
  );
  const enIds = uniqueSorted(enHeadingList);

  const bankDupes = duplicates(bankHeadingList);
  const enDupes = duplicates(enHeadingList);
  const missing = difference(canonicalBankIds, enIds);
  const extra = difference(enIds, canonicalBankIds);
  const provenanceBlockers = frozenRepresentativeEvidenceItems(bank, fn);
  const frStatusDrift = frStatusDriftItems(bank, en, fn);

  if (bankDupes.length) fail(`${bankPath}: duplicate question headings: ${bankDupes.join(", ")}`);
  if (enDupes.length) fail(`${enPath}: duplicate EN question headings: ${enDupes.join(", ")}`);
  if (missing.length) fail(`${fn}: EN package missing ${missing.length} bank ID(s): ${missing.join(", ")}`);
  if (extra.length) fail(`${fn}: EN package has ${extra.length} extra ID(s) not in canonical bank: ${extra.join(", ")}`);

  if (provenanceBlockers.length > 0) {
    // This is intentionally a readiness failure, not an automatic downgrade.
    // A FROZEN state must be backed by direct item-specific current Tier-A
    // evidence. If the item is truthfully downgraded to GAP/PARTIAL/DRAFT/
    // CONFLICT, its historical representative-sample note may remain for audit
    // history without creating a false permanent blocker.
    fail(`${fn}: ${provenanceBlockers.length} FROZEN item(s) still rely on representative/non-item-specific evidence: ${provenanceBlockers.join(", ")}`);
  }

  if (frStatusDrift.length > 0) {
    fail(`${fn}: ${frStatusDrift.length} overlapping bank/EN item(s) have stale or missing mirrored FR status: ${frStatusDrift.join("; ")}`);
  }

  assertApprovedHasReviewerAndDate(bank, fn, bankPath);
  assertApprovedHasReviewerAndDate(en, fn, enPath);
  assertTableApprovalsHaveReviewerAndDate(bank, bankPath);
  assertTableApprovalsHaveReviewerAndDate(en, enPath);

  rows.push({
    fn,
    bank: canonicalBankIds.length,
    en: enIds.length,
    missing: missing.length,
    extra: extra.length,
    provenanceBlockers: provenanceBlockers.length,
    frStatusDrift: frStatusDrift.length,
  });
  totalBank += canonicalBankIds.length;
  totalEn += enIds.length;
  totalMissing += missing.length;
  totalExtra += extra.length;
  totalProvenanceBlockers += provenanceBlockers.length;
  totalFrStatusDrift += frStatusDrift.length;
}

console.log("\nDGR/CBTA readiness artifact summary");
console.log("Function | Bank IDs | EN IDs | Missing EN | Extra EN | Frozen provenance blockers | FR↔EN status drift");
console.log("---------|----------|--------|------------|----------|----------------------------|-------------------");
for (const row of rows) {
  console.log(`${row.fn.padEnd(8)} | ${String(row.bank).padStart(8)} | ${String(row.en).padStart(6)} | ${String(row.missing).padStart(10)} | ${String(row.extra).padStart(8)} | ${String(row.provenanceBlockers).padStart(26)} | ${String(row.frStatusDrift).padStart(17)}`);
}
console.log("---------|----------|--------|------------|----------|----------------------------|-------------------");
console.log(`TOTAL    | ${String(totalBank).padStart(8)} | ${String(totalEn).padStart(6)} | ${String(totalMissing).padStart(10)} | ${String(totalExtra).padStart(8)} | ${String(totalProvenanceBlockers).padStart(26)} | ${String(totalFrStatusDrift).padStart(17)}`);

if (failed) {
  console.error("\nREADINESS ARTIFACT CHECK: FAIL");
  console.error("A failing result is expected while documented regulatory/bilingual blockers remain open. Do not treat this as an approval or regulatory-correctness engine.");
  process.exit(1);
}

warn("Artifact consistency passed, but this does not prove regulatory correctness, qualified human review, build/test/security readiness, or ANAC/IATA approval.");
console.log("READINESS ARTIFACT CHECK: PASS (artifact consistency only)");
