import { store } from "./core.js";

const AUDIT_KEY = "wt.ownerAudit";
const MAX = 500;

export function readAudit() {
  const list = store.get(AUDIT_KEY, []);
  return Array.isArray(list) ? list.filter((x) => x && typeof x === "object") : [];
}

export function logAudit({ kind = "action", action = "", target = "", detail = "", before = null, after = null, scope = "global", reason = "", source = "owner", rollback = null, actor = "owner" } = {}) {
  const list = readAudit();
  list.unshift({
    at: Date.now(),
    kind: String(kind || "action"),
    action: String(action || "").slice(0, 80),
    target: String(target || "").slice(0, 160),
    detail: String(detail || "").slice(0, 240),
    before,
    after,
    scope: String(scope || "global").slice(0, 40),
    reason: String(reason || "").slice(0, 200),
    source: String(source || "owner").slice(0, 40),
    rollback: rollback === null ? null : rollback,
    actor: String(actor || "owner").slice(0, 40)
  });
  store.set(AUDIT_KEY, list.slice(0, MAX));
  return list[0];
}

export function clearAudit() {
  store.set(AUDIT_KEY, []);
}

export function lastChangeFor(path) {
  return readAudit().find((item) => item.kind === "config" && item.target === path) || null;
}

export function auditCountSince(ts = 0) {
  return readAudit().filter((item) => Number(item.at) > Number(ts || 0)).length;
}
