import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { User } from "./models/User.js";
import { EmailToken } from "./models/EmailToken.js";
import { dbReady } from "./db.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(HERE, "data");
const SQLITE_FILE = process.env.SQLITE_FILE || path.join(DATA_DIR, "wt.sqlite");

let sqlite = null;
let sqliteTried = false;
let sqliteError = "";

function toUser(row) {
  if (!row) return null;
  return {
    id: String(row._id || row.id),
    username: row.username,
    usernameLower: row.usernameLower || String(row.username || "").toLowerCase(),
    email: row.email || "",
    emailVerified: Boolean(row.emailVerified),
    emailVerifiedAt: row.emailVerifiedAt ? new Date(row.emailVerifiedAt) : null,
    passwordHash: row.passwordHash || "",
    recoveryHash: row.recoveryHash || "",
    nick: row.nick || row.username || "",
    birthdate: row.birthdate || "",
    city: row.city || "",
    bio: row.bio || "",
    avatar: row.avatar || "",
    role: row.role || "user",
    createdAt: row.createdAt ? new Date(row.createdAt) : new Date(),
    lastLoginAt: row.lastLoginAt ? new Date(row.lastLoginAt) : null
  };
}

function fromSql(row) {
  if (!row) return null;
  return toUser({
    id: row.id,
    username: row.username,
    usernameLower: row.username_lower,
    email: row.email,
    emailVerified: row.email_verified,
    emailVerifiedAt: row.email_verified_at,
    passwordHash: row.password_hash,
    recoveryHash: row.recovery_hash,
    nick: row.nick,
    birthdate: row.birthdate,
    city: row.city,
    bio: row.bio,
    avatar: row.avatar,
    role: row.role,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at
  });
}

