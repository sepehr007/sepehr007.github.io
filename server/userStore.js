import crypto from "node:crypto";
import { User } from "./models/User.js";
import { EmailToken } from "./models/EmailToken.js";
import { Setting } from "./models/Setting.js";
import { dbReady } from "./db.js";
import { getDatabase, databaseState, transaction } from "./database/index.js";

function toUser(row) {
  if (!row) return null;
  return {
    id: String(row._id || row.id),
    username: row.username,
    usernameLower: row.usernameLower || String(row.username || "").toLowerCase(),
    email: row.email || "",
    emailVerified: Boolean(row.emailVerified),
    emailVerifiedAt: row.emailVerifiedAt ? new Date(row.emailVerifiedAt) : null,
    phone: row.phone || "",
    phoneVerified: Boolean(row.phoneVerified),
    phoneVerifiedAt: row.phoneVerifiedAt ? new Date(row.phoneVerifiedAt) : null,
    verifiedChannel: row.verifiedChannel || "",
    recoveryChannel: row.recoveryChannel || "",
    passwordHash: row.passwordHash || "",
    recoveryHash: row.recoveryHash || "",
    nick: row.nick || row.username || "",
    birthdate: row.birthdate || "",
    city: row.city || "",
    bio: row.bio || "",
    avatar: row.avatar || "",
    role: row.role || "user",
    status: row.status || "active",
    deletedAt: row.deletedAt ? new Date(row.deletedAt) : null,
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
    phone: row.phone,
    phoneVerified: row.phone_verified,
    phoneVerifiedAt: row.phone_verified_at,
    verifiedChannel: row.verified_channel,
    recoveryChannel: row.recovery_channel,
    passwordHash: row.password_hash,
    recoveryHash: row.recovery_hash,
    nick: row.nick,
    birthdate: row.birthdate,
    city: row.city,
    bio: row.bio,
    avatar: row.avatar,
    role: row.role,
    status: row.status || "active",
    deletedAt: row.deleted_at ? new Date(row.deleted_at) : null,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at
  });
}

export function storeMode() {
  if (dbReady()) return "mongodb";
  const state = databaseState();
  if (state.ready) return "sqlite";
  if (state.mode === "unavailable") return "unavailable";
  return "pending";
}

export function storeState() {
  const state = databaseState();
  return {
    mode: storeMode(),
    file: state.file,
    error: state.error,
    schemaVersion: state.version
  };
}

export async function ensureStore() {
  if (dbReady()) return true;
  return Boolean(await getDatabase());
}

export async function findUsers(query) {
  const { usernameLower, email } = query || {};
  if (dbReady()) {
    const filter = {};
    if (usernameLower) filter.usernameLower = usernameLower;
    if (email) filter.email = email;
    return (await User.find(filter).select("+passwordHash +recoveryHash").lean()).map(toUser);
  }
  const db = await getDatabase();
  if (!db) return [];
  const rows = [];
  if (usernameLower) {
    rows.push(...db.prepare("SELECT * FROM users WHERE username_lower = ?").all(usernameLower));
  }
  if (email) {
    rows.push(...db.prepare("SELECT * FROM users WHERE email = ?").all(email));
  }
  if (query?.phone) {
    rows.push(...db.prepare("SELECT * FROM users WHERE phone = ?").all(query.phone));
  }
  const seen = new Set();
  return rows.filter((r) => (seen.has(r.id) ? false : seen.add(r.id))).map(fromSql);
}

export async function findUsersByPhone(phone) {
  if (!phone) return [];
  if (dbReady()) {
    return (await User.find({ phone }).select("+passwordHash +recoveryHash").lean()).map(toUser);
  }
  const db = await getDatabase();
  if (!db) return [];
  return db.prepare("SELECT * FROM users WHERE phone = ?").all(phone).map(fromSql);
}

export async function findOwnerAccount() {
  if (dbReady()) {
    const doc = await User.findOne({ role: { $in: ["owner", "super_owner"] } })
      .sort({ createdAt: 1 })
      .select("+passwordHash +recoveryHash")
      .lean();
    return doc ? toUser(doc) : null;
  }
  const db = await getDatabase();
  if (!db) return null;
  const row = db
    .prepare("SELECT * FROM users WHERE role IN ('owner', 'super_owner') AND deleted_at IS NULL ORDER BY created_at LIMIT 1")
    .get();
  return row ? fromSql(row) : null;
}

