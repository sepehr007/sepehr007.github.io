import crypto from "node:crypto";
import { dbReady } from "../db.js";
import {
  databaseHealth,
  tableCounts,
  listAudit,
  pageLimit,
  recordModerationAction,
  all,
  get,
  run
} from "../database/index.js";
import { ensureStore, storeState } from "../userStore.js";
import { revokeAllSessionsFor, invalidateAuthCache } from "./auth.js";
import { mailState } from "../mailer.js";
import { smsState } from "../sms.js";
import { redisState } from "../redis.js";
import { audit } from "../audit.js";
import { adminLimit, ownerOnly } from "../adminGuard.js";
import {
  loadFeatureState,
  resolveFeatureState,
  featureStatus,
  summarizeFeatures,
  setFeatureOverride,
  clearFeatureOverride,
  scheduleFeatureChange,
  listFeatureOverrides,
  listFeatureSchedules,
  listFeatureHistory,
  removeSchedule,
  configHierarchy,
  FEATURE_CATALOG
} from "../features.js";
import {
  SETTINGS_REGISTRY,
  SETTINGS_CATEGORIES,
  getPlatformSettings,
  savePlatformSettings
} from "../platformSettings.js";

const DAY = 24 * 60 * 60 * 1000;
const ROLES = ["user", "member", "moderator", "administrator", "owner", "super_owner"];
const STATUSES = ["active", "suspended", "banned"];

function fail(reply, status, error, message) {
  return reply.code(status).send({ error, message });
}

async function ready(reply) {
  if (dbReady()) return true;
  if (await ensureStore()) return true;
  fail(reply, 503, "database_unavailable", "Database is not connected yet.");
  return false;
}

function safeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    nick: row.nick,
    role: row.role,
    status: row.status,
    phone: row.phone,
    city: row.city,
    emailVerified: Boolean(row.email_verified ?? row.emailVerified),
    createdAt: row.created_at ?? row.createdAt,
    lastLoginAt: row.last_login_at ?? row.lastLoginAt,
    lastSeenAt: row.last_seen_at ?? row.lastSeenAt
  };
}

function safeMessage(row) {
  return {
    id: row.id,
    room: row.room_code || row.roomCode || "",
    roomId: row.room_id,
    username: row.username,
    content: row.content,
    type: row.type,
    createdAt: row.created_at
  };
}

