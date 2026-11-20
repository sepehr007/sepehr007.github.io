import bcrypt from "bcryptjs";
import { getDatabase } from "./database/index.js";
import { createUser, countUsers } from "./userStore.js";
import { dbReady } from "./db.js";

export function normalizeOwnerPhone(raw) {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.startsWith("0098")) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith("98") && digits.length === 12) digits = `0${digits.slice(2)}`;
  else if (digits.length === 10 && digits.startsWith("9")) digits = `0${digits}`;
  return /^09\d{9}$/.test(digits) ? digits : "";
}

export function ownerSeedProblem(password, phoneRaw) {
  if (!password) return "OWNER_PASSWORD is required.";
  if (password === "change_me_before_deploying") return "OWNER_PASSWORD still has the example value.";
  if (password.length < 12) return "OWNER_PASSWORD must be at least 12 characters.";
  if (phoneRaw && !normalizeOwnerPhone(phoneRaw)) return "OWNER_PHONE must be an Iranian mobile number like 09121234567.";
  return "";
}

// Creates the super owner on first boot when the database has no users yet.
// Lets shared hosts without SSH finish deployment from the env panel alone.
export async function bootstrapOwnerFromEnv(log = null) {
  const email = String(process.env.OWNER_EMAIL || "").trim().toLowerCase();
  const password = String(process.env.OWNER_PASSWORD || "");
  const phoneRaw = String(process.env.OWNER_PHONE || "").trim();
  if (!email || !password) return { ok: false, reason: "env_missing" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, reason: "email_invalid" };
  const problem = ownerSeedProblem(password, phoneRaw);
  if (problem) return { ok: false, reason: "password_invalid" };
  const db = await getDatabase();
  if (!db) return { ok: false, reason: "database_unavailable" };
  if ((await countUsers()) > 0) return { ok: false, reason: "users_exist" };
  const username = String(process.env.OWNER_USERNAME || "owner").trim() || "owner";
  await createUser({
    username,
    usernameLower: username.toLowerCase(),
    email,
    emailVerified: true,
    emailVerifiedAt: Date.now(),
    phone: normalizeOwnerPhone(phoneRaw),
    passwordHash: await bcrypt.hash(password, 12),
    nick: username,
    role: "super_owner"
  });
  log?.info?.(`[owner] bootstrap super_owner created (${email})`);
  return { ok: true };
}

export function scheduleOwnerBootstrap(log, { retries = 3, delayMs = 20_000 } = {}) {
  const attempt = async (left) => {
    try {
      const result = await bootstrapOwnerFromEnv(log);
      if (result.ok || result.reason !== "database_unavailable") {
        if (!result.ok && result.reason !== "users_exist" && result.reason !== "env_missing") {
          log?.warn?.(`[owner] bootstrap skipped: ${result.reason}`);
        }
        return;
      }
      if (left > 0) {
        const timer = setTimeout(() => attempt(left - 1), delayMs);
        timer.unref?.();
      } else {
        log?.warn?.(`[owner] bootstrap skipped: ${result.reason}`);
      }
    } catch (err) {
      log?.warn?.(`[owner] bootstrap failed: ${err.message}`);
      if (left > 0) {
        const timer = setTimeout(() => attempt(left - 1), delayMs);
        timer.unref?.();
      }
    }
  };
  attempt(retries);
}
