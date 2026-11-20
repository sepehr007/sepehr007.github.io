import fs from "node:fs";
import { getDatabase, databaseState, all, get } from "../database/index.js";
import { dbReady } from "../db.js";
import { adminLimit, permissionOnly } from "../adminGuard.js";
import { appConfig } from "../config.js";
import { storageSummary } from "../storage.js";

const DAY = 86_400_000;

function fail(reply, status, error, message) {
  return reply.code(status).send({ error, message });
}

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function rangeOf(query) {
  const now = Date.now();
  const days = Number(query?.days);
  const to = Math.min(now + DAY, Number(query?.to) || now);
  const from = Number(query?.from) || (Number.isFinite(days) && days > 0 ? to - Math.min(366, days) * DAY : to - 30 * DAY);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return null;
  if (to - from > 366 * DAY) return null;
  return { from, to, days: Math.max(1, Math.round((to - from) / DAY)) };
}

function dayLabels(from, to) {
  const labels = [];
  const cursor = new Date(from);
  cursor.setUTCHours(0, 0, 0, 0);
  while (cursor.getTime() <= to) {
    labels.push(dayKey(cursor.getTime()));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return labels;
}

function seriesMap(rows) {
  const map = new Map();
  for (const row of rows) map.set(row.d, Number(row.n || 0));
  return map;
}

function fill(labels, map) {
  return labels.map((label) => map.get(label) || 0);
}

function csvEscape(value) {
  const text = String(value == null ? "" : value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(rows, columns) {
  const lines = [columns.map((column) => column.label).join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvEscape(column.get(row))).join(","));
  return "\uFEFF" + lines.join("\n");
}

function pct(part, whole) {
  if (!whole) return null;
  return Math.round((Number(part) / Number(whole)) * 1000) / 10;
}

export default async function adminAnalyticsRoutes(app) {
  app.addHook("preHandler", adminLimit);

  app.get("/analytics/report", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "audit.read"))) return undefined;
    if (dbReady()) return fail(reply, 503, "sqlite_only", "Analytics needs the SQLite deployment.");
    const range = rangeOf(req.query);
    if (!range) return fail(reply, 400, "invalid_range", "Date range is invalid or longer than a year.");
    const db = await getDatabase();
    if (!db) return fail(reply, 503, "database_unavailable", "Database is not connected yet.");
    const { from, to } = range;
    const labels = dayLabels(from, to);
    const now = Date.now();

    const registrations = Number(get("SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL AND created_at BETWEEN ? AND ?", from, to)?.n || 0);
    const totalUsers = Number(get("SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL")?.n || 0);
    const activeUsers = Number(
      get(
        "SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE COALESCE(last_seen_at, created_at) BETWEEN ? AND ?",
        from,
        to
      )?.n || 0
    );
    const messages = Number(get("SELECT COUNT(*) AS n FROM messages WHERE created_at BETWEEN ? AND ? AND deleted_at IS NULL", from, to)?.n || 0);
    const roomsCreated = Number(get("SELECT COUNT(*) AS n FROM rooms WHERE created_at BETWEEN ? AND ? AND deleted_at IS NULL", from, to)?.n || 0);
    const activeRooms = Number(get("SELECT COUNT(*) AS n FROM rooms WHERE is_active = 1 AND deleted_at IS NULL")?.n || 0);
    const joinings = Number(get("SELECT COUNT(*) AS n FROM room_memberships WHERE joined_at BETWEEN ? AND ?", from, to)?.n || 0);

    const watchRow = get("SELECT COALESCE(SUM(watched_seconds),0) AS seconds, COUNT(*) AS rows FROM playback_history WHERE last_watched_at BETWEEN ? AND ?", from, to);
    const watchTotalRows = Number(get("SELECT COUNT(*) AS n FROM playback_history")?.n || 0);
    const watchTime = { available: watchTotalRows > 0, seconds: Number(watchRow?.seconds || 0), sessions: Number(watchRow?.rows || 0), reason: watchTotalRows ? "" : "no_watch_history" };

    const paymentsPaid = get(
      "SELECT COALESCE(SUM(amount),0) AS amount, COUNT(*) AS count FROM payments WHERE status = 'paid' AND COALESCE(paid_at, verified_at, created_at) BETWEEN ? AND ?",
      from,
      to
    );
    const refunds = get(
      "SELECT COALESCE(SUM(amount),0) AS amount, COUNT(*) AS count FROM payments WHERE status = 'refunded' AND refunded_at BETWEEN ? AND ?",
      from,
      to
    );
    const activeSubs = Number(get("SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ?)", now)?.n || 0);
    const trialSubs = Number(get("SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active' AND renewal_status = 'trial'")?.n || 0);
    const pendingOrders = Number(get("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'")?.n || 0);
    const activated = Number(get("SELECT COUNT(*) AS n FROM subscription_events WHERE type = 'activated' AND created_at BETWEEN ? AND ?", from, to)?.n || 0);
    const expired = Number(get("SELECT COUNT(*) AS n FROM subscription_events WHERE type = 'expired' AND created_at BETWEEN ? AND ?", from, to)?.n || 0);

    const ticketsCreated = Number(get("SELECT COUNT(*) AS n FROM support_tickets WHERE created_at BETWEEN ? AND ?", from, to)?.n || 0);
    const ticketsResolved = Number(get("SELECT COUNT(*) AS n FROM support_tickets WHERE resolved_at BETWEEN ? AND ?", from, to)?.n || 0);
    const ticketsOpen = Number(get("SELECT COUNT(*) AS n FROM support_tickets WHERE status IN ('open','pending')")?.n || 0);
    const avgResolution = get("SELECT AVG(resolved_at - created_at) AS ms FROM support_tickets WHERE resolved_at BETWEEN ? AND ?", from, to);

    const reportsSocial = Number(get("SELECT COUNT(*) AS n FROM reports WHERE created_at BETWEEN ? AND ?", from, to)?.n || 0);
    const reportsMessages = Number(get("SELECT COUNT(*) AS n FROM message_reports WHERE created_at BETWEEN ? AND ?", from, to)?.n || 0);
    const reportsOpen = Number(get("SELECT COUNT(*) AS n FROM reports WHERE status IN ('open','reviewing')")?.n || 0);
    const reportsClosed = Number(
      get(
        "SELECT COUNT(*) AS n FROM reports WHERE status IN ('resolved','dismissed') AND updated_at BETWEEN ? AND ?",
        from,
        to
      )?.n || 0
    );

    const analyticsRows = Number(get("SELECT COUNT(*) AS n FROM analytics_events WHERE created_at BETWEEN ? AND ?", from, to)?.n || 0);
    const topPaths = all(
      "SELECT path, COUNT(*) AS n FROM analytics_events WHERE created_at BETWEEN ? AND ? GROUP BY path ORDER BY n DESC LIMIT 8",
      from,
      to
    ).map((row) => ({ path: row.path || "/", count: Number(row.n) }));
    const pageViews = { available: analyticsRows > 0, count: analyticsRows, reason: analyticsRows ? "" : "no_page_events_collected" };

    const failedPayments = Number(get("SELECT COUNT(*) AS n FROM payments WHERE status = 'failed' AND updated_at BETWEEN ? AND ?", from, to)?.n || 0);
    const failedRuns = Number(get("SELECT COUNT(*) AS n FROM automation_runs WHERE status = 'failed' AND started_at BETWEEN ? AND ?", from, to)?.n || 0);
    const errorStats = {
      available: true,
      failedPayments,
      failedAutomationRuns: failedRuns,
      total: failedPayments + failedRuns,
      note: "فقط خطاهای ثبت‌شده در پرداخت و گردش‌کار می‌آیند؛ خطای شبکه/مرورگر کلاینت رصد نمی‌شود."
    };

    const storage = await storageSummary();
    const dbSize = (() => {
      try {
        return fs.statSync(appConfig.sqliteFile).size;
      } catch {
        return null;
      }
    })();
    const memory = process.memoryUsage();
    const system = {
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      dbSizeBytes: dbSize,
      dbFile: databaseState()?.file ? "sqlite" : "",
      storageBytes: storage?.totalBytes ?? null,
      latency: { available: false, reason: "request_latency_not_instrumented" }
    };

    const series =
      {
        registrations: seriesMap(all("SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch') AS d, COUNT(*) AS n FROM users WHERE deleted_at IS NULL AND created_at BETWEEN ? AND ? GROUP BY d", from, to)),
        messages: seriesMap(all("SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch') AS d, COUNT(*) AS n FROM messages WHERE deleted_at IS NULL AND created_at BETWEEN ? AND ? GROUP BY d", from, to)),
        revenue: seriesMap(all("SELECT strftime('%Y-%m-%d', COALESCE(paid_at, verified_at, created_at)/1000, 'unixepoch') AS d, COALESCE(SUM(amount),0) AS n FROM payments WHERE status = 'paid' AND COALESCE(paid_at, verified_at, created_at) BETWEEN ? AND ? GROUP BY d", from, to)),
        tickets: seriesMap(all("SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch') AS d, COUNT(*) AS n FROM support_tickets WHERE created_at BETWEEN ? AND ? GROUP BY d", from, to)),
        reports: seriesMap(all("SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch') AS d, COUNT(*) AS n FROM reports WHERE created_at BETWEEN ? AND ? GROUP BY d", from, to)),
        pageViews: seriesMap(all("SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch') AS d, COUNT(*) AS n FROM analytics_events WHERE created_at BETWEEN ? AND ? GROUP BY d", from, to))
      };

    return {
      ok: true,
      generatedAt: now,
      range: { from, to, days: range.days, bucket: "day" },
      summary: {
        registrations,
        totalUsers,
        activeUsers,
        messages,
        roomsCreated,
        activeRooms,
        joinings,
        watchTime,
        revenue: { amount: Number(paymentsPaid?.amount || 0), payments: Number(paymentsPaid?.count || 0), currency: "IRT" },
        refunds: { amount: Number(refunds?.amount || 0), payments: Number(refunds?.count || 0) },
        subscriptions: { active: activeSubs, trials: trialSubs, pendingOrders, activated, expired },
        support: {
          created: ticketsCreated,
          resolved: ticketsResolved,
          open: ticketsOpen,
          avgResolutionHours: avgResolution?.ms ? Math.round((Number(avgResolution.ms) / 3_600_000) * 10) / 10 : null
        },
        moderation: { reports: reportsSocial + reportsMessages, open: reportsOpen, closed: reportsClosed },
        pageViews,
        errors: errorStats,
        storage: storage
          ? { usedBytes: storage.totalBytes, diskBytes: storage.diskBytes, files: storage.totalFiles, deletedBytes: storage.deleted.bytes }
          : { available: false, reason: "storage_unavailable" },
        system
      },
      availability: {
        watchTime: watchTime.available,
        pageViews: pageViews.available,
        latency: false,
        storage: Boolean(storage),
        revenue: true,
        support: true
      },
      topPaths,
      registrationsSharePct: pct(registrations, totalUsers) ?? 0,
      series: {
        labels,
        registrations: fill(labels, series.registrations),
        messages: fill(labels, series.messages),
        revenue: fill(labels, series.revenue),
        tickets: fill(labels, series.tickets),
        reports: fill(labels, series.reports),
        pageViews: analyticsRows ? fill(labels, series.pageViews) : null
      }
    };
  });

  app.get("/analytics/export", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "audit.read"))) return undefined;
    if (dbReady()) return fail(reply, 503, "sqlite_only", "Analytics needs the SQLite deployment.");
    const range = rangeOf(req.query);
    if (!range) return fail(reply, 400, "invalid_range", "Date range is invalid or longer than a year.");
    const dataset = String(req.query?.dataset || "registrations");
    const { from, to } = range;
    let rows;
    let columns;
    if (dataset === "revenue") {
      rows = all(
        "SELECT provider, amount, currency, status, paid_at, created_at FROM payments WHERE COALESCE(paid_at, verified_at, created_at) BETWEEN ? AND ? ORDER BY created_at DESC LIMIT 5000",
        from,
        to
      );
      columns = [
        { label: "provider", get: (row) => row.provider },
        { label: "amount", get: (row) => row.amount },
        { label: "currency", get: (row) => row.currency },
        { label: "status", get: (row) => row.status },
        { label: "paid_at", get: (row) => (row.paid_at ? new Date(row.paid_at).toISOString() : "") },
        { label: "created_at", get: (row) => new Date(row.created_at).toISOString() }
      ];
    } else if (dataset === "tickets") {
      rows = all("SELECT id, subject, category, priority, status, created_at, resolved_at FROM support_tickets WHERE created_at BETWEEN ? AND ? ORDER BY created_at DESC LIMIT 5000", from, to);
      columns = [
        { label: "id", get: (row) => row.id },
        { label: "subject", get: (row) => row.subject },
        { label: "category", get: (row) => row.category },
        { label: "priority", get: (row) => row.priority },
        { label: "status", get: (row) => row.status },
        { label: "created_at", get: (row) => new Date(row.created_at).toISOString() },
        { label: "resolved_at", get: (row) => (row.resolved_at ? new Date(row.resolved_at).toISOString() : "") }
      ];
    } else if (dataset === "reports") {
      rows = all("SELECT id, target_type, category, status, created_at FROM reports WHERE created_at BETWEEN ? AND ? ORDER BY created_at DESC LIMIT 5000", from, to);
      columns = [
        { label: "id", get: (row) => row.id },
        { label: "target_type", get: (row) => row.target_type },
        { label: "category", get: (row) => row.category },
        { label: "status", get: (row) => row.status },
        { label: "created_at", get: (row) => new Date(row.created_at).toISOString() }
      ];
    } else {
      rows = all("SELECT username, email, role, status, created_at FROM users WHERE created_at BETWEEN ? AND ? ORDER BY created_at DESC LIMIT 5000", from, to);
      columns = [
        { label: "username", get: (row) => row.username },
        { label: "email", get: (row) => row.email },
        { label: "role", get: (row) => row.role },
        { label: "status", get: (row) => row.status },
        { label: "created_at", get: (row) => new Date(row.created_at).toISOString() }
      ];
    }
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="analytics-${dataset}-${dayKey(from)}-${dayKey(to)}.csv"`);
    return csv(rows, columns);
  });
}
