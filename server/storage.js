import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { appConfig } from "./config.js";
import { getDatabase, get, all, run } from "./database/index.js";
import { settingNumber, settingBool } from "./platformSettings.js";

const ROOT = path.join(appConfig.dataDir, "uploads");

export const KINDS = {
  avatar: { bucket: "avatars", maxBytes: 2 * 1024 * 1024, public: true, types: ["image/png", "image/jpeg", "image/webp", "image/gif"], label: "تصویر پروفایل" },
  "room-cover": { bucket: "covers", maxBytes: 5 * 1024 * 1024, public: true, types: ["image/png", "image/jpeg", "image/webp"], label: "کاور اتاق" },
  "server-image": { bucket: "servers", maxBytes: 5 * 1024 * 1024, public: true, types: ["image/png", "image/jpeg", "image/webp"], label: "تصویر سرور" },
  "page-image": { bucket: "pages", maxBytes: 5 * 1024 * 1024, public: true, types: ["image/png", "image/jpeg", "image/webp", "image/gif"], label: "تصویر صفحهٔ سایت" },
  subtitle: { bucket: "subtitles", maxBytes: 1024 * 1024, public: false, types: ["text/vtt", "application/x-subrip"], label: "زیرنویس" },
  attachment: { bucket: "support", maxBytes: 5 * 1024 * 1024, public: false, types: ["image/png", "image/jpeg", "image/webp", "application/pdf", "text/plain"], label: "پیوست پشتیبانی" },
  media: { bucket: "media", maxBytes: 100 * 1024 * 1024, public: false, types: ["video/mp4", "video/webm"], label: "رسانه" }
};

const MB = 1024 * 1024;
const DEFAULT_MEDIA_MAX_MB = 50;
const MEDIA_MAX_MB = 100;
const USER_QUOTA_BYTES = Number(process.env.UPLOAD_USER_QUOTA_MB || 60) * MB;
const GLOBAL_QUOTA_BYTES = Number(process.env.UPLOAD_GLOBAL_QUOTA_MB || 2048) * MB;

export async function mediaMaxBytes() {
  const mb = await settingNumber("upload.maxFileMB", DEFAULT_MEDIA_MAX_MB);
  return Math.max(1, Math.min(MEDIA_MAX_MB, Math.round(mb))) * MB;
}

async function userQuotaBytes() {
  const mb = await settingNumber("upload.storageQuotaMB", USER_QUOTA_BYTES / MB);
  return Math.max(10, Math.round(mb)) * MB;
}

const EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/vtt": "vtt",
  "application/x-subrip": "srt",
  "video/mp4": "mp4",
  "video/webm": "webm"
};

function sniff(buffer) {
  if (!buffer || buffer.length < 12) return "";
  const b = buffer;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (b.toString("ascii", 0, 4) === "%PDF") return "application/pdf";
  if (b.toString("ascii", 4, 8) === "ftyp") return "video/mp4";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  return "";
}

