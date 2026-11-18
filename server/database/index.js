import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MIGRATIONS } from "./schema.js";
import { appConfig } from "../config.js";

export const DATA_DIR = appConfig.dataDir;
export const SQLITE_FILE = appConfig.sqliteFile;
export const BACKUP_DIR = appConfig.backupDir;
const RETRY_MS = appConfig.databaseRetryMs;

const BUSY_TIMEOUT_MS = Math.max(1000, Number(process.env.DB_BUSY_TIMEOUT_MS) || 5000);
const BACKUP_KEEP = Math.max(0, Number(process.env.BACKUP_KEEP) || 30);
const AUTO_BACKUP_HOURS = Math.max(0, Number(process.env.AUTO_BACKUP_HOURS ?? 24));
const DAY_MS = 24 * 60 * 60 * 1000;

const RETENTION = {
  sessionsGraceDays: Math.max(1, Number(process.env.RETENTION_SESSION_GRACE_DAYS) || 7),
  auditDays: Math.max(1, Number(process.env.RETENTION_AUDIT_DAYS) || 365),
  analyticsDays: Math.max(1, Number(process.env.RETENTION_ANALYTICS_DAYS) || 90),
  playbackDays: Math.max(1, Number(process.env.RETENTION_PLAYBACK_DAYS) || 365),
  notificationDays: Math.max(1, Number(process.env.RETENTION_NOTIFICATION_DAYS) || 90),
  messageDays: Math.max(0, Number(process.env.RETENTION_MESSAGE_DAYS) || 0)
};

let db = null;
let opening = null;
let tried = false;
let lastError = "";
let openedAt = 0;
let maintenanceTimer = null;
let transactionDepth = 0;
let retryTimer = null;

const statements = new Map();
const MAX_STATEMENTS = 400;

function nowMs() {
  return Date.now();
}

function configure(connection) {
  connection.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -64000;
  `);
}

function migrate(connection) {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL DEFAULT '',
      applied_at INTEGER NOT NULL
    );
  `);
  const applied = new Map(
    connection.prepare("SELECT version, name, checksum FROM schema_migrations").all().map((row) => [Number(row.version), row])
  );
  for (const migration of MIGRATIONS) {
    const checksum = crypto.createHash("sha256").update(migration.up.toString()).digest("hex");
    const previous = applied.get(migration.version);
    if (previous) {
      if (previous.checksum && previous.checksum !== checksum) {
        console.warn(`[db] migration ${migration.version} (${migration.name}) changed after it was applied`);
      }
      continue;
    }
    connection.exec("BEGIN IMMEDIATE");
    try {
      migration.up(connection);
      connection
        .prepare("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)")
        .run(migration.version, migration.name, checksum, nowMs());
      connection.exec("COMMIT");
      console.log(`[db] applied migration ${migration.version}: ${migration.name}`);
    } catch (err) {
      try {
        connection.exec("ROLLBACK");
      } catch {}
      throw new Error(`migration ${migration.version} (${migration.name}) failed: ${err.message}`);
    }
  }
}

function scheduleRetry() {
  if (retryTimer || !RETRY_MS) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    tried = false;
    getDatabase().catch(() => {});
  }, RETRY_MS);
  retryTimer.unref?.();
}

export async function getDatabase() {
  if (db) return db;
  if (opening) return opening;
  if (tried) return null;

  tried = true;
  const attempt = (async () => {
    try {
      fs.mkdirSync(path.dirname(SQLITE_FILE), { recursive: true });
      const { DatabaseSync } = await import("node:sqlite");
      const connection = new DatabaseSync(SQLITE_FILE);
      try {
        configure(connection);
        migrate(connection);
      } catch (err) {
        try {
          connection.close();
        } catch {}
        throw err;
      }
      db = connection;
      openedAt = nowMs();
      lastError = "";
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      return db;
    } catch (err) {
      lastError = err.message;
      console.error("[db] sqlite unavailable:", err.message);
      scheduleRetry();
      return null;
    }
  })();

  opening = attempt;
  attempt
    .finally(() => {
      if (opening === attempt) opening = null;
    })
    .catch(() => {});
  return opening;
}

export function closeDatabase() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  statements.clear();
  if (db) {
    try {
      db.close();
    } catch {}
  }
  db = null;
  tried = false;
  openedAt = 0;
}

export function databaseReady() {
  return Boolean(db);
}