async function getSqlite() {
  if (sqlite) return sqlite;
  if (sqliteTried) return null;
  sqliteTried = true;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    fs.mkdirSync(path.dirname(SQLITE_FILE), { recursive: true });
    const db = new DatabaseSync(SQLITE_FILE);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        username_lower TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        email_verified INTEGER DEFAULT 0,
        email_verified_at INTEGER,
        password_hash TEXT NOT NULL,
        recovery_hash TEXT DEFAULT '',
        nick TEXT DEFAULT '',
        birthdate TEXT DEFAULT '',
        city TEXT DEFAULT '',
        bio TEXT DEFAULT '',
        avatar TEXT DEFAULT '',
        role TEXT DEFAULT 'user',
        created_at INTEGER NOT NULL,
        last_login_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS email_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        code_hash TEXT DEFAULT '',
        link_hash TEXT DEFAULT '',
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        consumed_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens(user_id, kind, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_email_tokens_link ON email_tokens(link_hash) WHERE link_hash <> '';
    `);
    // Older databases created before email verification existed.
    const columns = new Set(db.prepare("PRAGMA table_info(users)").all().map((c) => c.name));
    if (!columns.has("email_verified")) db.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0");
    if (!columns.has("email_verified_at")) db.exec("ALTER TABLE users ADD COLUMN email_verified_at INTEGER");
    sqlite = db;
    return sqlite;
  } catch (err) {
    sqliteError = err.message;
    console.error("[store] sqlite unavailable:", err.message);
    return null;
  }
}

export function storeMode() {
  if (dbReady()) return "mongodb";
  if (sqlite) return "sqlite";
  if (sqliteTried) return "unavailable";
  return "pending";
}

export function storeState() {
  return {
    mode: storeMode(),
    file: sqlite ? SQLITE_FILE : "",
    error: sqliteError
  };
}

export async function ensureStore() {
  if (dbReady()) return true;
  return Boolean(await getSqlite());
}

export async function findUsers(query) {
  const { usernameLower, email } = query || {};
  if (dbReady()) {
    const filter = {};
    if (usernameLower) filter.usernameLower = usernameLower;
    if (email) filter.email = email;
    return (await User.find(filter).select("+passwordHash +recoveryHash").lean()).map(toUser);
  }
  const db = await getSqlite();
  if (!db) return [];
  const rows = [];
  if (usernameLower) {
    rows.push(...db.prepare("SELECT * FROM users WHERE username_lower = ?").all(usernameLower));
  }
  if (email) {
    rows.push(...db.prepare("SELECT * FROM users WHERE email = ?").all(email));
  }
  const seen = new Set();
  return rows.filter((r) => (seen.has(r.id) ? false : seen.add(r.id))).map(fromSql);
}

export async function findUserById(id) {
  if (!id) return null;
  if (dbReady()) {
    if (!String(id).match(/^[a-f0-9]{24}$/i)) return null;
    return toUser(await User.findById(id).select("+passwordHash +recoveryHash").lean());
  }
  const db = await getSqlite();
  if (!db) return null;
  return fromSql(db.prepare("SELECT * FROM users WHERE id = ?").get(String(id)));
}

export async function createUser(data) {
  const now = Date.now();
  if (dbReady()) {
    const doc = await User.create({
      username: data.username,
      usernameLower: data.usernameLower,
      email: data.email,
      emailVerified: Boolean(data.emailVerified),
      emailVerifiedAt: data.emailVerifiedAt ? new Date(data.emailVerifiedAt) : null,
      passwordHash: data.passwordHash,
      recoveryHash: data.recoveryHash || "",
      nick: data.nick || data.username,
      birthdate: data.birthdate || "",
      city: data.city || "",
      bio: data.bio || "",
      avatar: data.avatar || "",
      role: data.role || "user",
      createdAt: new Date(now)
    });
    return toUser({ ...doc.toObject(), _id: doc._id });
  }
  const db = await getSqlite();
  if (!db) throw new Error("store_unavailable");
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO users (id, username, username_lower, email, email_verified, email_verified_at, password_hash, recovery_hash, nick, birthdate, city, bio, avatar, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    data.username,
    data.usernameLower,
    data.email,
    data.emailVerified ? 1 : 0,
    data.emailVerifiedAt ? new Date(data.emailVerifiedAt).getTime() : null,
    data.passwordHash,
    data.recoveryHash || "",
    data.nick || data.username,
    data.birthdate || "",
    data.city || "",
    data.bio || "",
    data.avatar || "",
    data.role || "user",
    now
  );
  return findUserById(id);
}

const PATCH_COLUMNS = {
  username: "username",
  usernameLower: "username_lower",
  email: "email",
  emailVerified: "email_verified",
  emailVerifiedAt: "email_verified_at",
  passwordHash: "password_hash",
  recoveryHash: "recovery_hash",
  nick: "nick",
  birthdate: "birthdate",
  city: "city",
  bio: "bio",
  avatar: "avatar",
  role: "role",
  lastLoginAt: "last_login_at"
};

const DATE_FIELDS = new Set(["lastLoginAt", "emailVerifiedAt"]);

export async function updateUser(id, patch) {
  if (!id) return null;
  const clean = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (!PATCH_COLUMNS[key]) continue;
    clean[key] = value instanceof Date ? value.getTime() : value;
  }
  if (!Object.keys(clean).length) return findUserById(id);
  if (dbReady()) {
    const update = {};
    for (const [key, value] of Object.entries(clean)) {
      update[key] = DATE_FIELDS.has(key) ? new Date(value) : value;
    }
    await User.updateOne({ _id: id }, { $set: update });
    return findUserById(id);
  }
  const db = await getSqlite();
  if (!db) throw new Error("store_unavailable");
  const sets = Object.keys(clean).map((key) => `${PATCH_COLUMNS[key]} = ?`).join(", ");
  db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...Object.values(clean), String(id));
  return findUserById(id);
}

function fromTokenSql(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    kind: row.kind,
    codeHash: row.code_hash || "",
    linkHash: row.link_hash || "",
    expiresAt: Number(row.expires_at),
    attempts: Number(row.attempts || 0),
    consumedAt: row.consumed_at ? Number(row.consumed_at) : null,
    createdAt: Number(row.created_at)
  };
}

function fromTokenDoc(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    userId: String(doc.userId),
    kind: doc.kind,
    codeHash: doc.codeHash || "",
    linkHash: doc.linkHash || "",
    expiresAt: doc.expiresAt ? new Date(doc.expiresAt).getTime() : 0,
    attempts: Number(doc.attempts || 0),
    consumedAt: doc.consumedAt ? new Date(doc.consumedAt).getTime() : null,
    createdAt: doc.createdAt ? new Date(doc.createdAt).getTime() : 0
  };
}

export async function createEmailToken({ userId, kind, codeHash, linkHash, expiresAt }) {
  const id = crypto.randomUUID();
  const now = Date.now();
  if (dbReady()) {
    const doc = await EmailToken.create({
      userId,
      kind,
      codeHash: codeHash || "",
      linkHash: linkHash || "",
      expiresAt: new Date(expiresAt),
      createdAt: new Date(now)
    });
    return fromTokenDoc(doc.toObject());
  }
  const db = await getSqlite();
  if (!db) throw new Error("store_unavailable");
  db.prepare(
    `INSERT INTO email_tokens (id, user_id, kind, code_hash, link_hash, expires_at, attempts, consumed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?)`
  ).run(id, String(userId), kind, codeHash || "", linkHash || "", Number(expiresAt), now);
  return {
    id,
    userId: String(userId),
    kind,
    codeHash: codeHash || "",
    linkHash: linkHash || "",
    expiresAt: Number(expiresAt),
    attempts: 0,
    consumedAt: null,
    createdAt: now
  };
}

export async function deleteEmailTokens(userId, kind) {
  if (dbReady()) {
    await EmailToken.deleteMany({ userId, kind });
    return;
  }
  const db = await getSqlite();
  if (!db) return;
  db.prepare("DELETE FROM email_tokens WHERE user_id = ? AND kind = ?").run(String(userId), kind);
}

export async function findActiveEmailToken(userId, kind) {
  const now = Date.now();
  if (dbReady()) {
    const doc = await EmailToken.findOne({
      userId,
      kind,
      consumedAt: null,
      expiresAt: { $gt: new Date(now) }
    })
      .sort({ createdAt: -1 })
      .select("+codeHash")
      .lean();
    return fromTokenDoc(doc);
  }
  const db = await getSqlite();
  if (!db) return null;
  return fromTokenSql(
    db
      .prepare(
        `SELECT * FROM email_tokens
         WHERE user_id = ? AND kind = ? AND consumed_at IS NULL AND expires_at > ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(String(userId), kind, now)
  );
}

