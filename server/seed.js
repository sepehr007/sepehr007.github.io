import "dotenv/config";
import bcrypt from "bcryptjs";
import { connectDB, dbReady, disconnectDB } from "./db.js";
import { User } from "./models/User.js";

const OWNER_EMAIL = (process.env.OWNER_EMAIL || "owner@qoder.local").toLowerCase();
const OWNER_USERNAME = process.env.OWNER_USERNAME || "owner";
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || "A9!xK2@pL5#vN8$";

async function main() {
  await connectDB(process.env.MONGO_URI, { retry: false });
  if (!dbReady()) {
    console.error("[seed] MongoDB is not reachable. Start MongoDB and run `npm run seed` again.");
    process.exitCode = 1;
    return;
  }

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

main()
  .catch((err) => {
    console.error("[seed] failed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDB();
  });