export function databaseState() {
  let version = 0;
  if (db) {
    try {
      version = Number(db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get()?.version || 0);
    } catch {}
  }
  return {
    ready: Boolean(db),
    mode: db ? "sqlite" : tried ? "unavailable" : "pending",
    file: db ? SQLITE_FILE : "",
    version,
    error: lastError
  };
}

export function statement(sql) {
  if (!db) throw new Error("database_not_open");
  let prepared = statements.get(sql);
  if (!prepared) {
    prepared = db.prepare(sql);
    if (statements.size >= MAX_STATEMENTS) statements.clear();
    statements.set(sql, prepared);
  }
  return prepared;
}

export function run(sql, ...params) {
  return statement(sql).run(...params);
}

export function get(sql, ...params) {
  return statement(sql).get(...params);
}

export function all(sql, ...params) {
  return statement(sql).all(...params);
}

export function transaction(fn) {
  if (!db) throw new Error("database_not_open");
  if (typeof fn !== "function") throw new Error("transaction_requires_function");
  if (transactionDepth > 0) return fn(db);
  db.exec("BEGIN IMMEDIATE");
  transactionDepth += 1;
  try {
    const result = fn(db);
    if (result && typeof result.then === "function") {
      throw new Error("transaction_must_be_synchronous");
    }
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw err;
  } finally {
    transactionDepth -= 1;
  }
}

export function pageLimit(value, fallback = 50, max = 200) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(number)));
}

export function backupDirectory() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  return BACKUP_DIR;
}

async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function inspectSqliteFile(file) {
  const { DatabaseSync } = await import("node:sqlite");
  const connection = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = String(connection.prepare("PRAGMA integrity_check").get()?.integrity_check || "unknown");
    const foreignKeys = connection.prepare("PRAGMA foreign_key_check").all().length;
    const tables = Number(
      connection
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .get()?.n || 0
    );
    return { integrity, foreignKeyViolations: foreignKeys, tables, ok: integrity === "ok" && foreignKeys === 0 };
  } finally {
    connection.close();
  }
}

function retentionPlan() {
  return {
    ...RETENTION,
    messageDays: RETENTION.messageDays
  };
}

export async function databaseHealth() {
  const connection = await getDatabase();
  if (!connection) {
    return {
      ok: false,
      mode: "unavailable",
      file: "",
      error: lastError,
      retention: retentionPlan()
    };
  }
  const size = fs.existsSync(SQLITE_FILE) ? fs.statSync(SQLITE_FILE).size : 0;
  const integrity = String(connection.prepare("PRAGMA quick_check").get()?.quick_check || "unknown");
  const foreignKeyViolations = connection.prepare("PRAGMA foreign_key_check").all().length;
  const migrations = connection
    .prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version")
    .all()
    .map((row) => ({ version: Number(row.version), name: row.name, appliedAt: Number(row.applied_at) }));
  return {
    ok: integrity === "ok" && foreignKeyViolations === 0,
    mode: "sqlite",
    file: SQLITE_FILE,
    sizeBytes: size,
    openedAt,
    integrity,
    foreignKeyViolations,
    schemaVersion: migrations.length ? migrations[migrations.length - 1].version : 0,
    migrations,
    backupDir: BACKUP_DIR,
    backupsKept: BACKUP_KEEP,
    retention: retentionPlan()
  };
}

export async function tableCounts() {
  const connection = await getDatabase();
  if (!connection) return {};
  const tables = connection
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
  const counts = {};
  for (const table of tables) {
    const quoted = `"${String(table).replaceAll('"', '""')}"`;
    counts[table] = Number(connection.prepare(`SELECT COUNT(*) AS n FROM ${quoted}`).get()?.n || 0);
  }
  return counts;
}

