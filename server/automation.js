import crypto from "node:crypto";
import { getDatabase } from "./database/index.js";
import { all, get, run } from "./database/index.js";
import { deliverNotice } from "./notify.js";
import { sendSystemMail } from "./mailer.js";

export const TRIGGERS = {
  "user.registered": "ثبت‌نام کاربر جدید",
  "subscription.activated": "فعال‌شدن اشتراک",
  "subscription.expired": "انقضای اشتراک",
  "room.created": "ساخت اتاق جدید",
  "room.member_joined": "ورود عضو به اتاق",
  "room.member_left": "خروج عضو از اتاق",
  "moderation.report_created": "ثبت گزارش تخلف",
  "support.ticket_created": "تیکت جدید پشتیبانی",
  "support.ticket_updated": "به‌روزرسانی تیکت",
  "notification.broadcast": "ارسال اعلان همگانی",
  "page.form_submitted": "ثبت فرم صفحهٔ سایت",
  "payment.failed": "پرداخت ناموفق"
};

export const ACTIONS = {
  notify_user: {
    label: "اعلان درون‌برنامه‌ای به کاربر",
    params: { title: 120, body: 500, kind: 30, link: 200 },
    fa: "برای کاربرِ رویداد یک اعلان ثبت می‌کند."
  },
  notify_owner: {
    label: "اعلان به مالکان سایت",
    params: { title: 120, body: 500 },
    fa: "به همهٔ مالکان/مالکان ارشد اعلان می‌فرستد."
  },
  notify_role: {
    label: "اعلان به یک نقش",
    params: { role: 30, title: 120, body: 500 },
    fa: "به همهٔ کاربران دارای نقش مشخص اعلان می‌فرستد."
  },
  email_user: {
    label: "ایمیل به کاربر",
    params: { subject: 160, text: 2000 },
    fa: "با SMTP تنظیم‌شده ایمیل می‌فرستد؛ بدون SMTP در outbox ثبت می‌شود."
  },
  close_room: {
    label: "بستن اتاق",
    params: {},
    fa: "اتاقِ رویداد را می‌بندد (فقط رویدادهایی که roomId دارند)."
  }
};

const KINDS = ["announcement", "payment", "support_update", "security", "system"];
const OPS = ["eq", "neq", "contains", "starts_with", "ends_with", "gt", "gte", "lt", "lte", "exists"];
const ROLES = ["user", "member", "moderator", "administrator", "owner", "super_owner"];

function str(value, max) {
  return String(value == null ? "" : value).slice(0, max);
}