function num(value) {
  const n = Number(value?.n ?? value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function scalar(sql, params = []) {
  return num(get(sql, ...params));
}

export default async function platformRoutes(app) {
  app.addHook("preHandler", adminLimit);

  app.get("/overview", async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    if (!(await ready(reply))) return undefined;
    const now = Date.now();
    const featureState = await loadFeatureState();
    const counts = {
      users: scalar("SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL"),
      activeUsers: scalar("SELECT COUNT(*) AS n FROM users WHERE status = 'active' AND deleted_at IS NULL"),
      admins: scalar("SELECT COUNT(*) AS n FROM users WHERE role IN ('owner','super_owner','administrator')"),
      moderators: scalar("SELECT COUNT(*) AS n FROM users WHERE role = 'moderator'"),
      sessions: scalar("SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > ?", [now]),
      lobbiesActive: scalar("SELECT COUNT(*) AS n FROM lobbies WHERE active = 1 AND expires_at > ?", [now]),
      rooms: scalar("SELECT COUNT(*) AS n FROM rooms WHERE is_active = 1"),
      messages: scalar("SELECT COUNT(*) AS n FROM messages"),
      messages24h: scalar("SELECT COUNT(*) AS n FROM messages WHERE created_at > ?", [now - DAY]),
      reportsOpen: scalar("SELECT COUNT(*) AS n FROM message_reports WHERE status = 'open'"),
      ordersPending: scalar("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'"),
      subscriptionsActive: scalar("SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ?)", [now]),
      revenuePaid: scalar("SELECT COALESCE(SUM(amount),0) AS n FROM payments WHERE status = 'paid'")
    };
    const recentAudit = await listAudit({ limit: 8 });
    const recentUsers = all(
      "SELECT id, username, email, role, status, created_at FROM users WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 5"
    ).map(safeUser);
    return {
      ok: true,
      counts,
      features: summarizeFeatures(featureState),
      featureHealth: {
        total: FEATURE_CATALOG.length,
        off: FEATURE_CATALOG.filter((item) => featureState.flags?.[item.key]?.enabled === false).length
      },
      services: {
        store: storeState(),
        mail: mailState(),
        sms: smsState(),
        redis: redisState()
      },
      database: await databaseHealth(),
      recentAudit,
      recentUsers
    };
  });

  app.get("/users", async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    if (!(await ready(reply))) return undefined;
    const limit = pageLimit(req.query?.limit, 25, 100);
    const before = Number(req.query?.before) || Date.now() + 1;
    const q = String(req.query?.q || "").trim();
    const role = String(req.query?.role || "").trim();
    const status = String(req.query?.status || "").trim();
    const where = ["deleted_at IS NULL", "created_at < ?"];
    const params = [before];
    if (q) {
      where.push("(username LIKE ? OR email LIKE ? OR phone LIKE ?)");
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (role && ROLES.includes(role)) {
      where.push("role = ?");
      params.push(role);
    }
    if (status && STATUSES.includes(status)) {
      where.push("status = ?");
      params.push(status);
    }
    const rows = all(
      `SELECT id, username, email, nick, role, status, phone, city, email_verified, created_at, last_login_at, last_seen_at
       FROM users WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
      ...params,
      limit
    );
    return {
      ok: true,
      users: rows.map(safeUser),
      nextBefore: rows.length ? rows[rows.length - 1].created_at : 0,
      roles: ROLES,
      statuses: STATUSES
    };
  });

  app.patch("/users/:id", async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    if (!(await ready(reply))) return undefined;
    const target = get("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL", String(req.params.id));
    if (!target) return fail(reply, 404, "user_missing", "User not found.");
    const patch = {};
    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (body.role !== undefined) {
      if (!ROLES.includes(body.role)) return fail(reply, 400, "invalid_role", "That role does not exist.");
      patch.role = body.role;
    }
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) return fail(reply, 400, "invalid_status", "That status is not supported.");
      patch.status = body.status;
    }
    if (!Object.keys(patch).length) return fail(reply, 400, "nothing_to_update", "Send a role or status.");
    if (patch.role && patch.role !== target.role && String(target.id) === String(req.auth.userId)) {
      return fail(reply, 409, "self_role_change", "You cannot change your own role. Ask another owner.");
    }
    if (patch.role && patch.role !== target.role) {
      const remaining = scalar("SELECT COUNT(*) AS n FROM users WHERE role = 'super_owner' AND id <> ?", [target.id]);
      if (target.role === "super_owner" && remaining < 1) {
        return fail(reply, 409, "last_owner", "The last super owner cannot be demoted.");
      }
    }
    const now = Date.now();
    const sets = Object.keys(patch).map((key) => `${key} = ?`).join(", ");
    run(`UPDATE users SET ${sets}, updated_at = ? WHERE id = ?`, ...Object.values(patch), now, target.id);
    run("UPDATE profiles SET updated_at = ? WHERE user_id = ?", now, target.id);
    if (patch.role && patch.role !== target.role) {
      run("DELETE FROM user_roles WHERE user_id = ?", target.id);
      if (get("SELECT 1 AS ok FROM roles WHERE id = ?", patch.role)) {
        run("INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_at) VALUES (?, ?, ?)", target.id, patch.role, now);
      }
    }
    if (patch.status && patch.status !== "active") {
      run("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", now, target.id);
    }
    const sessionReset = patch.role || patch.status ? await revokeAllSessionsFor(target.id) : 0;
    invalidateAuthCache(target.id);
    if (patch.role) {
      recordModerationAction({
        moderatorId: req.auth.userId,
        action: "user_role",
        targetType: "user",
        targetId: target.id,
        reason: `role ${target.role} -> ${patch.role}`,
        meta: { from: target.role, to: patch.role }
      });
    }
    if (patch.status) {
      recordModerationAction({
        moderatorId: req.auth.userId,
        action: "user_status",
        targetType: "user",
        targetId: target.id,
        reason: `status ${target.status} -> ${patch.status}`,
        meta: { from: target.status, to: patch.status }
      });
    }
    await audit("admin.user.update", req, {
      targetType: "user",
      targetId: target.id,
      meta: { ...patch, sessionsRevoked: sessionReset }
    });
    return { ok: true, user: safeUser(get("SELECT * FROM users WHERE id = ?", target.id)) };
  });

  app.get("/rooms", async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    if (!(await ready(reply))) return undefined;
    const lobbies = all(
      `SELECT l.*, (SELECT COUNT(*) FROM messages m WHERE m.room_id = r.id) AS message_count
       FROM lobbies l LEFT JOIN rooms r ON r.room_code = l.code
       ORDER BY l.created_at DESC LIMIT 50`
    ).map((row) => ({
      code: row.code,
      name: row.name,
      owner: row.owner,
      ownerUsername: row.owner_username,
      capacity: row.capacity,
      privacy: row.privacy,
      active: Boolean(row.active),
      messageCount: num(row.message_count),
      createdAt: row.created_at,
      expiresAt: row.expires_at
    }));
    const q = String(req.query?.q || "").trim();
    const status = String(req.query?.status || "").trim();
    const includeDeleted = String(req.query?.includeDeleted || "") === "1";
    const where = [];
    const params = [];
    if (!includeDeleted) where.push("r.deleted_at IS NULL");
    if (status === "active") where.push("r.is_active = 1");
    if (status === "closed") where.push("r.is_active = 0");
    if (status === "deleted") where.push("r.deleted_at IS NOT NULL");
    if (q) {
      where.push("(r.room_code LIKE ? OR r.name LIKE ? OR u.nick LIKE ? OR u.username LIKE ?)");
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    const rooms = all(
      `SELECT r.id, r.room_code, r.name, r.host_id, r.is_active, r.member_count, r.last_activity_at,
              r.created_at, r.join_mode, r.visibility, r.password_hash, r.closed_at, r.deleted_at,
              u.username AS manager_username, u.nick AS manager_nick,
              (SELECT COUNT(*) FROM room_join_requests qr WHERE qr.room_id = r.id AND qr.status = 'pending') AS pending_requests
       FROM rooms r LEFT JOIN users u ON u.id = r.host_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY r.last_activity_at DESC LIMIT 100`,
      ...params
    ).map((row) => ({
      id: row.id,
      room_code: row.room_code,
      name: row.name,
      host_id: row.host_id,
      manager: row.manager_nick || row.manager_username || "",
      is_active: row.is_active,
      member_count: num(row.member_count),
      last_activity_at: row.last_activity_at,
      created_at: row.created_at,
      join_mode: row.join_mode,
      visibility: row.visibility,
      has_password: Boolean(row.password_hash),
      pending_requests: num(row.pending_requests),
      closed_at: row.closed_at,
      deleted_at: row.deleted_at
    }));
    return { ok: true, lobbies, rooms };
  });

  app.get("/messages", async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    if (!(await ready(reply))) return undefined;
    const limit = pageLimit(req.query?.limit, 30, 100);
    const before = Number(req.query?.before) || Date.now() + 1;
    const room = String(req.query?.room || "").trim().toUpperCase();
    const q = String(req.query?.q || "").trim();
    const where = ["m.created_at < ?"];
    const params = [before];
    if (room) {
      where.push("r.room_code = ?");
      params.push(room);
    }
    if (q) {
      where.push("m.content LIKE ?");
      params.push(`%${q}%`);
    }
    const rows = all(
      `SELECT m.*, r.room_code FROM messages m LEFT JOIN rooms r ON r.id = m.room_id
       WHERE ${where.join(" AND ")} ORDER BY m.created_at DESC LIMIT ?`,
      ...params,
      limit
    );
    return { ok: true, messages: rows.map(safeMessage), nextBefore: rows.length ? rows[rows.length - 1].created_at : 0 };
  });

  app.get("/reports", async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    if (!(await ready(reply))) return undefined;
    const limit = pageLimit(req.query?.limit, 30, 100);
    const rows = all(
      `SELECT rep.*, m.content AS message_content, m.username AS message_username, r.room_code
       FROM message_reports rep
       LEFT JOIN messages m ON m.id = rep.message_id
       LEFT JOIN rooms r ON r.id = m.room_id
       ORDER BY rep.created_at DESC LIMIT ?`,
      limit
    );
    return {
      ok: true,
      reports: rows.map((row) => ({
        id: row.id,
        status: row.status,
        reason: row.reason,
        reporter: row.reporter_id,
        message: row.message_content || "",
        messageUser: row.message_username || "",
        room: row.room_code || "",
        createdAt: row.created_at
      }))
    };
  });

  app.get("/finance", async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    if (!(await ready(reply))) return undefined;
    const now = Date.now();
    const plans = all("SELECT * FROM subscription_plans ORDER BY position, price").map((row) => ({
      id: row.id,
      name: row.name,
      cycle: row.cycle,
      price: row.price,
      currency: row.currency,
      days: row.days,
      active: Boolean(row.active),
      popular: Boolean(row.popular)
    }));
    const orders = all(
      `SELECT o.*, u.username FROM orders o LEFT JOIN users u ON u.id = o.user_id
       ORDER BY o.created_at DESC LIMIT 30`
    ).map((row) => ({
      id: row.id,
      username: row.username,
      planId: row.plan_id,
      amount: row.amount,
      currency: row.currency,
      status: row.status,
      createdAt: row.created_at,
      paidAt: row.paid_at
    }));
    const subscriptions = all(
      `SELECT s.*, u.username, p.name AS plan_name FROM subscriptions s
       LEFT JOIN users u ON u.id = s.user_id LEFT JOIN subscription_plans p ON p.id = s.plan_id
       ORDER BY s.updated_at DESC LIMIT 30`
    ).map((row) => ({
      id: row.id,
      username: row.username,
      plan: row.plan_name,
      status: row.status,
      startedAt: row.started_at,
      expiresAt: row.expires_at
    }));
    return {
      ok: true,
      plans,
      orders,
      subscriptions,
      totals: {
        paidAmount: scalar("SELECT COALESCE(SUM(amount),0) AS n FROM payments WHERE status = 'paid'"),
        pendingOrders: scalar("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'"),
        activeSubscriptions: scalar(
          "SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ?)",
          [now]
        ),
        paidOrders: scalar("SELECT COUNT(*) AS n FROM orders WHERE status = 'paid'")
      }
    };
  });

  app.get("/analytics", async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    if (!(await ready(reply))) return undefined;
    const since = Date.now() - 14 * DAY;
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" });
    const bucket = (rows) => {
      const map = new Map();
      for (let i = 0; i < 14; i++) map.set(day.format(new Date(since + i * DAY)), 0);
      for (const row of rows) map.set(day.format(new Date(row.day * 1000)), num(row.n));
      return [...map.entries()].map(([date, value]) => ({ date, value }));
    };
    const signups = all(
      `SELECT CAST(created_at / 1000 / 86400 AS INTEGER) * 86400 AS day, COUNT(*) AS n
       FROM users WHERE created_at > ? GROUP BY day ORDER BY day`,
      since
    );
    const messages = all(
      `SELECT CAST(created_at / 1000 / 86400 AS INTEGER) * 86400 AS day, COUNT(*) AS n
       FROM messages WHERE created_at > ? GROUP BY day ORDER BY day`,
      since
    );
    const events = all(
      `SELECT event, COUNT(*) AS n FROM analytics_events WHERE created_at > ? GROUP BY event ORDER BY n DESC LIMIT 10`,
      since
    );
    return {
      ok: true,
      days: 14,
      signups: bucket(signups),
      messages: bucket(messages),
      events,
      totals: {
        users: scalar("SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL"),
        sessionsToday: scalar("SELECT COUNT(*) AS n FROM sessions WHERE created_at > ?", [Date.now() - DAY]),
        messagesToday: scalar("SELECT COUNT(*) AS n FROM messages WHERE created_at > ?", [Date.now() - DAY])
      }
    };
  });

  app.get("/storage", async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    if (!(await ready(reply))) return undefined;
    const health = await databaseHealth();
    const counts = await tableCounts();
    const backups = all(
      "SELECT id, file_name, size_bytes, checksum, integrity, created_at, verified_at FROM backup_runs ORDER BY created_at DESC LIMIT 20"
    ).map((row) => ({
      id: row.id,
      fileName: row.file_name,
      sizeBytes: row.size_bytes,
      integrity: row.integrity,
      createdAt: row.created_at,
      verifiedAt: row.verified_at
    }));
    const media = all(
      "SELECT id, bucket, object_key, mime, size_bytes, kind, created_at FROM media_objects ORDER BY created_at DESC LIMIT 20"
    );
    return { ok: true, database: health, tables: counts, backups, media };
  });

  app.get("/settings", async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    const values = await getPlatformSettings();
    return {
      ok: true,
      values,
      registry: SETTINGS_REGISTRY.map((item) => ({
        id: item.id,
        label: item.label,
        category: item.category,
        type: item.type,
        min: item.min,
        max: item.max,
        maxLength: item.maxLength,
        values: item.values || null
      })),
      categories: SETTINGS_CATEGORIES
    };
  });

  app.put("/settings", async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    const values = req.body?.values;
    if (!values || typeof values !== "object") return fail(reply, 400, "invalid_payload", "Send a values object.");
    try {
      const result = await savePlatformSettings(values);
      await audit("admin.settings.update", req, {
        targetType: "settings",
        meta: { keys: Object.keys(result.changed) }
      });
      return { ok: true, changed: result.changed, values: result.values };
    } catch (err) {
      return fail(reply, err.statusCode || 400, "settings_invalid", err.message);
    }
  });

  app.get("/features", async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    const ctx = {
      userId: req.query?.userId ? String(req.query.userId) : "",
      role: req.query?.role ? String(req.query.role) : "",
      room: req.query?.room ? String(req.query.room) : "",
      server: req.query?.server ? String(req.query.server) : "",
      plan: req.query?.plan ? String(req.query.plan) : ""
    };
    const state = await resolveFeatureState(ctx);
    return {
      ok: true,
      context: state.context || ctx,
      hierarchy: configHierarchy(),
      catalog: FEATURE_CATALOG.map(({ key, id, group, label, desc, deps }) => ({ key, id, group, label, desc, deps })),
      status: featureStatus(state),
      overrides: await listFeatureOverrides(),
      schedules: await listFeatureSchedules({ pendingOnly: req.query?.all !== "1" }),
      global: summarizeFeatures(await loadFeatureState())
    };
  });

  app.put("/features/:key", async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    try {
      await setFeatureOverride({
        key: String(req.params.key),
        scopeType: body.scopeType || "global",
        scopeId: body.scopeId || "",
        enabled: body.enabled !== false,
        note: body.note || "",
        actor: req.auth.userId
      });
      await audit("admin.feature.set", req, {
        targetType: "feature",
        targetId: String(req.params.key),
        meta: { scopeType: body.scopeType || "global", scopeId: body.scopeId || "", enabled: body.enabled !== false }
      });
      return { ok: true };
    } catch (err) {
      return fail(reply, err.statusCode || 400, err.code || "feature_invalid", err.message);
    }
  });

  app.delete("/features/:key", async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const scopeType = String(req.query?.scopeType || body.scopeType || "global");
    const scopeId = String(req.query?.scopeId || body.scopeId || "");
    try {
      const existed = await clearFeatureOverride({
        key: String(req.params.key),
        scopeType,
        scopeId,
        actor: req.auth.userId,
        note: body.note || ""
      });
      await audit("admin.feature.clear", req, {
        targetType: "feature",
        targetId: String(req.params.key),
        meta: { scopeType, scopeId, existed }
      });
      return { ok: true, existed };
    } catch (err) {
      return fail(reply, err.statusCode || 400, "feature_invalid", err.message);
    }
  });

  app.post("/features/schedule", async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    try {
      const entry = await scheduleFeatureChange({
        key: String(body.key || ""),
        scopeType: body.scopeType || "global",
        scopeId: body.scopeId || "",
        enabled: body.enabled !== false,
        effectiveAt: body.effectiveAt,
        note: body.note || "",
        actor: req.auth.userId
      });
      await audit("admin.feature.schedule", req, { targetType: "feature", targetId: entry.key, meta: entry });
      return { ok: true, entry };
    } catch (err) {
      return fail(reply, err.statusCode || 400, err.code || "schedule_invalid", err.message);
    }
  });

  app.delete("/features/schedule/:id", async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    const removed = await removeSchedule(String(req.params.id));
    await audit("admin.feature.schedule-remove", req, { targetType: "feature", targetId: String(req.params.id) });
    return { ok: true, removed };
  });

  app.get("/features/history", async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    const entries = await listFeatureHistory({
      limit: pageLimit(req.query?.limit, 40, 200),
      before: Number(req.query?.before) || 0
    });
    return { ok: true, entries, nextBefore: entries.length ? entries[entries.length - 1].created_at : 0 };
  });

  app.get("/announcements", async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    if (!(await ready(reply))) return undefined;
    const rows = all("SELECT * FROM announcements ORDER BY created_at DESC LIMIT 50");
    return { ok: true, announcements: rows };
  });

  app.post("/announcements", async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    if (!(await ready(reply))) return undefined;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const title = String(body.title || "").trim().slice(0, 120);
    if (!title) return fail(reply, 400, "invalid_title", "A title is required.");
    const now = Date.now();
    const id = crypto.randomUUID();
    run(
      `INSERT INTO announcements (id, title, body, audience, status, publish_at, expires_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      title,
      String(body.body || "").slice(0, 4000),
      ["all", "users", "owners"].includes(body.audience) ? body.audience : "all",
      ["draft", "published"].includes(body.status) ? body.status : "published",
      body.publishAt ? Number(body.publishAt) : now,
      body.expiresAt ? Number(body.expiresAt) : null,
      req.auth.userId,
      now,
      now
    );
    await audit("admin.announcement.create", req, { targetType: "announcement", targetId: id, meta: { title } });
    return { ok: true, announcement: get("SELECT * FROM announcements WHERE id = ?", id) };
  });
}
