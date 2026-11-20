import { getDatabase } from "./database/index.js";
import { createNotification, markNotificationDelivered } from "./stores/social.js";

/* Stores one notification (honoring category, room/server mutes, quiet hours
   and duplicate windows) and pushes it live to every open socket of that user.
   Marking `delivered_at` only when at least one socket existed is what makes
   the delivery status in the API honest. */
export async function deliverNotice(app, userId, notice = {}) {
  try {
    if (!userId) return null;
    const db = await getDatabase();
    if (!db) return null;
    const stored = createNotification(db, userId, notice.kind, notice.title, notice.body, notice.link, {
      dedupeKey: notice.dedupeKey,
      dedupeWindowMs: notice.dedupeWindowMs,
      room: notice.room,
      server: notice.server
    });
    if (!stored) return null;
    if (stored.push) {
      let delivered = 0;
      try {
        delivered = Number(
          app?.notifyUser?.(String(userId), {
            type: "social",
            event: "notification",
            data: {
              id: stored.id,
              kind: stored.kind,
              title: stored.title,
              body: stored.body,
              link: stored.link,
              createdAt: stored.createdAt
            }
          }) || 0
        );
      } catch {}
      if (delivered > 0) markNotificationDelivered(db, userId, stored.id);
    }
    return stored;
  } catch {
    return null;
  }
}

export async function deliverNoticeMany(app, userIds, makeNotice) {
  const unique = [...new Set((userIds || []).map((id) => String(id || "")).filter(Boolean))];
  let count = 0;
  for (const userId of unique) {
    const notice = typeof makeNotice === "function" ? makeNotice(userId) : makeNotice;
    if (await deliverNotice(app, userId, notice)) count += 1;
  }
  return count;
}
