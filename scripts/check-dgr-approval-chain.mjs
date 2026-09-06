#!/usr/bin/env node

/**
 * Fail-closed DGR/CBTA approval-chain guard.
 *
 * This checker does not decide regulatory correctness and does not approve
 * questions. It only prevents a durable `APPROVED` claim from appearing
 * before the repository's documented four-gate sign-off chain is complete.
 *
 * Required before APPROVED:
 *  1. Gate 1: terminal FR source state (`FROZEN FR / SOURCE VERIFIED` or
 *     the explicitly governed `FR SOURCE GAP CONFIRMED` case);
 *  2. Gate 2: `FR TECHNICAL REVIEW COMPLETE` with full reviewer name,
 *     role/credential and ISO date;
 *  3. Gate 3: `BILINGUAL TECHNICAL REVIEW COMPLETE` with full reviewer name
 *     and ISO date;
 *  4. Gate 4: `APPROVED — <full name>, <YYYY-MM-DD>`.
 *
 * It scans both item blocks and Markdown status tables, and also requires an
 * approved ID to be consistently approved in its bank/status artifact and
 * its separate EN review package. No reviewer identity or qualification is
 * inferred from an automated agent, role label, ANAC, IATA, or KOST name.
 */

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const functions = ["7.1", "7.2", "7.3", "7.4", "7.5", "7.6", "7.7", "7.8", "7.9", "7.10"];
const idPattern = /^Q-7\.(?:10|[1-9])-\d{3}$/i;

