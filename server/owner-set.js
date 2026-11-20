import "dotenv/config";
import bcrypt from "bcryptjs";
import { connectDB, disconnectDB } from "./db.js";
import { ensureStore, findOwnerAccount, updateUser } from "./userStore.js";
import { revokeDbUserSessions } from "./sessionStore.js";
import { revokeUserSessions } from "./redis.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizePhone(raw) {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.startsWith("0098")) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith("98") && digits.length === 12) digits = `0${digits.slice(2)}`;
  else if (digits.length === 10 && digits.startsWith("9")) digits = `0${digits}`;
  return /^09\d{9}$/.test(digits) ? digits : "";
}

function maskEmail(email) {
  const [name, domain] = String(email || "").split("@");
  if (!domain) return "";
  return `${name.slice(0, 1)}${"*".repeat(Math.max(1, Math.min(4, name.length - 1)))}@${domain}`;
}

function maskPhone(phone) {
  const p = String(phone || "");
  if (!/^09\d{9}$/.test(p)) return "";
  return `${p.slice(0, 4)}***${p.slice(-4)}`;
}

async function main() {
  const yes = process.argv.includes("--yes");
  const emailRaw = String(process.env.OWNER_EMAIL || "").trim().toLowerCase();
  const phoneRaw = String(process.env.OWNER_PHONE || "").trim();
  const password = String(process.env.OWNER_PASSWORD || "");

  if (emailRaw && !EMAIL_RE.test(emailRaw)) {
    console.error("[owner] OWNER_EMAIL is not a valid email address.");
    process.exitCode = 1;
    return;
  }
  const phone = phoneRaw ? normalizePhone(phoneRaw) : "";
  if (phoneRaw && !phone) {
    console.error("[owner] OWNER_PHONE must be an Iranian mobile number like 09121234567.");
    process.exitCode = 1;
    return;
  }
  if (password && (password.length < 12 || password.length > 128)) {
    console.error("[owner] OWNER_PASSWORD must be between 12 and 128 characters.");
    process.exitCode = 1;
    return;
  }
  if (password && password === "change_me_before_deploying") {
    console.error("[owner] OWNER_PASSWORD is still the example value. Set a unique password.");
    process.exitCode = 1;
    return;
  }

  await connectDB(process.env.MONGO_URI, { retry: false });
  if (!(await ensureStore())) {
    console.error("[owner] no database is reachable. Check DATA_DIR or MONGO_URI.");
    process.exitCode = 1;
    return;
  }
  const owner = await findOwnerAccount();
  if (!owner) {
    console.error("[owner] no owner account found. Run `npm run seed` on an empty database first.");
    process.exitCode = 1;
    return;
  }

  const patch = {};
  const changed = [];
  if (emailRaw && emailRaw !== owner.email) {
    patch.email = emailRaw;
    patch.emailVerified = true;
    patch.emailVerifiedAt = new Date();
    changed.push("email");
  } else if (!owner.emailVerified) {
    patch.emailVerified = true;
    patch.emailVerifiedAt = owner.emailVerifiedAt || new Date();
    changed.push("email_verified");
  }
  if (phone && phone !== owner.phone) {
    patch.phone = phone;
    changed.push("phone");
  }
  if (password) {
    patch.passwordHash = await bcrypt.hash(password, 12);
    changed.push("password");
  }

  const nextEmail = patch.email || owner.email || "";
  const nextPhone = patch.phone || owner.phone || "";
  console.log(`[owner] account: ${owner.username} (${owner.id})`);
  console.log(`[owner] email: ${nextEmail ? maskEmail(nextEmail) : "not set"}`);
  console.log(`[owner] phone: ${nextPhone ? maskPhone(nextPhone) : "not set"}`);
  console.log(`[owner] planned changes: ${changed.length ? changed.join(", ") : "none"}`);

  if (!changed.length) {
    console.log("[owner] nothing to update.");
    return;
  }
  if (!yes) {
    console.log("[owner] dry run only. Re-run with --yes to apply.");
    return;
  }

  const updated = await updateUser(owner.id, patch);
  if (!updated) throw new Error("update_failed");
  if (patch.passwordHash) {
    await revokeDbUserSessions(owner.id);
    await revokeUserSessions(owner.id);
  }
  console.log("[owner] updated. The owner password was not printed and is never stored in this project.");
  console.log("[owner] next: sign in at owner.html with the owner email/username and the new password.");
}

main()
  .catch((err) => {
    console.error("[owner] failed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDB();
  });