export async function findEmailTokenByLink(linkHash, kind) {
  const now = Date.now();
  if (dbReady()) {
    const doc = await EmailToken.findOne({
      linkHash,
      kind,
      consumedAt: null,
      expiresAt: { $gt: new Date(now) }
    })
      .select("+codeHash")
      .lean();
    return fromTokenDoc(doc);
  }
  const db = await getSqlite();
  if (!db) return null;
  return fromTokenSql(
    db
      .prepare(
        `SELECT * FROM email_tokens
         WHERE link_hash = ? AND kind = ? AND consumed_at IS NULL AND expires_at > ?
         LIMIT 1`
      )
      .get(linkHash, kind, now)
  );
}

export async function bumpEmailTokenAttempts(id) {
  if (dbReady()) {
    const doc = await EmailToken.findByIdAndUpdate(id, { $inc: { attempts: 1 } }, { new: true }).lean();
    return doc ? Number(doc.attempts || 0) : 0;
  }
  const db = await getSqlite();
  if (!db) return 0;
  db.prepare("UPDATE email_tokens SET attempts = attempts + 1 WHERE id = ?").run(String(id));
  const row = db.prepare("SELECT attempts FROM email_tokens WHERE id = ?").get(String(id));
  return row ? Number(row.attempts || 0) : 0;
}

export async function consumeEmailToken(id) {
  const now = Date.now();
  if (dbReady()) {
    await EmailToken.updateOne({ _id: id }, { $set: { consumedAt: new Date(now) } });
    return;
  }
  const db = await getSqlite();
  if (!db) return;
  db.prepare("UPDATE email_tokens SET consumed_at = ? WHERE id = ?").run(now, String(id));
}

export async function purgeEmailTokens() {
  const now = Date.now();
  if (dbReady()) {
    await EmailToken.deleteMany({ expiresAt: { $lt: new Date(now) } });
    return;
  }
  const db = await getSqlite();
  if (!db) return;
  db.prepare("DELETE FROM email_tokens WHERE expires_at < ?").run(now);
}
