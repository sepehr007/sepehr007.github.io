import crypto from "node:crypto";
import { dbReady } from "../db.js";
import { ensureStore } from "../userStore.js";
import { all, get, run, transaction, pageLimit } from "../database/index.js";
import { audit } from "../audit.js";
import { adminLimit, ownerOnly, permissionOnly } from "../adminGuard.js";
import { sqlGetTicket, sqlPatchTicket, sqlListSupportAgents } from "../stores/social.js";
import { deliverNotice, deliverNoticeMany } from "../notify.js";
import { sanitizeBlocks, blocksFromJson, sanitizeVisibility } from "../pageBlocks.js";
import {
  TRIGGERS,
  ACTIONS,
  sanitizeConditions,
  sanitizeActions,
  simulateWorkflow,
  retryRun,
  sampleEvent
} from "../automation.js";

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
    description: row.description || "",
    blocks: blocksFromJson(row.blocks_json || row.body),
    status: row.status,
    locale: row.locale,
    visibility: row.visibility || "public",
    scheduledAt: row.scheduled_at ? Number(row.scheduled_at) : null,
    showInNav: Boolean(row.show_in_nav),
    navOrder: Number(row.nav_order || 0),
    version: Number(row.version || 1),
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
    description: row.description || "",
    trigger: row.trigger,
    conditions,
    actions,
    enabled: Boolean(row.enabled),
    lastRunAt: row.last_run_at ? Number(row.last_run_at) : null,
    lastStatus: row.last_status || "",
    lastError: row.last_error || "",
    runCount: Number(row.run_count || 0),
    errorCount: Number(row.error_count || 0),
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0)
  };
}

function mapRun(row) {
  let actions = [];
  try { actions = JSON.parse(row.actions_json || "[]"); } catch {}
  return {
    id: row.id,
    workflowId: row.workflow_id,
    trigger: row.trigger,
    status: row.status,
    attempts: Number(row.attempts || 1),
    actions,
    error: row.error || "",
    retryOf: row.retry_of || "",
    startedAt: Number(row.started_at || 0),
    finishedAt: row.finished_at ? Number(row.finished_at) : null
  };
}