function normalize(value = "") {
  return value.replace(/[`*_]/g, " ").replace(/\s+/g, " ").trim();
}

function isApproved(value = "") {
  return /^APPROVED\b/i.test(normalize(value));
}

function isPlaceholder(value = "") {
  return /(?:^|\b)(?:pending|tbd|todo|unknown|unnamed|reviewer|name|credential|qualification|à renseigner|a renseigner|non renseigné|non renseigne)(?:\b|$)|[<>]/i.test(
    normalize(value),
  );
}

function looksLikeFullName(value = "") {
  const text = normalize(value);
  if (!text || isPlaceholder(text)) return false;
  const words = text.match(/[\p{L}][\p{L}'’.-]*/gu) ?? [];
  if (words.length < 2) return false;
  const genericOnly = /^(?:IATA|ANAC|KOST|reviewer|instructor|auditor|admin|administrator|team|staff|operator)$/i;
  return !words.every((word) => genericOnly.test(word));
}

function hasIsoDate(value = "") {
  return /\b\d{4}-\d{2}-\d{2}\b/.test(value);
}

function terminalFrSourceState(value = "") {
  const text = normalize(value).toUpperCase();
  if (!text) return false;
  if (/SOURCE CONFLICT|PARTIALLY CONFIRMED|STALE CITATION|\bDRAFT\b|SOURCE REQUIRED|NOT YET VERIFIED/.test(text)) {
    return false;
  }
  return /^FROZEN FR\s*\/\s*SOURCE VERIFIED\b/.test(text) || /^FR SOURCE GAP CONFIRMED\b/.test(text);
}

function parseReviewedByAnnotation(status, marker, requireCredential) {
  const normalized = normalize(status);
  const markerRe = marker === "fr"
    ? /FR TECHNICAL REVIEW COMPLETE\s*\(([^)]*)\)/i
    : /BILINGUAL TECHNICAL REVIEW COMPLETE(?:D)?\s*\(([^)]*)\)/i;
  const match = normalized.match(markerRe);
  if (!match) return { ok: false, reason: `${marker === "fr" ? "FR" : "EN"} review completion marker missing` };

  const body = match[1].replace(/^\s*reviewed by\s+/i, "").trim();
  if (!/^reviewed by\b/i.test(match[1].trim())) {
    return { ok: false, reason: `${marker === "fr" ? "FR" : "EN"} review does not identify who reviewed it` };
  }

  const date = body.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] ?? "";
  if (!date) return { ok: false, reason: `${marker === "fr" ? "FR" : "EN"} review ISO date missing` };

  const beforeDate = body.slice(0, body.indexOf(date)).replace(/[;,\-–—]+\s*$/g, "").trim();
  const parts = beforeDate.split(/\s*,\s*/).filter(Boolean);
  const name = parts[0] ?? "";
  if (!looksLikeFullName(name)) {
    return { ok: false, reason: `${marker === "fr" ? "FR" : "EN"} review does not contain a non-placeholder full reviewer name` };
  }

  if (requireCredential) {
    const credential = parts.slice(1).join(", ").trim();
    if (!credential || isPlaceholder(credential) || credential.length < 3) {
      return { ok: false, reason: "FR technical review is missing the reviewer's role/credential" };
    }
  }

  return { ok: true };
}

function finalApprovalLooksComplete(value = "") {
  const text = normalize(value);
  if (!isApproved(text)) return false;
  const date = text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] ?? "";
  if (!date) return false;
  const beforeDate = text
    .replace(/^APPROVED\b\s*[:\-–—]?\s*/i, "")
    .slice(0, text.replace(/^APPROVED\b\s*[:\-–—]?\s*/i, "").indexOf(date))
    .replace(/[;,\-–—]+\s*$/g, "")
    .trim();
  return looksLikeFullName(beforeDate);
}

function fieldFromBlock(block, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`^\\s*\\*\\*${escaped}:\\*\\*\\s*(.+)$`, "im"));
  return match?.[1]?.trim() ?? "";
}

function itemBlockRecords(text, artifact, kind) {
  const headingRe = /^#{2,4}\s+(Q-7\.(?:10|[1-9])-\d{3})\b.*$/gmi;
  const matches = [...text.matchAll(headingRe)];
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? text.length) : text.length;
    const block = text.slice(start, end);
    return {
      id: match[1].toUpperCase(),
      frStatus: fieldFromBlock(block, "FR status"),
      enStatus: fieldFromBlock(block, "EN status"),
      approval: fieldFromBlock(block, "Approval"),
      artifact,
      kind,
      format: "item",
    };
  });
}

function markdownCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return [];
  return trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
}

function tableRecords(text, artifact, kind) {
  const lines = text.split(/\r?\n/);
  const records = [];

  for (let i = 0; i < lines.length; i += 1) {
    const headers = markdownCells(lines[i]);
    if (!headers.length) continue;
    const normalized = headers.map((header) => normalize(header).toLowerCase());
    const idIndex = normalized.indexOf("id");
    const frIndex = normalized.indexOf("fr status");
    const enIndex = normalized.indexOf("en status");
    const approvalIndex = normalized.indexOf("approval");
    if ([idIndex, frIndex, enIndex, approvalIndex].some((index) => index < 0)) continue;

    const separator = markdownCells(lines[i + 1] ?? "");
    if (!separator.length) continue;

    for (let j = i + 2; j < lines.length; j += 1) {
      const cells = markdownCells(lines[j]);
      if (!cells.length) break;
      const id = normalize(cells[idIndex] ?? "").toUpperCase();
      if (!idPattern.test(id)) continue;
      records.push({
        id,
        frStatus: cells[frIndex] ?? "",
        enStatus: cells[enIndex] ?? "",
        approval: cells[approvalIndex] ?? "",
        artifact,
        kind,
        format: "table",
      });
    }
  }

  return records;
}

function recordsFromText(text, artifact, kind) {
  return [...itemBlockRecords(text, artifact, kind), ...tableRecords(text, artifact, kind)];
}

function validateApprovedRecord(record) {
  const errors = [];
  if (!isApproved(record.approval)) return errors;

  if (!terminalFrSourceState(record.frStatus)) {
    errors.push("Gate 1 is not in a permitted terminal FR source state");
  }

  const frReview = parseReviewedByAnnotation(record.frStatus, "fr", true);
  if (!frReview.ok) errors.push(`Gate 2 incomplete: ${frReview.reason}`);

  const enReview = parseReviewedByAnnotation(record.enStatus, "en", false);
  if (!enReview.ok) errors.push(`Gate 3 incomplete: ${enReview.reason}`);

  if (!finalApprovalLooksComplete(record.approval)) {
    errors.push("Gate 4 APPROVED field lacks a non-placeholder full accountable-reviewer name + ISO date");
  }

  return errors;
}

function validateRecords(records) {
  const errors = [];

  for (const record of records) {
    for (const error of validateApprovedRecord(record)) {
      errors.push(`${record.artifact}: ${record.id} (${record.format}) — ${error}`);
    }
  }

  const byId = new Map();
  for (const record of records) {
    if (!byId.has(record.id)) byId.set(record.id, []);
    byId.get(record.id).push(record);
  }

  for (const [id, idRecords] of byId) {
    if (!idRecords.some((record) => isApproved(record.approval))) continue;

    const explicitApprovalRecords = idRecords.filter((record) => normalize(record.approval));
    const inconsistent = explicitApprovalRecords.filter((record) => !isApproved(record.approval));
    if (inconsistent.length) {
      errors.push(
        `${id}: APPROVED is inconsistent with pending/non-approved duplicate record(s): ${inconsistent
          .map((record) => `${record.artifact} (${record.format}: ${normalize(record.approval)})`)
          .join("; ")}`,
      );
    }

    if (!idRecords.some((record) => record.kind === "bank")) {
      errors.push(`${id}: APPROVED has no durable production-bank/status record`);
    }
    if (!idRecords.some((record) => record.kind === "en")) {
      errors.push(`${id}: APPROVED has no separate EN review-package record`);
    }
  }

  return errors;
}

function readExisting(relativePath) {
  const absolute = path.join(root, relativePath);
  if (!fs.existsSync(absolute)) return "";
  return fs.readFileSync(absolute, "utf8");
}

function runRepositoryCheck() {
  const records = [];
  const stagePath = "docs/DGR_STAGE_2B_STATUS.md";
  records.push(...recordsFromText(readExisting(stagePath), stagePath, "bank"));

  for (const fn of functions) {
    const bankPath = `docs/DGR_PRODUCTION_BANK_${fn}.md`;
    const enPath = `docs/DGR_EN_REVIEW_PACKAGE_${fn}.md`;
    records.push(...recordsFromText(readExisting(bankPath), bankPath, "bank"));
    records.push(...recordsFromText(readExisting(enPath), enPath, "en"));
  }

  const errors = validateRecords(records);
  if (errors.length) {
    for (const error of errors) console.error(`ERROR: ${error}`);
    console.error(`\nDGR APPROVAL-CHAIN CHECK: FAIL (${errors.length} issue(s))`);
    process.exit(1);
  }

  const approvedIds = [...new Set(records.filter((record) => isApproved(record.approval)).map((record) => record.id))];
  console.log(`DGR APPROVAL-CHAIN CHECK: PASS (${approvedIds.length} APPROVED item(s) observed)`);
  console.log("PASS means only that any durable APPROVED claims satisfy the recorded gate chain; it does not prove regulatory correctness or ANAC/IATA approval.");
}

function expectFixture(name, text, expectedErrors) {
  const records = recordsFromText(text, `${name}.md`, "bank");
  const errors = validateRecords(records);
  const hasErrors = errors.length > 0;
  if (hasErrors !== expectedErrors) {
    throw new Error(`${name}: expected errors=${expectedErrors}, got ${errors.length}: ${errors.join(" | ")}`);
  }
}

function runRegressionFixtures() {
  const valid = `## Q-7.2-001 — fixture\n\n**FR status:** FROZEN FR / SOURCE VERIFIED — FR TECHNICAL REVIEW COMPLETE (reviewed by Jane Doe, DGR/CBTA Instructor, 2026-09-06)\n**EN status:** BILINGUAL TECHNICAL REVIEW COMPLETE (reviewed by John Smith, 2026-09-06)\n**Approval:** APPROVED — Jane Doe, 2026-09-06\n`;
  const gapValid = `## Q-7.2-002 — fixture\n\n**FR status:** FR SOURCE GAP CONFIRMED — Tier B/C basis retained — FR TECHNICAL REVIEW COMPLETE (reviewed by Jane Doe, DGR/CBTA Instructor, 2026-09-06)\n**EN status:** BILINGUAL TECHNICAL REVIEW COMPLETE (reviewed by John Smith, 2026-09-06)\n**Approval:** APPROVED — Jane Doe, 2026-09-06\n`;
  const draftApproved = valid.replace("FROZEN FR / SOURCE VERIFIED", "DRAFT — Tier A required");
  const noFrReview = valid.replace(" — FR TECHNICAL REVIEW COMPLETE (reviewed by Jane Doe, DGR/CBTA Instructor, 2026-09-06)", "");
  const noCredential = valid.replace("Jane Doe, DGR/CBTA Instructor, 2026-09-06", "Jane Doe, 2026-09-06");
  const enPending = valid.replace("BILINGUAL TECHNICAL REVIEW COMPLETE (reviewed by John Smith, 2026-09-06)", "BILINGUAL TECHNICAL REVIEW REQUIRED");
  const approvalNoName = valid.replace("APPROVED — Jane Doe, 2026-09-06", "APPROVED — Reviewer, 2026-09-06");
  const pending = `## Q-7.2-003 — fixture\n\n**FR status:** DRAFT\n**EN status:** BILINGUAL TECHNICAL REVIEW REQUIRED\n**Approval:** PENDING REVIEWER + DATE\n`;

  expectFixture("valid-approved-chain", valid, false);
  expectFixture("valid-source-gap-chain", gapValid, false);
  expectFixture("draft-approved", draftApproved, true);
  expectFixture("missing-fr-review", noFrReview, true);
  expectFixture("missing-fr-credential", noCredential, true);
  expectFixture("pending-en-review", enPending, true);
  expectFixture("generic-final-reviewer", approvalNoName, true);
  expectFixture("ordinary-pending-item", pending, false);

  const invalidTable = `| ID | FR status | Type | Current source basis | EN status | Approval |\n|---|---|---|---|---|---|\n| Q-7.3-001 | FROZEN FR / SOURCE VERIFIED | MCQ | fixture | BILINGUAL TECHNICAL REVIEW REQUIRED | APPROVED — Jane Doe, 2026-09-06 |\n`;
  expectFixture("table-approved-before-en-review", invalidTable, true);

  console.log("DGR approval-chain regression fixtures: PASS");
}

if (process.argv.includes("--test")) {
  runRegressionFixtures();
} else {
  runRepositoryCheck();
}
