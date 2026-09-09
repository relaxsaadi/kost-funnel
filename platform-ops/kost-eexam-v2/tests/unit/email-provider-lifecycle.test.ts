import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb } from "./test-db";

describe("Resend provider lifecycle evidence — #100", async () => {
  let db: ReturnType<typeof import("../../lib/db").getDb>;

  before(async () => {
    setupTestDb();
    db = (await import("../../lib/db")).getDb();
  });

  function makeNotification(key: string, providerMessageId: string) {
    const result = db.prepare(
      `INSERT INTO notification_log
         (recipient_email, event_type, template_id, template_version, subject,
          idempotency_key, status, provider_message_id, created_at)
       VALUES ('lifecycle@example.com', 'ACCOUNT_CREATED', 'test', 'v1', 'Test',
               ?, 'SENT', ?, '2026-09-09T12:00:00.000Z')`
    ).run(key, providerMessageId);
    return Number(result.lastInsertRowid);
  }

  function evidence(providerEventId: string, providerCreatedAt: string) {
    return { providerEventId, providerCreatedAt };
  }

  function providerAuditRows(notificationId: number) {
    return db.prepare(
      `SELECT metadata_json
       FROM audit_logs
       WHERE action = 'notification_provider_event'
         AND target_type = 'notification_log'
         AND target_id = ?
       ORDER BY id`
    ).all(notificationId) as { metadata_json: string }[];
  }

  test("normalise un timestamp provider absolu et refuse une date ambiguë/malformée", async () => {
    const { normalizeProviderEventTimestamp } = await import("../../lib/email/webhook");
    assert.equal(normalizeProviderEventTimestamp("2026-09-09T12:34:56+01:00"), "2026-09-09T11:34:56.000Z");
    assert.equal(normalizeProviderEventTimestamp("2026-09-09T12:34:56Z"), "2026-09-09T12:34:56.000Z");
    assert.equal(normalizeProviderEventTimestamp("2026-09-09 12:34:56"), null);
    assert.equal(normalizeProviderEventTimestamp("not-a-date"), null);
    assert.equal(normalizeProviderEventTimestamp(undefined), null);
  });

  test("delivered → complained conserve les deux preuves et affiche COMPLAINED comme outcome canonique", async () => {
    const { applyWebhookEvent, deriveCanonicalProviderOutcome } = await import("../../lib/email/webhook");
    const { listNotificationHistory } = await import("../../lib/email/history");
    const id = makeNotification("provider-lifecycle-1", "msg-provider-lifecycle-1");

    const delivered = applyWebhookEvent(
      "email.delivered",
      "msg-provider-lifecycle-1",
      evidence("evt-delivered-1", "2026-09-09T12:01:00.000Z")
    );
    const complained = applyWebhookEvent(
      "email.complained",
      "msg-provider-lifecycle-1",
      evidence("evt-complained-1", "2026-09-09T12:05:00.000Z")
    );
    assert.equal(delivered.applied, true);
    assert.equal(complained.applied, true, "une plainte nouvelle est appliquée comme preuve même si le snapshot est déjà terminal");

    const snapshot = db.prepare(`SELECT status FROM notification_log WHERE id = ?`).get(id) as { status: string };
    assert.equal(snapshot.status, "DELIVERED", "le snapshot historique reste compatible avec la politique existante");
    assert.ok(db.prepare(`SELECT 1 FROM email_suppressions WHERE email = 'lifecycle@example.com'`).get());

    const audits = providerAuditRows(id).map((row) => JSON.parse(row.metadata_json) as { providerEventType: string; providerCreatedAt: string });
    assert.deepEqual(audits.map((row) => row.providerEventType), ["email.delivered", "email.complained"]);
    assert.deepEqual(audits.map((row) => row.providerCreatedAt), ["2026-09-09T12:01:00.000Z", "2026-09-09T12:05:00.000Z"]);
    assert.equal(deriveCanonicalProviderOutcome(audits.map((row) => row.providerEventType)), "COMPLAINED");

    const history = listNotificationHistory({ userIdsOrNull: null, limit: 20 });
    const row = history.find((item) => item.id === id);
    assert.ok(row);
    assert.equal(row.provider_outcome, "COMPLAINED");
    assert.equal(row.provider_events.length, 2);

    const complainedFilter = listNotificationHistory({ userIdsOrNull: null, status: "COMPLAINED", limit: 20 });
    assert.ok(complainedFilter.some((item) => item.id === id), "le filtre COMPLAINED ne doit pas masquer cette preuve");
  });

  test("delivered → bounced conserve le bounce comme outcome critique et suppression durable", async () => {
    const { applyWebhookEvent } = await import("../../lib/email/webhook");
    const { listNotificationHistory } = await import("../../lib/email/history");
    const id = makeNotification("provider-lifecycle-2", "msg-provider-lifecycle-2");

    applyWebhookEvent("email.delivered", "msg-provider-lifecycle-2", evidence("evt-delivered-2", "2026-09-09T13:00:00.000Z"));
    applyWebhookEvent("email.bounced", "msg-provider-lifecycle-2", evidence("evt-bounced-2", "2026-09-09T13:02:00.000Z"));

    const row = listNotificationHistory({ userIdsOrNull: null, limit: 20 }).find((item) => item.id === id);
    assert.ok(row);
    assert.equal(row.provider_outcome, "BOUNCED");
    assert.equal(row.provider_events.length, 2);
    assert.ok(db.prepare(`SELECT 1 FROM email_suppressions WHERE email = 'lifecycle@example.com' AND reason = 'hard_bounce'`).get());
  });

  test("un même svix-id est idempotent : une seule preuve provider et aucun double effet", async () => {
    const { applyWebhookEvent } = await import("../../lib/email/webhook");
    const id = makeNotification("provider-lifecycle-3", "msg-provider-lifecycle-3");
    const first = applyWebhookEvent(
      "email.complained",
      "msg-provider-lifecycle-3",
      evidence("evt-duplicate-3", "2026-09-09T14:00:00.000Z")
    );
    const second = applyWebhookEvent(
      "email.complained",
      "msg-provider-lifecycle-3",
      evidence("evt-duplicate-3", "2026-09-09T14:00:00.000Z")
    );

    assert.equal(first.applied, true);
    assert.equal(second.applied, false);
    assert.equal(second.reason, "stale_or_duplicate_event");
    assert.equal(providerAuditRows(id).length, 1);
    const suppressions = db.prepare(`SELECT COUNT(*) AS n FROM email_suppressions WHERE email = 'lifecycle@example.com'`).get() as { n: number };
    assert.equal(suppressions.n, 1);
  });

  test("l'ordre de réception ne masque pas une plainte : l'outcome canonique dépend de toute la preuve", async () => {
    const { applyWebhookEvent, deriveCanonicalProviderOutcome } = await import("../../lib/email/webhook");
    const id = makeNotification("provider-lifecycle-4", "msg-provider-lifecycle-4");

    applyWebhookEvent("email.complained", "msg-provider-lifecycle-4", evidence("evt-complained-4", "2026-09-09T15:05:00.000Z"));
    applyWebhookEvent("email.delivered", "msg-provider-lifecycle-4", evidence("evt-delivered-4", "2026-09-09T15:00:00.000Z"));

    const eventTypes = providerAuditRows(id).map((row) => (JSON.parse(row.metadata_json) as { providerEventType: string }).providerEventType);
    assert.deepEqual(eventTypes, ["email.complained", "email.delivered"]);
    assert.equal(deriveCanonicalProviderOutcome(eventTypes), "COMPLAINED");
  });

  test("une preuve malformée échoue fermée sans journal ni mutation", async () => {
    const { applyWebhookEvent } = await import("../../lib/email/webhook");
    const id = makeNotification("provider-lifecycle-5", "msg-provider-lifecycle-5");
    const result = applyWebhookEvent("email.delivered", "msg-provider-lifecycle-5", evidence("evt-invalid-5", "2026-09-09 16:00:00"));
    assert.equal(result.applied, false);
    assert.equal(result.reason, "invalid_event_evidence");
    assert.equal(providerAuditRows(id).length, 0);
    const snapshot = db.prepare(`SELECT status FROM notification_log WHERE id = ?`).get(id) as { status: string };
    assert.equal(snapshot.status, "SENT");
  });

  test("échec DB partiel rollbacke la preuve; le même event peut ensuite être rejoué et réparé", async () => {
    const { applyWebhookEvent } = await import("../../lib/email/webhook");
    const id = makeNotification("provider-lifecycle-6", "msg-provider-lifecycle-6");

    db.exec(`
      CREATE TRIGGER force_provider_lifecycle_failure
      BEFORE UPDATE ON notification_log
      WHEN NEW.status = 'COMPLAINED'
      BEGIN
        SELECT RAISE(ABORT, 'forced lifecycle failure');
      END;
    `);

    assert.throws(() =>
      applyWebhookEvent(
        "email.complained",
        "msg-provider-lifecycle-6",
        evidence("evt-replay-6", "2026-09-09T16:10:00.000Z")
      )
    );
    assert.equal(providerAuditRows(id).length, 0, "la preuve provider doit être rollbackée avec la mutation métier");
    assert.equal(Boolean(db.prepare(`SELECT 1 FROM email_suppressions WHERE email = 'lifecycle@example.com'`).get()), false);

    db.exec(`DROP TRIGGER force_provider_lifecycle_failure`);
    const replay = applyWebhookEvent(
      "email.complained",
      "msg-provider-lifecycle-6",
      evidence("evt-replay-6", "2026-09-09T16:10:00.000Z")
    );
    assert.equal(replay.applied, true);
    assert.equal(providerAuditRows(id).length, 1);
    assert.ok(db.prepare(`SELECT 1 FROM email_suppressions WHERE email = 'lifecycle@example.com'`).get());
  });
});