export async function getAppSetting(key) {
  const name = String(key || "");
  if (!name) return null;
  if (dbReady()) {
    const doc = await Setting.findOne({ key: name }).lean();
    return doc?.value ?? null;
  }
  const db = await getDatabase();
  if (!db) return null;
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(name);
  return row ? row.value : null;
}

export async function setAppSetting(key, value) {
  const name = String(key || "");
  if (!name) return false;
  if (dbReady()) {
    await Setting.updateOne({ key: name }, { $set: { value: String(value ?? "") } }, { upsert: true });
    return true;
  }
  const db = await getDatabase();
  if (!db) return false;
  db.prepare(
    "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(name, String(value ?? ""));
  return true;
}

export async function findUserById(id) {
  if (!id) return null;
  if (dbReady()) {
    if (!String(id).match(/^[a-f0-9]{24}$/i)) return null;
    return toUser(await User.findById(id).select("+passwordHash +recoveryHash").lean());
  }
  const db = await getDatabase();
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
      phone: data.phone || "",
      phoneVerified: Boolean(data.phoneVerified),
      phoneVerifiedAt: data.phoneVerifiedAt ? new Date(data.phoneVerifiedAt) : null,
      verifiedChannel: data.verifiedChannel || "",
      recoveryChannel: data.recoveryChannel || "",
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
  const db = await getDatabase();
  if (!db) throw new Error("store_unavailable");
  const id = crypto.randomUUID();
  const role = data.role || "user";
  transaction((conn) => {
    conn
      .prepare(
        `INSERT INTO users
         (id, username, username_lower, email, email_verified, email_verified_at, phone, phone_verified,
          phone_verified_at, verified_channel, recovery_channel, password_hash,
          recovery_hash, nick, birthdate, city, bio, avatar, role, status, locale, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'fa', ?, ?)`
      )
      .run(
        id,
        data.username,
        data.usernameLower,
        data.email,
        data.emailVerified ? 1 : 0,
        data.emailVerifiedAt ? new Date(data.emailVerifiedAt).getTime() : null,
        data.phone || "",
        data.phoneVerified ? 1 : 0,
        data.phoneVerifiedAt ? new Date(data.phoneVerifiedAt).getTime() : null,
        data.verifiedChannel || "",
        data.recoveryChannel || "",
        data.passwordHash,
        data.recoveryHash || "",
        data.nick || data.username,
        data.birthdate || "",
        data.city || "",
        data.bio || "",
        data.avatar || "",
        role,
        now,
        now
      );
    conn.prepare("INSERT OR IGNORE INTO profiles (user_id, updated_at) VALUES (?, ?)").run(id, now);
    const roleExists = conn.prepare("SELECT 1 AS ok FROM roles WHERE id = ?").get(role);
    if (roleExists) {
      conn.prepare("INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_at) VALUES (?, ?, ?)").run(id, role, now);
    }
  });
  return findUserById(id);
}

const PATCH_COLUMNS = {
  username: "username",
  usernameLower: "username_lower",
  email: "email",
  emailVerified: "email_verified",
  emailVerifiedAt: "email_verified_at",
  phone: "phone",
  phoneVerified: "phone_verified",
  phoneVerifiedAt: "phone_verified_at",
  verifiedChannel: "verified_channel",
  recoveryChannel: "recovery_channel",
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

const DATE_FIELDS = new Set(["lastLoginAt", "emailVerifiedAt", "phoneVerifiedAt"]);

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
  const db = await getDatabase();
  if (!db) throw new Error("store_unavailable");
  const now = Date.now();
  const sets = Object.keys(clean).map((key) => `${PATCH_COLUMNS[key]} = ?`).join(", ");
  transaction((conn) => {
    conn.prepare(`UPDATE users SET ${sets}, updated_at = ? WHERE id = ?`).run(...Object.values(clean), now, String(id));
    if (clean.role && conn.prepare("SELECT 1 AS ok FROM roles WHERE id = ?").get(clean.role)) {
      conn.prepare("DELETE FROM user_roles WHERE user_id = ?").run(String(id));
      conn.prepare("INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_at) VALUES (?, ?, ?)").run(
        String(id),
        clean.role,
        now
      );
    }
    conn.prepare("UPDATE profiles SET updated_at = ? WHERE user_id = ?").run(now, String(id));
  });
  return findUserById(id);
}

export async function softDeleteUser(userId) {
  if (!userId || dbReady()) return false;
  const db = await getDatabase();
  if (!db) throw new Error("store_unavailable");
  const id = String(userId);
  const row = db.prepare("SELECT id FROM users WHERE id = ? AND deleted_at IS NULL").get(id);
  if (!row) return false;
  const stamp = id.replace(/-/g, "").slice(0, 12);
  const now = Date.now();
  transaction((conn) => {
    conn
      .prepare(
        `UPDATE users SET
           username = ?, username_lower = ?, email = ?, phone = '', bio = '', avatar = '', nick = '',
           recovery_hash = '', password_hash = 'deleted-account', email_verified = 0, email_verified_at = NULL,
           status = 'deleted', deleted_at = ?, last_seen_at = NULL, updated_at = ?
         WHERE id = ?`
      )
      .run(`deleted_${stamp}`, `deleted_${stamp}`, `deleted_${stamp}@invalid.local`, now, now, id);
    conn.prepare("DELETE FROM email_tokens WHERE user_id = ?").run(id);
    conn.prepare("DELETE FROM profiles WHERE user_id = ?").run(id);
    conn.prepare("UPDATE dm_conversations SET updated_at = ? WHERE user_a = ? OR user_b = ?").run(now, id, id);
  });
  return true;
}

export async function countUsers() {
  if (dbReady()) return User.estimatedDocumentCount();
  const db = await getDatabase();
  if (!db) return 0;
  return Number(db.prepare("SELECT COUNT(*) AS n FROM users").get()?.n || 0);
}

function fromTokenSql(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    kind: row.kind,
    channel: row.channel || "email",
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
    channel: doc.channel || "email",
    codeHash: doc.codeHash || "",
    linkHash: doc.linkHash || "",
    expiresAt: doc.expiresAt ? new Date(doc.expiresAt).getTime() : 0,
    attempts: Number(doc.attempts || 0),
    consumedAt: doc.consumedAt ? new Date(doc.consumedAt).getTime() : null,
    createdAt: doc.createdAt ? new Date(doc.createdAt).getTime() : 0
  };
}

