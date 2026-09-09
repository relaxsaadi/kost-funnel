import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb } from "./test-db";

describe("Resend webhook failure atomicity — #63", async () => {
  let db: ReturnType<typeof import("../../lib/db").getDb>;

  before(async () => {
    setupTestDb();
    db = (await import("../../lib/db")).getDb();
  });

  function makeNotification(key: string, providerMessageId: string) {
    const email = `${key}@example.com`;
    const result = db.prepare(
      `INSERT INTO notification_log
         (recipient_email, event_type, template_id, template_version, subject,
          idempotency_key, status, provider_message_id, created_at)
       VALUES (?, 'ACCOUNT_CREATED', 'test', 'v1', 'Test',
               ?, 'SENT', ?, '2026-09-09T12:00:00.000Z')`
    ).run(email, key, providerMessageId);
    return { id: Number(result.lastInsertRowid), email };
  }

  function evidence(providerEventId: string, providerCreatedAt: string) {
    return { providerEventId, providerCreatedAt };
  }

  function auditCount(notificationId: number, action: string): number {
    const row = db.prepare(
      `SELECT COUNT(*) AS n
       FROM audit_logs
       WHERE action = ? AND target_type = 'notification_log' AND target_id = ?`
    ).get(action, notificationId) as { n: number };
    return row.n;
  }

  test("FAILED + audit métier sont atomiques; un échec pendant l'audit rollbacke puis le même event répare", async () => {
    const { applyWebhookEvent } = await import("../../lib/email/webhook");
    const { id } = makeNotification("atomic-failed", "msg-atomic-failed");

    db.exec(`
      CREATE TRIGGER force_failed_business_audit_failure
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'notification_delivery_failed'
      BEGIN
        SELECT RAISE(ABORT, 'forced failed audit failure');
      END;
    `);

    assert.throws(() =>
      applyWebhookEvent(
        "email.failed",
        "msg-atomic-failed",
        evidence("evt-atomic-failed", "2026-09-09T16:20:00.000Z")
      )
    );

    const afterFailure = db.prepare(`SELECT status, failed_at FROM notification_log WHERE id = ?`).get(id) as {
      status: string;
      failed_at: string | null;
    };
    assert.equal(afterFailure.status, "SENT", "le terminal FAILED ne doit pas survivre sans son audit requis");
    assert.equal(afterFailure.failed_at, null);
    assert.equal(auditCount(id, "notification_provider_event"), 0, "la preuve provider doit rollbacker avec le statut");
    assert.equal(auditCount(id, "notification_delivery_failed"), 0);

    db.exec(`DROP TRIGGER force_failed_business_audit_failure`);
    const replay = applyWebhookEvent(
      "email.failed",
      "msg-atomic-failed",
      evidence("evt-atomic-failed", "2026-09-09T16:20:00.000Z")
    );
    assert.equal(replay.applied, true);

    const repaired = db.prepare(`SELECT status, failed_at FROM notification_log WHERE id = ?`).get(id) as {
      status: string;
      failed_at: string | null;
    };
    assert.equal(repaired.status, "FAILED");
    assert.equal(repaired.failed_at, "2026-09-09T16:20:00.000Z");
    assert.equal(auditCount(id, "notification_provider_event"), 1);
    assert.equal(auditCount(id, "notification_delivery_failed"), 1);
  });

  test("BOUNCED + suppression + audits sont atomiques; un échec d'audit ne laisse aucun effet partiel", async () => {
    const { applyWebhookEvent } = await import("../../lib/email/webhook");
    const { id, email } = makeNotification("atomic-bounced", "msg-atomic-bounced");

    db.exec(`
      CREATE TRIGGER force_bounce_business_audit_failure
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'notification_bounced'
      BEGIN
        SELECT RAISE(ABORT, 'forced bounce audit failure');
      END;
    `);

    assert.throws(() =>
      applyWebhookEvent(
        "email.bounced",
        "msg-atomic-bounced",
        evidence("evt-atomic-bounced", "2026-09-09T16:25:00.000Z")
      )
    );

    const afterFailure = db.prepare(`SELECT status, bounced_at FROM notification_log WHERE id = ?`).get(id) as {
      status: string;
      bounced_at: string | null;
    };
    assert.equal(afterFailure.status, "SENT");
    assert.equal(afterFailure.bounced_at, null);
    assert.equal(Boolean(db.prepare(`SELECT 1 FROM email_suppressions WHERE email = ?`).get(email)), false);
    assert.equal(auditCount(id, "notification_provider_event"), 0);
    assert.equal(auditCount(id, "notification_bounced"), 0);

    db.exec(`DROP TRIGGER force_bounce_business_audit_failure`);
    const replay = applyWebhookEvent(
      "email.bounced",
      "msg-atomic-bounced",
      evidence("evt-atomic-bounced", "2026-09-09T16:25:00.000Z")
    );
    assert.equal(replay.applied, true);

    const repaired = db.prepare(`SELECT status, bounced_at FROM notification_log WHERE id = ?`).get(id) as {
      status: string;
      bounced_at: string | null;
    };
    assert.equal(repaired.status, "BOUNCED");
    assert.equal(repaired.bounced_at, "2026-09-09T16:25:00.000Z");
    assert.ok(db.prepare(`SELECT 1 FROM email_suppressions WHERE email = ? AND reason = 'hard_bounce'`).get(email));
    assert.equal(auditCount(id, "notification_provider_event"), 1);
    assert.equal(auditCount(id, "notification_bounced"), 1);
  });
});
