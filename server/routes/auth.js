import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createUser, findUserById, findUsers, updateUser, ensureStore } from "../userStore.js";
import {
  saveSession,
  getSession,
  revokeSession,
  revokeUserSessions,
  cacheGet,
  cacheSet,
  cacheDel,
  createRateLimiter
} from "../redis.js";

const JWT_ISSUER = "watch-together";
const JWT_AUDIENCE = "watch-together-web";
const JWT_TTL_SECONDS = 7 * 24 * 60 * 60;
const BCRYPT_ROUNDS = 12;
const RECOVERY_ROUNDS = 10;
const USER_CACHE_TTL = 120;
const USERNAME_RE = /^[\p{L}\p{N}_-]{3,24}$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

let warnedSecret = false;

const loginLimit = createRateLimiter({ max: 25, windowMs: 60_000, prefix: "wt:rl:login:" });
const registerLimit = createRateLimiter({ max: 12, windowMs: 60_000, prefix: "wt:rl:register:" });
const recoverLimit = createRateLimiter({ max: 10, windowMs: 60_000, prefix: "wt:rl:recover:" });

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (secret) return secret;
  if (!warnedSecret) {
    warnedSecret = true;
    console.warn("[auth] JWT_SECRET is not set - using an insecure development secret");
  }
  return "dev-only-secret-change-me";
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: String(user.id),
    username: user.username,
    email: user.email,
    role: user.role || "user",
    avatar: user.avatar || "",
    nick: user.nick || user.username,
    createdAt: user.createdAt || null,
    profile: {
      nick: user.nick || user.username,
      birthdate: user.birthdate || "",
      city: user.city || "",
      bio: user.bio || "",
      avatar: user.avatar || ""
    }
  };
}

function fail(reply, status, error, message) {
  return reply.code(status).send({ error, message });
}

function cleanString(value, max = 200) {
  return String(value ?? "").trim().slice(0, max);
}

export function newRecoveryCode() {
  const pick = () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  const block = () => Array.from({ length: 4 }, pick).join("");
  return `${block()}-${block()}-${block()}`;
}

