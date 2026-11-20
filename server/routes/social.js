import { dbReady } from "../db.js";
import { getDatabase } from "../database/index.js";
import { requireAuth } from "./auth.js";
import { audit } from "../audit.js";
import {
  SocialError,
  isStaff,
  sqlTouchUser,
  sqlListPeople,
  sqlFindUserByUsername,
  sqlListFriends,
  sqlListFriendRequests,
  sqlSendFriendRequest,
  sqlRespondFriendRequest,
  sqlCancelFriendRequest,
  sqlRemoveFriend,
  sqlListBlocks,
  sqlBlockUser,
  sqlUnblockUser,
  sqlListConversations,
  sqlOpenConversation,
  sqlListDmMessages,
  sqlSendDmMessage,
  sqlEditDmMessage,
  sqlDeleteDmMessage,
  sqlAddDmReaction,
  sqlRemoveDmReaction,
  sqlMarkConversationRead,
  sqlSetConversationPref,
  sqlConversationPeerId,
  sqlDmMessagePeerId,
  sqlDmMessageReactions,
  sqlSearch,
  sqlCreateReport,
  sqlListMyReports,
  sqlListReports,
  sqlGetReport,
  sqlPatchReport,
  sqlCreateInvite,
  sqlListInvites,
  sqlRevokeInvite,
  sqlAcceptInvite,
  sqlListHistory,
  sqlUpsertHistory,
  sqlDeleteHistory,
  sqlClearHistory,
  sqlListPolls,
  sqlCreatePoll,
  sqlVotePoll,
  sqlClosePoll,
  sqlDeletePoll,
  sqlPollAudience,
  sqlListLibrary,
  sqlAddLibraryItem,
  sqlDeleteLibraryItem,
  sqlCreateTicket,
  sqlListTickets,
  sqlGetTicket,
  sqlAddTicketMessage,
  sqlPatchTicket,
  sqlListSupportAgents,
  sqlListStaffIds,
  sqlListNotifications,
  sqlMarkNotificationsRead,
  sqlMarkAllNotificationsRead,
  sqlGetNotificationPrefs,
  sqlPutNotificationPrefs
} from "../stores/social.js";
import { deliverNotice, deliverNoticeMany } from "../notify.js";

function fail(reply, status, error, message) {
  return reply.code(status).send({ error, message });
}

function body(req) {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
}

function cleanText(value, max = 200) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
}

async function touchPresence(req) {
  if (!req.auth?.userId) return;
  try {
    await sqlTouchUser(req.auth.userId);
  } catch {}
}

const AUTH = [requireAuth, touchPresence];

function socialReady(reply) {
  if (dbReady()) {
    fail(reply, 503, "database_unavailable", "Social features are only available on the SQLite deployment.");
    return false;
  }
  return true;
}

function handle(fn) {
  return async (req, reply) => {
    if (!socialReady(reply)) return undefined;
    const db = await getDatabase();
    if (!db) return fail(reply, 503, "database_unavailable", "Database is not connected yet.");
    try {
      return await fn(req, reply);
    } catch (err) {
      if (err instanceof SocialError) return fail(reply, err.status, err.code, err.message);
      if (String(err?.message || "") === "database_not_open") {
        return fail(reply, 503, "database_unavailable", "Database is not connected yet.");
      }
      throw err;
    }
  };
}

function notify(req, userId, event, data) {
  try {
    req.server.notifyUser?.(userId, { type: "social", event, data });
  } catch {}
}

async function broadcastPoll(req, poll, { event = "poll_update", skipUserId = null, notifyCreate = false } = {}) {
  let audience = { ids: [], roomCode: poll.roomCode, name: poll.roomCode };
  try {
    audience = await sqlPollAudience(poll.roomCode);
  } catch {}
  const data = event === "poll_removed"
    ? { id: String(poll.id), roomCode: poll.roomCode }
    : {
        id: poll.id,
        roomCode: poll.roomCode,
        question: poll.question,
        closed: Boolean(poll.closed),
        closesAt: poll.closesAt || null,
        totalVotes: Number(poll.totalVotes || 0),
        options: (poll.options || []).map((option) => ({ id: option.id, label: option.label, votes: Number(option.votes || 0) }))
      };
  for (const id of audience.ids) {
    if (skipUserId && String(id) === String(skipUserId)) continue;
    notify(req, id, event, data);
  }
  if (notifyCreate) {
    await deliverNoticeMany(req.server, audience.ids.filter((id) => String(id) !== String(poll.createdBy)), () => ({
      kind: "poll",
      title: `نظرسنجی تازه در «${audience.name || poll.roomCode}»`,
      body: poll.question,
      link: "social.html#rooms",
      dedupeKey: `poll:${poll.id}`,
      dedupeWindowMs: 15 * 60_000,
      room: poll.roomCode
    }));
  }
  return audience;
}

