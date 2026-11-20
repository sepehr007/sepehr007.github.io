import fs from "node:fs";
import { fileRecord } from "../storage.js";
import { requireAuth, readAuth } from "./auth.js";
import { permissionGranted } from "../adminGuard.js";
import { dbReady } from "../db.js";
import { ensureStore } from "../userStore.js";

function staffAccess(role, userId) {
  return role === "owner" || role === "super_owner" || permissionGranted(role, userId, "support.manage");
}

export default async function fileRoutes(app) {
  app.get("/:id", async (req, reply) => {
    if (dbReady()) return reply.code(503).send({ error: "sqlite_only", message: "Files need the SQLite deployment." });
    if (!(await ensureStore())) return reply.code(503).send({ error: "database_unavailable", message: "Database is not connected yet." });
    const record = await fileRecord(String(req.params.id || ""));
    if (!record) return reply.code(404).send({ error: "file_missing", message: "That file does not exist." });
    const { row, filePath } = record;
    if (row.visibility !== "public") {
      let auth = readAuth(req);
      if (!auth) {
        await requireAuth(req, reply);
        if (reply.sent) return undefined;
        auth = { sub: req.auth.userId, role: req.auth.role };
      }
      const owns = String(row.owner_id || "") === String(auth.sub);
      if (!owns && !staffAccess(auth.role || req.auth?.role || "", auth.sub)) {
        return reply.code(403).send({ error: "forbidden", message: "You do not have access to this file." });
      }
    }
    const total = Number(row.size_bytes) || 0;
    const type = row.mime || "application/octet-stream";
    reply.header("content-type", type);
    reply.header("x-content-type-options", "nosniff");
    reply.header("accept-ranges", "bytes");
    if (row.visibility === "public") reply.header("cache-control", "public, max-age=31536000, immutable");
    else reply.header("cache-control", "private, no-store");
    if (row.kind === "subtitle" || row.kind === "attachment") {
      const name = String(row.purpose || "file").replace(/["\r\n]/g, "").slice(0, 120);
      reply.header("content-disposition", `inline; filename="${name || "file"}"`);
    }
    const range = String(req.headers.range || "");
    if (range && (row.kind === "media" || type.startsWith("video/") || type.startsWith("audio/"))) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (match) {
        let start = match[1] ? Number(match[1]) : 0;
        let end = match[2] ? Number(match[2]) : total - 1;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
          reply.header("content-range", `bytes */${total}`);
          return reply.code(416).send();
        }
        end = Math.min(end, total - 1);
        reply.code(206);
        reply.header("content-range", `bytes ${start}-${end}/${total}`);
        reply.header("content-length", String(end - start + 1));
        return reply.send(fs.createReadStream(filePath, { start, end }));
      }
    }
    reply.header("content-length", String(total));
    return reply.send(fs.createReadStream(filePath));
  });
}
