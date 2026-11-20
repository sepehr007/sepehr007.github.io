import "dotenv/config";
import bcrypt from "bcryptjs";
import { connectDB, dbReady, disconnectDB } from "./db.js";
import { User } from "./models/User.js";
import { createUser, countUsers, ensureStore } from "./userStore.js";

const OWNER_EMAIL = (process.env.OWNER_EMAIL || "owner@qoder.local").trim().toLowerCase();
const OWNER_USERNAME = String(process.env.OWNER_USERNAME || "owner").trim();
const OWNER_PASSWORD = String(process.env.OWNER_PASSWORD || "");
const OWNER_PHONE_RAW = String(process.env.OWNER_PHONE || "").trim();

function normalizeOwnerPhone(raw) {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.startsWith("0098")) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith("98") && digits.length === 12) digits = `0${digits.slice(2)}`;
  else if (digits.length === 10 && digits.startsWith("9")) digits = `0${digits}`;
  return /^09\d{9}$/.test(digits) ? digits : "";
}

const OWNER_PHONE = normalizeOwnerPhone(OWNER_PHONE_RAW);

function ownerSeedProblem() {
  if (!OWNER_PASSWORD) return "OWNER_PASSWORD is required. Set a unique 12+ character password in server/.env.";
  if (OWNER_PASSWORD === "change_me_before_deploying") return "OWNER_PASSWORD still has the example value. Set a unique 12+ character password.";
  if (OWNER_PASSWORD.length < 12) return "OWNER_PASSWORD must be at least 12 characters.";
  if (OWNER_PHONE_RAW && !OWNER_PHONE) return "OWNER_PHONE must be an Iranian mobile number like 09121234567.";
  return "";
}

async function seedMongo() {
  const total = await User.countDocuments();
  if (total > 0) {
    console.log(`[seed] database already has ${total} user(s) - nothing to do`);
    return;
  }
  const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
  const owner = await User.create({
    username: OWNER_USERNAME,
    usernameLower: OWNER_USERNAME.toLowerCase(),
    email: OWNER_EMAIL,
    emailVerified: true,
    emailVerifiedAt: new Date(),
    phone: OWNER_PHONE,
    passwordHash,
    role: "super_owner"
  });
  console.log(`[seed] created super_owner ${owner.email} (username: ${owner.username})`);
  if (!OWNER_PHONE) console.warn("[seed] OWNER_PHONE is empty; owner verification will use the verified owner email only.");
}

async function seedSqlite() {
  const total = await countUsers();
  if (total > 0) {
    console.log(`[seed] database already has ${total} user(s) - nothing to do`);
    return;
  }
  const owner = await createUser({
    username: OWNER_USERNAME,
    usernameLower: OWNER_USERNAME.toLowerCase(),
    email: OWNER_EMAIL,
    emailVerified: true,
    emailVerifiedAt: Date.now(),
    phone: OWNER_PHONE,
    passwordHash: await bcrypt.hash(OWNER_PASSWORD, 12),
    nick: OWNER_USERNAME,
    role: "super_owner"
  });
  console.log(`[seed] created super_owner ${owner.email} (username: ${owner.username}) in the SQLite store`);
  if (!OWNER_PHONE) console.warn("[seed] OWNER_PHONE is empty; owner verification will use the verified owner email only.");
}

async function main() {
  const problem = ownerSeedProblem();
  if (problem) {
    console.error(`[seed] ${problem}`);
    process.exitCode = 1;
    return;
  }
  await connectDB(process.env.MONGO_URI, { retry: false });
  if (dbReady()) {
    await seedMongo();
    return;
  }
  if (!(await ensureStore())) {
    console.error("[seed] no database is reachable. Set MONGO_URI or make sure the SQLite data directory is writable.");
    process.exitCode = 1;
    return;
  }
  await seedSqlite();
}

main()
  .catch((err) => {
    console.error("[seed] failed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDB();
  });
