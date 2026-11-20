import { dbReady } from "../db.js";
import { getDatabase } from "../database/index.js";

export const PROFILE_VISIBILITY = ["public", "unlisted", "private"];
export const LAST_ACTIVE_VISIBILITY = ["everyone", "friends", "nobody"];
export const ACTIVITY_VISIBILITY = ["everyone", "friends", "nobody"];

export const PRIVACY_DEFAULTS = Object.freeze({
  profileVisibility: "public",
  lastActiveVisibility: "friends",
  activityVisibility: "friends"
});

function pick(value, allowed, fallback) {
  return allowed.includes(String(value)) ? String(value) : fallback;
}

export async function getPrivacy(userId) {
  if (!userId || dbReady()) return { ...PRIVACY_DEFAULTS, unsupported: dbReady() };
  const db = await getDatabase();
  if (!db) return { ...PRIVACY_DEFAULTS, unsupported: true };
  const row = db
    .prepare("SELECT visibility, last_active_visibility, activity_visibility FROM profiles WHERE user_id = ?")
    .get(String(userId));
  if (!row) {
    db.prepare("INSERT OR IGNORE INTO profiles (user_id, updated_at) VALUES (?, ?)").run(String(userId), Date.now());
    return { ...PRIVACY_DEFAULTS };
  }
  return {
    profileVisibility: pick(row.visibility, PROFILE_VISIBILITY, "public"),
    lastActiveVisibility: pick(row.last_active_visibility, LAST_ACTIVE_VISIBILITY, "friends"),
    activityVisibility: pick(row.activity_visibility, ACTIVITY_VISIBILITY, "friends")
  };
}

export async function setPrivacy(userId, patch = {}) {
  if (!userId || dbReady()) throw new Error("privacy_unsupported");
  const db = await getDatabase();
  if (!db) throw new Error("database_unavailable");
  const current = await getPrivacy(userId);
  const next = {
    visibility: patch.profileVisibility === undefined
      ? current.profileVisibility
      : pick(patch.profileVisibility, PROFILE_VISIBILITY, current.profileVisibility),
    lastActive: patch.lastActiveVisibility === undefined
      ? current.lastActiveVisibility
      : pick(patch.lastActiveVisibility, LAST_ACTIVE_VISIBILITY, current.lastActiveVisibility),
    activity: patch.activityVisibility === undefined
      ? current.activityVisibility
      : pick(patch.activityVisibility, ACTIVITY_VISIBILITY, current.activityVisibility)
  };
  db.prepare(
    `INSERT INTO profiles (user_id, visibility, last_active_visibility, activity_visibility, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       visibility = excluded.visibility,
       last_active_visibility = excluded.last_active_visibility,
       activity_visibility = excluded.activity_visibility,
       updated_at = excluded.updated_at`
  ).run(String(userId), next.visibility, next.lastActive, next.activity, Date.now());
  return {
    profileVisibility: next.visibility,
    lastActiveVisibility: next.lastActive,
    activityVisibility: next.activity
  };
}