export async function createEmailToken({ userId, kind, channel = "email", codeHash, linkHash, expiresAt }) {
  const id = crypto.randomUUID();
  const now = Date.now();
  if (dbReady()) {
    const doc = await EmailToken.create({
      userId,
      kind,
      channel,
      codeHash: codeHash || "",
      linkHash: linkHash || "",
      expiresAt: new Date(expiresAt),
      createdAt: new Date(now)
    });
    return fromTokenDoc(doc.toObject());
  }
  const db = await getDatabase();
  if (!db) throw new Error("store_unavailable");
  db.prepare(
    `INSERT INTO email_tokens (id, user_id, kind, channel, code_hash, link_hash, expires_at, attempts, consumed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`
  ).run(id, String(userId), kind, channel === "sms" ? "sms" : "email", codeHash || "", linkHash || "", Number(expiresAt), now);
  return {
    id,
    userId: String(userId),
    kind,
    channel: channel === "sms" ? "sms" : "email",
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
  const db = await getDatabase();
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
  const db = await getDatabase();
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
  const db = await getDatabase();
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
  const db = await getDatabase();
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
  const db = await getDatabase();
  if (!db) return;
  db.prepare("UPDATE email_tokens SET consumed_at = ? WHERE id = ?").run(now, String(id));
}

export async function purgeEmailTokens() {
  const now = Date.now();
  if (dbReady()) {
    await EmailToken.deleteMany({ expiresAt: { $lt: new Date(now) } });
    return;
  }
  const db = await getDatabase();
  if (!db) return;
  db.prepare("DELETE FROM email_tokens WHERE expires_at < ?").run(now);
}
