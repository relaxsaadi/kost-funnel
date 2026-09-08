const NON_VERIFIED_EVIDENCE_RE = /SOURCE GAP|SOURCE CONFLICT|NOT YET VERIFIED|STALE CITATION|PARTIALLY CONFIRMED|\bDRAFT\b|SOURCE REQUIRED/i;
const NON_VERIFIED_FR_STATE_RE = /SOURCE GAP|SOURCE CONFLICT|NOT YET VERIFIED|NOT VERIFIED|UNVERIFIED|STALE CITATION|PARTIALLY CONFIRMED|\bDRAFT\b|SOURCE REQUIRED|NOT ATTEMPTED|UNATTEMPTED/i;
const PROVISIONAL_RE = /\b(?:pending|tbd|todo|requested|needed|missing)\b|\bto\s+(?:verify|check|confirm|locate)\b|\b(?:needs?|requires?)\s+(?:verification|checking|confirmation|a\s+locator|locator)\b|(?:à|a)\s+(?:vérifier|verifier|contrôler|controler|confirmer|localiser)/i;

export function isExplicitNonVerifiedEvidence(value) {
  return NON_VERIFIED_EVIDENCE_RE.test(String(value ?? ""));
}

export function isVerifiedFrState(value) {
  const text = String(value ?? "");
  if (NON_VERIFIED_FR_STATE_RE.test(text)) return false;
  return /FROZEN|SOURCE VERIFIED|\bVERIFIED\b/i.test(text);
}

export function hasIataDgrSourceIdentity(value) {
  const text = String(value ?? "")
    .replace(/[`*_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Deterministic provenance syntax only. `DGR` is the repository's canonical
  // shorthand for the IATA Dangerous Goods Regulations, so an explicit DGR
  // token is sufficient source-family identification. If the title is spelled
  // out instead, require the IATA name next to it so a generic "dangerous goods
  // regulations" phrase cannot satisfy the gate by accident.
  return Boolean(
    /\bDGR\b/i.test(text) ||
      /\bIATA\b.{0,48}\bDangerous\s+Goods\s+Regulations?\b/i.test(text) ||
      /\bDangerous\s+Goods\s+Regulations?\b.{0,48}\bIATA\b/i.test(text),
  );
}

export function hasCurrentEdition2026(value) {
  const text = String(value ?? "");
  const hasEdition = /\b67(?:th|e|ème|eme)\b|67th edition|67e édition/i.test(text);
  return hasIataDgrSourceIdentity(text) && hasEdition && /\b2026\b/.test(text);
}

export function hasConcreteLocator(value) {
  const text = String(value ?? "").replace(/[`*_]/g, " ");

  // Deterministic syntax only: this deliberately does not validate the cited
  // licensed IATA text. It requires a durable locator shape beyond the edition
  // and year, such as a section/table/page token or a dotted section number.
  return Boolean(
    /§{1,2}\s*\d+(?:\.\d+)*(?:\([a-z0-9]+\))*/i.test(text) ||
      /\b(?:section|subsection|paragraph|para\.?|table|figure|fig\.?|appendix|attachment|page|p\.)\s*(?:[a-z]?\d[\w.-]*|[a-z])\b/i.test(text) ||
      /\b[1-9]\d?(?:\.\d+){1,5}(?:\([a-z0-9]+\))*/i.test(text),
  );
}

export function hasProvisionalPhrase(value) {
  return PROVISIONAL_RE.test(String(value ?? ""));
}

export function reviewerAndDateLooksComplete(value) {
  const text = String(value ?? "").trim();
  const date = text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] ?? "";
  const reviewer = text
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "")
    .replace(/[|;,/()\-–—]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return Boolean(
    reviewer &&
      date &&
      !/pending|tbd|todo|not yet|non renseign|à renseigner|a renseigner/i.test(reviewer),
  );
}

export function validateTierAEvidenceForFrState({ tierAEvidence, frState, frVerifier }) {
  const errors = [];
  const evidence = String(tierAEvidence ?? "").trim();
  const verified = isVerifiedFrState(frState);
  const nonVerifiedEvidence = isExplicitNonVerifiedEvidence(evidence);

  if (!evidence) {
    errors.push("missing Tier-A evidence or explicit non-verified source state");
    return errors;
  }

  if (verified) {
    if (nonVerifiedEvidence) {
      errors.push("FR state claims verification while Tier-A evidence is explicitly non-verified");
    }
    if (hasProvisionalPhrase(evidence)) {
      errors.push("FR verified state relies on provisional/pending Tier-A evidence wording");
    }
    if (!hasCurrentEdition2026(evidence)) {
      errors.push("FR verified state lacks explicit IATA DGR 67th Edition 2026 evidence identification");
    }
    if (!hasConcreteLocator(evidence)) {
      errors.push("FR verified state lacks a concrete section/table/page locator");
    }
    if (!reviewerAndDateLooksComplete(frVerifier)) {
      errors.push("FR verified state lacks a named verifier + ISO review date");
    }
    return errors;
  }

  // Non-verified FR states may legitimately carry an explicit GAP/CONFLICT/
  // DRAFT marker. Otherwise, a cell that presents itself as evidence must still
  // be a current-edition locator rather than vague or provisional prose.
  if (nonVerifiedEvidence) return errors;

  if (hasProvisionalPhrase(evidence)) {
    errors.push("Tier-A evidence cell is provisional but does not use an explicit non-verified source state");
  }
  if (!hasCurrentEdition2026(evidence)) {
    errors.push("Tier-A evidence is neither an explicit non-verified state nor identified as IATA DGR 67th Edition 2026");
  }
  if (hasCurrentEdition2026(evidence) && !hasConcreteLocator(evidence)) {
    errors.push("current-edition Tier-A evidence lacks a concrete section/table/page locator");
  }

  return errors;
}