function looksText(buffer) {
  if (buffer.includes(0)) return false;
  let suspicious = 0;
  for (const byte of buffer) {
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious === 0;
}

function resolveType(buffer, declared, allowed) {
  const sniffed = sniff(buffer);
  if (sniffed) return allowed.includes(sniffed) ? sniffed : "";
  if (!looksText(buffer)) return "";
  if (declared === "text/vtt" && allowed.includes("text/vtt") && buffer.toString("utf8", 0, 40).includes("WEBVTT")) return "text/vtt";
  if (declared === "application/x-subrip" && allowed.includes("application/x-subrip")) return "application/x-subrip";
  if (declared === "text/plain" && allowed.includes("text/plain")) return "text/plain";
  if (allowed.includes("text/vtt") && buffer.toString("utf8", 0, 80).includes("WEBVTT")) return "text/vtt";
  if (allowed.includes("text/plain")) return "text/plain";
  return "";
}

export function uploadRoot() {
  return ROOT;
}

export async function usageFor(userId) {
  const quota = await userQuotaBytes();
  const db = await getDatabase();
  if (!db) return { used: 0, quota, globalUsed: 0, globalQuota: GLOBAL_QUOTA_BYTES };
  const used = Number(get("SELECT COALESCE(SUM(size_bytes),0) AS n FROM media_objects WHERE owner_id = ? AND deleted_at IS NULL", userId)?.n || 0);
  const globalUsed = Number(get("SELECT COALESCE(SUM(size_bytes),0) AS n FROM media_objects WHERE deleted_at IS NULL")?.n || 0);
  return { used, quota, globalUsed, globalQuota: GLOBAL_QUOTA_BYTES };
}

export async function saveUpload({ buffer, kind, declaredType = "", fileName = "", userId }) {
  const meta = KINDS[kind];
  if (!meta) return { ok: false, status: 400, error: "unknown_kind" };
  if (!buffer || !buffer.length) return { ok: false, status: 400, error: "empty_file" };
  const maxBytes = kind === "media" ? await mediaMaxBytes() : meta.maxBytes;
  if (buffer.length > maxBytes) return { ok: false, status: 413, error: "file_too_large", maxBytes };
  const type = resolveType(buffer, String(declaredType || "").toLowerCase(), meta.types);
  if (!type) return { ok: false, status: 415, error: "unsupported_type" };
  const usage = await usageFor(userId);
  if (usage.used + buffer.length > usage.quota) return { ok: false, status: 413, error: "user_quota_exceeded", quota: usage.quota, used: usage.used };
  if (usage.globalUsed + buffer.length > usage.globalQuota) return { ok: false, status: 507, error: "storage_full" };
  const id = crypto.randomUUID();
  const now = new Date();
  const dir = path.join(ROOT, meta.bucket, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"));
  const objectKey = `${meta.bucket}/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${id}.${EXT[type]}`;
  const filePath = path.join(ROOT, objectKey);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(filePath, buffer, { flag: "wx" });
  const checksum = crypto.createHash("sha256").update(buffer).digest("hex");
  run(
    `INSERT INTO media_objects (id, owner_id, bucket, object_key, mime, size_bytes, checksum, kind, visibility, purpose, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    userId,
    meta.bucket,
    objectKey,
    type,
    buffer.length,
    checksum,
    kind,
    meta.public ? "public" : "private",
    String(fileName || "").slice(0, 160),
    Date.now()
  );
  return {
    ok: true,
    file: { id, kind, mime: type, size: buffer.length, checksum, url: `/api/files/${id}`, visibility: meta.public ? "public" : "private" }
  };
}

export async function fileRecord(id) {
  const db = await getDatabase();
  if (!db) return null;
  const row = get("SELECT * FROM media_objects WHERE id = ? AND deleted_at IS NULL", String(id));
  if (!row) return null;
  const filePath = path.join(ROOT, row.object_key);
  const normalized = path.resolve(filePath);
  if (!normalized.startsWith(path.resolve(ROOT) + path.sep)) return null;
  if (!fs.existsSync(normalized)) return null;
  return { row, filePath: normalized };
}

export async function touchWatched(id) {
  const db = await getDatabase();
  if (!db) return false;
  const now = Date.now();
  const info = run(
    "UPDATE media_objects SET watched_at = ? WHERE id = ? AND kind = 'media' AND deleted_at IS NULL AND (watched_at IS NULL OR watched_at < ?)",
    now,
    String(id),
    now - 60_000
  );
  return Number(info?.changes || 0) > 0;
}

export async function sweepMedia() {
  const db = await getDatabase();
  if (!db) return { ok: false, error: "database_unavailable" };
  const deleteAfterWatch = await settingBool("upload.deleteAfterWatch", true);
  const graceMinutes = Math.max(1, Math.round(await settingNumber("upload.deleteGraceMinutes", 30)));
  const keepHours = Math.max(0, Math.round(await settingNumber("upload.mediaKeepHours", 48)));
  const now = Date.now();
  const rows = [];
  if (deleteAfterWatch) {
    rows.push(
      ...all(
        "SELECT * FROM media_objects WHERE kind = 'media' AND deleted_at IS NULL AND watched_at IS NOT NULL AND watched_at <= ? LIMIT 200",
        now - graceMinutes * 60_000
      )
    );
  }
  if (keepHours > 0) {
    rows.push(
      ...all(
        "SELECT * FROM media_objects WHERE kind = 'media' AND deleted_at IS NULL AND watched_at IS NULL AND created_at <= ? LIMIT 200",
        now - keepHours * 3_600_000
      )
    );
  }
  let removed = 0;
  let freedBytes = 0;
  for (const row of rows) {
    try {
      const filePath = path.join(ROOT, row.object_key);
      if (path.resolve(filePath).startsWith(path.resolve(ROOT) + path.sep)) await fsp.rm(filePath, { force: true });
    } catch {}
    run("DELETE FROM media_objects WHERE id = ?", row.id);
    removed += 1;
    freedBytes += Number(row.size_bytes) || 0;
  }
  return { ok: true, removed, freedBytes };
}

export async function removeUpload(id, { actorId = "", isStaff = false } = {}) {
  const db = await getDatabase();
  if (!db) return { ok: false, error: "database_unavailable" };
  const row = get("SELECT * FROM media_objects WHERE id = ? AND deleted_at IS NULL", String(id));
  if (!row) return { ok: false, error: "file_missing" };
  if (!isStaff && String(row.owner_id || "") !== String(actorId || "")) return { ok: false, error: "forbidden" };
  try {
    const filePath = path.join(ROOT, row.object_key);
    if (path.resolve(filePath).startsWith(path.resolve(ROOT) + path.sep)) await fsp.rm(filePath, { force: true });
  } catch {}
  run("UPDATE media_objects SET deleted_at = ? WHERE id = ?", Date.now(), row.id);
  return { ok: true, removed: row.id };
}

export async function storageSummary() {
  const db = await getDatabase();
  if (!db) return null;
  const byKind = all(
    "SELECT kind, COUNT(*) AS files, COALESCE(SUM(size_bytes),0) AS bytes FROM media_objects WHERE deleted_at IS NULL GROUP BY kind ORDER BY bytes DESC"
  );
  const deleted = all("SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes),0) AS bytes FROM media_objects WHERE deleted_at IS NOT NULL")[0];
  let diskBytes = 0;
  try {
    const walk = async (dir) => {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else diskBytes += (await fsp.stat(full)).size;
      }
    };
    if (fs.existsSync(ROOT)) await walk(ROOT);
  } catch {}
  return {
    root: "uploads",
    totalFiles: byKind.reduce((sum, row) => sum + Number(row.files), 0),
    totalBytes: byKind.reduce((sum, row) => sum + Number(row.bytes), 0),
    diskBytes,
    byKind: byKind.map((row) => ({ kind: row.kind, files: Number(row.files), bytes: Number(row.bytes), label: KINDS[row.kind]?.label || row.kind })),
    deleted: { files: Number(deleted.files), bytes: Number(deleted.bytes) },
    quota: { user: await userQuotaBytes(), global: GLOBAL_QUOTA_BYTES }
  };
}

export async function cleanupUploads({ olderThanDays = 7, removeOrphans = true } = {}) {
  const db = await getDatabase();
  if (!db) return { ok: false, error: "database_unavailable" };
  const cutoff = Date.now() - Math.max(0, Number(olderThanDays) || 0) * 86_400_000;
  const stale = all("SELECT * FROM media_objects WHERE deleted_at IS NOT NULL AND deleted_at <= ? LIMIT 500", cutoff);
  let removed = 0;
  for (const row of stale) {
    try {
      const filePath = path.join(ROOT, row.object_key);
      if (path.resolve(filePath).startsWith(path.resolve(ROOT) + path.sep)) await fsp.rm(filePath, { force: true });
    } catch {}
    run("DELETE FROM media_objects WHERE id = ?", row.id);
    removed += 1;
  }
  let orphans = 0;
  if (removeOrphans) {
    const known = new Set(all("SELECT object_key FROM media_objects").map((row) => row.object_key));
    const walk = async (dir) => {
      if (!fs.existsSync(dir)) return;
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else {
          const rel = path.relative(ROOT, full).split(path.sep).join("/");
          if (!known.has(rel)) {
            try {
              await fsp.rm(full, { force: true });
              orphans += 1;
            } catch {}
          }
        }
      }
    };
    await walk(ROOT);
  }
  return { ok: true, removedRows: removed, removedOrphans: orphans };
}
