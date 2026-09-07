#!/usr/bin/env node

/**
 * Cross-artifact approval consistency guard for DGR/CBTA 7.1-7.10.
 *
 * This checker never approves questions. It only rejects durable APPROVED
 * claims that are not consistently represented across the production-bank/
 * status layer and the separate EN review-package layer.
 */

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const functions = ["7.1", "7.2", "7.3", "7.4", "7.5", "7.6", "7.7", "7.8", "7.9", "7.10"];
const idPattern = /^Q-7\.(?:10|[1-9])-\d{3}$/i;

const normalize = (value = "") => value.replace(/[`*_]/g, " ").replace(/\s+/g, " ").trim();
const isApproved = (value = "") => /^APPROVED\b/i.test(normalize(value));

function isPlaceholder(value = "") {
  const text = normalize(value);
  return !text || /(?:^|\b)(?:pending|tbd|todo|unknown|unnamed|reviewer|name|credential|qualification|à renseigner|a renseigner|non renseigné|non renseigne)(?:\b|$)|[<>]/i.test(text);
}

function looksLikeFullName(value = "") {
  const text = normalize(value);
  if (!text || isPlaceholder(text)) return false;
  const words = text.match(/[\p{L}][\p{L}'’.-]*/gu) ?? [];
  if (words.length < 2) return false;
  const generic = /^(?:IATA|ANAC|KOST|reviewer|instructor|auditor|admin|administrator|team|staff|operator)$/i;
  return !words.every((word) => generic.test(word));
}

function looksLikeDgrCredential(value = "") {
  const text = normalize(value);
  if (!text || /(?:^|\b)(?:pending|tbd|todo|unknown|unnamed|à renseigner|a renseigner|non renseigné|non renseigne)(?:\b|$)|[<>]/i.test(text)) return false;
  return /\bDGR\b|\bCBTA\b|dangerous\s+goods|marchandises\s+dangereuses/i.test(text);
}

function looksExplicitlyBilingual(value = "") {
  const text = normalize(value);
  if (!text || /(?:^|\b)(?:pending|tbd|todo|unknown|unnamed|à renseigner|a renseigner|non renseigné|non renseigne)(?:\b|$)|[<>]/i.test(text)) return false;
  return /\bbilingual\b|\bbilingue\b|\bFR\s*[\/+&-]\s*EN\b|\bEN\s*[\/+&-]\s*FR\b|French\s*[\/+&-]\s*English|English\s*[\/+&-]\s*French|fran[cç]ais\s*[\/+&-]\s*anglais|anglais\s*[\/+&-]\s*fran[cç]ais/i.test(text);
}

function isRealNonFutureIsoDate(value = "") {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const instant = new Date(Date.UTC(year, month - 1, day));
  if (instant.getUTCFullYear() !== year || instant.getUTCMonth() !== month - 1 || instant.getUTCDate() !== day) return false;
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return instant.getTime() <= todayUtc;
}

function completedBilingualReview(value = "") {
  const text = normalize(value);
  const body = text.match(/BILINGUAL TECHNICAL REVIEW COMPLETE(?:D)?\s*\(reviewed by\s+([^)]*)\)/i)?.[1]?.trim() ?? "";
  if (!body) return { ok: false, reason: "canonical bilingual completion marker/reviewer missing" };
  const date = body.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] ?? "";
  if (!date) return { ok: false, reason: "EN ISO review date missing" };
  if (!isRealNonFutureIsoDate(date)) return { ok: false, reason: "EN review date is impossible or in the future" };
  const beforeDate = body.slice(0, body.indexOf(date)).replace(/[;,\-–—]+\s*$/g, "").trim();
  const parts = beforeDate.split(/\s*,\s*/).filter(Boolean);
  const name = parts[0] ?? "";
  const credential = parts.slice(1).join(", ").trim();
  if (!looksLikeFullName(name)) return { ok: false, reason: "full EN reviewer name missing/placeholder" };
  if (!looksLikeDgrCredential(credential)) return { ok: false, reason: "EN reviewer DGR/CBTA role or credential missing" };
  if (!looksExplicitlyBilingual(credential)) return { ok: false, reason: "EN reviewer credential does not explicitly establish bilingual competence" };
  return { ok: true };
}

function field(block, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return block.match(new RegExp(`^\\s*\\*\\*${escaped}:\\*\\*\\s*(.+)$`, "im"))?.[1]?.trim() ?? "";
}

function itemRecords(text, artifact, kind) {
  const re = /^#{2,4}\s+(Q-7\.(?:10|[1-9])-\d{3})\b.*$/gmi;
  const matches = [...text.matchAll(re)];
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? text.length) : text.length;
    const block = text.slice(start, end);
    return { id: match[1].toUpperCase(), en: field(block, "EN status"), approval: field(block, "Approval"), artifact, kind, format: "item" };
  });
}

function cells(line) {
  const text = line.trim();
  return text.startsWith("|") && text.endsWith("|") ? text.slice(1, -1).split("|").map((value) => value.trim()) : [];
}

function tableRecords(text, artifact, kind) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const headers = cells(lines[i]);
    const normalized = headers.map((value) => normalize(value).toLowerCase());
    const idIndex = normalized.indexOf("id");
    const enIndex = normalized.indexOf("en status");
    const approvalIndex = normalized.indexOf("approval");
    if (idIndex < 0 || enIndex < 0 || approvalIndex < 0 || !cells(lines[i + 1] ?? "").length) continue;
    for (let j = i + 2; j < lines.length; j += 1) {
      const row = cells(lines[j]);
      if (!row.length) break;
      const id = normalize(row[idIndex] ?? "").toUpperCase();
      if (!idPattern.test(id)) continue;
      out.push({ id, en: row[enIndex] ?? "", approval: row[approvalIndex] ?? "", artifact, kind, format: "table" });
    }
  }
  return out;
}

const recordsFromText = (text, artifact, kind) => [...itemRecords(text, artifact, kind), ...tableRecords(text, artifact, kind)];

function validate(records) {
  const errors = [];
  const byId = new Map();
  for (const record of records) {
    if (!byId.has(record.id)) byId.set(record.id, []);
    byId.get(record.id).push(record);
  }
  for (const [id, set] of byId) {
    if (!set.some((record) => isApproved(record.approval))) continue;
    const bankRecords = set.filter((record) => record.kind === "bank");
    const enRecords = set.filter((record) => record.kind === "en");
    if (!bankRecords.some((record) => isApproved(record.approval))) {
      errors.push(`${id}: APPROVED exists outside the durable bank/status layer; no bank/status record is itself APPROVED`);
    }
    if (!enRecords.length) {
      errors.push(`${id}: APPROVED has no separate EN review-package record`);
      continue;
    }
    if (!enRecords.some((record) => completedBilingualReview(record.en).ok)) {
      errors.push(`${id}: separate EN review package has no canonical completed qualified bilingual DGR/CBTA review`);
    }
    for (const record of enRecords) {
      const enState = normalize(record.en);
      if (!enState) continue;
      const result = completedBilingualReview(enState);
      if (!result.ok) {
        errors.push(`${record.artifact}: ${id} (${record.format}) — contradictory/non-complete EN package state for APPROVED item: ${result.reason}`);
      }
    }
  }
  return errors;
}

function read(relative) {
  const absolute = path.join(root, relative);
  return fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : "";
}

function repositoryCheck() {
  const records = [];
  records.push(...recordsFromText(read("docs/DGR_STAGE_2B_STATUS.md"), "docs/DGR_STAGE_2B_STATUS.md", "bank"));
  for (const fn of functions) {
    const bank = `docs/DGR_PRODUCTION_BANK_${fn}.md`;
    const en = `docs/DGR_EN_REVIEW_PACKAGE_${fn}.md`;
    records.push(...recordsFromText(read(bank), bank, "bank"));
    records.push(...recordsFromText(read(en), en, "en"));
  }
  const errors = validate(records);
  if (errors.length) {
    errors.forEach((error) => console.error(`ERROR: ${error}`));
    console.error(`\nDGR CROSS-ARTIFACT APPROVAL CHECK: FAIL (${errors.length} issue(s))`);
    process.exit(1);
  }
  const approved = new Set(records.filter((record) => isApproved(record.approval)).map((record) => record.id));
  console.log(`DGR CROSS-ARTIFACT APPROVAL CHECK: PASS (${approved.size} APPROVED item(s) observed)`);
  console.log("PASS validates only cross-artifact approval consistency; it does not prove regulatory correctness or ANAC/IATA approval.");
}

function fixtureRecords(bankText, enText) {
  return [...recordsFromText(bankText, "bank.md", "bank"), ...recordsFromText(enText, "en.md", "en")];
}

function expect(name, bankText, enText, shouldFail) {
  const errors = validate(fixtureRecords(bankText, enText));
  if ((errors.length > 0) !== shouldFail) throw new Error(`${name}: expected fail=${shouldFail}, got ${errors.length}: ${errors.join(" | ")}`);
}

function fixtures() {
  const bankApproved = `## Q-7.2-001\n\n**EN status:** BILINGUAL TECHNICAL REVIEW COMPLETE (reviewed by John Smith, Bilingual DGR Reviewer, 2026-09-06)\n**Approval:** APPROVED — Jane Doe, 2026-09-06\n`;
  const bankPending = bankApproved.replace("APPROVED — Jane Doe, 2026-09-06", "PENDING REVIEWER + DATE");
  const enComplete = `## Q-7.2-001\n\n**EN status:** BILINGUAL TECHNICAL REVIEW COMPLETE (reviewed by John Smith, Bilingual DGR Reviewer, 2026-09-06)\n**Approval:**\n`;
  const enPending = enComplete.replace("BILINGUAL TECHNICAL REVIEW COMPLETE (reviewed by John Smith, Bilingual DGR Reviewer, 2026-09-06)", "BILINGUAL TECHNICAL REVIEW REQUIRED");
  const enApproved = enComplete.replace("**Approval:**", "**Approval:** APPROVED — Jane Doe, 2026-09-06");
  expect("valid-cross-artifact", bankApproved, enComplete, false);
  expect("bank-approved-en-pending", bankApproved, enPending, true);
  expect("en-only-approved-bank-pending", bankPending, enApproved, true);
  expect("bank-approved-no-en-record", bankApproved, "", true);
  const contradictoryEn = `${enComplete}\n## Q-7.2-001\n\n**EN status:** BILINGUAL TECHNICAL REVIEW REQUIRED\n**Approval:**\n`;
  expect("contradictory-en-record", bankApproved, contradictoryEn, true);
  expect("ordinary-pending", bankPending, enPending, false);
  console.log("DGR cross-artifact approval regression fixtures: PASS");
}

if (process.argv.includes("--test")) fixtures();
else repositoryCheck();
