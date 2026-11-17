import { toast, validateMediaUrl, uid } from "./core.js";

const PREFIX = "wt";
const MAX_CHAT = 400;

const ICE = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:global.stun.twilio.com:3478" },
    { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" }
  ],
  sdpSemantics: "unified-plan"
};

export const peerIdFor = (code) => `${PREFIX}${code.toUpperCase()}`;

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Room network layer.
 * Host: authoritative for members, playback, chat, queue and settings.
 * Guest: sends commands to host and receives broadcasts.
 */
export class Net {
  constructor({ code, nick, isHost, password = "", roomName = "", capacity = 6, privacy = "public" }) {
    this.code = code.toUpperCase();
    this.nick = nick;
    this.isHost = isHost;
    this.password = password;
    this.roomName = roomName;
    this.capacity = capacity;
    this.privacy = privacy;

    this.peer = null;
    this.hostConn = null;
    this.conns = new Map(); // host: peerId -> DataConnection
    this.handlers = new Map();
    this.destroyed = false;
    this.selfId = null;
    this.role = isHost ? "owner" : "member";

    if (isHost) this.#initHostState();
    this.peer = null;
  }

  /* ---------- events ---------- */
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  }
  emit(type, data) {
    this.handlers.get(type)?.forEach((fn) => {
      try { fn(data); } catch (err) { console.error(err); }
    });
  }

  /* ---------- host state ---------- */
  #initHostState() {
    this.room = {
      code: this.code,
      name: this.roomName || `Room ${this.code}`,
      capacity: this.capacity,
      privacy: this.privacy,
      control: "mods",
      locked: false,
      approval: false
    };
    this.members = new Map();
    this.banned = new Set();
    this.playback = { url: "", playing: false, time: 0, at: Date.now(), rate: 1, by: "" };
    this.chat = [];
    this.queue = [];
    this.pwdHash = null;
    if (this.privacy === "password" && this.password) {
      sha256(this.password).then((h) => { this.pwdHash = h; });
    }
  }

  /* ---------- lifecycle ---------- */
  async start() {
    this.emit("status", "connecting");
    if (this.isHost) return this.#startHost();
    return this.#startGuest();
  }

  #newPeer(id) {
    return new Promise((resolve, reject) => {
      const peer = id ? new Peer(id, { debug: 0, config: ICE }) : new Peer({ debug: 0, config: ICE });
      const t = setTimeout(() => reject(new Error("peer-timeout")), 15000);
      peer.on("open", (pid) => { clearTimeout(t); resolve({ peer, id: pid }); });
      peer.on("error", (err) => {
        clearTimeout(t);
        if (err?.type === "unavailable-id") reject(err);
      });
    });
  }

  async #startHost() {
    const wanted = peerIdFor(this.code);
    let peer, id;
    try {
      ({ peer, id } = await this.#newPeer(wanted));
    } catch (err) {
      this.emit("status", "offline");
      this.emit("error", err?.type === "unavailable-id" ? "code-taken" : "net");
      return;
    }
    this.peer = peer;
    this.selfId = peer.id;

    const owner = {
      id: peer.id,
      nick: this.nick,
      role: "owner",
      muted: false,
      voice: false,
      joinedAt: Date.now()
    };
    this.members.set(peer.id, owner);
    this.emit("status", "online");
    this.emit("welcome", this.#snapshot(owner));

    peer.on("connection", (conn) => this.#onIncoming(conn));
    peer.on("call", (call) => this.emit("incomingCall", call));
    peer.on("disconnected", () => {
      this.emit("status", "offline");
      try { peer.reconnect(); } catch {}
    });
    peer.on("error", (err) => {
      if (err?.type === "peer-unavailable") return;
      this.emit("error", "net");
    });
  }

  async #startGuest() {
    let peer, id;
    try {
      ({ peer, id } = await this.#newPeer(null));
    } catch { this.emit("status", "offline"); this.emit("error", "net"); return; }
    this.peer = peer;
    this.selfId = id;

    const conn = peer.connect(peerIdFor(this.code), { reliable: true, serialization: "json" });
    this.hostConn = conn;

    const failTimer = setTimeout(() => {
      if (!this.joined) {
        this.emit("status", "offline");
        this.emit("deny", "unreachable");
      }
    }, 16000);

    conn.on("open", async () => {
      const pwdHash = this.password ? await sha256(this.password) : null;
      conn.send({ t: "hello", nick: this.nick, pwdHash });
    });
    conn.on("data", (msg) => this.#onHostMessage(msg));
    conn.on("close", () => {
      clearTimeout(failTimer);
      this.emit("status", "offline");
      if (this.joined) this.emit("disconnected");
    });
    conn.on("error", () => {
      clearTimeout(failTimer);
      this.emit("status", "offline");
    });

    peer.on("call", (call) => this.emit("incomingCall", call));
    peer.on("error", (err) => {
      if (err?.type === "peer-unavailable") {
        clearTimeout(failTimer);
        this.emit("status", "offline");
        this.emit("deny", "not-found");
      }
    });
  }

  #onIncoming(conn) {
    conn.on("data", (msg) => this.#onGuestMessage(conn, msg));
    conn.on("close", () => this.#dropMember(conn.peer));
    conn.on("error", () => this.#dropMember(conn.peer));
  }

  #dropMember(peerId) {
    if (!this.members.has(peerId)) return;
    this.members.delete(peerId);
    this.conns.delete(peerId);
    this.#broadcastMembers();
    this.emit("voice", { id: peerId, on: false, left: true });
  }

  /* ---------- guest -> host ---------- */
  async #onGuestMessage(conn, msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "hello") return this.#handleHello(conn, msg);

    const member = this.members.get(conn.peer);
    if (!member) return;

    switch (msg.t) {
      case "chat": return this.#hostChat(member, msg);
      case "chatEdit": return this.#hostChatEdit(member, msg);
      case "chatDelete": return this.#hostChatDelete(member, msg);
      case "react": return this.#hostReact(member, msg);
      case "pin": return this.#hostPin(member, msg);
      case "typing": return this.#hostTyping(member);
      case "loadVideo": return this.#hostLoadVideo(member, msg.url);
      case "control": return this.#hostControl(member, msg);
      case "queueAdd": return this.#hostQueueAdd(member, msg.url);
      case "queueVote": return this.#hostQueueVote(member, msg.id);
      case "queuePlay": return this.#hostQueuePlay(member, msg.id);
      case "settings": return this.#hostSettings(member, msg.patch);
      case "mod": return this.#hostMod(member, msg);
      case "voice": return this.#hostVoice(member, !!msg.on);
      case "syncRequest": return this.#sendTo(conn.peer, { t: "playback", state: this.playback });
    }
  }

  async #handleHello(conn, msg) {
    const nick = String(msg.nick || "").trim().slice(0, 20) || "Guest";
    if (this.room.locked) return this.#deny(conn, "locked");
    if (this.banned.has(nick.toLowerCase())) return this.#deny(conn, "banned");
    if (this.members.size >= this.room.capacity) return this.#deny(conn, "full");
    if (this.pwdHash && msg.pwdHash !== this.pwdHash) return this.#deny(conn, "password");

    if (this.room.approval) {
      const ok = await new Promise((resolve) => {
        if (!this.pendingApprovals) this.pendingApprovals = new Map();
        this.pendingApprovals.set(conn.peer, resolve);
        this.emit("joinRequest", { peerId: conn.peer, nick });
        setTimeout(() => {
          if (this.pendingApprovals?.delete(conn.peer)) resolve(false);
        }, 45000);
      });
      if (!ok) return this.#deny(conn, "rejected");
    }

    let finalNick = nick;
    const existing = [...this.members.values()].map((m) => m.nick.toLowerCase());
    if (existing.includes(finalNick.toLowerCase())) {
      let i = 2;
      while (existing.includes(`${finalNick} ${i}`.toLowerCase())) i++;
      finalNick = `${finalNick} ${i}`;
    }

    const member = {
      id: conn.peer, nick: finalNick, role: "member",
      muted: false, voice: false, joinedAt: Date.now()
    };
    this.members.set(conn.peer, member);
    this.conns.set(conn.peer, conn);
    conn.send({ t: "welcome", ...this.#snapshot(member) });
    this.#broadcastMembers();
    this.emit("system", { key: "join", nick: finalNick });
  }

  #deny(conn, reason) {
    try { conn.send({ t: "deny", reason }); } catch {}
    setTimeout(() => { try { conn.close(); } catch {} }, 120);
  }

  #snapshot(member) {
    return {
      self: { id: member.id, nick: member.nick, role: member.role },
      room: { ...this.room },
      members: [...this.members.values()].map((m) => ({ id: m.id, nick: m.nick, role: m.role, muted: m.muted, voice: m.voice })),
      playback: this.playback,
      chat: this.chat,
      queue: this.queue
    };
  }

  #broadcastMembers() {
    const members = [...this.members.values()].map((m) => ({ id: m.id, nick: m.nick, role: m.role, muted: m.muted, voice: m.voice }));
    this.#broadcast({ t: "members", members });
    this.emit("members", members);
  }

  #broadcast(msg, exceptId = null) {
    for (const [id, conn] of this.conns) {
      if (id === exceptId) continue;
      try { if (conn.open) conn.send(msg); } catch {}
    }
  }
  #sendTo(id, msg) {
    const conn = this.conns.get(id);
    try { if (conn?.open) conn.send(msg); } catch {}
    return !!(conn?.open);
  }

  canControl(member) {
    if (!member) return false;
    if (member.role === "owner") return true;
    if (this.room.control === "all") return true;
    if (this.room.control === "mods" && member.role === "mod") return true;
    return false;
  }
  isMod(member) { return member?.role === "owner" || member?.role === "mod"; }

  #hostChat(member, msg) {
    const text = String(msg.text || "").slice(0, 500).trim();
    if (!text) return;
    const last = member.lastChatAt || 0;
    if (Date.now() - last < 500) return;
    member.lastChatAt = Date.now();
    const entry = {
      id: uid(), by: member.id, nick: member.nick, role: member.role,
      text, at: Date.now(), replyTo: msg.replyTo || null,
      edited: false, deleted: false, pinned: false, reactions: {}
    };
    this.chat.push(entry);
    if (this.chat.length > MAX_CHAT) this.chat.shift();
    this.#broadcast({ t: "chat", msg: entry });
    this.emit("chat", entry);
  }

  #hostChatEdit(member, msg) {
    const entry = this.chat.find((m) => m.id === msg.id);
    if (!entry || entry.by !== member.id || entry.deleted) return;
    const text = String(msg.text || "").slice(0, 500).trim();
    if (!text) return;
    entry.text = text; entry.edited = true;
    this.#broadcast({ t: "chatUpdate", msg: entry });
  }

  #hostChatDelete(member, msg) {
    const entry = this.chat.find((m) => m.id === msg.id);
    if (!entry) return;
    if (entry.by !== member.id && !this.isMod(member)) return;
    entry.deleted = true; entry.text = "";
    this.#broadcast({ t: "chatUpdate", msg: entry });
  }

  #hostReact(member, msg) {
    const entry = this.chat.find((m) => m.id === msg.id);
    if (!entry) return;
    const emoji = String(msg.emoji || "").slice(0, 8);
    if (!emoji) return;
    const list = entry.reactions[emoji] || (entry.reactions[emoji] = []);
    const idx = list.indexOf(member.id);
    if (idx >= 0) list.splice(idx, 1); else list.push(member.id);
    if (!list.length) delete entry.reactions[emoji];
    this.#broadcast({ t: "chatUpdate", msg: entry });
  }

  #hostPin(member, msg) {
    if (!this.isMod(member)) return;
    const entry = this.chat.find((m) => m.id === msg.id);
    if (!entry) return;
    entry.pinned = !entry.pinned;
    this.#broadcast({ t: "chatUpdate", msg: entry });
  }

  #hostTyping(member) {
    this.#broadcast({ t: "typing", id: member.id, nick: member.nick }, member.id);
  }

  #hostLoadVideo(member, url) {
    if (!this.canControl(member)) return this.#sendTo(member.id, { t: "denied", reason: "control" });
    const v = validateMediaUrl(url);
    if (!v.ok) return this.#sendTo(member.id, { t: "denied", reason: v.reason });
    this.playback = { url: v.url, playing: false, time: 0, at: Date.now(), rate: 1, by: member.nick };
    this.#broadcast({ t: "playback", state: this.playback });
    this.emit("playback", this.playback);
  }

  #hostControl(member, msg) {
    if (!this.canControl(member)) return this.#sendTo(member.id, { t: "denied", reason: "control" });
    const p = { ...this.playback };
    switch (msg.action) {
      case "play": p.playing = true; p.at = Date.now(); break;
      case "pause": p.time = Number(msg.time) || 0; p.playing = false; p.at = Date.now(); break;
      case "seek": p.time = Math.max(0, Number(msg.time) || 0); p.at = Date.now(); break;
      case "rate": p.rate = Number(msg.value) || 1; p.time = Number(msg.time) || p.time; p.at = Date.now(); break;
      case "sync": break;
      default: return;
    }
    p.by = member.nick;
    this.playback = p;
    this.#broadcast({ t: "playback", state: p });
    this.emit("playback", p);
  }

  #hostQueueAdd(member, url) {
    const v = validateMediaUrl(url);
    if (!v.ok) return this.#sendTo(member.id, { t: "denied", reason: v.reason });
    if (this.queue.some((q) => q.url === v.url)) return;
    this.queue.push({ id: uid(), url: v.url, by: member.nick, votes: [member.id], at: Date.now() });
    this.#broadcast({ t: "queue", items: this.queue });
    this.emit("queue", this.queue);
  }

  #hostQueueVote(member, id) {
    const item = this.queue.find((q) => q.id === id);
    if (!item) return;
    const i = item.votes.indexOf(member.id);
    if (i >= 0) item.votes.splice(i, 1); else item.votes.push(member.id);
    this.#broadcast({ t: "queue", items: this.queue });
    this.emit("queue", this.queue);
  }

  #hostQueuePlay(member, id) {
    if (!this.canControl(member)) return this.#sendTo(member.id, { t: "denied", reason: "control" });
    const item = this.queue.find((q) => q.id === id);
    if (!item) return;
    this.playback = { url: item.url, playing: false, time: 0, at: Date.now(), rate: 1, by: member.nick };
    this.#broadcast({ t: "playback", state: this.playback });
    this.emit("playback", this.playback);
  }

  #hostSettings(member, patch) {
    if (member.role !== "owner" || !patch) return;
    const allowed = ["control", "locked", "approval", "capacity"];
    for (const k of allowed) {
      if (k in patch) {
        if (k === "capacity") this.room.capacity = Math.min(24, Math.max(2, Number(patch[k]) || 6));
        else if (k === "control") this.room.control = ["host", "mods", "all"].includes(patch[k]) ? patch[k] : this.room.control;
        else this.room[k] = !!patch[k];
      }
    }
    this.#broadcast({ t: "room", room: this.room });
    this.emit("room", this.room);
  }

  #hostMod(member, msg) {
    if (!this.isMod(member)) return;
    const target = this.members.get(msg.target);
    if (!target || target.role === "owner") return;
    const action = msg.action;
    if (action === "promote" || action === "demote") {
      if (member.role !== "owner" && action === "promote") return;
      target.role = action === "promote" ? "mod" : "member";
      this.#broadcastMembers();
      return;
    }
    if (target.role === "mod" && member.role !== "owner") return;
    if (action === "mute") {
      target.muted = !target.muted;
      this.#sendTo(target.id, { t: "forceMute", muted: target.muted });
      this.#broadcastMembers();
      return;
    }
    if (action === "kick" || action === "ban") {
      if (action === "ban") this.banned.add(target.nick.toLowerCase());
      this.#sendTo(target.id, { t: "kicked", reason: action, by: member.nick });
      setTimeout(() => { try { this.conns.get(target.id)?.close(); } catch {} }, 150);
      this.#dropMember(target.id);
    }
  }

  #hostVoice(member, on) {
    if (member.muted && on) return;
    member.voice = on;
    this.#broadcast({ t: "voice", id: member.id, on, nick: member.nick });
    this.emit("voice", { id: member.id, on, nick: member.nick });
    this.#broadcastMembers();
  }

  /* ---------- host receive ---------- */
  #onHostMessage(msg) {
    switch (msg.t) {
      case "welcome":
        this.joined = true;
        this.self = msg.self;
        this.role = msg.role || msg.self?.role || "member";
        this.roomState = msg.room;
        this.emit("status", "online");
        this.emit("welcome", msg);
        this.emit("members", msg.members);
        break;
      case "deny":
        this.emit("status", "offline");
        this.emit("deny", msg.reason);
        break;
      case "members":
        this.members = msg.members;
        this.emit("members", msg.members);
        break;
      case "chat":
        this.emit("chat", msg.msg);
        break;
      case "chatUpdate":
        this.emit("chatUpdate", msg.msg);
        break;
      case "typing":
        this.emit("typing", { id: msg.id, nick: msg.nick });
        break;
      case "playback":
        this.emit("playback", msg.state);
        break;
      case "room":
        this.roomState = msg.room;
        if (this.self && msg.room) {
          const me = this.self;
          // role changes come through members; keep self.role in sync there
        }
        this.emit("room", msg.room);
        break;
      case "queue":
        this.emit("queue", msg.items);
        break;
      case "kick":
      case "kicked":
        this.emit("kicked", msg.reason);
        break;
      case "denied":
        this.emit("denied", msg.reason);
        break;
      case "forceMute":
        this.emit("forceMute", msg.muted);
        break;
      case "voice":
        this.emit("voice", { id: msg.id, on: msg.on, nick: msg.nick });
        break;
      default:
        break;
    }
  }

  /* ---------- unified command API ---------- */
  command(type, payload = {}) {
    if (this.isHost) {
      const me = this.members.get(this.selfId);
      if (!me) return;
      this.#applyLocal(me, type, payload);
      return;
    }
    try { this.hostConn?.send({ t: type, ...payload }); } catch {}
  }

  #applyLocal(me, type, payload) {
    const fn = {
      chat: () => this.#hostChat(me, payload),
      chatEdit: () => this.#hostChatEdit(me, payload),
      chatDelete: () => this.#hostChatDelete(me, payload),
      react: () => this.#hostReact(me, payload),
      pin: () => this.#hostPin(me, payload),
      typing: () => { this.#broadcast({ t: "typing", id: me.id, nick: me.nick }); this.emit("typing", { id: me.id, nick: me.nick, self: true }); },
      loadVideo: () => this.#hostLoadVideo(me, payload.url),
      control: () => this.#hostControl(me, payload),
      queueAdd: () => this.#hostQueueAdd(me, payload.url),
      queueVote: () => this.#hostQueueVote(me, payload.id),
      queuePlay: () => this.#hostQueuePlay(me, payload.id),
      settings: () => this.#hostSettings(me, payload.patch),
      mod: () => this.#hostMod(me, payload),
      voice: () => this.#hostVoice(me, !!payload.on)
    }[type];
    fn?.();
  }

  approve(peerId, ok) {
    const resolve = this.pendingApprovals?.get(peerId);
    if (!resolve) return;
    this.pendingApprovals.delete(peerId);
    resolve(!!ok);
  }

  call(peerId, stream) {
    if (!this.peer) return null;
    return this.peer.call(peerId, stream, { metadata: { nick: this.nick } });
  }

  destroy() {
    this.destroyed = true;
    try { this.peer?.destroy(); } catch {}
  }
}