export default async function socialRoutes(app) {
  /* ------------------------------------------------------------------ people */
  app.get("/people", { preHandler: AUTH }, handle(async (req) => {
    const q = cleanText(req.query?.q, 80);
    return { ok: true, people: await sqlListPeople(req.auth.userId, q, req.query?.limit) };
  }));

  app.get("/friends", { preHandler: AUTH }, handle(async (req) => {
    return { ok: true, friends: await sqlListFriends(req.auth.userId) };
  }));

  app.get("/requests", { preHandler: AUTH }, handle(async (req) => {
    const requests = await sqlListFriendRequests(req.auth.userId);
    return {
      ok: true,
      incoming: requests.filter((item) => item.incoming),
      outgoing: requests.filter((item) => !item.incoming)
    };
  }));

  app.post("/friends/request", { preHandler: AUTH }, handle(async (req, reply) => {
    const payload = body(req);
    const username = cleanText(payload.username, 24);
    if (!username) return fail(reply, 400, "invalid_username", "Username is required.");
    const request = await sqlSendFriendRequest(req.auth.userId, username, payload.message);
    notify(req, request.to.id, "friend_request", request);
    await deliverNotice(req.server, request.to.id, {
      kind: "friend_request",
      title: `${request.from.username} درخواست دوستی فرستاد`,
      body: request.message || "",
      link: "social.html#people",
      dedupeKey: `friend_request:${request.id}`,
      dedupeWindowMs: 60 * 60_000
    });
    await audit("friend.request", req, { targetType: "user", targetId: request.to.id, meta: { username } });
    return reply.code(201).send({ ok: true, request });
  }));

  app.post("/friends/respond", { preHandler: AUTH }, handle(async (req) => {
    const payload = body(req);
    const requestId = cleanText(payload.requestId, 80);
    if (!requestId) throw new SocialError(400, "invalid_request", "requestId is required.");
    const accept = payload.accept === true || payload.accept === "true" || payload.accept === 1;
    const request = await sqlRespondFriendRequest(req.auth.userId, requestId, accept);
    if (accept) {
      notify(req, request.from.id, "friend_accept", request);
      await deliverNotice(req.server, request.from.id, {
        kind: "friend_accept",
        title: `${request.to.username} درخواست دوستی را پذیرفت`,
        body: "",
        link: "social.html#people",
        dedupeKey: `friend_accept:${request.id}`,
        dedupeWindowMs: 60 * 60_000
      });
    }
    await audit("friend.respond", req, {
      targetType: "friend_request",
      targetId: requestId,
      meta: { accepted: accept }
    });
    return { ok: true, request };
  }));

  app.delete("/friends/request/:id", { preHandler: AUTH }, handle(async (req) => {
    const request = await sqlCancelFriendRequest(req.auth.userId, req.params.id);
    return { ok: true, request };
  }));

  app.delete("/friends/:username", { preHandler: AUTH }, handle(async (req) => {
    const username = cleanText(req.params.username, 24);
    const result = await sqlRemoveFriend(req.auth.userId, username);
    await audit("friend.remove", req, { targetType: "user", targetId: username });
    return result;
  }));

  app.get("/blocks", { preHandler: AUTH }, handle(async (req) => {
    return { ok: true, blocks: await sqlListBlocks(req.auth.userId) };
  }));

  app.post("/blocks", { preHandler: AUTH }, handle(async (req, reply) => {
    const username = cleanText(body(req).username, 24);
    if (!username) return fail(reply, 400, "invalid_username", "Username is required.");
    const result = await sqlBlockUser(req.auth.userId, username);
    await audit("user.block", req, { targetType: "user", targetId: result.blocked.id });
    return reply.code(201).send(result);
  }));

  app.delete("/blocks/:username", { preHandler: AUTH }, handle(async (req) => {
    const username = cleanText(req.params.username, 24);
    return sqlUnblockUser(req.auth.userId, username);
  }));

  /* ---------------------------------------------------------------------- DM */
  app.get("/dm", { preHandler: AUTH }, handle(async (req) => {
    return { ok: true, conversations: await sqlListConversations(req.auth.userId, req.query?.limit) };
  }));

  app.post("/dm", { preHandler: AUTH }, handle(async (req, reply) => {
    const username = cleanText(body(req).username, 24);
    if (!username) return fail(reply, 400, "invalid_username", "Username is required.");
    const conversation = await sqlOpenConversation(req.auth.userId, username);
    return reply.code(201).send({ ok: true, conversation });
  }));

  app.get("/dm/:id/messages", { preHandler: AUTH }, handle(async (req) => {
    const messages = await sqlListDmMessages(
      req.auth.userId,
      req.params.id,
      req.query?.before,
      req.query?.limit
    );
    return { ok: true, messages };
  }));

  app.post("/dm/:id/messages", { preHandler: AUTH }, handle(async (req, reply) => {
    const payload = body(req);
    const message = await sqlSendDmMessage(req.auth.userId, req.params.id, payload.body, payload.attachment);
    const peerId = await sqlConversationPeerId(req.auth.userId, req.params.id);
    const text = String(message.body || "");
    const handles = [...new Set([...text.matchAll(/@([\p{L}\p{N}_-]{3,24})/gu)].map((m) => m[1].toLowerCase()))].slice(0, 5);
    let mentionedPeer = false;
    for (const handle of handles) {
      const user = await sqlFindUserByUsername(handle);
      if (user && String(user.id) === String(peerId)) mentionedPeer = true;
    }
    notify(req, peerId, "dm_message", message);
    await deliverNotice(req.server, peerId, {
      kind: mentionedPeer ? "mention" : "dm_message",
      title: mentionedPeer
        ? `${req.auth.username || "کاربر"} در پیام خصوصی به تو منشن داد`
        : `پیام تازه از ${req.auth.username || "کاربر"}`,
      body: text.slice(0, 120),
      link: "social.html#messages",
      dedupeKey: `dm:${message.id}`,
      dedupeWindowMs: 10 * 60_000
    });
    return reply.code(201).send({ ok: true, message });
  }));

  app.patch("/dm/messages/:messageId", { preHandler: AUTH }, handle(async (req) => {
    const message = await sqlEditDmMessage(req.auth.userId, req.params.messageId, body(req).body);
    const peerId = await sqlDmMessagePeerId(req.auth.userId, req.params.messageId);
    notify(req, peerId, "dm_message_updated", {
      id: message.id,
      conversationId: message.conversationId,
      body: message.body,
      editedAt: message.editedAt
    });
    return { ok: true, message };
  }));

  app.delete("/dm/messages/:messageId", { preHandler: AUTH }, handle(async (req) => {
    const peerId = await sqlDmMessagePeerId(req.auth.userId, req.params.messageId);
    const result = await sqlDeleteDmMessage(req.auth.userId, req.params.messageId);
    notify(req, peerId, "dm_message_deleted", { id: String(req.params.messageId) });
    return result;
  }));

  app.post("/dm/messages/:messageId/reactions", { preHandler: AUTH }, handle(async (req, reply) => {
    const emoji = cleanText(body(req).emoji, 32);
    const peerId = await sqlDmMessagePeerId(req.auth.userId, req.params.messageId);
    const result = await sqlAddDmReaction(req.auth.userId, req.params.messageId, emoji);
    notify(req, peerId, "dm_reaction", {
      messageId: String(req.params.messageId),
      reactions: await sqlDmMessageReactions(peerId, req.params.messageId)
    });
    return reply.code(201).send(result);
  }));

  app.delete("/dm/messages/:messageId/reactions/:emoji", { preHandler: AUTH }, handle(async (req) => {
    const emoji = cleanText(req.params.emoji, 32);
    const peerId = await sqlDmMessagePeerId(req.auth.userId, req.params.messageId);
    const result = await sqlRemoveDmReaction(req.auth.userId, req.params.messageId, emoji);
    notify(req, peerId, "dm_reaction", {
      messageId: String(req.params.messageId),
      reactions: await sqlDmMessageReactions(peerId, req.params.messageId)
    });
    return result;
  }));

  app.post("/dm/:id/read", { preHandler: AUTH }, handle(async (req) => {
    const result = await sqlMarkConversationRead(req.auth.userId, req.params.id);
    const peerId = await sqlConversationPeerId(req.auth.userId, req.params.id);
    notify(req, peerId, "dm_read", { conversationId: req.params.id, readerId: req.auth.userId, lastReadAt: result.lastReadAt });
    return result;
  }));

  app.post("/dm/:id/mute", { preHandler: AUTH }, handle(async (req) => {
    const muted = Boolean(body(req).muted);
    const conversation = await sqlSetConversationPref(req.auth.userId, req.params.id, { muted });
    return { ok: true, conversation };
  }));

  app.post("/dm/:id/archive", { preHandler: AUTH }, handle(async (req) => {
    const archived = Boolean(body(req).archived);
    const conversation = await sqlSetConversationPref(req.auth.userId, req.params.id, { archived });
    return { ok: true, conversation };
  }));

  /* ------------------------------------------------------------------ search */
  app.get("/search", { preHandler: AUTH }, handle(async (req) => {
    const result = await sqlSearch(req.auth.userId, {
      q: req.query?.q,
      type: req.query?.type,
      page: req.query?.page,
      limit: req.query?.limit,
      sort: req.query?.sort,
      filter: req.query?.filter
    });
    return { ok: true, ...result };
  }));

  /* ----------------------------------------------------------------- reports */
  app.post("/reports", { preHandler: AUTH }, handle(async (req, reply) => {
    const payload = body(req);
    const report = await sqlCreateReport(req.auth.userId, {
      targetType: payload.targetType,
      targetId: payload.targetId,
      category: payload.category,
      details: payload.details,
      evidence: payload.evidence
    });
    await audit("report.create", req, {
      targetType: "report",
      targetId: report.id,
      meta: { targetType: report.targetType, targetId: report.targetId, category: report.category }
    });
    return reply.code(201).send({ ok: true, report });
  }));

  app.get("/reports/mine", { preHandler: AUTH }, handle(async (req) => {
    return { ok: true, reports: await sqlListMyReports(req.auth.userId, req.query?.limit) };
  }));

  app.get("/reports", { preHandler: AUTH }, handle(async (req) => {
    const result = await sqlListReports(req.auth.role, {
      status: req.query?.status,
      limit: req.query?.limit,
      offset: req.query?.offset
    });
    return { ok: true, ...result };
  }));

  app.get("/reports/:id", { preHandler: AUTH }, handle(async (req) => {
    const report = await sqlGetReport(req.auth.userId, req.auth.role, req.params.id);
    return { ok: true, report };
  }));

  app.patch("/reports/:id", { preHandler: AUTH }, handle(async (req) => {
    const payload = body(req);
    const report = await sqlPatchReport(req.auth.userId, req.auth.role, req.params.id, {
      status: payload.status,
      resolution: payload.resolution,
      note: payload.note,
      assignedTo: payload.assignedTo
    });
    await audit("report.update", req, {
      targetType: "report",
      targetId: req.params.id,
      meta: { status: report.status, note: Boolean(cleanText(payload.note, 2000)) }
    });
    const reporterId = report.reporter?.id || report.reporterId;
    if (reporterId && String(reporterId) !== String(req.auth.userId)) {
      const labels = { open: "باز", reviewing: "در حال بررسی", resolved: "حل شد", dismissed: "رد شد" };
      await deliverNotice(req.server, reporterId, {
        kind: "moderation",
        title: "گزارش تو به‌روزرسانی شد",
        body: `وضعیت گزارش: ${labels[report.status] || report.status}${report.resolution ? ` — ${report.resolution}` : ""}`,
        link: "social.html#reports",
        dedupeKey: `moderation:${report.id}:${report.status}`,
        dedupeWindowMs: 60 * 60_000
      });
      if (report.assignedTo) {
        await deliverNotice(req.server, report.assignedTo, {
          kind: "moderation",
          title: "گزارش به تو ارجاع شد",
          body: `گزارش ${report.targetType} · وضعیت ${labels[report.status] || report.status}`,
          link: "social.html#reports",
          dedupeKey: `moderation_assign:${report.id}:${report.assignedTo}`,
          dedupeWindowMs: 60 * 60_000
        });
      }
    }
    return { ok: true, report };
  }));

  /* ----------------------------------------------------------------- invites */
  app.post("/invites", { preHandler: AUTH }, handle(async (req, reply) => {
    const payload = body(req);
    const invite = await sqlCreateInvite(req.auth.userId, req.auth.role, {
      roomCode: payload.roomCode,
      serverId: payload.serverId,
      expiresInHours: payload.expiresInHours,
      maxUses: payload.maxUses
    });
    await audit("invite.create", req, {
      targetType: "invite",
      targetId: invite.id,
      meta: { roomCode: invite.roomCode, maxUses: invite.maxUses }
    });
    return reply.code(201).send({ ok: true, invite });
  }));

  app.get("/invites", { preHandler: AUTH }, handle(async (req) => {
    return { ok: true, invites: await sqlListInvites(req.auth.userId, req.query?.limit) };
  }));

  app.delete("/invites/:id", { preHandler: AUTH }, handle(async (req) => {
    const invite = await sqlRevokeInvite(req.auth.userId, req.params.id);
    await audit("invite.revoke", req, { targetType: "invite", targetId: invite.id });
    return { ok: true, invite };
  }));

  app.post("/invites/accept", { preHandler: AUTH }, handle(async (req) => {
    const result = await sqlAcceptInvite(req.auth.userId, body(req).code);
    await audit("invite.accept", req, {
      targetType: "invite",
      targetId: result.invite.id,
      meta: { roomCode: result.roomCode }
    });
    if (result.inviterId && String(result.inviterId) !== String(req.auth.userId)) {
      await deliverNotice(req.server, result.inviterId, {
        kind: "room_invite",
        title: "دعوتت قبول شد",
        body: `${req.auth.username || "کاربر"} با لینک دعوت به «${result.roomName || result.roomCode}» پیوست.`,
        link: "social.html#rooms",
        dedupeKey: `invite_accept:${result.invite.id}`,
        dedupeWindowMs: 60 * 60_000,
        room: result.roomCode
      });
    }
    return { ok: true, ...result };
  }));

  /* ----------------------------------------------------------------- history */
  app.get("/history", { preHandler: AUTH }, handle(async (req) => {
    return { ok: true, history: await sqlListHistory(req.auth.userId, req.query?.limit) };
  }));

  app.post("/history", { preHandler: AUTH }, handle(async (req, reply) => {
    const payload = body(req);
    const item = await sqlUpsertHistory(req.auth.userId, {
      mediaUrl: payload.mediaUrl,
      title: payload.title,
      position: payload.position,
      duration: payload.duration,
      roomId: payload.roomId
    });
    return reply.code(201).send({ ok: true, item });
  }));

  app.delete("/history/:id", { preHandler: AUTH }, handle(async (req) => {
    return sqlDeleteHistory(req.auth.userId, req.params.id);
  }));

  app.delete("/history", { preHandler: AUTH }, handle(async (req) => {
    return sqlClearHistory(req.auth.userId);
  }));

  /* ------------------------------------------------------------------- polls */
  app.get("/polls", { preHandler: AUTH }, handle(async (req) => {
    const polls = await sqlListPolls(req.auth.userId, req.auth.role, req.query?.room);
    return { ok: true, polls };
  }));

  app.post("/polls", { preHandler: AUTH }, handle(async (req, reply) => {
    const payload = body(req);
    const poll = await sqlCreatePoll(req.auth.userId, req.auth.role, {
      roomCode: payload.roomCode,
      question: payload.question,
      options: payload.options,
      multi: Boolean(payload.multi),
      anonymous: payload.anonymous === undefined ? true : Boolean(payload.anonymous),
      closesInMinutes: payload.closesInMinutes
    });
    notify(req, poll.createdBy, "poll_update", poll);
    await broadcastPoll(req, poll, { notifyCreate: true });
    await audit("poll.create", req, { targetType: "poll", targetId: poll.id, meta: { roomCode: poll.roomCode } });
    return reply.code(201).send({ ok: true, poll });
  }));

  app.post("/polls/:id/vote", { preHandler: AUTH }, handle(async (req) => {
    const poll = await sqlVotePoll(req.auth.userId, req.auth.role, req.params.id, body(req).optionIds);
    await broadcastPoll(req, poll);
    return { ok: true, poll };
  }));

  app.post("/polls/:id/close", { preHandler: AUTH }, handle(async (req) => {
    const poll = await sqlClosePoll(req.auth.userId, req.auth.role, req.params.id);
    await broadcastPoll(req, poll);
    await audit("poll.close", req, { targetType: "poll", targetId: poll.id });
    return { ok: true, poll };
  }));

  app.delete("/polls/:id", { preHandler: AUTH }, handle(async (req) => {
    const result = await sqlDeletePoll(req.auth.userId, req.auth.role, req.params.id);
    const poll = result?.poll;
    if (poll) await broadcastPoll(req, poll, { event: "poll_removed" });
    await audit("poll.delete", req, { targetType: "poll", targetId: req.params.id });
    return result;
  }));

  /* ----------------------------------------------------------------- library */
  app.get("/library", { preHandler: AUTH }, handle(async (req) => {
    return { ok: true, items: await sqlListLibrary(req.auth.userId, req.query?.kind, req.query?.limit) };
  }));

  app.post("/library", { preHandler: AUTH }, handle(async (req, reply) => {
    const payload = body(req);
    const item = await sqlAddLibraryItem(req.auth.userId, {
      kind: payload.kind,
      title: payload.title,
      url: payload.url,
      meta: payload.meta
    });
    return reply.code(201).send({ ok: true, item });
  }));

  app.delete("/library/:id", { preHandler: AUTH }, handle(async (req) => {
    return sqlDeleteLibraryItem(req.auth.userId, req.params.id);
  }));

  /* ----------------------------------------------------------------- support */
  const TICKET_STATUS_FA = { open: "باز", pending: "در انتظار پاسخ", resolved: "حل شد", closed: "بسته" };
  const TICKET_PRIORITY_FA = { low: "کم", normal: "معمولی", high: "زیاد", urgent: "فوری" };

  app.get("/support/agents", { preHandler: AUTH }, handle(async (req, reply) => {
    if (!isStaff(req.auth.role)) return fail(reply, 403, "forbidden", "Only support staff can list agents.");
    return { ok: true, agents: await sqlListSupportAgents() };
  }));

  app.get("/support/tickets", { preHandler: AUTH }, handle(async (req) => {
    const tickets = await sqlListTickets(req.auth.userId, req.auth.role, {
      status: req.query?.status,
      limit: req.query?.limit,
      offset: req.query?.offset
    });
    return { ok: true, tickets };
  }));

  app.post("/support/tickets", { preHandler: AUTH }, handle(async (req, reply) => {
    const payload = body(req);
    const ticket = await sqlCreateTicket(req.auth.userId, {
      subject: payload.subject,
      category: payload.category,
      priority: payload.priority,
      body: payload.body,
      attachment: payload.attachment
    });
    const staffIds = (await sqlListStaffIds()).filter((id) => String(id) !== String(req.auth.userId));
    await deliverNoticeMany(req.server, staffIds, () => ({
      kind: "support_new",
      title: "تیکت تازه در پشتیبانی",
      body: `${req.auth.username || "کاربر"}: ${ticket.subject}`,
      link: "social.html#support",
      dedupeKey: `support_new:${ticket.id}`,
      dedupeWindowMs: 60 * 60_000
    }));
    await audit("support.create", req, { targetType: "support_ticket", targetId: ticket.id, meta: { category: ticket.category } });
    return reply.code(201).send({ ok: true, ticket });
  }));

  app.get("/support/tickets/:id", { preHandler: AUTH }, handle(async (req) => {
    const ticket = await sqlGetTicket(req.auth.userId, req.auth.role, req.params.id);
    return { ok: true, ticket };
  }));

  app.post("/support/tickets/:id/messages", { preHandler: AUTH }, handle(async (req, reply) => {
    const payload = body(req);
    const ticket = await sqlAddTicketMessage(req.auth.userId, req.auth.role, req.params.id, payload.body, payload.attachment);
    const ownerId = ticket.user?.id;
    const staffReply = isStaff(req.auth.role) && String(ownerId) !== String(req.auth.userId);
    if (staffReply) {
      await deliverNotice(req.server, ownerId, {
        kind: "support_update",
        title: "پاسخ تازه در تیکت پشتیبانی",
        body: `${ticket.subject}: ${String(payload.body || "پیوست تازه").slice(0, 120)}`,
        link: "social.html#support",
        dedupeKey: `support_msg:${ticket.id}:${ticket.messages?.length || 0}`,
        dedupeWindowMs: 10 * 60_000
      });
      notify(req, ownerId, "support_reply", { ticketId: ticket.id });
    } else {
      const targets = ticket.assignedTo
        ? [ticket.assignedTo]
        : (await sqlListStaffIds());
      await deliverNoticeMany(req.server, targets.filter((id) => String(id) !== String(req.auth.userId)), () => ({
        kind: "support_update",
        title: "پیام تازه از کاربر در پشتیبانی",
        body: `${ticket.subject}: ${String(payload.body || "پیوست تازه").slice(0, 120)}`,
        link: "social.html#support",
        dedupeKey: `support_user_msg:${ticket.id}`,
        dedupeWindowMs: 10 * 60_000
      }));
      if (ticket.assignedTo) notify(req, ticket.assignedTo, "support_reply", { ticketId: ticket.id });
    }
    return reply.code(201).send({ ok: true, ticket });
  }));

  app.patch("/support/tickets/:id", { preHandler: AUTH }, handle(async (req) => {
    const payload = body(req);
    const result = await sqlPatchTicket(req.auth.userId, req.auth.role, req.params.id, {
      status: payload.status,
      priority: payload.priority,
      assignedTo: payload.assignedTo,
      resolution: payload.resolution
    });
    const { events, ...ticket } = result;
    const ownerId = ticket.user?.id;
    if (events.statusChanged && ownerId && String(ownerId) !== String(req.auth.userId)) {
      await deliverNotice(req.server, ownerId, {
        kind: "support_update",
        title: "وضعیت تیکت پشتیبانی تغییر کرد",
        body: `${ticket.subject}: ${TICKET_STATUS_FA[ticket.status] || ticket.status}`,
        link: "social.html#support",
        dedupeKey: `support_status:${ticket.id}:${ticket.status}`,
        dedupeWindowMs: 15 * 60_000
      });
    }
    if (events.assigneeChanged && events.assignedTo && String(events.assignedTo) !== String(req.auth.userId)) {
      await deliverNotice(req.server, events.assignedTo, {
        kind: "support_update",
        title: "تیکت پشتیبانی به تو ارجاع شد",
        body: `${ticket.subject} · اولویت ${TICKET_PRIORITY_FA[ticket.priority] || ticket.priority}`,
        link: "social.html#support",
        dedupeKey: `support_assign:${ticket.id}:${events.assignedTo}`,
        dedupeWindowMs: 60 * 60_000
      });
    }
    await audit("support.update", req, {
      targetType: "support_ticket",
      targetId: ticket.id,
      meta: { status: ticket.status, priority: ticket.priority, assignedTo: ticket.assignedTo }
    });
    return { ok: true, ticket, events };
  }));

  /* ----------------------------------------------------------- notifications */
  app.get("/notification-prefs", { preHandler: AUTH }, handle(async (req) => {
    return { ok: true, ...(await sqlGetNotificationPrefs(req.auth.userId)) };
  }));

  app.put("/notification-prefs", { preHandler: AUTH }, handle(async (req) => {
    const payload = body(req);
    const prefs = await sqlPutNotificationPrefs(req.auth.userId, {
      prefs: payload.prefs,
      quietFrom: payload.quietFrom,
      quietTo: payload.quietTo
    });
    return { ok: true, ...prefs };
  }));

  app.get("/notifications", { preHandler: AUTH }, handle(async (req) => {
    const unreadFlag = String(req.query?.unread || "") === "1" || String(req.query?.unread || "") === "true";
    const result = await sqlListNotifications(req.auth.userId, {
      unread: unreadFlag,
      limit: req.query?.limit,
      before: req.query?.before
    });
    return { ok: true, ...result };
  }));

  app.post("/notifications/read", { preHandler: AUTH }, handle(async (req) => {
    return sqlMarkNotificationsRead(req.auth.userId, body(req).ids);
  }));

  app.post("/notifications/read-all", { preHandler: AUTH }, handle(async (req) => {
    return sqlMarkAllNotificationsRead(req.auth.userId);
  }));
}