export async function createBackup({ label = "", keep = BACKUP_KEEP } = {}) {
  const connection = await getDatabase();
  if (!connection) throw new Error("database_unavailable");
  const dir = backupDirectory();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeLabel = String(label || "")
    .replace(/[^a-z0-9_-]/gi, "")
    .slice(0, 24);
  const fileName = `wt-${stamp}${safeLabel ? `-${safeLabel}` : ""}.sqlite`;
  const file = path.join(dir, fileName);

  connection.exec("PRAGMA wal_checkpoint(PASSIVE)");
  connection.prepare("VACUUM INTO ?").run(file);

  const stat = fs.statSync(file);
  const checksum = await sha256File(file);
  const inspection = await inspectSqliteFile(file);
  const id = crypto.randomUUID();
  const at = nowMs();
  connection
    .prepare(
      `INSERT INTO backup_runs (id, file_name, size_bytes, checksum, integrity, created_at, verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, fileName, stat.size, checksum, inspection.integrity, at, inspection.ok ? at : null);

  const removed = pruneBackupFiles(keep);
  return {
    id,
    fileName,
    file,
    sizeBytes: stat.size,
    checksum,
    integrity: inspection.integrity,
    foreignKeyViolations: inspection.foreignKeyViolations,
    verified: inspection.ok,
    removedOldBackups: removed,
    createdAt: at
  };
}

function pruneBackupFiles(keep) {
  if (!Number.isFinite(keep) || keep <= 0) return 0;
  let removed = 0;
  try {
    const files = fs
      .readdirSync(BACKUP_DIR)
      .filter((name) => /^wt-.*\.sqlite$/.test(name))
      .map((name) => ({ name, time: fs.statSync(path.join(BACKUP_DIR, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    for (const file of files.slice(keep)) {
      fs.unlinkSync(path.join(BACKUP_DIR, file.name));
      removed += 1;
    }
  } catch (err) {
    console.warn("[db] backup retention failed:", err.message);
  }
  return removed;
}

export async function verifyDatabase(fileName = "") {
  if (fileName) {
    const safe = path.basename(String(fileName));
    const file = path.join(backupDirectory(), safe);
    if (!fs.existsSync(file)) return { ok: false, file: safe, error: "backup_not_found" };
    const inspection = await inspectSqliteFile(file);
    return { ...inspection, file: safe, sizeBytes: fs.statSync(file).size };
  }
  const connection = await getDatabase();
  if (!connection) return { ok: false, error: "database_unavailable" };
  const integrity = String(connection.prepare("PRAGMA integrity_check").get()?.integrity_check || "unknown");
  const foreignKeyViolations = connection.prepare("PRAGMA foreign_key_check").all().length;
  return {
    ok: integrity === "ok" && foreignKeyViolations === 0,
    file: path.basename(SQLITE_FILE),
    sizeBytes: fs.existsSync(SQLITE_FILE) ? fs.statSync(SQLITE_FILE).size : 0,
    integrity,
    foreignKeyViolations
  };
}

export async function exportDatabase() {
  const connection = await getDatabase();
  if (!connection) throw new Error("database_unavailable");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(backupDirectory(), `export-${stamp}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tables = connection
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
  const manifest = { generatedAt: new Date().toISOString(), source: SQLITE_FILE, tables: {} };
  let totalRows = 0;
  for (const table of tables) {
    const quoted = `"${String(table).replaceAll('"', '""')}"`;
    const stmt = connection.prepare(`SELECT * FROM ${quoted}`);
    const file = path.join(dir, `${table}.jsonl`);
    const out = fs.openSync(file, "w", 0o600);
    let rows = 0;
    try {
      for (const row of stmt.iterate()) {
        fs.writeSync(out, `${JSON.stringify(row)}\n`);
        rows += 1;
      }
    } finally {
      fs.closeSync(out);
    }
    const checksum = await sha256File(file);
    manifest.tables[table] = { rows, checksum, file: `${table}.jsonl` };
    totalRows += rows;
  }
  const manifestFile = path.join(dir, "manifest.json");
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return {
    dir,
    name: path.basename(dir),
    tables: tables.length,
    rows: totalRows,
    manifest: manifestFile,
    createdAt: nowMs()
  };
}

export async function pruneDatabase() {
  const connection = await getDatabase();
  if (!connection) return { ok: false, error: "database_unavailable" };
  const now = nowMs();
  const plan = retentionPlan();
  const result = transaction((conn) => {
    const deleted = {};
    const remove = (table, sql, ...params) => {
      const info = conn.prepare(sql).run(...params);
      deleted[table] = Number(info.changes || 0);
    };

    remove("email_tokens", "DELETE FROM email_tokens WHERE expires_at < ?", now);
    remove(
      "sessions",
      "DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)",
      now - plan.sessionsGraceDays * DAY_MS,
      now - plan.sessionsGraceDays * DAY_MS
    );
    remove("audit_logs", "DELETE FROM audit_logs WHERE created_at < ?", now - plan.auditDays * DAY_MS);
    remove("analytics_events", "DELETE FROM analytics_events WHERE created_at < ?", now - plan.analyticsDays * DAY_MS);
    remove("playback_history", "DELETE FROM playback_history WHERE last_watched_at < ?", now - plan.playbackDays * DAY_MS);
    remove(
      "notifications",
      `DELETE FROM notifications
       WHERE (expires_at IS NOT NULL AND expires_at < ?)
          OR (read_at IS NOT NULL AND read_at < ?)`,
      now,
      now - plan.notificationDays * DAY_MS
    );
    if (plan.messageDays > 0) {
      const info = conn
        .prepare("UPDATE messages SET deleted_at = ? WHERE created_at < ? AND deleted_at IS NULL")
        .run(now, now - plan.messageDays * DAY_MS);
      deleted.messages_archived = Number(info.changes || 0);
    }
    return deleted;
  });
  return { ok: true, at: now, retention: plan, deleted: result };
}

export function recordAudit({
  actorId = null,
  actorRole = "",
  action,
  targetType = "",
  targetId = "",
  ip = "",
  userAgent = "",
  meta = {},
  createdAt = nowMs()
} = {}) {
  if (!db || !action) return false;
  try {
    db.prepare(
      `INSERT INTO audit_logs
       (id, actor_id, actor_role, action, target_type, target_id, ip, user_agent, meta_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      crypto.randomUUID(),
      actorId ? String(actorId) : null,
      String(actorRole || "").slice(0, 40),
      String(action).slice(0, 80),
      String(targetType || "").slice(0, 40),
      String(targetId || "").slice(0, 80),
      String(ip || "").slice(0, 80),
      String(userAgent || "").slice(0, 220),
      JSON.stringify(meta || {}),
      createdAt
    );
    return true;
  } catch (err) {
    lastError = err.message;
    return false;
  }
}

export async function listAudit({ limit = 50, before = 0 } = {}) {
  const connection = await getDatabase();
  if (!connection) return [];
  const size = pageLimit(limit, 50, 200);
  const rows = before
    ? connection
        .prepare("SELECT * FROM audit_logs WHERE created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?")
        .all(Number(before), size)
    : connection.prepare("SELECT * FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT ?").all(size);
  return rows.map((row) => ({
    id: row.id,
    actorId: row.actor_id || "",
    actorRole: row.actor_role || "",
    action: row.action,
    targetType: row.target_type || "",
    targetId: row.target_id || "",
    ip: row.ip || "",
    userAgent: row.user_agent || "",
    meta: safeJson(row.meta_json),
    createdAt: Number(row.created_at || 0)
  }));
}

function safeJson(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

export async function runMaintenance(log = console) {
  const connection = await getDatabase();
  if (!connection) return { ok: false, error: lastError || "database_unavailable" };
  let backup = null;
  try {
    const last = connection.prepare("SELECT file_name, created_at FROM backup_runs ORDER BY created_at DESC LIMIT 1").get();
    const intervalMs = AUTO_BACKUP_HOURS * 60 * 60 * 1000;
    if (intervalMs > 0 && (!last || nowMs() - Number(last.created_at || 0) >= intervalMs)) {
      backup = await createBackup({ label: "auto" });
    }
  } catch (err) {
    log?.warn?.(`[db] automatic backup failed: ${err.message}`);
  }
  let prune = null;
  try {
    prune = await pruneDatabase();
  } catch (err) {
    log?.warn?.(`[db] retention failed: ${err.message}`);
  }
  return { ok: true, backup, prune };
}

export async function startMaintenance(log = console) {
  const connection = await getDatabase();
  if (!connection) return false;
  try {
    await runMaintenance(log);
  } catch (err) {
    log?.warn?.(`[db] initial maintenance failed: ${err.message}`);
  }
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  const intervalMs = Math.max(60_000, Number(process.env.MAINTENANCE_INTERVAL_MS) || 6 * 60 * 60 * 1000);
  maintenanceTimer = setInterval(() => {
    runMaintenance(log).catch((err) => log?.warn?.(`[db] maintenance failed: ${err.message}`));
  }, intervalMs);
  maintenanceTimer.unref?.();
  return true;
}

export function stopMaintenance() {
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  maintenanceTimer = null;
}

export { RETENTION, BACKUP_KEEP, AUTO_BACKUP_HOURS };
