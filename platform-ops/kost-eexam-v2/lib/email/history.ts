// Historique des notifications — métadonnées uniquement, jamais le contenu
// rendu de l'email. Depuis #100, la lecture joint également les événements
// provider signés conservés dans audit_logs afin qu'une plainte/bounce
// arrivée après un autre terminal reste visible et filtrable.
import { getDb } from "../db";
import { EMAIL_EVENT_TYPES, type EmailEventType } from "./types";
import { deriveCanonicalProviderOutcome, type CanonicalProviderOutcome } from "./webhook";

export interface NotificationProviderEventRow {
  provider_event_type: string;
  provider_created_at: string;
  received_at: string;
}

export interface NotificationHistoryRow {
  id: number;
  tenant_company_id: number | null;
  company_name: string | null;
  user_id: number | null;
  full_name: string | null;
  recipient_email: string;
  event_type: string;
  subject: string;
  /** Snapshot local historique (compatibilité opérations existantes). */
  status: string;
  /** Outcome fournisseur fail-closed dérivé de TOUTE la preuve observée. */
  provider_outcome: CanonicalProviderOutcome | null;
  provider_events: NotificationProviderEventRow[];
  failure_reason_safe: string | null;
  retry_count: number;
  metadata_json: string | null;
  created_at: string;
  sent_at: string | null;
  delivered_at: string | null;
}

type NotificationHistoryBaseRow = Omit<NotificationHistoryRow, "provider_outcome" | "provider_events">;

export interface NotificationHistoryFilters {
  userIdsOrNull: number[] | null;
  status?: string;
  eventType?: string;
  userId?: number;
  companyId?: number;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
}

const STATUS_TO_PROVIDER_EVENT: Readonly<Record<string, string>> = {
  SENT: "email.sent",
  DELIVERED: "email.delivered",
  DELAYED: "email.delivery_delayed",
  BOUNCED: "email.bounced",
  COMPLAINED: "email.complained",
  FAILED: "email.failed",
};

function parseProviderEvent(metadataJson: string | null, receivedAt: string): NotificationProviderEventRow | null {
  if (!metadataJson) return null;
  try {
    const metadata = JSON.parse(metadataJson) as {
      provider?: unknown;
      providerEventType?: unknown;
      providerCreatedAt?: unknown;
    };
    if (
      metadata.provider !== "resend" ||
      typeof metadata.providerEventType !== "string" ||
      typeof metadata.providerCreatedAt !== "string"
    ) {
      return null;
    }
    return {
      provider_event_type: metadata.providerEventType,
      provider_created_at: metadata.providerCreatedAt,
      received_at: receivedAt,
    };
  } catch {
    return null;
  }
}

function loadProviderEvents(notificationIds: number[]): Map<number, NotificationProviderEventRow[]> {
  const result = new Map<number, NotificationProviderEventRow[]>();
  if (notificationIds.length === 0) return result;

  const db = getDb();
  const placeholders = notificationIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT target_id AS notification_id, timestamp, metadata_json
       FROM audit_logs
       WHERE action = 'notification_provider_event'
         AND target_type = 'notification_log'
         AND target_id IN (${placeholders})
       ORDER BY timestamp ASC, id ASC`
    )
    .all(...notificationIds) as { notification_id: number; timestamp: string; metadata_json: string | null }[];

  for (const row of rows) {
    const event = parseProviderEvent(row.metadata_json, row.timestamp);
    if (!event) continue;
    const current = result.get(row.notification_id) ?? [];
    current.push(event);
    result.set(row.notification_id, current);
  }
  return result;
}

export function listNotificationHistory(filters: NotificationHistoryFilters): NotificationHistoryRow[] {
  const db = getDb();
  const clauses: string[] = [];
  const args: (string | number)[] = [];

  if (filters.userIdsOrNull !== null) {
    if (filters.userIdsOrNull.length === 0) return [];
    clauses.push(`n.user_id IN (${filters.userIdsOrNull.map(() => "?").join(",")})`);
    args.push(...filters.userIdsOrNull);
  }
  if (filters.status) {
    const providerEventType = STATUS_TO_PROVIDER_EVENT[filters.status];
    if (providerEventType) {
      // Le filtre ne doit pas masquer un bounce/complaint durablement
      // observé uniquement parce que le snapshot local avait déjà atteint
      // un autre terminal. JSON.stringify() du journal produit exactement
      // ce fragment ; valeur providerEventType ici issue d'une table fixe,
      // jamais de l'entrée utilisateur.
      clauses.push(
        `(n.status = ? OR EXISTS (
          SELECT 1 FROM audit_logs pe
          WHERE pe.action = 'notification_provider_event'
            AND pe.target_type = 'notification_log'
            AND pe.target_id = n.id
            AND pe.metadata_json LIKE ?
        ))`
      );
      args.push(filters.status, `%"providerEventType":"${providerEventType}"%`);
    } else {
      clauses.push(`n.status = ?`);
      args.push(filters.status);
    }
  }
  if (filters.eventType) {
    clauses.push(`n.event_type = ?`);
    args.push(filters.eventType);
  }
  if (filters.userId) {
    clauses.push(`n.user_id = ?`);
    args.push(filters.userId);
  }
  if (filters.companyId) {
    clauses.push(`n.tenant_company_id = ?`);
    args.push(filters.companyId);
  }
  if (filters.search) {
    clauses.push(`LOWER(n.recipient_email) LIKE ?`);
    args.push(`%${filters.search.toLowerCase()}%`);
  }
  if (filters.dateFrom) {
    clauses.push(`n.created_at >= ?`);
    args.push(`${filters.dateFrom}T00:00:00.000Z`);
  }
  if (filters.dateTo) {
    clauses.push(`n.created_at <= ?`);
    args.push(`${filters.dateTo}T23:59:59.999Z`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = filters.limit ?? 200;
  const baseRows = db
    .prepare(
      `SELECT n.id, n.tenant_company_id, c.name AS company_name, n.user_id, u.full_name,
              n.recipient_email, n.event_type, n.subject, n.status, n.failure_reason_safe,
              n.retry_count, n.metadata_json, n.created_at, n.sent_at, n.delivered_at
       FROM notification_log n
       LEFT JOIN companies c ON c.id = n.tenant_company_id
       LEFT JOIN users u ON u.id = n.user_id
       ${where}
       ORDER BY n.id DESC
       LIMIT ?`
    )
    .all(...args, limit) as unknown as NotificationHistoryBaseRow[];

  const providerEvents = loadProviderEvents(baseRows.map((row) => row.id));
  return baseRows.map((row) => {
    const events = providerEvents.get(row.id) ?? [];
    return {
      ...row,
      provider_events: events,
      provider_outcome: deriveCanonicalProviderOutcome(events.map((event) => event.provider_event_type)),
    };
  });
}

export function notificationHistorySummary(userIdsOrNull: number[] | null): { status: string; count: number }[] {
  const db = getDb();
  if (userIdsOrNull !== null && userIdsOrNull.length === 0) return [];
  const where = userIdsOrNull !== null ? `WHERE user_id IN (${userIdsOrNull.map(() => "?").join(",")})` : "";
  const args = userIdsOrNull !== null ? userIdsOrNull : [];
  return db
    .prepare(`SELECT status, COUNT(*) AS count FROM notification_log ${where} GROUP BY status ORDER BY count DESC`)
    .all(...args) as unknown as { status: string; count: number }[];
}

export const KNOWN_EVENT_TYPES: EmailEventType[] = EMAIL_EVENT_TYPES;
