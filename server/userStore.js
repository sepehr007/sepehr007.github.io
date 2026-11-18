import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { User } from "./models/User.js";
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
    `);
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
    `INSERT INTO users (id, username, username_lower, email, password_hash, recovery_hash, nick, birthdate, city, bio, avatar, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    data.username,
    data.usernameLower,
    data.email,
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
      update[key] = key === "lastLoginAt" ? new Date(value) : value;
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
