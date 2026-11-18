import { dbReady } from "../db.js";
import { requireAuth } from "./auth.js";
import { createRateLimiter } from "../redis.js";
import { audit } from "../audit.js";
import { storeState } from "../userStore.js";
import {
  databaseHealth,
  tableCounts,
  createBackup,
  verifyDatabase,
  exportDatabase,
  pruneDatabase,
  listAudit
} from "../database/index.js";

const adminLimit = createRateLimiter({ max: 30, windowMs: 60_000, prefix: "wt:rl:admin:" });

async function ownerOnly(req, reply) {
  await requireAuth(req, reply);
  if (reply.sent) return false;
  if (!["owner", "super_owner"].includes(req.auth.role)) {
    reply.code(403).send({ error: "forbidden", message: "Only the site owner can manage the database." });
    return false;
  }
  return true;
}

export default async function adminRoutes(app) {
  app.addHook("preHandler", adminLimit);

  app.get("/database", async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    const health = await databaseHealth();
    return {
      ok: Boolean(health.ok),
      primary: dbReady() ? "mongodb" : "sqlite",
      store: storeState(),
      database: health
    };
  });

  app.get("/database/tables", async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    return { ok: true, tables: await tableCounts() };
  });

  app.post("/database/backup", async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    try {
      const backup = await createBackup({ label: "manual" });
      await audit("admin.database.backup", req, {
        targetType: "database",
        meta: { fileName: backup.fileName, sizeBytes: backup.sizeBytes, verified: backup.verified }
      });
      return {
        ok: true,
        backup: {
          fileName: backup.fileName,
          sizeBytes: backup.sizeBytes,
          checksum: backup.checksum,
          integrity: backup.integrity,
          verified: backup.verified,
          createdAt: backup.createdAt
        }
      };
    } catch (err) {
      return reply.code(503).send({ error: "backup_failed", message: err.message });
    }
  });

  app.post("/database/verify", async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    const fileName = String(req.body?.file || "").trim();
    const result = await verifyDatabase(fileName);
    await audit("admin.database.verify", req, {
      targetType: "database",
      targetId: fileName,
      meta: { ok: Boolean(result.ok), integrity: result.integrity || "" }
    });
    return { ok: Boolean(result.ok), result };
  });

  app.post("/database/export", async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    try {
      const result = await exportDatabase();
      await audit("admin.database.export", req, {
        targetType: "database",
        meta: { name: result.name, tables: result.tables, rows: result.rows }
      });
      return {
        ok: true,
        export: {
          name: result.name,
          tables: result.tables,
          rows: result.rows,
          createdAt: result.createdAt
        }
      };
    } catch (err) {
      return reply.code(503).send({ error: "export_failed", message: err.message });
    }
  });

  app.post("/database/prune", async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    const result = await pruneDatabase();
    await audit("admin.database.prune", req, {
      targetType: "database",
      meta: { deleted: result.deleted || {} }
    });
    return result;
  });

  app.get("/audit", async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    const limit = Math.min(200, Math.max(1, Number(req.query?.limit) || 50));
    const before = Number(req.query?.before) || 0;
    const entries = await listAudit({ limit, before });
    return { ok: true, entries, nextBefore: entries.length ? entries[entries.length - 1].createdAt : 0 };
  });
}
