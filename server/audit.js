import { recordAudit } from "./database/index.js";

const BLOCKED_KEY = /pass|secret|token|code|api.?key|authorization|recovery|cookie|session|hash/i;

function cleanValue(value, depth = 0) {
  if (depth > 4) return "[deep]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.slice(0, 600);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => cleanValue(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (BLOCKED_KEY.test(key)) {
        out[key] = "[redacted]";
        continue;
      }
      out[key] = cleanValue(item, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, 200);
}

export function audit(action, req, { targetType = "", targetId = "", meta = {}, actorId, actorRole } = {}) {
  try {
    return Promise.resolve(
      recordAudit({
        actorId: actorId ?? req?.auth?.userId ?? null,
        actorRole: actorRole ?? req?.auth?.role ?? "",
        action,
        targetType,
        targetId,
        ip: req?.ip || "",
        userAgent: req?.headers?.["user-agent"] || "",
        meta: cleanValue(meta)
      })
    );
  } catch {
    return Promise.resolve(false);
  }
}
