import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import {
  createUser,
  findUserById,
  findUsers,
  findUsersByPhone,
  updateUser,
  ensureStore,
  createEmailToken,
  deleteEmailTokens,
  findActiveEmailToken,
  findEmailTokenByLink,
  bumpEmailTokenAttempts,
  consumeEmailToken,
  purgeEmailTokens
} from "../userStore.js";
import { sendVerificationMail, sendResetMail, sendTestMail, mailMode, mailState, applyMailSettings } from "../mailer.js";
import { sendResetSms, sendTestSms, smsMode, smsState } from "../sms.js";
import { loadConnections, saveConnections, safeConnections } from "../settings.js";
import { saveDbSession, getDbSession, touchDbSession, revokeDbSession, revokeDbUserSessions } from "../sessionStore.js";
import { audit } from "../audit.js";
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
const PHONE_RE = /^09\d{9}$/;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const VERIFY_TTL_MINUTES = 30;
const RESET_TTL_MINUTES = 15;
const MAX_CODE_ATTEMPTS = 5;
const CODE_HASH_ROUNDS = 8;

let warnedSecret = false;

const loginLimit = createRateLimiter({ max: 25, windowMs: 60_000, prefix: "wt:rl:login:" });
const registerLimit = createRateLimiter({ max: 12, windowMs: 60_000, prefix: "wt:rl:register:" });
const recoverLimit = createRateLimiter({ max: 10, windowMs: 60_000, prefix: "wt:rl:recover:" });
const verifySendLimit = createRateLimiter({ max: 6, windowMs: 60_000, prefix: "wt:rl:verifysend:" });
const verifyConfirmLimit = createRateLimiter({ max: 20, windowMs: 60_000, prefix: "wt:rl:verifyconfirm:" });
const forgotLimit = createRateLimiter({ max: 6, windowMs: 60_000, prefix: "wt:rl:forgot:" });
const resetLimit = createRateLimiter({ max: 12, windowMs: 60_000, prefix: "wt:rl:reset:" });
const connectionsLimit = createRateLimiter({ max: 20, windowMs: 60_000, prefix: "wt:rl:connections:" });
const connectionsTestLimit = createRateLimiter({ max: 6, windowMs: 60_000, prefix: "wt:rl:constest:" });

const mailCooldowns = new Map();

function takeCooldown(key, ms = 60_000) {
  const now = Date.now();
  const last = mailCooldowns.get(key) || 0;
  if (now - last < ms) return false;
  mailCooldowns.set(key, now);
  return true;
}

function devSecretsAllowed() {
  return process.env.NODE_ENV !== "production";
}

function verificationRequired() {
  const flag = String(process.env.REQUIRE_EMAIL_VERIFICATION || "").trim().toLowerCase();
  if (flag === "false" || flag === "off" || flag === "0") return false;
  return true;
}

function maskEmail(email) {
  const [name, domain] = String(email || "").split("@");
  if (!domain) return "";
  const head = name.slice(0, 1);
  return `${head}${"*".repeat(Math.max(1, Math.min(4, name.length - 1)))}@${domain}`;
}

function normalizePhone(raw) {
  let digits = String(raw ?? "")
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/\D/g, "");
  if (digits.startsWith("0098")) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith("98") && digits.length === 12) digits = `0${digits.slice(2)}`;
  else if (digits.length === 10 && digits.startsWith("9")) digits = `0${digits}`;
  return PHONE_RE.test(digits) ? digits : "";
}

function maskPhone(phone) {
  const p = String(phone || "");
  if (!/^09\d{9}$/.test(p)) return "";
  return `${p.slice(0, 4)}***${p.slice(-4)}`;
}

function newNumericCode() {
  return String(crypto.randomInt(0, 100000000)).padStart(8, "0");
}

function newLinkToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashLinkToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function appOrigin(req) {
  const configured = String(process.env.APP_ORIGIN || process.env.PUBLIC_URL || "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  const origin = cleanString(req.headers.origin, 200);
  if (/^https?:\/\//i.test(origin)) return origin.replace(/\/+$/, "");
  return "http://localhost:4789";
}

async function issueEmailToken(user, kind, req, channel = "email") {
  const minutes = kind === "reset" ? RESET_TTL_MINUTES : VERIFY_TTL_MINUTES;
  const useSms = channel === "sms" && kind === "reset";
  const code = newNumericCode();
  const linkToken = useSms ? "" : newLinkToken();
  await deleteEmailTokens(user.id, kind);
  const record = await createEmailToken({
    userId: user.id,
    kind,
    codeHash: await bcrypt.hash(code, CODE_HASH_ROUNDS),
    linkHash: linkToken ? hashLinkToken(linkToken) : "",
    expiresAt: Date.now() + minutes * 60_000
  });
  purgeEmailTokens().catch(() => {});
  const base = appOrigin(req);
  const link =
    useSms
      ? ""
      : kind === "reset"
        ? `${base}/auth.html?reset=${encodeURIComponent(linkToken)}`
        : `${base}/auth.html?verify=${encodeURIComponent(linkToken)}`;
  const delivery = useSms
    ? await sendResetSms({ to: user.phone, code, minutes })
    : kind === "reset"
      ? await sendResetMail({ to: user.email, username: user.nick || user.username, code, link, minutes })
      : await sendVerificationMail({ to: user.email, username: user.nick || user.username, code, link, minutes });
  return { record, delivery, code, link, minutes, channel: useSms ? "sms" : "email" };
}

function publicDelivery(user, issued) {
  const delivery = issued.delivery || { ok: false, mode: "", error: "unknown" };
  const channel = issued.channel || "email";
  const payload = {
    sent: Boolean(delivery.ok),
    mode: delivery.mode || "",
    channel,
    email: channel === "email" ? maskEmail(user.email) : "",
    phone: channel === "sms" ? maskPhone(user.phone) : "",
    minutes: issued.minutes
  };
  if (!delivery.ok) payload.error = delivery.error || "send_failed";
  if (delivery.ok && delivery.mode === "outbox" && devSecretsAllowed()) {
    payload.previewCode = issued.code;
    if (issued.link) payload.previewLink = issued.link;
  }
  return payload;
}

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
    phone: user.phone || "",
    role: user.role || "user",
    avatar: user.avatar || "",
    nick: user.nick || user.username,
    emailVerified: Boolean(user.emailVerified),
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

async function revokeAllSessions(userId) {
  await revokeUserSessions(userId);
  await revokeDbUserSessions(userId);
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
  await saveDbSession({
    jti,
    userId,
    role: user.role || "user",
    ip: req.ip || "",
    userAgent: cleanString(req.headers["user-agent"], 220),
    expiresAt: Date.now() + JWT_TTL_SECONDS * 1000
  });
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
  let session = await getSession(payload.jti);
  if (!session || String(session.userId) !== String(payload.sub)) {
    const durable = await getDbSession(payload.jti);
    if (durable && String(durable.userId) === String(payload.sub)) {
      session = durable;
      const ttl = Math.max(60, Math.floor((durable.expiresAt - Date.now()) / 1000));
      await saveSession(payload.jti, durable, ttl).catch(() => {});
      await touchDbSession(payload.jti).catch(() => {});
    }
  }
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
    const phoneRaw = cleanString(body.phone, 20);
    const phone = phoneRaw ? normalizePhone(phoneRaw) : "";
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
    if (phoneRaw && !phone) {
      return fail(reply, 400, "invalid_phone", "Phone must be a valid Iranian mobile number like 09121234567.");
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
        phone,
        passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
        recoveryHash: await bcrypt.hash(normalizeCode(recoveryCode), RECOVERY_ROUNDS),
        nick,
        birthdate,
        city,
        bio,
        avatar,
        role: "user"
      });
      let verification = null;
      try {
        verification = publicDelivery(user, await issueEmailToken(user, "verify", req));
      } catch (err) {
        req.log.error({ err }, "verification email failed at register");
        verification = { sent: false, mode: mailMode(), email: maskEmail(user.email), error: "send_failed" };
      }
      const issued = await issueToken(user, req);
      await audit("auth.register", req, {
        targetType: "user",
        targetId: user.id,
        actorId: user.id,
        actorRole: user.role || "user",
        meta: { emailVerified: Boolean(user.emailVerified), hasPhone: Boolean(user.phone) }
      });
      return reply.code(201).send({
        token: issued.token,
        tokenType: "Bearer",
        expiresIn: issued.expiresIn,
        user: publicUser(user),
        recoveryCode,
        verification,
        verificationRequired: verificationRequired()
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
      await audit("auth.login_failed", req, {
        meta: { identifierType: identifier.includes("@") ? "email" : "username", accountFound: Boolean(user) }
      });
      return fail(reply, 401, "invalid_credentials", "Email/username or password is incorrect.");
    }

    if (verificationRequired() && !user.emailVerified) {
      let verification = {
        sent: Boolean(mailMode() === "outbox"),
        mode: mailMode(),
        email: maskEmail(user.email),
        minutes: VERIFY_TTL_MINUTES
      };
      if (takeCooldown(`verify:${user.id}`, 60_000)) {
        try {
          verification = publicDelivery(user, await issueEmailToken(user, "verify", req));
        } catch (err) {
          req.log.error({ err }, "verification email failed at login");
          verification = { sent: false, mode: mailMode(), email: maskEmail(user.email), error: "send_failed" };
        }
      }
      return reply.code(403).send({
        error: "email_not_verified",
        message: "This email is not verified yet. Enter the code we sent to it.",
        email: maskEmail(user.email),
        verification
      });
    }

    await updateUser(user.id, { lastLoginAt: new Date() });

    const issued = await issueToken(user, req);
    const safe = publicUser(user);
    await cacheSet(`user:${safe.id}`, safe, USER_CACHE_TTL);
    await audit("auth.login", req, {
      targetType: "user",
      targetId: user.id,
      actorId: user.id,
      actorRole: user.role || "user"
    });

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
      await revokeDbSession(req.auth.jti);
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
      const current = await findUserById(req.auth.userId);
      if (!current || current.email !== email) {
        patch.email = email;
        patch.emailVerified = false;
        patch.emailVerifiedAt = null;
      }
    }

    if (body.phone !== undefined) {
      const raw = cleanString(body.phone, 20);
      if (raw) {
        const phone = normalizePhone(raw);
        if (!phone) return fail(reply, 400, "invalid_phone", "Phone must be a valid Iranian mobile number like 09121234567.");
        patch.phone = phone;
      } else {
        patch.phone = "";
      }
    }
    if (!Object.keys(patch).length) return fail(reply, 400, "nothing_to_update", "No profile fields were sent.");
    let user = await updateUser(req.auth.userId, patch);
    if (!user) return fail(reply, 404, "user_missing", "Account not found.");
    let verification = null;
    if (patch.email) {
      try {
        verification = publicDelivery(user, await issueEmailToken(user, "verify", req));
      } catch (err) {
        req.log.error({ err }, "verification email failed after email change");
        verification = { sent: false, mode: mailMode(), email: maskEmail(user.email), error: "send_failed" };
      }
    }
    const safe = publicUser(user);
    await cacheDel(`user:${safe.id}`);
    await cacheSet(`user:${safe.id}`, safe, USER_CACHE_TTL);
    return verification ? { user: safe, verification } : { user: safe };
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
    await revokeAllSessions(user.id);
    const issued = await issueToken(user, req);
    await cacheDel(`user:${user.id}`);
    await audit("auth.password_change", req, { targetType: "user", targetId: user.id });
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
    await revokeAllSessions(user.id);
    await cacheDel(`user:${user.id}`);
    const issued = await issueToken(updated, req);
    await audit("auth.recover", req, {
      targetType: "user",
      targetId: user.id,
      actorId: user.id,
      actorRole: user.role || "user"
    });
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
    await audit("auth.recovery_code_rotate", req, { targetType: "user", targetId: user.id });
    return { ok: true, recoveryCode };
  });

  app.post("/verify/send", { preHandler: [verifySendLimit] }, async (req, reply) => {
    if (!(await storeReady())) return fail(reply, 503, "database_unavailable", "Database is not connected yet.");
    const body = req.body && typeof req.body === "object" ? req.body : {};
    let user = null;
    const authenticated = String(req.headers.authorization || "").startsWith("Bearer ");
    if (authenticated) {
      await requireAuth(req, reply);
      if (reply.sent) return undefined;
      user = await findUserById(req.auth.userId);
      if (!user) return fail(reply, 401, "user_missing", "Account not found.");
    } else {
      const identifier = cleanString(body.identifier || body.email || body.username, 160).toLowerCase();
      if (identifier) {
        const rows = await findUsers(
          identifier.includes("@") ? { email: identifier } : { usernameLower: identifier }
        );
        user = rows[0] || null;
      }
      if (!user) {
        return {
          ok: true,
          verification: { sent: true, mode: mailMode(), email: "", minutes: VERIFY_TTL_MINUTES }
        };
      }
    }
    if (user.emailVerified) return { ok: true, already: true, user: authenticated ? publicUser(user) : null };
    if (!takeCooldown(`verify:${user.id}`, 45_000)) {
      return {
        ok: true,
        cooldown: true,
        verification: { sent: true, mode: mailMode(), email: maskEmail(user.email), minutes: VERIFY_TTL_MINUTES }
      };
    }
    const verification = publicDelivery(user, await issueEmailToken(user, "verify", req));
    return { ok: true, verification };
  });

  app.post("/verify/confirm", { preHandler: [verifyConfirmLimit] }, async (req, reply) => {
    if (!(await storeReady())) return fail(reply, 503, "database_unavailable", "Database is not connected yet.");
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const code = String(body.code ?? "").replace(/\D/g, "");
    if (!/^\d{8}$/.test(code)) return fail(reply, 400, "invalid_code", "The code must be 8 digits.");

    let user = null;
    let authenticated = false;
    if (String(req.headers.authorization || "").startsWith("Bearer ")) {
      await requireAuth(req, reply);
      if (reply.sent) return undefined;
      authenticated = true;
      user = await findUserById(req.auth.userId);
      if (!user) return fail(reply, 401, "user_missing", "Account not found.");
    } else {
      const identifier = cleanString(body.identifier || body.email || body.username, 160).toLowerCase();
      if (!identifier) return fail(reply, 400, "missing_identifier", "Enter your email or username.");
      const rows = await findUsers(
        identifier.includes("@") ? { email: identifier } : { usernameLower: identifier }
      );
      user = rows[0] || null;
      if (!user) return fail(reply, 400, "invalid_code", "The code is not correct.");
    }
    if (user.emailVerified) return { ok: true, already: true, user: publicUser(user) };

    const token = await findActiveEmailToken(user.id, "verify");
    if (!token) return fail(reply, 400, "code_expired", "The code expired. Request a new one.");
    const valid = await bcrypt.compare(code, token.codeHash || "");
    if (!valid) {
      const attempts = await bumpEmailTokenAttempts(token.id);
      if (attempts >= MAX_CODE_ATTEMPTS) {
        await consumeEmailToken(token.id);
        return fail(reply, 429, "too_many_attempts", "Too many wrong codes. Request a new code.");
      }
      return fail(reply, 400, "invalid_code", "The code is not correct.");
    }

    await consumeEmailToken(token.id);
    const updated = await updateUser(user.id, { emailVerified: true, emailVerifiedAt: new Date() });
    const safe = publicUser(updated);
    await cacheDel(`user:${safe.id}`);
    await cacheSet(`user:${safe.id}`, safe, USER_CACHE_TTL);
    await audit("auth.email_verified", req, { targetType: "user", targetId: user.id, meta: { via: "code" } });
    if (authenticated) return { ok: true, user: safe };
    const issued = await issueToken(updated, req);
    return {
      ok: true,
      token: issued.token,
      tokenType: "Bearer",
      expiresIn: issued.expiresIn,
      user: safe
    };
  });

  app.post("/verify-link", { preHandler: [verifyConfirmLimit] }, async (req, reply) => {
    if (!(await storeReady())) return fail(reply, 503, "database_unavailable", "Database is not connected yet.");
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const token = String(body.token ?? "").trim();
    if (!token) return fail(reply, 400, "invalid_link", "This verification link is not valid.");
    const record = await findEmailTokenByLink(hashLinkToken(token), "verify");
    if (!record) return fail(reply, 400, "link_expired", "This verification link expired or was already used.");
    const user = await findUserById(record.userId);
    if (!user) return fail(reply, 404, "user_missing", "Account not found.");

    await consumeEmailToken(record.id);
    const updated = await updateUser(user.id, { emailVerified: true, emailVerifiedAt: new Date() });
    await cacheDel(`user:${user.id}`);
    const issued = await issueToken(updated, req);
    await audit("auth.email_verified", req, { targetType: "user", targetId: user.id, meta: { via: "link" } });
    return {
      ok: true,
      token: issued.token,
      tokenType: "Bearer",
      expiresIn: issued.expiresIn,
      user: publicUser(updated)
    };
  });

  app.post("/password/forgot", { preHandler: [forgotLimit] }, async (req, reply) => {
    if (!(await storeReady())) return fail(reply, 503, "database_unavailable", "Database is not connected yet.");
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const phoneRaw = cleanString(body.phone, 20);
    const email = cleanString(body.email, 160).toLowerCase();

    if (phoneRaw) {
      const phone = normalizePhone(phoneRaw);
      if (!phone) return fail(reply, 400, "invalid_phone", "Phone must be a valid Iranian mobile number like 09121234567.");
      const rows = await findUsersByPhone(phone);
      const user = rows.length === 1 ? rows[0] : null;
      const masked = { phone: maskPhone(phone), minutes: RESET_TTL_MINUTES, channel: "sms" };
      if (!user || !user.phone) return { ok: true, sent: true, ...masked };
      if (!takeCooldown(`forgot:phone:${phone}`, 60_000)) {
        return { ok: true, sent: true, cooldown: true, ...masked };
      }
      try {
        const delivery = publicDelivery(user, await issueEmailToken(user, "reset", req, "sms"));
        if (!delivery.sent) {
          return fail(reply, 502, "sms_failed", "The SMS could not be sent right now. Try again in a minute.");
        }
        return { ok: true, ...delivery };
      } catch (err) {
        req.log.error({ err }, "reset sms failed");
        return fail(reply, 502, "sms_failed", "The SMS could not be sent right now. Try again in a minute.");
      }
    }

    if (!EMAIL_RE.test(email)) return fail(reply, 400, "invalid_email", "Enter a valid email address.");

    const rows = await findUsers({ email });
    const user = rows[0] || null;
    if (!user) {
      // Same answer for unknown emails so accounts cannot be probed.
      return { ok: true, sent: true, channel: "email", email: maskEmail(email), minutes: RESET_TTL_MINUTES };
    }
    if (!takeCooldown(`forgot:${email}`, 60_000)) {
      return { ok: true, sent: true, cooldown: true, channel: "email", email: maskEmail(email), minutes: RESET_TTL_MINUTES };
    }
    try {
      const delivery = publicDelivery(user, await issueEmailToken(user, "reset", req));
      if (!delivery.sent) {
        return fail(reply, 502, "mail_failed", "The email could not be sent right now. Try again in a minute.");
      }
      return { ok: true, ...delivery, verificationRequired: verificationRequired() };
    } catch (err) {
      req.log.error({ err }, "reset email failed");
      return fail(reply, 502, "mail_failed", "The email could not be sent right now. Try again in a minute.");
    }
  });

  app.post("/password/reset", { preHandler: [resetLimit] }, async (req, reply) => {
    if (!(await storeReady())) return fail(reply, 503, "database_unavailable", "Database is not connected yet.");
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const linkToken = String(body.token ?? "").trim();
    const email = cleanString(body.email, 160).toLowerCase();
    const phoneRaw = cleanString(body.phone, 20);
    const code = String(body.code ?? "").replace(/\D/g, "");
    const next = String(body.password ?? "");
    if (next.length < 8 || next.length > 128) {
      return fail(reply, 400, "invalid_password", "Password must be between 8 and 128 characters.");
    }

    let record = null;
    let user = null;
    let checkCode = false;
    if (linkToken) {
      record = await findEmailTokenByLink(hashLinkToken(linkToken), "reset");
      if (!record) return fail(reply, 400, "link_expired", "This reset link expired or was already used.");
      user = await findUserById(record.userId);
    } else {
      if (!/^\d{8}$/.test(code)) return fail(reply, 400, "invalid_code", "The code must be 8 digits.");
      if (phoneRaw) {
        const phone = normalizePhone(phoneRaw);
        if (!phone) return fail(reply, 400, "invalid_phone", "Phone must be a valid Iranian mobile number like 09121234567.");
        const rows = await findUsersByPhone(phone);
        user = rows.length === 1 ? rows[0] : null;
      } else {
        if (!EMAIL_RE.test(email)) return fail(reply, 400, "invalid_email", "Enter the email of your account.");
        const rows = await findUsers({ email });
        user = rows[0] || null;
      }
      record = user ? await findActiveEmailToken(user.id, "reset") : null;
      if (!user || !record) return fail(reply, 400, "code_expired", "The code expired. Request a new one.");
      checkCode = true;
    }
    if (checkCode) {
      const valid = await bcrypt.compare(code, record.codeHash || "");
      if (!valid) {
        const attempts = await bumpEmailTokenAttempts(record.id);
        if (attempts >= MAX_CODE_ATTEMPTS) {
          await consumeEmailToken(record.id);
          return fail(reply, 429, "too_many_attempts", "Too many wrong codes. Request a new code.");
        }
        return fail(reply, 400, "invalid_code", "The code is not correct.");
      }
    }
    if (!user) return fail(reply, 400, "user_missing", "Account not found.");

    const recoveryCode = newRecoveryCode();
    const updated = await updateUser(user.id, {
      passwordHash: await bcrypt.hash(next, BCRYPT_ROUNDS),
      recoveryHash: await bcrypt.hash(normalizeCode(recoveryCode), RECOVERY_ROUNDS),
      emailVerified: true,
      emailVerifiedAt: user.emailVerifiedAt || new Date()
    });
    await consumeEmailToken(record.id);
    await revokeAllSessions(user.id);
    await cacheDel(`user:${user.id}`);
    const issued = await issueToken(updated, req);
    await audit("auth.password_reset", req, {
      targetType: "user",
      targetId: user.id,
      actorId: user.id,
      actorRole: user.role || "user",
      meta: { via: linkToken ? "link" : "code" }
    });
    return {
      ok: true,
      token: issued.token,
      tokenType: "Bearer",
      expiresIn: issued.expiresIn,
      user: publicUser(updated),
      recoveryCode
    };
  });

  app.post("/logout", { preHandler: [requireAuth] }, async (req) => {
    await revokeSession(req.auth.jti);
    await revokeDbSession(req.auth.jti);
    await cacheDel(`user:${req.auth.userId}`);
    await audit("auth.logout", req, { targetType: "session", targetId: req.auth.jti });
    return { ok: true };
  });

  /* ---------- owner: email + SMS connections ---------- */
  async function ownerOnly(req, reply) {
    await requireAuth(req, reply);
    if (reply.sent) return false;
    if (!["owner", "super_owner"].includes(req.auth.role)) {
      fail(reply, 403, "forbidden", "Only the site owner can manage connections.");
      return false;
    }
    return true;
  }

  app.get("/owner/connections", { preHandler: [connectionsLimit] }, async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    await loadConnections(true);
    return {
      ok: true,
      connections: safeConnections(),
      effective: { mail: mailState(), sms: smsState() }
    };
  });

  app.put("/owner/connections", { preHandler: [connectionsLimit] }, async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const mail = body.mail && typeof body.mail === "object" ? body.mail : null;
    const sms = body.sms && typeof body.sms === "object" ? body.sms : null;
    if (mail?.enabled) {
      if (!cleanString(mail.host, 200)) return fail(reply, 400, "invalid_host", "SMTP host is required when email is enabled.");
      const port = Number(mail.port);
      if (!Number.isFinite(port) || port < 1 || port > 65535) return fail(reply, 400, "invalid_port", "SMTP port must be between 1 and 65535.");
    }
    if (sms?.enabled) {
      const provider = String(sms.provider || "").trim();
      if (!["kavenegar", "twilio", "webhook"].includes(provider)) {
        return fail(reply, 400, "invalid_provider", "Pick an SMS provider: kavenegar, twilio or webhook.");
      }
      if (provider === "kavenegar" && !String(sms.apiKey || "").trim()) {
        return fail(reply, 400, "missing_api_key", "Kavenegar API key is required.");
      }
      if (provider === "twilio" && (!String(sms.twilioSid || "").trim() || !String(sms.twilioToken || "").trim())) {
        return fail(reply, 400, "missing_twilio", "Twilio SID and auth token are required.");
      }
      if (provider === "webhook" && !/^https?:\/\//i.test(String(sms.webhookUrl || "").trim())) {
        return fail(reply, 400, "invalid_webhook", "Webhook URL must start with http:// or https://.");
      }
    }
    const saved = await saveConnections({ mail: mail || undefined, sms: sms || undefined });
    if (!saved.ok) return fail(reply, 503, "store_unavailable", "Could not save the connection settings.");
    applyMailSettings();
    await audit("owner.connections.update", req, {
      targetType: "settings",
      targetId: "connections",
      meta: {
        mail: { enabled: Boolean(mail?.enabled), host: Boolean(mail?.host) },
        sms: { enabled: Boolean(sms?.enabled), provider: sms?.provider || "" }
      }
    });
    return {
      ok: true,
      connections: safeConnections(),
      effective: { mail: mailState(), sms: smsState() }
    };
  });

  app.post("/owner/connections/test", { preHandler: [connectionsTestLimit] }, async (req, reply) => {
    if (!(await ownerOnly(req, reply))) return undefined;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const kind = String(body.kind || "").trim();
    if (kind === "mail") {
      const to = cleanString(body.to, 160).toLowerCase();
      if (!EMAIL_RE.test(to)) return fail(reply, 400, "invalid_email", "Enter a valid email address.");
      const result = await sendTestMail({ to });
      await audit("owner.connections.test", req, {
        targetType: "mail",
        meta: { ok: Boolean(result.ok), mode: result.mode || "" }
      });
      return { ok: Boolean(result.ok), mode: result.mode || "", error: result.error || "" };
    }
    if (kind === "sms") {
      const phone = normalizePhone(cleanString(body.to, 20));
      if (!phone) return fail(reply, 400, "invalid_phone", "Phone must be a valid Iranian mobile number like 09121234567.");
      const result = await sendTestSms({ to: phone });
      await audit("owner.connections.test", req, {
        targetType: "sms",
        meta: { ok: Boolean(result.ok), mode: result.mode || "" }
      });
      return { ok: Boolean(result.ok), mode: result.mode || "", error: result.error || "" };
    }
    return fail(reply, 400, "invalid_kind", "Test kind must be mail or sms.");
  });
}