function snapshotPage(pageId, actorId) {
  const row = get("SELECT * FROM website_pages WHERE id = ?", pageId);
  if (!row) return null;
  run(
    `INSERT OR REPLACE INTO page_versions (id, page_id, version, title, description, blocks_json, status, visibility, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    row.id,
    Number(row.version || 1),
    row.title,
    row.description || "",
    row.blocks_json || "[]",
    row.status,
    row.visibility || "public",
    actorId || null,
    Date.now()
  );
  run(
    "DELETE FROM page_versions WHERE page_id = ? AND version <= ?",
    row.id,
    Math.max(0, Number(row.version || 1) - 30)
  );
  return row;
}

function pageInput(input, current) {
  const blocksRaw = input.blocks !== undefined ? input.blocks : undefined;
  let blocks;
  if (blocksRaw !== undefined) {
    const result = sanitizeBlocks(blocksRaw);
    if (!result.ok) return { ok: false, error: result.error };
    blocks = result.blocks;
  } else if (current === null && typeof input.body === "string" && input.body.trim()) {
    const result = sanitizeBlocks([{ type: "text", text: input.body }]);
    if (!result.ok) return { ok: false, error: result.error };
    blocks = result.blocks;
  }
  const scheduled =
    input.scheduledAt === undefined
      ? undefined
      : input.scheduledAt === null || input.scheduledAt === ""
        ? null
        : Number(input.scheduledAt || 0) || null;
  return {
    ok: true,
    fields: {
      title: input.title === undefined ? undefined : String(input.title || "").trim().slice(0, 160),
      description: input.description === undefined ? undefined : String(input.description || "").slice(0, 400),
      blocks,
      locale: input.locale === undefined ? undefined : String(input.locale || "fa").slice(0, 8),
      visibility: input.visibility === undefined ? undefined : sanitizeVisibility(String(input.visibility)),
      scheduledAt: scheduled,
      showInNav: input.showInNav === undefined ? undefined : Boolean(input.showInNav),
      navOrder: input.navOrder === undefined ? undefined : Number(input.navOrder) || 0
    }
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
    emitEvent(req.server, "support.ticket_updated", {
      ticketId: ticket.id,
      userId: ownerId || "",
      status: ticket.status,
      priority: ticket.priority,
      assignedTo: ticket.assignedTo || "",
      statusChanged: Boolean(events.statusChanged)
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
    const rows = all(
      `SELECT p.*, (SELECT COUNT(*) FROM page_submissions s WHERE s.page_id = p.id) AS submission_count
       FROM website_pages p ORDER BY p.nav_order ASC, p.updated_at DESC LIMIT 100`
    );
    return {
      ok: true,
      pages: rows.map((row) => ({ ...mapPage(row), submissionCount: Number(row.submission_count || 0) }))
    };
  });

  app.get("/pages/:id", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "content.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const row = get("SELECT * FROM website_pages WHERE id = ?", String(req.params.id));
    if (!row) return fail(reply, 404, "page_missing", "That page does not exist.");
    const versions = all(
      "SELECT version, status, created_at, created_by FROM page_versions WHERE page_id = ? ORDER BY version DESC LIMIT 30",
      row.id
    ).map((item) => ({
      version: Number(item.version),
      status: item.status,
      createdAt: Number(item.created_at),
      createdBy: item.created_by || ""
    }));
    const submissions = Number(get("SELECT COUNT(*) AS n FROM page_submissions WHERE page_id = ?", row.id)?.n || 0);
    return { ok: true, page: { ...mapPage(row), versions, submissionCount: submissions } };
  });

  app.get("/pages/:id/versions", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "content.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const row = get("SELECT id FROM website_pages WHERE id = ?", String(req.params.id));
    if (!row) return fail(reply, 404, "page_missing", "That page does not exist.");
    const versions = all("SELECT * FROM page_versions WHERE page_id = ? ORDER BY version DESC LIMIT 30", row.id).map((item) => ({
      id: item.id,
      version: Number(item.version),
      title: item.title,
      description: item.description || "",
      blocks: blocksFromJson(item.blocks_json),
      status: item.status,
      visibility: item.visibility || "public",
      createdAt: Number(item.created_at)
    }));
    return { ok: true, versions };
  });

  app.get("/pages/:id/submissions", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "content.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const row = get("SELECT id FROM website_pages WHERE id = ?", String(req.params.id));
    if (!row) return fail(reply, 404, "page_missing", "That page does not exist.");
    const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 50));
    const rows = all(
      "SELECT * FROM page_submissions WHERE page_id = ? ORDER BY created_at DESC LIMIT ?",
      row.id,
      limit
    );
    return {
      ok: true,
      submissions: rows.map((item) => ({
        id: item.id,
        name: item.name,
        email: item.email,
        message: item.message,
        createdAt: Number(item.created_at)
      }))
    };
  });

  app.post("/pages", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "content.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const input = body(req);
    const slug = String(input.slug || "").trim().toLowerCase();
    if (!/^[a-z0-9-]{2,64}$/.test(slug)) return fail(reply, 400, "invalid_slug", "Slug must be 2-64 latin letters, digits or dashes.");
    const parsed = pageInput(input, null);
    if (!parsed.ok) return fail(reply, 400, parsed.error, "One of the blocks is not valid.");
    const title = parsed.fields.title === undefined ? "" : parsed.fields.title;
    if (!title) return fail(reply, 400, "invalid_title", "A title is required.");
    if (get("SELECT 1 FROM website_pages WHERE slug = ?", slug)) return fail(reply, 409, "slug_exists", "That slug already exists.");
    const status = ["draft", "published", "archived"].includes(input.status) ? input.status : "draft";
    const now = Date.now();
    const id = crypto.randomUUID();
    run(
      `INSERT INTO website_pages
       (id, slug, title, description, body, blocks_json, status, locale, visibility, scheduled_at, show_in_nav, nav_order, version, updated_by, created_at, updated_at, published_at)
       VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      id,
      slug,
      title,
      parsed.fields.description || "",
      JSON.stringify(parsed.fields.blocks || []),
      status,
      parsed.fields.locale || "fa",
      parsed.fields.visibility || "public",
      parsed.fields.scheduledAt || null,
      parsed.fields.showInNav ? 1 : 0,
      parsed.fields.navOrder || 0,
      req.auth.userId,
      now,
      now,
      status === "published" ? now : null
    );
    snapshotPage(id, req.auth.userId);
    await audit("admin.page.create", req, { targetType: "page", targetId: id, meta: { slug, blocks: (parsed.fields.blocks || []).length } });
    return { ok: true, page: mapPage(get("SELECT * FROM website_pages WHERE id = ?", id)) };
  });

  app.post("/pages/reorder", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "content.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const ids = Array.isArray(body(req).ids) ? body(req).ids.slice(0, 100).map(String) : [];
    if (!ids.length) return fail(reply, 400, "empty_order", "Send the page ids in display order.");
    ids.forEach((id, index) => run("UPDATE website_pages SET nav_order = ?, updated_at = ? WHERE id = ?", index, Date.now(), id));
    await audit("admin.page.reorder", req, { targetType: "page", meta: { count: ids.length } });
    return { ok: true, order: ids };
  });

  app.patch("/pages/:id", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "content.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const row = get("SELECT * FROM website_pages WHERE id = ?", String(req.params.id));
    if (!row) return fail(reply, 404, "page_missing", "That page does not exist.");
    const input = body(req);
    const status = input.status === undefined ? row.status : String(input.status);
    if (!["draft", "published", "archived"].includes(status)) return fail(reply, 400, "invalid_status", "Page status is not valid.");
    const parsed = pageInput(input, row);
    if (!parsed.ok) return fail(reply, 400, parsed.error, "One of the blocks is not valid.");
    const f = parsed.fields;
    const contentChanged = f.blocks !== undefined || (f.title !== undefined && f.title !== row.title) || (f.description !== undefined && f.description !== row.description);
    const nextVersion = contentChanged ? Number(row.version || 1) + 1 : Number(row.version || 1);
    const now = Date.now();
    run(
      `UPDATE website_pages SET title = ?, description = ?, blocks_json = ?, status = ?, locale = ?, visibility = ?,
       scheduled_at = ?, show_in_nav = ?, nav_order = ?, version = ?, published_at = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
      f.title === undefined ? row.title : f.title,
      f.description === undefined ? row.description : f.description,
      f.blocks === undefined ? row.blocks_json : JSON.stringify(f.blocks),
      status,
      f.locale === undefined ? row.locale : f.locale,
      f.visibility === undefined ? row.visibility || "public" : f.visibility,
      f.scheduledAt === undefined ? row.scheduled_at : f.scheduledAt,
      f.showInNav === undefined ? row.show_in_nav : f.showInNav ? 1 : 0,
      f.navOrder === undefined ? row.nav_order : f.navOrder,
      nextVersion,
      status === "published" ? row.published_at || now : row.published_at,
      req.auth.userId,
      now,
      row.id
    );
    if (contentChanged) snapshotPage(row.id, req.auth.userId);
    await audit("admin.page.update", req, { targetType: "page", targetId: row.id, meta: { status, version: nextVersion } });
    return { ok: true, page: mapPage(get("SELECT * FROM website_pages WHERE id = ?", row.id)) };
  });

  app.post("/pages/:id/rollback", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "content.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    if (!needConfirm(reply, req)) return undefined;
    const row = get("SELECT * FROM website_pages WHERE id = ?", String(req.params.id));
    if (!row) return fail(reply, 404, "page_missing", "That page does not exist.");
    const version = Number(body(req).version || 0);
    const snap = get("SELECT * FROM page_versions WHERE page_id = ? AND version = ?", row.id, version);
    if (!snap) return fail(reply, 404, "version_missing", "That version does not exist.");
    const nextVersion = Number(row.version || 1) + 1;
    run(
      "UPDATE website_pages SET title = ?, description = ?, blocks_json = ?, version = ?, updated_by = ?, updated_at = ? WHERE id = ?",
      snap.title,
      snap.description || "",
      snap.blocks_json,
      nextVersion,
      req.auth.userId,
      Date.now(),
      row.id
    );
    snapshotPage(row.id, req.auth.userId);
    await audit("admin.page.rollback", req, { targetType: "page", targetId: row.id, meta: { from: version, to: nextVersion } });
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
    const runs = all(
      `SELECT r.*, w.name AS workflow_name FROM automation_runs r
       LEFT JOIN automation_workflows w ON w.id = r.workflow_id
       ORDER BY r.started_at DESC LIMIT 25`
    ).map((row) => ({ ...mapRun(row), workflowName: row.workflow_name || "" }));
    return {
      ok: true,
      workflows: all("SELECT * FROM automation_workflows ORDER BY updated_at DESC LIMIT 100").map(mapWorkflow),
      runs,
      runner: { available: true, triggers: TRIGGERS, actions: ACTIONS }
    };
  });

  app.get("/automation/runs", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "site.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const status = ["ok", "failed", "running"].includes(String(req.query?.status || "")) ? String(req.query.status) : "";
    const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 50));
    const rows = status
      ? all(
          `SELECT r.*, w.name AS workflow_name FROM automation_runs r
           LEFT JOIN automation_workflows w ON w.id = r.workflow_id
           WHERE r.status = ? ORDER BY r.started_at DESC LIMIT ?`,
          status,
          limit
        )
      : all(
          `SELECT r.*, w.name AS workflow_name FROM automation_runs r
           LEFT JOIN automation_workflows w ON w.id = r.workflow_id
           ORDER BY r.started_at DESC LIMIT ?`,
          limit
        );
    return { ok: true, runs: rows.map((row) => ({ ...mapRun(row), workflowName: row.workflow_name || "" })) };
  });

  app.get("/automation/:id", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "site.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const row = get("SELECT * FROM automation_workflows WHERE id = ?", String(req.params.id));
    if (!row) return fail(reply, 404, "workflow_missing", "That workflow does not exist.");
    const runs = all("SELECT * FROM automation_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT 50", row.id).map(mapRun);
    return { ok: true, workflow: mapWorkflow(row), runs };
  });

  app.post("/automation", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "site.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const input = body(req);
    const name = String(input.name || "").trim().slice(0, 120);
    if (!name) return fail(reply, 400, "invalid_name", "A workflow name is required.");
    const trigger = String(input.trigger || "").trim();
    if (!TRIGGERS[trigger]) return fail(reply, 400, "invalid_trigger", "That trigger is not supported.");
    const conditions = sanitizeConditions(input.conditions);
    if (!conditions.ok) return fail(reply, 400, conditions.error, "One of the conditions is not valid.");
    const actions = sanitizeActions(input.actions);
    if (!actions.ok) return fail(reply, 400, actions.error, "One of the actions is not supported.");
    const enabled = Boolean(input.enabled);
    if (enabled && !actions.actions.length) return fail(reply, 400, "no_actions", "Add at least one action before enabling.");
    const now = Date.now();
    const id = crypto.randomUUID();
    run(
      `INSERT INTO automation_workflows
       (id, name, description, trigger, conditions_json, actions_json, enabled, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      name,
      String(input.description || "").slice(0, 400),
      trigger,
      JSON.stringify(conditions.conditions),
      JSON.stringify(actions.actions),
      enabled ? 1 : 0,
      req.auth.userId,
      now,
      now
    );
    await audit("admin.automation.create", req, { targetType: "workflow", targetId: id, meta: { name, trigger, enabled } });
    return { ok: true, workflow: mapWorkflow(get("SELECT * FROM automation_workflows WHERE id = ?", id)) };
  });

  app.patch("/automation/:id", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "site.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const row = get("SELECT * FROM automation_workflows WHERE id = ?", String(req.params.id));
    if (!row) return fail(reply, 404, "workflow_missing", "That workflow does not exist.");
    const input = body(req);
    const trigger = input.trigger === undefined ? row.trigger : String(input.trigger || "").trim();
    if (!TRIGGERS[trigger]) return fail(reply, 400, "invalid_trigger", "That trigger is not supported.");
    let conditionsJson = row.conditions_json;
    if (input.conditions !== undefined) {
      const conditions = sanitizeConditions(input.conditions);
      if (!conditions.ok) return fail(reply, 400, conditions.error, "One of the conditions is not valid.");
      conditionsJson = JSON.stringify(conditions.conditions);
    }
    let actionsJson = row.actions_json;
    if (input.actions !== undefined) {
      const actions = sanitizeActions(input.actions);
      if (!actions.ok) return fail(reply, 400, actions.error, "One of the actions is not supported.");
      actionsJson = JSON.stringify(actions.actions);
    }
    const enabled = input.enabled === undefined ? Boolean(row.enabled) : Boolean(input.enabled);
    let actionCount = 0;
    try {
      actionCount = JSON.parse(actionsJson || "[]").length;
    } catch {}
    if (enabled && !actionCount) return fail(reply, 400, "no_actions", "Add at least one action before enabling.");
    run(
      `UPDATE automation_workflows SET name = ?, description = ?, trigger = ?, conditions_json = ?, actions_json = ?, enabled = ?, updated_at = ?
       WHERE id = ?`,
      input.name === undefined ? row.name : String(input.name || "").trim().slice(0, 120) || row.name,
      input.description === undefined ? row.description : String(input.description || "").slice(0, 400),
      trigger,
      conditionsJson,
      actionsJson,
      enabled ? 1 : 0,
      Date.now(),
      row.id
    );
    await audit("admin.automation.update", req, { targetType: "workflow", targetId: row.id, meta: { enabled } });
    return { ok: true, workflow: mapWorkflow(get("SELECT * FROM automation_workflows WHERE id = ?", row.id)) };
  });

  app.post("/automation/:id/simulate", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "site.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    if (!needConfirm(reply, req)) return undefined;
    const row = get("SELECT * FROM automation_workflows WHERE id = ?", String(req.params.id));
    if (!row) return fail(reply, 404, "workflow_missing", "That workflow does not exist.");
    const eventInput = body(req).event && typeof body(req).event === "object" ? body(req).event : {};
    const event = { ...sampleEvent(row.trigger), ...eventInput, trigger: row.trigger };
    const outcomes = await simulateWorkflow(req.server, row.id, event);
    const outcome = outcomes[0] || { matched: false, results: [] };
    await audit("admin.automation.simulate", req, { targetType: "workflow", targetId: row.id, meta: { matched: Boolean(outcome.matched) } });
    return { ok: true, matched: Boolean(outcome.matched), actions: outcome.results || [], dryRun: true };
  });

  app.post("/automation/runs/:id/retry", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "site.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    if (!needConfirm(reply, req)) return undefined;
    const result = await retryRun(req.server, String(req.params.id), req.auth.userId);
    if (!result.ok) return fail(reply, result.error === "run_missing" ? 404 : 409, result.error, "Retry could not be started.");
    await audit("admin.automation.retry", req, { targetType: "run", targetId: result.runId, meta: { status: result.status } });
    return { ok: true, runId: result.runId, status: result.status, actions: result.results };
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
    emitEvent(req.server, "notification.broadcast", { audience, role, delivered, title, userId: req.auth.userId });
    return { ok: true, audience, delivered, note: "کاربرانی که همهٔ اعلان‌ها را خاموش کرده‌اند دریافت نمی‌کنند." };
  });
}
