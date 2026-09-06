#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  hasConcreteLocator,
  isVerifiedFrState,
  validateTierAEvidenceForFrState,
} from "./lib/dgr-matrix-tier-a-policy.mjs";

function errors(input) {
  return validateTierAEvidenceForFrState(input);
}

assert.equal(isVerifiedFrState("FROZEN FR / SOURCE VERIFIED"), true);
assert.equal(isVerifiedFrState("NOT YET VERIFIED"), false);
assert.equal(isVerifiedFrState("SOURCE GAP"), false);
assert.equal(hasConcreteLocator("IATA DGR 67th Edition 2026 § 5.0.1.2(c)"), true);
assert.equal(hasConcreteLocator("IATA DGR 67th Edition 2026 Table 2.3.A"), true);
assert.equal(hasConcreteLocator("IATA DGR 67th Edition 2026"), false);

assert.ok(
  errors({
    tierAEvidence: "SOURCE GAP",
    frState: "FROZEN FR / SOURCE VERIFIED",
    frVerifier: "Qualified Reviewer — 2026-09-06",
  }).some((error) => error.includes("explicitly non-verified")),
  "SOURCE GAP + FR VERIFIED must fail",
);

assert.ok(
  errors({
    tierAEvidence: "IATA DGR 67th Edition 2026 — to verify",
    frState: "FROZEN FR / SOURCE VERIFIED",
    frVerifier: "Qualified Reviewer — 2026-09-06",
  }).length > 0,
  "current-edition wording with provisional phrase must fail",
);

assert.ok(
  errors({
    tierAEvidence: "IATA DGR 67th Edition 2026",
    frState: "FROZEN FR / SOURCE VERIFIED",
    frVerifier: "Qualified Reviewer — 2026-09-06",
  }).some((error) => error.includes("concrete section/table/page locator")),
  "edition/year alone must not satisfy a verified FR row",
);

assert.deepEqual(
  errors({
    tierAEvidence: "IATA DGR 67th Edition 2026 § 5.0.1.2(c)",
    frState: "FROZEN FR / SOURCE VERIFIED",
    frVerifier: "Qualified Reviewer — 2026-09-06",
  }),
  [],
  "current-edition direct locator + named verifier/date should pass syntax only",
);

assert.deepEqual(
  errors({
    tierAEvidence: "SOURCE CONFLICT",
    frState: "SOURCE CONFLICT",
    frVerifier: "",
  }),
  [],
  "non-verified FR states may carry explicit conflict evidence state",
);

assert.deepEqual(
  errors({
    tierAEvidence: "SOURCE GAP",
    frState: "NOT YET VERIFIED",
    frVerifier: "",
  }),
  [],
  "NOT YET VERIFIED must not be misclassified as a verified FR state",
);

assert.ok(
  errors({
    tierAEvidence: "IATA DGR 67th Edition 2026 source requested",
    frState: "SOURCE GAP",
    frVerifier: "",
  }).length > 0,
  "vague provisional evidence without an explicit non-verified marker must fail",
);

console.log("DGR Tier-A matrix policy regression fixtures: PASS");