function cleanLink(value) {
  const link = str(value, 200).trim();
  if (!link) return "";
  if (link.startsWith("/") || link.startsWith("#")) return link;
  if (/^https:\/\//i.test(link)) return link;
  return "";
}

export function sanitizeConditions(input) {
  const pack = input && typeof input === "object" ? input : {};
  const match = pack.match === "any" ? "any" : "all";
  const rules = [];
  const list = Array.isArray(pack.rules) ? pack.rules.slice(0, 12) : [];
  for (const rule of list) {
    if (!rule || typeof rule !== "object") return { ok: false, error: "invalid_condition" };
    const field = str(rule.field, 64);
    if (!/^[a-zA-Z0-9_.]{1,64}$/.test(field)) return { ok: false, error: "invalid_condition_field" };
    const op = OPS.includes(rule.op) ? rule.op : "eq";
    const value = typeof rule.value === "number" ? rule.value : str(rule.value, 200);
    rules.push({ field, op, value });
  }
  return { ok: true, conditions: { match, rules } };
}

export function sanitizeActions(input) {
  const list = Array.isArray(input) ? input.slice(0, 10) : [];
  const actions = [];
  for (const item of list) {
    if (!item || typeof item !== "object") return { ok: false, error: "invalid_action" };
    const type = ACTIONS[item.type] ? item.type : "";
    if (!type) return { ok: false, error: "unsupported_action" };
    const params = item.params && typeof item.params === "object" ? item.params : {};
    const clean = { type };
    if (type === "notify_user") {
      const title = str(params.title, 120).trim();
      if (!title) return { ok: false, error: "action_title_required" };
      clean.params = {
        title,
        body: str(params.body, 500),
        kind: KINDS.includes(params.kind) ? params.kind : "announcement",
        link: cleanLink(params.link)
      };
    } else if (type === "notify_owner") {
      const title = str(params.title, 120).trim();
      if (!title) return { ok: false, error: "action_title_required" };
      clean.params = { title, body: str(params.body, 500) };
    } else if (type === "notify_role") {
      const title = str(params.title, 120).trim();
      if (!title || !ROLES.includes(params.role)) return { ok: false, error: "action_invalid" };
      clean.params = { role: params.role, title, body: str(params.body, 500) };
    } else if (type === "email_user") {
      const subject = str(params.subject, 160).trim();
      if (!subject) return { ok: false, error: "action_subject_required" };
      clean.params = { subject, text: str(params.text, 2000) };
    } else {
      clean.params = {};
    }
    actions.push(clean);
  }
  return { ok: true, actions };
}

function resolveField(event, path) {
  let cursor = event;
  for (const part of path.split(".")) {
    if (cursor == null || typeof cursor !== "object") return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function compare(actual, op, expected) {
  if (op === "exists") return actual !== undefined && actual !== null && String(actual) !== "";
  if (actual === undefined || actual === null) return false;
  const a = typeof actual === "number" ? actual : String(actual);
  const b = typeof expected === "number" ? expected : String(expected);
  switch (op) {
    case "eq":
      return String(a) === String(b);
    case "neq":
      return String(a) !== String(b);
    case "contains":
      return String(a).toLowerCase().includes(String(b).toLowerCase());
    case "starts_with":
      return String(a).toLowerCase().startsWith(String(b).toLowerCase());
    case "ends_with":
      return String(a).toLowerCase().endsWith(String(b).toLowerCase());
    case "gt":
      return Number(a) > Number(b);
    case "gte":
      return Number(a) >= Number(b);
    case "lt":
      return Number(a) < Number(b);
    case "lte":
      return Number(a) <= Number(b);
    default:
      return false;
  }
}

export function matchesConditions(conditions, event) {
  const rules = Array.isArray(conditions?.rules) ? conditions.rules : [];
  if (!rules.length) return true;
  const results = rules.map((rule) => compare(resolveField(event, rule.field), rule.op, rule.value));
  return conditions?.match === "any" ? results.some(Boolean) : results.every(Boolean);
}

async function ownerIds() {
  return all("SELECT id FROM users WHERE role IN ('owner','super_owner') AND deleted_at IS NULL LIMIT 20").map((row) => row.id);
}

async function executeAction(app, action, event) {
  const params = action.params || {};
  if (action.type === "notify_user") {
    const userId = event.userId || event.targetUserId || event.ownerId || "";
    if (!userId) return { type: action.type, status: "skipped", note: "no_target_user" };
    const stored = await deliverNotice(app, userId, {
      kind: params.kind,
      title: params.title,
      body: params.body,
      link: params.link,
      dedupeKey: `automation:${event.eventId || ""}:${params.title}`,
      dedupeWindowMs: 30 * 60_000
    });
    return { type: action.type, status: stored ? "ok" : "skipped", note: stored ? "" : "notification_suppressed" };
  }
  if (action.type === "notify_owner") {
    const ids = await ownerIds();
    let sent = 0;
    for (const id of ids) {
      const stored = await deliverNotice(app, id, {
        kind: "system",
        title: params.title,
        body: params.body,
        dedupeKey: `automation:${event.eventId || ""}:${params.title}`,
        dedupeWindowMs: 30 * 60_000
      });
      if (stored) sent += 1;
    }
    return { type: action.type, status: sent ? "ok" : "skipped", note: `${sent} owners` };
  }
  if (action.type === "notify_role") {
    const ids = all("SELECT id FROM users WHERE role = ? AND status = 'active' AND deleted_at IS NULL LIMIT 500", params.role).map((row) => row.id);
    let sent = 0;
    for (const id of ids) {
      const stored = await deliverNotice(app, id, {
        kind: "system",
        title: params.title,
        body: params.body,
        dedupeKey: `automation:${event.eventId || ""}:${params.title}`,
        dedupeWindowMs: 30 * 60_000
      });
      if (stored) sent += 1;
    }
    return { type: action.type, status: sent ? "ok" : "skipped", note: `${sent} users` };
  }
  if (action.type === "email_user") {
    const userId = event.userId || event.targetUserId || "";
    if (!userId) return { type: action.type, status: "skipped", note: "no_target_user" };
    const user = get("SELECT email, email_verified FROM users WHERE id = ?", userId);
    if (!user?.email || !Number(user.email_verified)) return { type: action.type, status: "skipped", note: "email_unverified" };
    const result = await sendSystemMail({ to: user.email, subject: params.subject, text: params.text });
    return { type: action.type, status: result.ok ? "ok" : "failed", note: result.mode || result.error || "" };
  }
  if (action.type === "close_room") {
    const roomId = event.roomId || "";
    if (!roomId) return { type: action.type, status: "skipped", note: "no_room" };
    const now = Date.now();
    run("UPDATE rooms SET is_active = 0, closed_at = ?, last_activity_at = ? WHERE id = ? AND is_active = 1", now, now, roomId);
    return { type: action.type, status: "ok", note: roomId };
  }
  return { type: action.type, status: "failed", note: "unsupported" };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeActions(app, actions, event, dryRun) {
  const results = [];
  for (const action of actions) {
    let attempt = 0;
    let outcome = null;
    while (attempt < 2) {
      attempt += 1;
      try {
        outcome = dryRun ? { type: action.type, status: "planned", note: "dry_run" } : await executeAction(app, action, event);
        if (outcome.status !== "failed") break;
      } catch (err) {
        outcome = { type: action.type, status: "failed", note: err.message || "action_error" };
      }
      if (attempt === 1) await sleep(250);
    }
    results.push({ ...outcome, attempts: attempt });
  }
  return results;
}

export async function runWorkflows(app, trigger, event = {}, { dryRun = false, onlyWorkflowId = "" } = {}) {
  if (!TRIGGERS[trigger]) return [];
  const db = await getDatabase();
  if (!db) return [];
  const workflows = onlyWorkflowId
    ? all("SELECT * FROM automation_workflows WHERE id = ?", onlyWorkflowId)
    : all("SELECT * FROM automation_workflows WHERE enabled = 1 AND trigger = ? ORDER BY updated_at ASC LIMIT 20", trigger);
  const finished = [];
  for (const workflow of workflows) {
    let conditions = {};
    let actions = [];
    try {
      conditions = JSON.parse(workflow.conditions_json || "{}");
    } catch {}
    try {
      actions = JSON.parse(workflow.actions_json || "[]");
    } catch {}
    const safeActions = sanitizeActions(actions);
    if (!safeActions.ok) continue;
    if (!matchesConditions(conditions, event)) {
      if (dryRun) finished.push({ workflowId: workflow.id, matched: false, results: [] });
      continue;
    }
    if (dryRun) {
      finished.push({ workflowId: workflow.id, matched: true, results: await executeActions(app, safeActions.actions, event, true) });
      continue;
    }
    const now = Date.now();
    const runId = crypto.randomUUID();
    run(
      `INSERT INTO automation_runs (id, workflow_id, trigger, event_json, status, attempts, actions_json, error, retry_of, started_at)
       VALUES (?, ?, ?, ?, 'running', 1, '[]', '', NULL, ?)`,
      runId,
      workflow.id,
      trigger,
      JSON.stringify(event).slice(0, 20_000),
      now
    );
    const results = await executeActions(app, safeActions.actions, event, false);
    const failed = results.some((item) => item.status === "failed");
    const error = failed ? results.filter((item) => item.status === "failed").map((item) => `${item.type}:${item.note}`).join("; ") : "";
    run(
      "UPDATE automation_runs SET status = ?, actions_json = ?, error = ?, finished_at = ? WHERE id = ?",
      failed ? "failed" : "ok",
      JSON.stringify(results).slice(0, 20_000),
      error.slice(0, 1000),
      Date.now(),
      runId
    );
    run(
      "UPDATE automation_workflows SET last_run_at = ?, last_status = ?, last_error = ?, run_count = run_count + 1, error_count = error_count + ? WHERE id = ?",
      Date.now(),
      failed ? "failed" : "ok",
      error.slice(0, 500),
      failed ? 1 : 0,
      workflow.id
    );
    finished.push({ runId, workflowId: workflow.id, matched: true, status: failed ? "failed" : "ok", results });
  }
  return finished;
}

export async function emitEvent(app, trigger, event = {}) {
  try {
    return await runWorkflows(app, trigger, { ...event, eventId: event.eventId || crypto.randomUUID(), emittedAt: Date.now() });
  } catch (err) {
    app?.log?.error?.({ err, trigger }, "automation event failed");
    return [];
  }
}

export async function simulateWorkflow(app, workflowId, event = {}) {
  return runWorkflows(app, String(event.trigger || ""), { ...event, eventId: crypto.randomUUID() }, { dryRun: true, onlyWorkflowId: workflowId });
}

export async function retryRun(app, runId, actorId) {
  const row = get("SELECT * FROM automation_runs WHERE id = ?", runId);
  if (!row) return { ok: false, error: "run_missing" };
  const workflow = get("SELECT * FROM automation_workflows WHERE id = ?", row.workflow_id);
  if (!workflow) return { ok: false, error: "workflow_missing" };
  let event = {};
  try {
    event = JSON.parse(row.event_json || "{}");
  } catch {}
  const now = Date.now();
  const newRunId = crypto.randomUUID();
  run(
    `INSERT INTO automation_runs (id, workflow_id, trigger, event_json, status, attempts, actions_json, error, retry_of, started_at)
     VALUES (?, ?, ?, ?, 'running', 1, '[]', '', ?, ?)`,
    newRunId,
    workflow.id,
    row.trigger,
    JSON.stringify(event).slice(0, 20_000),
    row.id,
    now
  );
  let actions = [];
  try {
    actions = JSON.parse(workflow.actions_json || "[]");
  } catch {}
  const safeActions = sanitizeActions(actions);
  if (!safeActions.ok) {
    run("UPDATE automation_runs SET status = 'failed', error = 'invalid_actions', finished_at = ? WHERE id = ?", Date.now(), newRunId);
    return { ok: false, error: "invalid_actions", runId: newRunId };
  }
  const results = await executeActions(app, safeActions.actions, event, false);
  const failed = results.some((item) => item.status === "failed");
  const error = failed ? results.filter((item) => item.status === "failed").map((item) => `${item.type}:${item.note}`).join("; ") : "";
  run(
    "UPDATE automation_runs SET status = ?, actions_json = ?, error = ?, finished_at = ? WHERE id = ?",
    failed ? "failed" : "ok",
    JSON.stringify(results).slice(0, 20_000),
    error.slice(0, 1000),
    Date.now(),
    newRunId
  );
  run(
    "UPDATE automation_workflows SET last_run_at = ?, last_status = ?, last_error = ?, run_count = run_count + 1, error_count = error_count + ? WHERE id = ?",
    Date.now(),
    failed ? "failed" : "ok",
    error.slice(0, 500),
    failed ? 1 : 0,
    workflow.id
  );
  return { ok: true, runId: newRunId, status: failed ? "failed" : "ok", results, actorId };
}

export function sampleEvent(trigger) {
  const base = { eventId: crypto.randomUUID(), emittedAt: Date.now(), userId: "", roomId: "", amount: 0 };
  switch (trigger) {
    case "user.registered":
      return { ...base, username: "sample_user", email: "sample@example.com" };
    case "subscription.activated":
    case "subscription.expired":
      return { ...base, planId: "monthly", amount: 49000 };
    case "room.created":
      return { ...base, roomCode: "SAMPLE", name: "اتاق نمونه", ownerId: "" };
    case "room.member_joined":
    case "room.member_left":
      return { ...base, roomCode: "SAMPLE", memberCount: 2 };
    case "moderation.report_created":
      return { ...base, targetType: "message", category: "spam", targetId: "sample" };
    case "support.ticket_created":
    case "support.ticket_updated":
      return { ...base, ticketId: "sample", status: "open", priority: "normal" };
    case "notification.broadcast":
      return { ...base, audience: "all", delivered: 0 };
    case "page.form_submitted":
      return { ...base, slug: "contact", name: "نمونه" };
    case "payment.failed":
      return { ...base, amount: 49000, provider: "manual" };
    default:
      return base;
  }
}