function normalizeCode(raw) {
  return String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function validBirthdate(raw) {
  const s = String(raw || "").trim();
  if (!s) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00`);
  if (!Number.isFinite(t)) return false;
  const year = Number(s.slice(0, 4));
  return year >= 1900 && t <= Date.now();
}

function cleanNick(raw, fallback) {
  const s = String(raw || "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 24);
  if (!s) return cleanString(fallback, 24);
  return s;
}

function cleanAvatar(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^preset:[a-z0-9-]{2,20}$/i.test(s)) return s;
  if (/^data:image\/(?:png|jpe?g|webp);base64,[a-z0-9+/=]+$/i.test(s) && s.length <= 400000) return s;
  return null;
}

async function storeReady() {
  return ensureStore();
}

export async function issueToken(user, req) {
  const jti = crypto.randomUUID();
  const userId = String(user.id);
  const token = jwt.sign(
    {
      sub: userId,
      role: user.role || "user",
      username: user.username,
      jti
    },
    getSecret(),
    {
      expiresIn: JWT_TTL_SECONDS,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE
    }
  );
  await saveSession(
    jti,
    {
      userId,
      role: user.role || "user",
      ip: req.ip || "",
      ua: cleanString(req.headers["user-agent"], 220)
    },
    JWT_TTL_SECONDS
  );
  return { token, jti, expiresIn: JWT_TTL_SECONDS };
}

export async function requireAuth(req, reply) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    return fail(reply, 401, "missing_token", "Authorization bearer token is required.");
  }
  let payload;
  try {
    payload = jwt.verify(token, getSecret(), {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE
    });
  } catch (err) {
    return fail(reply, 401, "invalid_token", "Session expired or invalid. Please log in again.");
  }
  if (!payload?.jti || !payload?.sub) {
    return fail(reply, 401, "invalid_token", "Session expired or invalid. Please log in again.");
  }
  const session = await getSession(payload.jti);
  if (!session || String(session.userId) !== String(payload.sub)) {
    return fail(reply, 401, "session_revoked", "This session was logged out. Please log in again.");
  }
  req.auth = {
    userId: String(payload.sub),
    role: session.role || payload.role || "user",
    jti: payload.jti
  };
  return undefined;
}

export default async function authRoutes(app) {
  app.post("/register", { preHandler: [registerLimit] }, async (req, reply) => {
    if (!(await storeReady())) {
      return fail(reply, 503, "database_unavailable", "Database is not connected yet. Try again shortly.");
    }
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const username = cleanString(body.username, 24);
    const email = cleanString(body.email, 160).toLowerCase();
    const password = String(body.password ?? "");
    const nick = cleanNick(body.nick, username);
    const birthdate = cleanString(body.birthdate, 10);
    const city = cleanString(body.city, 40);
    const bio = cleanString(body.bio, 200);
    const avatar = cleanAvatar(body.avatar);

    if (!USERNAME_RE.test(username)) {
      return fail(reply, 400, "invalid_username", "Username must be 3-24 letters, numbers, dashes or underscores.");
    }
    if (!EMAIL_RE.test(email)) {
      return fail(reply, 400, "invalid_email", "Enter a valid email address.");
    }
    if (password.length < 8 || password.length > 128) {
      return fail(reply, 400, "invalid_password", "Password must be between 8 and 128 characters.");
    }
    if (!validBirthdate(birthdate)) {
      return fail(reply, 400, "invalid_birthdate", "Birth date must be a real past date.");
    }
    if (avatar === null) {
      return fail(reply, 400, "invalid_avatar", "That avatar is not supported.");
    }

    const usernameLower = username.toLowerCase();
    const clash = await findUsers({ usernameLower, email });
    if (clash.length) return fail(reply, 409, "already_exists", "This username or email is already registered.");

    const recoveryCode = newRecoveryCode();
    try {
      const user = await createUser({
        username,
        usernameLower,
        email,
        passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
        recoveryHash: await bcrypt.hash(normalizeCode(recoveryCode), RECOVERY_ROUNDS),
        nick,
        birthdate,
        city,
        bio,
        avatar,
        role: "user"
      });
      const issued = await issueToken(user, req);
      return reply.code(201).send({
        token: issued.token,
        tokenType: "Bearer",
        expiresIn: issued.expiresIn,
        user: publicUser(user),
        recoveryCode
      });
    } catch (err) {
      if (err?.code === 11000) {
        return fail(reply, 409, "already_exists", "This username or email is already registered.");
      }
      throw err;
    }
  });

  app.post("/login", { preHandler: [loginLimit] }, async (req, reply) => {
    if (!(await storeReady())) {
      return fail(reply, 503, "database_unavailable", "Database is not connected yet. Try again shortly.");
    }
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const identifier = cleanString(body.identifier || body.email || body.username, 160).toLowerCase();
    const password = String(body.password ?? "");

    if (!identifier || !password) {
      return fail(reply, 400, "missing_credentials", "Email or username and password are required.");
    }

    const rows = await findUsers(
      identifier.includes("@") ? { email: identifier } : { usernameLower: identifier }
    );
    const user = rows[0] || null;
    const valid = user ? await bcrypt.compare(password, user.passwordHash) : false;
    if (!user || !valid) {
      return fail(reply, 401, "invalid_credentials", "Email/username or password is incorrect.");
    }

    await updateUser(user.id, { lastLoginAt: new Date() });

    const issued = await issueToken(user, req);
    const safe = publicUser(user);
    await cacheSet(`user:${safe.id}`, safe, USER_CACHE_TTL);

    return {
      token: issued.token,
      tokenType: "Bearer",
      expiresIn: issued.expiresIn,
      user: safe
    };
  });

  app.get("/me", { preHandler: [requireAuth] }, async (req, reply) => {
    const cached = await cacheGet(`user:${req.auth.userId}`);
    if (cached) return { user: cached };

    if (!(await storeReady())) {
      return fail(reply, 503, "database_unavailable", "Database is not connected yet. Try again shortly.");
    }

    const user = await findUserById(req.auth.userId);
    if (!user) {
      await revokeSession(req.auth.jti);
      return fail(reply, 401, "user_missing", "Account not found. Please log in again.");
    }
    const safe = publicUser(user);
    await cacheSet(`user:${safe.id}`, safe, USER_CACHE_TTL);
    return { user: safe };
  });

  app.patch("/me", { preHandler: [requireAuth] }, async (req, reply) => {
    if (!(await storeReady())) {
      return fail(reply, 503, "database_unavailable", "Database is not connected yet. Try again shortly.");
    }
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const patch = {};

    if (body.nick !== undefined) patch.nick = cleanNick(body.nick, "");
    if (body.birthdate !== undefined) {
      if (!validBirthdate(body.birthdate)) return fail(reply, 400, "invalid_birthdate", "Birth date must be a real past date.");
      patch.birthdate = cleanString(body.birthdate, 10);
    }
    if (body.city !== undefined) patch.city = cleanString(body.city, 40);
    if (body.bio !== undefined) patch.bio = cleanString(body.bio, 200);
    if (body.avatar !== undefined) {
      const avatar = cleanAvatar(body.avatar);
      if (avatar === null) return fail(reply, 400, "invalid_avatar", "That avatar is not supported.");
      patch.avatar = avatar;
    }
    if (body.username !== undefined) {
      const next = cleanString(body.username, 24);
      if (!USERNAME_RE.test(next)) return fail(reply, 400, "invalid_username", "Username must be 3-24 letters, numbers, dashes or underscores.");
      const nextLower = next.toLowerCase();
      const clash = await findUsers({ usernameLower: nextLower });
      if (clash.length && String(clash[0].id) !== String(req.auth.userId)) {
        return fail(reply, 409, "already_exists", "This username is already taken.");
      }
      patch.username = next;
      patch.usernameLower = nextLower;
    }
    if (body.email !== undefined) {
      const email = cleanString(body.email, 160).toLowerCase();
      if (!EMAIL_RE.test(email)) return fail(reply, 400, "invalid_email", "Enter a valid email address.");
      const clash = await findUsers({ email });
      if (clash.length && String(clash[0].id) !== String(req.auth.userId)) {
        return fail(reply, 409, "already_exists", "This email is already registered.");
      }
      patch.email = email;
    }

    if (!Object.keys(patch).length) return fail(reply, 400, "nothing_to_update", "No profile fields were sent.");
    const user = await updateUser(req.auth.userId, patch);
    if (!user) return fail(reply, 404, "user_missing", "Account not found.");
    const safe = publicUser(user);
    await cacheDel(`user:${safe.id}`);
    await cacheSet(`user:${safe.id}`, safe, USER_CACHE_TTL);
    return { user: safe };
  });

  app.post("/password", { preHandler: [requireAuth] }, async (req, reply) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const current = String(body.current ?? "");
    const next = String(body.next ?? body.password ?? "");
    if (next.length < 8 || next.length > 128) {
      return fail(reply, 400, "invalid_password", "Password must be between 8 and 128 characters.");
    }
    const user = await findUserById(req.auth.userId);
    if (!user) return fail(reply, 401, "user_missing", "Account not found.");
    const valid = await bcrypt.compare(current, user.passwordHash);
    if (!valid) return fail(reply, 403, "wrong_password", "Current password is incorrect.");

    await updateUser(user.id, { passwordHash: await bcrypt.hash(next, BCRYPT_ROUNDS) });
    await revokeUserSessions(user.id);
    const issued = await issueToken(user, req);
    await cacheDel(`user:${user.id}`);
    return { ok: true, token: issued.token, expiresIn: issued.expiresIn };
  });

  app.post("/recover", { preHandler: [recoverLimit] }, async (req, reply) => {
    if (!(await storeReady())) {
      return fail(reply, 503, "database_unavailable", "Database is not connected yet. Try again shortly.");
    }
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const identifier = cleanString(body.identifier || body.username || body.email, 160).toLowerCase();
    const code = normalizeCode(body.code);
    const next = String(body.password ?? "");
    if (!identifier || !code) {
      return fail(reply, 400, "missing_fields", "Username and recovery code are required.");
    }
    if (next.length < 8 || next.length > 128) {
      return fail(reply, 400, "invalid_password", "Password must be between 8 and 128 characters.");
    }
    const rows = await findUsers(
      identifier.includes("@") ? { email: identifier } : { usernameLower: identifier }
    );
    const user = rows[0] || null;
    const valid = user?.recoveryHash ? await bcrypt.compare(code, user.recoveryHash) : false;
    if (!user || !valid) {
      return fail(reply, 401, "invalid_recovery", "That username and recovery code do not match.");
    }

    const recoveryCode = newRecoveryCode();
    const updated = await updateUser(user.id, {
      passwordHash: await bcrypt.hash(next, BCRYPT_ROUNDS),
      recoveryHash: await bcrypt.hash(normalizeCode(recoveryCode), RECOVERY_ROUNDS)
    });
    await revokeUserSessions(user.id);
    await cacheDel(`user:${user.id}`);
    const issued = await issueToken(updated, req);
    return {
      ok: true,
      token: issued.token,
      tokenType: "Bearer",
      expiresIn: issued.expiresIn,
      user: publicUser(updated),
      recoveryCode
    };
  });

  app.post("/recovery-code", { preHandler: [requireAuth] }, async (req, reply) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const password = String(body.password ?? "");
    const user = await findUserById(req.auth.userId);
    if (!user) return fail(reply, 401, "user_missing", "Account not found.");
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return fail(reply, 403, "wrong_password", "Current password is incorrect.");
    const recoveryCode = newRecoveryCode();
    await updateUser(user.id, { recoveryHash: await bcrypt.hash(normalizeCode(recoveryCode), RECOVERY_ROUNDS) });
    return { ok: true, recoveryCode };
  });

  app.post("/logout", { preHandler: [requireAuth] }, async (req) => {
    await revokeSession(req.auth.jti);
    await cacheDel(`user:${req.auth.userId}`);
    return { ok: true };
  });
}
