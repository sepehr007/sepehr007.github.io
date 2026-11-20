import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const TMP = path.join(HERE, ".tmp", `release-${STAMP}`);
const DATA = path.join(TMP, "data");
const BACKUPS = path.join(DATA, "backups");

fs.mkdirSync(BACKUPS, { recursive: true });

Object.assign(process.env, {
  APP_ENV: "development",
  NODE_ENV: "development",
  LOG_LEVEL: "silent",
  DATA_DIR: DATA,
  SQLITE_FILE: path.join(DATA, "wt.sqlite"),
  BACKUP_DIR: BACKUPS,
  JWT_SECRET: "release-check-secret-0123456789abcdef0123456789",
  APP_ORIGIN: "http://127.0.0.1:4791",
  CORS_ORIGIN: "http://127.0.0.1:4791",
  RATE_LIMIT_MAX: "100000",
  RATE_LIMIT_WINDOW_MS: "1000",
  REQUIRE_EMAIL_VERIFICATION: "false",
  MONGO_URI: "",
  REDIS_URL: "",
  PAYMENT_PROVIDER: "manual",
  AUTO_BACKUP_HOURS: "0"
});

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail || "").slice(0, 300) });
  if (!ok) console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function htmlFiles() {
  return fs.readdirSync(ROOT).filter((name) => name.endsWith(".html"));
}

