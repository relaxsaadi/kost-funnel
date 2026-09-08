#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  hasConcreteLocator,
  hasCurrentEdition2026,
  hasCurrentEdition2026WithConcreteLocator,
  hasIataDgrSourceIdentity,
  isVerifiedFrState,
  validateTierAEvidenceForFrState,
} from "./lib/dgr-matrix-tier-a-policy.mjs";

function errors(input) {
  return validateTierAEvidenceForFrState(input);
}

assert.equal(isVerifiedFrState("FROZEN FR / SOURCE VERIFIED"), true);
assert.equal(isVerifiedFrState("NOT YET VERIFIED"), false);
assert.equal(isVerifiedFrState("SOURCE GAP"), false);
assert.equal(hasIataDgrSourceIdentity("IATA DGR 67th Edition 2026 § 5.0.1.2(c)"), true);
assert.equal(hasIataDgrSourceIdentity("DGR 67th Edition 2026 § 5.0.1.2(c)"), true);
assert.equal(hasIataDgrSourceIdentity("IATA Dangerous Goods Regulations 67th Edition 2026 § 5.0.1.2(c)"), true);
assert.equal(hasIataDgrSourceIdentity("67th Edition 2026 § 5.0.1.2(c)"), false);
assert.equal(hasIataDgrSourceIdentity("IATA 67th Edition 2026 § 5.0.1.2(c)"), false);
assert.equal(hasIataDgrSourceIdentity("Dangerous Goods Regulations 67th Edition 2026 § 5.0.1.2(c)"), false);
assert.equal(hasConcreteLocator("IATA DGR 67th Edition 2026 § 5.0.1.2(c)"), true);
assert.equal(hasConcreteLocator("IATA DGR 67th Edition 2026 Table 2.3.A"), true);
assert.equal(hasConcreteLocator("IATA DGR 67th Edition 2026"), false);

assert.equal(
  hasCurrentEdition2026("DGR 66th Edition 2025 §1.1; internal reference 67th Edition 2026 §2.2"),
  false,
  "an older DGR source and a separate current local source must not synthesize current DGR identity",
);
assert.equal(
  hasCurrentEdition2026WithConcreteLocator("DGR 67th Edition 2026; internal reference §2.2"),
  false,
  "a locator in another source segment must not satisfy current DGR direct-evidence syntax",
);
assert.equal(
  hasCurrentEdition2026WithConcreteLocator("DGR 67th Edition 2026 §1.1; internal cross-reference p.2"),
  true,
  "canonical current DGR identity and locator in the same source segment must remain valid",
);
assert.equal(
  hasCurrentEdition2026WithConcreteLocator(
    "DGR 66th Edition 2025 §1.1; IATA Dangerous Goods Regulations 67th Edition 2026 Table 2.3.A",
  ),
  true,
  "a separate segment that itself identifies current IATA DGR and a locator must remain valid",
);

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

for (const tierAEvidence of [
  "67th Edition 2026 § 5.0.1.2(c)",
  "IATA 67th Edition 2026 § 5.0.1.2(c)",
  "Dangerous Goods Regulations 67th Edition 2026 § 5.0.1.2(c)",
]) {
  assert.ok(
    errors({
      tierAEvidence,
      frState: "FROZEN FR / SOURCE VERIFIED",
      frVerifier: "Qualified Reviewer — 2026-09-06",
    }).some((error) => error.includes("explicit IATA DGR 67th Edition 2026 evidence identification")),
    `${tierAEvidence} must not satisfy the current Tier-A source-identity gate`,
  );
}

assert.ok(
  errors({
    tierAEvidence: "DGR 66th Edition 2025 §1.1; internal reference 67th Edition 2026 §2.2",
    frState: "FROZEN FR / SOURCE VERIFIED",
    frVerifier: "Qualified Reviewer — 2026-09-06",
  }).some((error) => error.includes("explicit IATA DGR 67th Edition 2026 evidence identification")),
  "mixed old-DGR/current-local evidence must fail instead of combining whole-cell tokens",
);

assert.ok(
  errors({
    tierAEvidence: "DGR 67th Edition 2026; internal reference §2.2",
    frState: "FROZEN FR / SOURCE VERIFIED",
    frVerifier: "Qualified Reviewer — 2026-09-06",
  }).some((error) => error.includes("bound to the same current DGR source segment")),
  "a locator from another source segment must not satisfy direct current DGR evidence",
);

assert.deepEqual(
  errors({
    tierAEvidence: "DGR 67th Edition 2026 § 5.0.1.2(c)",
    frState: "FROZEN FR / SOURCE VERIFIED",
    frVerifier: "Qualified Reviewer — 2026-09-06",
  }),
  [],
  "canonical DGR shorthand + current edition + direct locator + named verifier/date should pass syntax only",
);

assert.deepEqual(
  errors({
    tierAEvidence: "DGR 67th Edition 2026 §1.1; internal cross-reference p.2",
    frState: "FROZEN FR / SOURCE VERIFIED",
    frVerifier: "Qualified Reviewer — 2026-09-06",
  }),
  [],
  "secondary source notes must remain allowed when current DGR identity and locator are already bound",
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
