import "dotenv/config";
import bcrypt from "bcryptjs";
import { connectDB, dbReady, disconnectDB } from "./db.js";
import { User } from "./models/User.js";
import { createUser, countUsers, ensureStore } from "./userStore.js";

const OWNER_EMAIL = (process.env.OWNER_EMAIL || "owner@qoder.local").toLowerCase();
const OWNER_USERNAME = process.env.OWNER_USERNAME || "owner";
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || "A9!xK2@pL5#vN8$";

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
    passwordHash,
    role: "super_owner"
  });
  console.log(`[seed] created super_owner ${owner.email} (username: ${owner.username})`);
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
    passwordHash: await bcrypt.hash(OWNER_PASSWORD, 12),
    nick: OWNER_USERNAME,
    role: "super_owner"
  });
  console.log(`[seed] created super_owner ${owner.email} (username: ${owner.username}) in the SQLite store`);
}

async function main() {
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