function attrRefs(html) {
  const refs = [];
  const re = /(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let match;
  while ((match = re.exec(html))) refs.push(match[1] ?? match[2] ?? "");
  return refs;
}

function localTarget(ref) {
  if (!ref) return "";
  const value = ref.trim();
  if (!value || value.startsWith("#") || /^(?:[a-z]+:|\/\/)/i.test(value)) return "";
  const clean = value.split("#")[0].split("?")[0];
  if (!clean) return "";
  if (clean.startsWith("/")) return path.join(ROOT, clean.slice(1));
  const fromRoot = path.join(ROOT, clean);
  if (fs.existsSync(fromRoot)) return fromRoot;
  return path.join(ROOT, clean);
}

function checkHashRef(pageFile, ref) {
  const hash = ref.split("#")[1];
  if (!hash) return null;
  const clean = ref.split("#")[0].split("?")[0];
  const target = clean ? (clean.startsWith("/") ? path.join(ROOT, clean.slice(1)) : path.join(ROOT, clean)) : pageFile;
  if (!target.endsWith(".html") || !fs.existsSync(target)) return null;
  const html = fs.readFileSync(target, "utf8");
  return new RegExp(`id=["']${hash.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).test(html);
}

function checkStaticSite() {
  const pages = htmlFiles();
  const broken = [];
  for (const page of pages) {
    const file = path.join(ROOT, page);
    const html = fs.readFileSync(file, "utf8");
    const htmlTag = html.match(/<html[^>]*>/i)?.[0] || "";
    if (!/\blang=["']fa["']/i.test(htmlTag) || !/\bdir=["']rtl["']/i.test(htmlTag)) {
      broken.push(`${page}: missing lang=fa/dir=rtl`);
    }
    for (const ref of attrRefs(html)) {
      const target = localTarget(ref);
      if (!target) continue;
      if (!fs.existsSync(target)) {
        broken.push(`${page}: missing ${ref}`);
        continue;
      }
      const hashOk = checkHashRef(file, ref);
      if (hashOk === false) broken.push(`${page}: missing anchor ${ref}`);
    }
  }
  check("static: local links and assets resolve", broken.length === 0, broken.slice(0, 8).join("; "));

  const cssBroken = [];
  for (const file of fs.readdirSync(path.join(ROOT, "assets/css"))) {
    if (!file.endsWith(".css")) continue;
    const css = fs.readFileSync(path.join(ROOT, "assets/css", file), "utf8");
    const re = /url\(\s*["']?([^"')]+)["']?\s*\)/g;
    let match;
    while ((match = re.exec(css))) {
      const value = match[1].trim();
      if (!value || /^(?:data:|https?:|\/\/|#)/i.test(value)) continue;
      const target = path.resolve(path.join(ROOT, "assets/css"), value.split("?")[0].split("#")[0]);
      if (!fs.existsSync(target)) cssBroken.push(`${file}: ${value}`);
    }
  }
  check("static: CSS url() targets exist", cssBroken.length === 0, cssBroken.slice(0, 8).join("; "));

  const jsBroken = [];
  for (const file of fs.readdirSync(path.join(ROOT, "assets/js"))) {
    if (!file.endsWith(".js")) continue;
    const source = fs.readFileSync(path.join(ROOT, "assets/js", file), "utf8");
    const re = /(?:from\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
    let match;
    while ((match = re.exec(source))) {
      const target = path.resolve(path.join(ROOT, "assets/js"), match[1].split("?")[0]);
      if (!fs.existsSync(target)) jsBroken.push(`${file}: ${match[1]}`);
    }
  }
  check("static: ES module imports resolve", jsBroken.length === 0, jsBroken.slice(0, 8).join("; "));

  const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  const cache = sw.match(/const CACHE = "([^"]+)"/)?.[1] || "";
  check("pwa: service worker cache version present", /^wt-v\d+$/.test(cache), cache || "missing");
  const shell = [...sw.matchAll(/^\s*"\.\/([^"]+)",?$/gm)].map((match) => match[1]);
  const missingShell = shell.filter((rel) => rel && !fs.existsSync(path.join(ROOT, rel)));
  check("pwa: every precached file exists", missingShell.length === 0, missingShell.join(", "));

  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.webmanifest"), "utf8"));
  } catch {}
  const manifestIcons = manifest?.icons || [];
  const missingIcons = manifestIcons.map((icon) => icon.src).filter((src) => !exists(src));
  check("pwa: manifest parses and icons exist", Boolean(manifest) && manifestIcons.length > 0 && missingIcons.length === 0, missingIcons.join(", "));
  check("pwa: manifest language is fa", manifest?.lang === "fa", manifest?.lang || "missing");
}

async function checkConfig() {
  const auth = spawnSync(process.execPath, ["config-check.js"], {
    cwd: HERE,
    env: { ...process.env, APP_ENV: "production", JWT_SECRET: "x".repeat(48), CORS_ORIGIN: "https://example.com", APP_ORIGIN: "https://example.com" },
    encoding: "utf8"
  });
  let parsed = null;
  try {
    parsed = JSON.parse(auth.stdout);
  } catch {}
  check("config: production check passes with JWT_SECRET", auth.status === 0 && parsed?.ok === true, parsed?.warnings?.map((w) => w.code).join(",") || auth.stderr.trim());

  const insecure = spawnSync(process.execPath, ["config-check.js"], {
    cwd: HERE,
    env: { ...process.env, APP_ENV: "production", JWT_SECRET: "", CORS_ORIGIN: "", APP_ORIGIN: "" },
    encoding: "utf8"
  });
  let insecureParsed = null;
  try {
    insecureParsed = JSON.parse(insecure.stdout);
  } catch {}
  const codes = insecureParsed?.warnings?.map((warning) => warning.code) || [];
  check("config: production refuses to start without JWT_SECRET", insecure.status === 1 && codes.includes("jwt_secret_missing"), codes.join(","));

  const staging = spawnSync(process.execPath, ["config-check.js"], {
    cwd: HERE,
    env: { ...process.env, APP_ENV: "staging", JWT_SECRET: "y".repeat(48), CORS_ORIGIN: "https://stage.example.com", APP_ORIGIN: "https://stage.example.com" },
    encoding: "utf8"
  });
  let stagingParsed = null;
  try {
    stagingParsed = JSON.parse(staging.stdout);
  } catch {}
  check("config: staging starts with its own origin", staging.status === 0 && stagingParsed?.env === "staging" && stagingParsed?.cors?.includes("https://stage.example.com"), stagingParsed?.cors?.join(",") || staging.stderr.trim());
}

function prepareLegacyUpgrade() {
  const live = path.join(HERE, "data", "wt.sqlite");
  if (!fs.existsSync(live)) return { skipped: true };
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = `${live}${suffix}`;
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(DATA, `wt.sqlite${suffix}`));
  }
  return { skipped: false };
}

async function checkDatabase() {
  const { MIGRATIONS } = await import("./database/schema.js");
  const latest = MIGRATIONS.at(-1).version;
  const { DatabaseSync } = await import("node:sqlite");
  const upgrade = prepareLegacyUpgrade();
  let preservedUsers = null;
  if (!upgrade.skipped) {
    const copy = new DatabaseSync(path.join(DATA, "wt.sqlite"));
    try {
      copy.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      preservedUsers = Number(copy.prepare("SELECT COUNT(*) AS n FROM users").get()?.n || 0);
      copy.prepare("DELETE FROM schema_migrations WHERE version = ?").run(latest);
      copy.exec("DROP INDEX IF EXISTS idx_users_active_created; DROP INDEX IF EXISTS idx_rooms_last_activity;");
    } finally {
      copy.close();
    }
  }

  const { getDatabase, closeDatabase, createBackup, verifyDatabase } = await import("./database/index.js");
  const db = await getDatabase();
  check("database: opens", Boolean(db));
  const version = Number(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()?.v || 0);
  check("database: migrations reach latest version", version === latest, `version=${version} latest=${latest}`);
  if (!upgrade.skipped) {
    const usersNow = Number(db.prepare("SELECT COUNT(*) AS n FROM users").get()?.n || 0);
    check("database: upgrade from previous schema preserves rows", usersNow === preservedUsers, `before=${preservedUsers} after=${usersNow}`);
  }
  const integrity = String(db.prepare("PRAGMA integrity_check").get()?.integrity_check || "");
  check("database: integrity_check ok", integrity === "ok", integrity);
  const fk = db.prepare("PRAGMA foreign_key_check").all();
  check("database: no foreign-key violations", fk.length === 0, `violations=${fk.length}`);

  const expectedTables = [
    "users", "profiles", "sessions", "roles", "permissions", "friendships", "blocks",
    "dm_conversations", "dm_messages", "servers", "categories", "channels", "rooms",
    "room_memberships", "invitations", "messages", "message_reactions", "room_polls",
    "poll_options", "poll_votes", "reports", "moderation_actions", "support_tickets",
    "playback_states", "playback_history", "media_library", "user_themes", "notifications",
    "subscription_plans", "entitlements", "payments", "transactions", "app_settings",
    "feature_flags", "audit_logs", "website_pages", "analytics_events", "automation_workflows"
  ];
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  const missingTables = expectedTables.filter((name) => !tables.has(name));
  check("database: required tables exist", missingTables.length === 0, missingTables.join(", "));

  const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((row) => row.name));
  const expectedIndexes = [
    "idx_users_active_created", "idx_rooms_last_activity", "idx_notifications_user_unread",
    "idx_dm_messages_conversation", "uq_media_library_item", "idx_audit_target",
    "idx_rooms_privacy_activity", "idx_moderation_actions_created"
  ];
  const missingIndexes = expectedIndexes.filter((name) => !indexes.has(name));
  check("database: performance/integrity indexes exist", missingIndexes.length === 0, missingIndexes.join(", "));

  const backup = await createBackup({ label: "release-check", keep: 50 });
  check("backup: create on demand", backup?.verified === true && fs.existsSync(backup.file), backup?.file || "");
  const verified = await verifyDatabase(path.basename(backup.file));
  check("backup: verify checksum and integrity", verified?.ok === true, verified?.error || "");

  const restore = spawnSync(process.execPath, ["restore.js", backup.file], { cwd: HERE, env: process.env, encoding: "utf8" });
  check("backup: restore dry-run validates without writing", restore.status === 0 && /dry run/.test(restore.stdout), restore.stderr.trim() || restore.stdout.trim().slice(-120));

  await closeDatabase();
}

async function checkApi() {
  const { buildServer } = await import("./index.js");
  const app = await buildServer();
  try {
    const routes = app.printRoutes({ commonPrefix: false });
    const routeCount = routes.split("\n").filter((line) => /\((?:GET|HEAD|POST|PUT|PATCH|DELETE)/.test(line)).length;
    check("routes: registry loaded", routeCount >= 120, `routes=${routeCount}`);
    const prefixes = ["/api/auth/", "/api/rooms", "/api/social/", "/api/billing", "/api/uploads", "/api/files/", "/api/pages/", "/api/analytics", "/api/admin/", "/api/features", "/api/settings/public", "/ws"];
    const missing = prefixes.filter((prefix) => !routes.includes(prefix));
    check("routes: every module is mounted", missing.length === 0, missing.join(", "));

    const health = await app.inject({ method: "GET", url: "/api/health" });
    const healthBody = health.json();
    check("api: health is 200 and reports storage", health.statusCode === 200 && healthBody.ok === true && Boolean(healthBody.storage), `${health.statusCode} ${healthBody.store || healthBody.storage?.mode || ""}`);

    const ready = await app.inject({ method: "GET", url: "/api/ready" });
    check("api: ready is 200 with SQLite", ready.statusCode === 200 && ready.json().ok === true, `${ready.statusCode} ${ready.json().store || ""}`);

    const features = await app.inject({ method: "GET", url: "/api/features" });
    check("api: public feature flags", features.statusCode === 200 && features.json().ok === true && features.json().flags, features.statusCode);

    const settings = await app.inject({ method: "GET", url: "/api/settings/public" });
    check("api: public settings", settings.statusCode === 200 && settings.json().ok === true, settings.statusCode);

    const nav = await app.inject({ method: "GET", url: "/api/pages/nav" });
    check("api: public page navigation", nav.statusCode === 200 && nav.json().ok === true, nav.statusCode);

    const missingRoute = await app.inject({ method: "GET", url: "/api/this-route-does-not-exist" });
    check("api: unknown route returns JSON 404", missingRoute.statusCode === 404 && missingRoute.json().error === "not_found", missingRoute.statusCode);

    const secure = await app.inject({ method: "GET", url: "/api/settings/public" });
    check("api: security headers on responses", secure.headers["x-content-type-options"] === "nosniff" && secure.headers["x-frame-options"] === "DENY", Object.keys(secure.headers).join(","));
    check("api: API responses are not cached", secure.headers["cache-control"] === "no-store", secure.headers["cache-control"] || "");

    const cors = await app.inject({ method: "GET", url: "/api/features", headers: { origin: "http://127.0.0.1:4791" } });
    check("api: CORS allows configured origin", cors.headers["access-control-allow-origin"] === "http://127.0.0.1:4791", cors.headers["access-control-allow-origin"] || "missing");

    const gzip = await app.inject({ method: "GET", url: "/api/features", headers: { "accept-encoding": "gzip" } });
    check("api: compression enabled for JSON", gzip.headers["content-encoding"] === "gzip", gzip.headers["content-encoding"] || "none");

    const register = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "releasecheck", email: "release@check.local", password: "ReleaseCheck#12345", birthdate: "1995-05-10" }
    });
    check("auth: registration returns a session", register.statusCode === 201 && Boolean(register.json().token), `${register.statusCode} ${register.json().error || ""}`);
    const token = register.json().token || "";

    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${token}` } });
    check("auth: bearer session reads profile", me.statusCode === 200 && Boolean(me.json().user), `${me.statusCode} ${me.json().error || ""}`);

    const anonymousFiles = await app.inject({ method: "GET", url: "/api/files/does-not-exist" });
    check("files: route is mounted and answers structured errors", anonymousFiles.statusCode === 404 && anonymousFiles.json().error === "file_missing", `${anonymousFiles.statusCode} ${anonymousFiles.json().error || ""}`);

    const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { authorization: `Bearer ${token}` } });
    check("auth: logout revokes the session", logout.statusCode === 200, String(logout.statusCode));
    const afterLogout = await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${token}` } });
    check("auth: revoked session is rejected", afterLogout.statusCode === 401, String(afterLogout.statusCode));
  } finally {
    await app.close();
    const { closeDatabase } = await import("./database/index.js");
    await closeDatabase();
  }
}

async function main() {
  console.log(`release-check ${new Date().toISOString()}`);
  checkStaticSite();
  await checkConfig();
  await checkDatabase();
  await checkApi();

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log(JSON.stringify({ ok: false, failed: failed.map((item) => item.name) }, null, 2));
    process.exitCode = 1;
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
}

main().catch((err) => {
  console.error("[release-check] failed:", err);
  process.exitCode = 1;
});
