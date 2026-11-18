import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SQLITE_FILE, BACKUP_DIR } from "./database/index.js";

const confirmed = process.argv.includes("--yes");
const input = process.argv.slice(2).find((arg) => arg !== "--yes") || "";

function usage(message = "") {
  if (message) console.error(`[restore] ${message}`);
  console.error("Usage: node restore.js <backup-file> [--yes]");
  console.error("  Without --yes the script only verifies the backup and prints a plan.");
  try {
    const files = fs
      .readdirSync(BACKUP_DIR)
      .filter((name) => name.endsWith(".sqlite"))
      .map((name) => ({ name, time: fs.statSync(path.join(BACKUP_DIR, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time)
      .slice(0, 10);
    if (files.length) {
      console.error("\nAvailable backups:");
      for (const file of files) {
        const full = path.join(BACKUP_DIR, file.name);
        const stat = fs.statSync(full);
        console.error(`  ${file.name}  ${(stat.size / 1024).toFixed(1)} KB  ${stat.mtime.toISOString()}`);
      }
    }
  } catch {}
  process.exitCode = 1;
}

function resolveBackup(value) {
  if (!value) return "";
  const direct = path.resolve(value);
  if (fs.existsSync(direct)) return direct;
  const inBackups = path.join(BACKUP_DIR, path.basename(value));
  return fs.existsSync(inBackups) ? inBackups : "";
}

function checksum(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function inspect(file) {
  const { DatabaseSync } = await import("node:sqlite");
  const connection = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = String(connection.prepare("PRAGMA integrity_check").get()?.integrity_check || "unknown");
    const foreignKeyViolations = connection.prepare("PRAGMA foreign_key_check").all().length;
    let schemaVersion = 0;
    try {
      schemaVersion = Number(connection.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get()?.v || 0);
    } catch {}
    return {
      integrity,
      foreignKeyViolations,
      schemaVersion,
      ok: integrity === "ok" && foreignKeyViolations === 0
    };
  } finally {
    connection.close();
  }
}

async function main() {
  if (!input) {
    usage("A backup file is required.");
    return;
  }
  const backup = resolveBackup(input);
  if (!backup) {
    usage(`Backup not found: ${input}`);
    return;
  }

  const report = await inspect(backup);
  if (!report.ok) {
    console.error(`[restore] Backup failed verification: integrity=${report.integrity}, foreign-key violations=${report.foreignKeyViolations}`);
    process.exitCode = 1;
    return;
  }

  const exists = fs.existsSync(SQLITE_FILE);
  console.log(`[restore] backup: ${backup}`);
  console.log(`[restore] sha256: ${checksum(backup)}`);
  console.log(`[restore] integrity: ${report.integrity}, schema v${report.schemaVersion}`);
  console.log(`[restore] target: ${SQLITE_FILE}${exists ? "" : " (new file)"}`);

  if (!confirmed) {
    console.log("[restore] dry run: nothing was written. Re-run with --yes to replace the live database.");
    return;
  }

  fs.mkdirSync(path.dirname(SQLITE_FILE), { recursive: true });
  if (exists) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safety = path.join(BACKUP_DIR, `pre-restore-${stamp}.sqlite`);
    fs.copyFileSync(SQLITE_FILE, safety);
    console.log(`[restore] current database saved to ${safety}`);
  }

  fs.copyFileSync(backup, SQLITE_FILE);
  for (const suffix of ["-wal", "-shm"]) {
    const stale = `${SQLITE_FILE}${suffix}`;
    if (fs.existsSync(stale)) fs.rmSync(stale);
  }

  const after = await inspect(SQLITE_FILE);
  console.log(`[restore] done. integrity=${after.integrity}, foreign-key violations=${after.foreignKeyViolations}, schema v${after.schemaVersion}`);
  process.exitCode = after.ok ? 0 : 1;
}

main().catch((err) => {
  console.error(`[restore] failed: ${err.message}`);
  console.error("[restore] If the API is running, stop it first (systemctl stop / docker compose stop), then retry.");
  process.exitCode = 1;
});
