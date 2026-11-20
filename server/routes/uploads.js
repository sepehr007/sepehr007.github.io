import { requireAuth } from "./auth.js";
import { dbReady } from "../db.js";
import { ensureStore } from "../userStore.js";
import { KINDS, saveUpload, usageFor, removeUpload } from "../storage.js";
import { audit } from "../audit.js";
import { permissionGranted } from "../adminGuard.js";
import { createRateLimiter } from "../redis.js";

const uploadLimit = createRateLimiter({ max: 20, windowMs: 60_000, prefix: "wt:rl:upload:" });

function fail(reply, status, error, message) {
  return reply.code(status).send({ error, message });
}

async function ready(reply) {
  if (dbReady()) {
    fail(reply, 503, "sqlite_only", "Uploads need the SQLite deployment.");
    return false;
  }
  if (await ensureStore()) return true;
  fail(reply, 503, "database_unavailable", "Database is not connected yet.");
  return false;
}

export default async function uploadRoutes(app) {
  app.get("/usage", { preHandler: [requireAuth] }, async (req) => {
    const usage = await usageFor(req.auth.userId);
    return {
      ok: true,
      usedBytes: usage.used,
      quotaBytes: usage.quota,
      globalUsedBytes: usage.globalUsed,
      globalQuotaBytes: usage.globalQuota,
      kinds: Object.entries(KINDS).map(([key, value]) => ({ key, label: value.label, maxBytes: value.maxBytes, types: value.types }))
    };
  });

  app.post("/", { preHandler: [requireAuth, uploadLimit], bodyLimit: 55 * 1024 * 1024 }, async (req, reply) => {
    if (!(await ready(reply))) return undefined;
    if (!Buffer.isBuffer(req.body)) return fail(reply, 415, "unsupported_body", "Send the file as a raw binary body.");
    const kind = String(req.query?.kind || req.headers["x-file-kind"] || "").trim();
    const fileName = String(req.headers["x-file-name"] || "").trim();
    const declaredType = String(req.headers["x-file-type"] || "").trim();
    const result = await saveUpload({ buffer: req.body, kind, declaredType, fileName, userId: req.auth.userId });
    if (!result.ok) {
      const message =
        result.error === "file_too_large"
          ? "File is larger than the allowed limit."
          : result.error === "unsupported_type"
            ? "File type is not allowed for this upload."
            : result.error === "user_quota_exceeded"
              ? "Your storage quota is full. Delete older files first."
              : result.error === "storage_full"
                ? "Server storage is full."
                : "Upload rejected.";
      return reply.code(result.status || 400).send({ error: result.error, message, ...result });
    }
    await audit("upload.create", req, { targetType: "file", targetId: result.file.id, meta: { kind, mime: result.file.mime, size: result.file.size } });
    const usage = await usageFor(req.auth.userId);
    return { ok: true, ...result.file, usage: { usedBytes: usage.used, quotaBytes: usage.quota } };
  });

  app.delete("/:id", { preHandler: [requireAuth] }, async (req, reply) => {
    if (!(await ready(reply))) return undefined;
    const isStaff = permissionGranted(req.auth.role, req.auth.userId, "users.manage");
    const result = await removeUpload(req.params.id, { actorId: req.auth.userId, isStaff });
    if (!result.ok) {
      if (result.error === "forbidden") return fail(reply, 403, "forbidden", "You can only delete your own files.");
      return fail(reply, 404, "file_missing", "That file does not exist.");
    }
    await audit("upload.delete", req, { targetType: "file", targetId: result.removed, meta: { staff: isStaff } });
    return { ok: true, removed: result.removed };
  });
}
