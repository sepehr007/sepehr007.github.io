import crypto from "node:crypto";
import { dbReady } from "../db.js";
import { ensureStore } from "../userStore.js";
import { all, get, run, transaction, pageLimit } from "../database/index.js";
import { audit } from "../audit.js";
import { adminLimit, ownerOnly, permissionOnly } from "../adminGuard.js";
import { sqlGetTicket, sqlPatchTicket, sqlListSupportAgents } from "../stores/social.js";
import { deliverNotice, deliverNoticeMany } from "../notify.js";

const ROLES = ["user", "member", "moderator", "administrator", "owner", "super_owner"];
const STATUSES = ["active", "suspended", "banned"];
const STAFF_ROLES = ["moderator", "administrator", "owner", "super_owner"];
const TICKET_STATUS_FA = { open: "باز", pending: "در انتظار پاسخ", resolved: "حل شد", closed: "بسته" };

function fail(reply, status, error, message) {
  return reply.code(status).send({ error, message });
}

async function ready(reply) {
  if (dbReady()) {
    fail(reply, 503, "sqlite_only", "This management panel needs the SQLite deployment.");
    return false;
  }
  if (await ensureStore()) return true;
  fail(reply, 503, "database_unavailable", "Database is not connected yet.");
  return false;
}

function deny(error, reply, fallbackCode, fallbackMessage) {
  const status = Number(error?.status) || 500;
  return fail(reply, status, error?.code || fallbackCode, error?.message || fallbackMessage);
}

function body(req) {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
}

function needConfirm(reply, req) {
  if (body(req).confirm === true) return true;
  fail(reply, 428, "confirmation_required", "Send confirm:true to run this action.");
  return false;
}

function mapPage(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    body: row.body,
    status: row.status,
    locale: row.locale,
    updatedBy: row.updated_by || "",
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
    publishedAt: row.published_at ? Number(row.published_at) : null
  };
}

function mapWorkflow(row) {
  let conditions = {};
  let actions = [];
  try { conditions = JSON.parse(row.conditions_json || "{}"); } catch {}
  try { actions = JSON.parse(row.actions_json || "[]"); } catch {}
  return {
    id: row.id,
    name: row.name,
    trigger: row.trigger,
    conditions,
    actions,
    enabled: Boolean(row.enabled),
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0)
  };
}

