import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { User } from "../models/User.js";
import { dbReady } from "../db.js";
import {
  saveSession,
  getSession,
  revokeSession,
  cacheGet,
  cacheSet,
  cacheDel
} from "../redis.js";

const JWT_ISSUER = "watch-together";
const JWT_AUDIENCE = "watch-together-web";
const JWT_TTL_SECONDS = 7 * 24 * 60 * 60;
const BCRYPT_ROUNDS = 12;
const USER_CACHE_TTL = 300;
const USERNAME_RE = /^[\p{L}\p{N}_-]{3,24}$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

let warnedSecret = false;

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
    id: String(user._id || user.id),
    username: user.username,
    email: user.email,
    role: user.role || "user",
    avatar: user.avatar || "",
    createdAt: user.createdAt || null
  };
}

function fail(reply, status, error, message) {
  return reply.code(status).send({ error, message });
}

function cleanString(value, max = 200) {
  return String(value ?? "").trim().slice(0, max);
}

export async function issueToken(user, req) {
  const jti = crypto.randomUUID();
  const userId = String(user._id || user.id);
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
  app.post("/register", async (req, reply) => {
    if (!dbReady()) {
      return fail(reply, 503, "database_unavailable", "Database is not connected yet. Try again shortly.");
    }
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const username = cleanString(body.username, 24);
    const email = cleanString(body.email, 160).toLowerCase();
    const password = String(body.password ?? "");
    const avatar = cleanString(body.avatar, 120);

    if (!USERNAME_RE.test(username)) {
      return fail(reply, 400, "invalid_username", "Username must be 3-24 letters, numbers, dashes or underscores.");
    }
    if (!EMAIL_RE.test(email)) {
      return fail(reply, 400, "invalid_email", "Enter a valid email address.");
    }
    if (password.length < 8 || password.length > 128) {
      return fail(reply, 400, "invalid_password", "Password must be between 8 and 128 characters.");
    }

    const usernameLower = username.toLowerCase();
    const existing = await User.findOne({
      $or: [{ email }, { usernameLower }]
    })
      .select("email usernameLower")
      .lean();

    if (existing) {
      const field = existing.email === email ? "email" : "username";
      return fail(reply, 409, "already_exists", `This ${field} is already registered.`);
    }

    try {
      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const user = await User.create({
        username,
        usernameLower,
        email,
        passwordHash,
        avatar,
        role: "user"
      });
      const issued = await issueToken(user, req);
      return reply.code(201).send({
        token: issued.token,
        tokenType: "Bearer",
        expiresIn: issued.expiresIn,
        user: publicUser(user)
      });
    } catch (err) {
      if (err?.code === 11000) {
        return fail(reply, 409, "already_exists", "This username or email is already registered.");
      }
      throw err;
    }
  });

  app.post("/login", async (req, reply) => {
    if (!dbReady()) {
      return fail(reply, 503, "database_unavailable", "Database is not connected yet. Try again shortly.");
    }
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const identifier = cleanString(body.identifier || body.email || body.username, 160).toLowerCase();
    const password = String(body.password ?? "");

    if (!identifier || !password) {
      return fail(reply, 400, "missing_credentials", "Email or username and password are required.");
    }

    const query = identifier.includes("@")
      ? { email: identifier }
      : { usernameLower: identifier };

    const user = await User.findOne(query).select("+passwordHash").lean();
    const valid = user ? await bcrypt.compare(password, user.passwordHash) : false;
    if (!user || !valid) {
      return fail(reply, 401, "invalid_credentials", "Email/username or password is incorrect.");
    }

    User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } }).catch(() => {});

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

  app.get("/me", { preHandler: requireAuth }, async (req, reply) => {
    const cached = await cacheGet(`user:${req.auth.userId}`);
    if (cached) return { user: cached };

    if (!dbReady()) {
      return fail(reply, 503, "database_unavailable", "Database is not connected yet. Try again shortly.");
    }

    const user = await User.findById(req.auth.userId).lean();
    if (!user) {
      await revokeSession(req.auth.jti);
      return fail(reply, 401, "user_missing", "Account not found. Please log in again.");
    }
    const safe = publicUser(user);
    await cacheSet(`user:${safe.id}`, safe, USER_CACHE_TTL);
    return { user: safe };
  });

  app.post("/logout", { preHandler: requireAuth }, async (req) => {
    await revokeSession(req.auth.jti);
    await cacheDel(`user:${req.auth.userId}`);
    return { ok: true };
  });
}
