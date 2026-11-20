import { dbReady } from "../db.js";
import { all, pageLimit } from "../database/index.js";
import { audit } from "../audit.js";
import { adminLimit, permissionOnly } from "../adminGuard.js";
import { storageSummary, cleanupUploads, KINDS } from "../storage.js";
import { ensureStore } from "../userStore.js";

function fail(reply, status, error, message) {
  return reply.code(status).send({ error, message });
}

async function ready(reply) {
  if (dbReady()) {
    fail(reply, 503, "sqlite_only", "File storage needs the SQLite deployment.");
    return false;
  }
  if (await ensureStore()) return true;
  fail(reply, 503, "database_unavailable", "Database is not connected yet.");
  return false;
}

function mapFile(row) {
  return {
    id: row.id,
    ownerId: row.owner_id || "",
    owner: row.username || "",
    kind: row.kind,
    label: KINDS[row.kind]?.label || row.kind,
    mime: row.mime,
    sizeBytes: Number(row.size_bytes || 0),
    visibility: row.visibility,
    purpose: row.purpose || "",
    url: `/api/files/${row.id}`,
    deleted: Boolean(row.deleted_at),
    createdAt: Number(row.created_at || 0)
  };
}

export default async function adminStorageRoutes(app) {
  app.addHook("preHandler", adminLimit);

  app.get("/storage/usage", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "users.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const summary = await storageSummary();
    return { ok: true, ...(summary || { totalFiles: 0, totalBytes: 0, byKind: [], quota: null }) };
  });

  app.get("/storage/files", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "users.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    const limit = pageLimit(req.query?.limit, 30, 100);
    const before = Number(req.query?.before) || 0;
    const kind = String(req.query?.kind || "").trim();
    const where = ["1 = 1"];
    const params = [];
    if (kind) {
      where.push("m.kind = ?");
      params.push(kind);
    }
    if (before) {
      where.push("m.created_at < ?");
      params.push(before);
    }
    const rows = all(
      `SELECT m.*, u.username FROM media_objects m LEFT JOIN users u ON u.id = m.owner_id
       WHERE ${where.join(" AND ")} ORDER BY m.created_at DESC LIMIT ?`,
      ...params,
      limit + 1
    );
    const hasMore = rows.length > limit;
    return { ok: true, files: rows.slice(0, limit).map(mapFile), nextBefore: hasMore ? rows[limit - 1].created_at : null };
  });

  app.post("/storage/cleanup", async (req, reply) => {
    if (!(await permissionOnly(req, reply, "users.manage"))) return undefined;
    if (!(await ready(reply))) return undefined;
    if (req.body?.confirm !== true) return fail(reply, 428, "confirmation_required", "Send confirm:true to run cleanup.");
    const olderThanDays = Math.max(0, Math.min(3650, Math.floor(Number(req.body?.olderThanDays ?? 7)) || 0));
    const result = await cleanupUploads({ olderThanDays });
    await audit("admin.storage.cleanup", req, { targetType: "storage", meta: { olderThanDays, ...result } });
    return { ok: true, ...result };
  });
}