export default async function adminOpsRoutes(app) {
  app.addHook("preHandler", adminLimit);

  /* ------------------------------------------------- roles & permissions */
  app.get("/roles", async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    if (!(await ready(reply))) return undefined;
    const roles = all("SELECT * FROM roles ORDER BY id");
    const permissions = all("SELECT * FROM permissions ORDER BY group_name ASC, id ASC");
    const grants = all("SELECT role_id, permission_id FROM role_permissions");
    const counts = all("SELECT role, COUNT(*) AS n FROM users WHERE deleted_at IS NULL GROUP BY role");
    const countMap = new Map(counts.map((row) => [row.role, Number(row.n)]));
    const grantMap = new Map();
    for (const grant of grants) {
      if (!grantMap.has(grant.role_id)) grantMap.set(grant.role_id, []);
      grantMap.get(grant.role_id).push(grant.permission_id);
    }
    return {
      ok: true,
      roles: roles.map((role) => ({
        id: role.id,
        name: role.name,
        description: role.description || "",
        system: Boolean(role.is_system),
        users: countMap.get(role.id) || 0,
        permissions: grantMap.get(role.id) || [],
        locked: role.id === "owner" || role.id === "super_owner"
      })),
      permissions: permissions.map((perm) => ({ id: perm.id, group: perm.group_name, description: perm.description || "" }))
    };
  });

  app.put("/roles/:role/permissions", async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    if (!(await ready(reply))) return undefined;
    const roleId = String(req.params.role || "");
    const role = get("SELECT * FROM roles WHERE id = ?", roleId);
    if (!role) return fail(reply, 404, "role_missing", "That role does not exist.");
    if (roleId === "owner" || roleId === "super_owner") {
      return fail(reply, 409, "role_locked", "Owner roles always keep full access.");
    }
    if (!needConfirm(reply, req)) return undefined;
    const input = Array.isArray(body(req).permissions) ? body(req).permissions.map(String) : null;
    if (!input) return fail(reply, 400, "invalid_permissions", "Send a permissions array.");
    const known = new Set(all("SELECT id FROM permissions").map((row) => row.id));
    const wanted = [...new Set(input)].filter((id) => known.has(id)).slice(0, 100);
    const now = Date.now();
    transaction((conn) => {
      conn.prepare("DELETE FROM role_permissions WHERE role_id = ?").run(roleId);
      const insert = conn.prepare("INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)");
      for (const permission of wanted) insert.run(roleId, permission);
    });
    await audit("admin.roles.permissions", req, {
      targetType: "role",
      targetId: roleId,
      meta: { permissions: wanted, at: now }
    });
    return { ok: true, role: roleId, permissions: wanted };
  });

  /* ------------------------------------------------------ bulk user actions */
  app.post("/users/bulk", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "users.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    if (!needConfirm(reply, req)) return undefined;
    const input = body(req);
    const action = String(input.action || "");
    if (!["role", "status"].includes(action)) return fail(reply, 400, "invalid_action", "Action must be role or status.");
    const ids = [...new Set((Array.isArray(input.ids) ? input.ids : []).map(String).filter(Boolean))].slice(0, 50);
    if (!ids.length) return fail(reply, 400, "no_targets", "Pick at least one account.");
    if (action === "role" && !ROLES.includes(input.role)) return fail(reply, 400, "invalid_role", "That role does not exist.");
    if (action === "status" && !STATUSES.includes(input.status)) return fail(reply, 400, "invalid_status", "That status is not supported.");
    const actorId = String(req.auth.userId);
    const actorRole = req.auth.role;
    const now = Date.now();
    const updated = [];
    const skipped = [];
    for (const id of ids) {
      const target = get("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL", id);
      if (!target) {
        skipped.push({ id, reason: "missing" });
        continue;
      }
      if (String(target.id) === actorId) {
        skipped.push({ id, reason: "self" });
        continue;
      }
      if (target.role === "super_owner" && actorRole !== "super_owner") {
        skipped.push({ id, reason: "protected" });
        continue;
      }
      if (action === "role" && target.role === "super_owner" && input.role !== "super_owner") {
        const remaining = get("SELECT COUNT(*) AS n FROM users WHERE role = 'super_owner' AND id <> ?", target.id);
        if (Number(remaining?.n || 0) < 1) {
          skipped.push({ id, reason: "last_super_owner" });
          continue;
        }
      }
      if (action === "role") {
        run("UPDATE users SET role = ?, updated_at = ? WHERE id = ?", input.role, now, target.id);
        run("INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_by, granted_at) VALUES (?, ?, ?, ?)", target.id, input.role, actorId, now);
      } else {
        run("UPDATE users SET status = ?, updated_at = ? WHERE id = ?", input.status, now, target.id);
        if (input.status === "suspended" || input.status === "banned") {
          run("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", now, target.id);
        }
      }
      updated.push(target.id);
      await audit("admin.user.bulk", req, {
        targetType: "user",
        targetId: target.id,
        meta: action === "role" ? { role: input.role } : { status: input.status }
      });
    }
    return { ok: true, updated, skipped };
  });

  /* --------------------------------------------------------- support queue */
  app.get("/support", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "chat.moderate"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const limit = pageLimit(req.query?.limit, 25, 100);
    const before = Number(req.query?.before) || Date.now() + 1;
    const status = String(req.query?.status || "").trim();
    const priority = String(req.query?.priority || "").trim();
    const q = String(req.query?.q || "").trim();
    const where = ["t.created_at < ?"];
    const params = [before];
    if (["open", "pending", "resolved", "closed"].includes(status)) {
      where.push("t.status = ?");
      params.push(status);
    }
    if (["low", "normal", "high", "urgent"].includes(priority)) {
      where.push("t.priority = ?");
      params.push(priority);
    }
    if (q) {
      where.push("(t.subject LIKE ? OR u.username LIKE ? OR t.id = ?)");
      params.push(`%${q}%`, `%${q}%`, q);
    }
    const rows = all(
      `SELECT t.*, u.username, u.email, a.username AS assignee_name
       FROM support_tickets t
       LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN users a ON a.id = t.assigned_to
       WHERE ${where.join(" AND ")}
       ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.updated_at DESC
       LIMIT ?`,
      ...params,
      limit
    );
    return {
      ok: true,
      tickets: rows.map((row) => ({
        id: row.id,
        subject: row.subject,
        category: row.category,
        priority: row.priority,
        status: row.status,
        username: row.username || "",
        email: row.email || "",
        assignedTo: row.assigned_to || "",
        assigneeName: row.assignee_name || "",
        resolution: row.resolution || "",
        createdAt: Number(row.created_at || 0),
        updatedAt: Number(row.updated_at || 0),
        resolvedAt: row.resolved_at ? Number(row.resolved_at) : null
      })),
      nextBefore: rows.length ? Number(rows[rows.length - 1].created_at) : 0,
      agents: (await sqlListSupportAgents()).map((agent) => ({ id: agent.id, username: agent.username, role: agent.role }))
    };
  });

  app.get("/support/:id", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "chat.moderate"))) return undefined;
    if (!(await ready(reply))) return undefined;
    try {
      const ticket = await sqlGetTicket(req.auth.userId, req.auth.role, req.params.id);
      return { ok: true, ticket, agents: await sqlListSupportAgents() };
    } catch (error) {
      return deny(error, reply, "ticket_error", "Could not load that ticket.");
    }
  });

  app.patch("/support/:id", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "chat.moderate"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const input = body(req);
    let result;
    try {
      result = await sqlPatchTicket(req.auth.userId, req.auth.role, req.params.id, {
        status: input.status,
        priority: input.priority,
        assignedTo: input.assignedTo,
        resolution: input.resolution
      });
    } catch (error) {
      return deny(error, reply, "ticket_error", "Could not update that ticket.");
    }
    const { events, ...ticket } = result;
    const ownerId = ticket.user?.id;
    if (events.statusChanged && ownerId && String(ownerId) !== String(req.auth.userId)) {
      await deliverNotice(req.server, ownerId, {
        kind: "support_update",
        title: "وضعیت تیکت پشتیبانی تغییر کرد",
        body: `${ticket.subject}: ${TICKET_STATUS_FA[ticket.status] || ticket.status}`,
        link: "social.html#support",
        dedupeKey: `support_status:${ticket.id}:${ticket.status}`,
        dedupeWindowMs: 15 * 60_000
      });
    }
    if (events.assigneeChanged && events.assignedTo && String(events.assignedTo) !== String(req.auth.userId)) {
      await deliverNotice(req.server, events.assignedTo, {
        kind: "support_update",
        title: "تیکت پشتیبانی به تو ارجاع شد",
        body: ticket.subject,
        link: "social.html#support",
        dedupeKey: `support_assign:${ticket.id}:${events.assignedTo}`,
        dedupeWindowMs: 60 * 60_000
      });
    }
    await audit("admin.support.update", req, {
      targetType: "support_ticket",
      targetId: ticket.id,
      meta: { status: ticket.status, priority: ticket.priority, assignedTo: ticket.assignedTo || "" }
    });
    return { ok: true, ticket, events };
  });

  /* -------------------------------------------------------------- reports */
  app.get("/reports/social", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "chat.moderate"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const limit = pageLimit(req.query?.limit, 25, 100);
    const before = Number(req.query?.before) || Date.now() + 1;
    const status = String(req.query?.status || "").trim();
    const where = ["r.created_at < ?"];
    const params = [before];
    if (["open", "reviewing", "resolved", "dismissed"].includes(status)) {
      where.push("r.status = ?");
      params.push(status);
    }
    const rows = all(
      `SELECT r.*, u.username AS reporter, a.username AS assignee
       FROM reports r
       LEFT JOIN users u ON u.id = r.reporter_id
       LEFT JOIN users a ON a.id = r.assigned_to
       WHERE ${where.join(" AND ")} ORDER BY r.created_at DESC LIMIT ?`,
      ...params,
      limit
    );
    return {
      ok: true,
      reports: rows.map((row) => ({
        id: row.id,
        reporter: row.reporter || "",
        targetType: row.target_type,
        targetId: row.target_id,
        category: row.category,
        details: row.details,
        status: row.status,
        assignedTo: row.assigned_to || "",
        assignee: row.assignee || "",
        resolution: row.resolution || "",
        createdAt: Number(row.created_at || 0),
        updatedAt: Number(row.updated_at || 0)
      })),
      nextBefore: rows.length ? Number(rows[rows.length - 1].created_at) : 0
    };
  });

  app.patch("/reports/social/:id", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "chat.moderate"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const row = get("SELECT * FROM reports WHERE id = ?", String(req.params.id));
    if (!row) return fail(reply, 404, "report_missing", "That report does not exist.");
    const input = body(req);
    const status = input.status === undefined ? row.status : String(input.status);
    if (!["open", "reviewing", "resolved", "dismissed"].includes(status)) {
      return fail(reply, 400, "invalid_status", "Report status is not valid.");
    }
    const resolution = input.resolution === undefined ? row.resolution || "" : String(input.resolution).slice(0, 2000);
    run("UPDATE reports SET status = ?, resolution = ?, updated_at = ? WHERE id = ?", status, resolution, Date.now(), row.id);
    await audit("admin.report.update", req, { targetType: "report", targetId: row.id, meta: { status } });
    return { ok: true, report: { id: row.id, status, resolution } };
  });

  app.patch("/reports/message/:id", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "chat.moderate"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const row = get("SELECT * FROM message_reports WHERE id = ?", String(req.params.id));
    if (!row) return fail(reply, 404, "report_missing", "That report does not exist.");
    const status = String(body(req).status || "reviewed");
    if (!["open", "reviewed", "dismissed"].includes(status)) {
      return fail(reply, 400, "invalid_status", "Report status is not valid.");
    }
    run(
      "UPDATE message_reports SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?",
      status,
      req.auth.userId,
      Date.now(),
      row.id
    );
    await audit("admin.report.message", req, { targetType: "message_report", targetId: row.id, meta: { status } });
    return { ok: true, report: { id: row.id, status } };
  });

  /* ----------------------------------------------------------- room control */
  app.patch("/rooms/:id", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "rooms.close"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const input = body(req);
    const action = String(input.action || "");
    if (!["close", "reopen"].includes(action)) return fail(reply, 400, "invalid_action", "Action must be close or reopen.");
    if (!needConfirm(reply, req)) return undefined;
    const room = get("SELECT * FROM rooms WHERE id = ?", String(req.params.id));
    if (!room) return fail(reply, 404, "room_missing", "That room does not exist.");
    const now = Date.now();
    if (action === "close") {
      run("UPDATE rooms SET is_active = 0, closed_at = ?, closed_by = ?, updated_at = ? WHERE id = ?", now, req.auth.userId, now, room.id);
    } else {
      run("UPDATE rooms SET is_active = 1, closed_at = NULL, closed_by = NULL, updated_at = ? WHERE id = ?", now, room.id);
    }
    await audit(action === "close" ? "admin.room.close" : "admin.room.reopen", req, {
      targetType: "room",
      targetId: room.id,
      meta: { code: room.room_code, name: room.name }
    });
    if (room.host_id) {
      await deliverNotice(req.server, room.host_id, {
        kind: "moderation",
        title: action === "close" ? "اتاقت توسط مدیریت بسته شد" : "اتاقت دوباره باز شد",
        body: room.name || room.room_code || "",
        link: "rooms.html",
        dedupeKey: `room_${action}:${room.id}:${Math.floor(now / 60_000)}`,
        dedupeWindowMs: 5 * 60_000
      });
    }
    return { ok: true, room: { id: room.id, isActive: action === "reopen" } };
  });

  /* ---------------------------------------------------------- restrictions */
  app.get("/restrictions", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "users.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const blocks = all(
      `SELECT b.*, u.username AS blocker_name, t.username AS blocked_name
       FROM blocks b
       LEFT JOIN users u ON u.id = b.blocker_id
       LEFT JOIN users t ON t.id = b.blocked_id
       ORDER BY b.created_at DESC LIMIT 100`
    );
    const restricted = all(
      "SELECT id, username, email, role, status, updated_at FROM users WHERE status <> 'active' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 100"
    );
    return {
      ok: true,
      blocks: blocks.map((row) => ({
        id: row.id,
        userId: row.blocker_id,
        username: row.blocker_name || "",
        blockedId: row.blocked_id,
        blockedName: row.blocked_name || "",
        createdAt: Number(row.created_at || 0)
      })),
      restricted: restricted.map((row) => ({
        id: row.id,
        username: row.username,
        email: row.email,
        role: row.role,
        status: row.status,
        updatedAt: Number(row.updated_at || 0)
      }))
    };
  });

  app.delete("/restrictions/blocks/:id", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "users.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    if (!needConfirm(reply, req)) return undefined;
    const row = get("SELECT * FROM blocks WHERE id = ?", String(req.params.id));
    if (!row) return fail(reply, 404, "block_missing", "That block does not exist.");
    run("DELETE FROM blocks WHERE id = ?", row.id);
    await audit("admin.restriction.unblock", req, {
      targetType: "block",
      targetId: row.id,
      meta: { userId: row.blocker_id, blockedId: row.blocked_id }
    });
    return { ok: true, removed: row.id };
  });

  /* --------------------------------------------------------- website pages */
  app.get("/pages", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "content.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    return { ok: true, pages: all("SELECT * FROM website_pages ORDER BY updated_at DESC LIMIT 100").map(mapPage) };
  });

  app.post("/pages", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "content.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const input = body(req);
    const slug = String(input.slug || "").trim().toLowerCase();
    if (!/^[a-z0-9-]{2,64}$/.test(slug)) return fail(reply, 400, "invalid_slug", "Slug must be 2-64 latin letters, digits or dashes.");
    const title = String(input.title || "").trim().slice(0, 160);
    if (!title) return fail(reply, 400, "invalid_title", "A title is required.");
    if (get("SELECT 1 FROM website_pages WHERE slug = ?", slug)) return fail(reply, 409, "slug_exists", "That slug already exists.");
    const status = ["draft", "published", "archived"].includes(input.status) ? input.status : "draft";
    const now = Date.now();
    const id = crypto.randomUUID();
    run(
      `INSERT INTO website_pages (id, slug, title, body, status, locale, updated_by, created_at, updated_at, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      slug,
      title,
      String(input.body || "").slice(0, 200_000),
      status,
      String(input.locale || "fa").slice(0, 8),
      req.auth.userId,
      now,
      now,
      status === "published" ? now : null
    );
    await audit("admin.page.create", req, { targetType: "page", targetId: id, meta: { slug } });
    return { ok: true, page: mapPage(get("SELECT * FROM website_pages WHERE id = ?", id)) };
  });

  app.patch("/pages/:id", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "content.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const row = get("SELECT * FROM website_pages WHERE id = ?", String(req.params.id));
    if (!row) return fail(reply, 404, "page_missing", "That page does not exist.");
    const input = body(req);
    const status = input.status === undefined ? row.status : String(input.status);
    if (!["draft", "published", "archived"].includes(status)) return fail(reply, 400, "invalid_status", "Page status is not valid.");
    const now = Date.now();
    run(
      "UPDATE website_pages SET title = ?, body = ?, status = ?, locale = ?, published_at = ?, updated_by = ?, updated_at = ? WHERE id = ?",
      input.title === undefined ? row.title : String(input.title).slice(0, 160),
      input.body === undefined ? row.body : String(input.body).slice(0, 200_000),
      status,
      input.locale === undefined ? row.locale : String(input.locale).slice(0, 8),
      status === "published" ? row.published_at || now : row.published_at,
      req.auth.userId,
      now,
      row.id
    );
    await audit("admin.page.update", req, { targetType: "page", targetId: row.id, meta: { status } });
    return { ok: true, page: mapPage(get("SELECT * FROM website_pages WHERE id = ?", row.id)) };
  });

  app.delete("/pages/:id", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "content.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    if (!needConfirm(reply, req)) return undefined;
    const row = get("SELECT * FROM website_pages WHERE id = ?", String(req.params.id));
    if (!row) return fail(reply, 404, "page_missing", "That page does not exist.");
    run("UPDATE website_pages SET status = 'archived', updated_by = ?, updated_at = ? WHERE id = ?", req.auth.userId, Date.now(), row.id);
    await audit("admin.page.archive", req, { targetType: "page", targetId: row.id, meta: { slug: row.slug } });
    return { ok: true, archived: row.id };
  });

  /* ------------------------------------------------------------ automation */
  app.get("/automation", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "site.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    return {
      ok: true,
      workflows: all("SELECT * FROM automation_workflows ORDER BY updated_at DESC LIMIT 100").map(mapWorkflow),
      runner: { available: false, note: "ثبت و فعال‌سازی گردش‌کارها انجام می‌شود؛ اجرای خودکار به سرویس اجراکنندهٔ جداگانه نیاز دارد." }
    };
  });

  app.post("/automation", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "site.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const input = body(req);
    const name = String(input.name || "").trim().slice(0, 120);
    const trigger = String(input.trigger || "").trim().slice(0, 80);
    if (!name || !trigger) return fail(reply, 400, "invalid_workflow", "Name and trigger are required.");
    const actions = Array.isArray(input.actions) ? input.actions.slice(0, 20) : [];
    const now = Date.now();
    const id = crypto.randomUUID();
    run(
      `INSERT INTO automation_workflows (id, name, trigger, conditions_json, actions_json, enabled, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      name,
      trigger,
      JSON.stringify(input.conditions && typeof input.conditions === "object" ? input.conditions : {}),
      JSON.stringify(actions),
      input.enabled ? 1 : 0,
      req.auth.userId,
      now,
      now
    );
    await audit("admin.automation.create", req, { targetType: "workflow", targetId: id, meta: { name, trigger } });
    return { ok: true, workflow: mapWorkflow(get("SELECT * FROM automation_workflows WHERE id = ?", id)) };
  });

  app.patch("/automation/:id", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "site.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const row = get("SELECT * FROM automation_workflows WHERE id = ?", String(req.params.id));
    if (!row) return fail(reply, 404, "workflow_missing", "That workflow does not exist.");
    const input = body(req);
    run(
      `UPDATE automation_workflows SET name = ?, trigger = ?, conditions_json = ?, actions_json = ?, enabled = ?, updated_at = ?
       WHERE id = ?`,
      input.name === undefined ? row.name : String(input.name).slice(0, 120),
      input.trigger === undefined ? row.trigger : String(input.trigger).slice(0, 80),
      input.conditions === undefined ? row.conditions_json : JSON.stringify(input.conditions && typeof input.conditions === "object" ? input.conditions : {}),
      input.actions === undefined ? row.actions_json : JSON.stringify(Array.isArray(input.actions) ? input.actions.slice(0, 20) : []),
      input.enabled === undefined ? row.enabled : input.enabled ? 1 : 0,
      Date.now(),
      row.id
    );
    await audit("admin.automation.update", req, { targetType: "workflow", targetId: row.id, meta: { enabled: input.enabled } });
    return { ok: true, workflow: mapWorkflow(get("SELECT * FROM automation_workflows WHERE id = ?", row.id)) };
  });

  /* ------------------------------------------------------ notifications push */
  app.post("/notifications/broadcast", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "content.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    if (!needConfirm(reply, req)) return undefined;
    const input = body(req);
    const title = String(input.title || "").trim().slice(0, 160);
    const text = String(input.body || "").trim().slice(0, 600);
    if (!title) return fail(reply, 400, "invalid_title", "A title is required.");
    const audience = ["all", "role"].includes(input.audience) ? input.audience : "all";
    const role = String(input.role || "").trim();
    let rows;
    if (audience === "role") {
      if (!ROLES.includes(role)) return fail(reply, 400, "invalid_role", "That role does not exist.");
      rows = all("SELECT id FROM users WHERE deleted_at IS NULL AND status = 'active' AND role = ? LIMIT 1000", role);
    } else {
      rows = all("SELECT id FROM users WHERE deleted_at IS NULL AND status = 'active' LIMIT 1000");
    }
    const ids = rows.map((row) => row.id);
    const delivered = await deliverNoticeMany(req.server, ids, (userId) => ({
      kind: "announcement",
      title,
      body: text,
      link: String(input.link || "").slice(0, 200),
      dedupeKey: `broadcast:${crypto.createHash("sha1").update(`${title}:${text}`).digest("hex").slice(0, 12)}`,
      dedupeWindowMs: 6 * 60 * 60_000
    }));
    await audit("admin.notifications.broadcast", req, {
      targetType: "notification",
      meta: { audience, role, delivered, title }
    });
    return { ok: true, audience, delivered, note: "کاربرانی که همهٔ اعلان‌ها را خاموش کرده‌اند دریافت نمی‌کنند." };
  });
}
