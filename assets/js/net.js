import { validateMediaUrl, uid } from "./core.js";
import { avatarId } from "./avatars.js";

const DEFAULT_SIGNAL_BASE = "https://ntfy.sh";
const SIGNAL_BASE = (() => {
  try {
    const q = new URLSearchParams(location.search).get("signal");
    if (q) return q.replace(/\/+$/, "");
    const saved = localStorage.getItem("wt.signal");
    if (saved) return saved.replace(/\/+$/, "");
  } catch {}
  return DEFAULT_SIGNAL_BASE;
})();
const MAX_CHAT = 400;
const JOIN_RETRY_MS = 2500;
const JOIN_MAX_TRIES = 9;
const PRESENCE_MS = 30000;
const AVATAR_RE = /^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/;
const LIVE_REACTIONS = ["❤️", "😂", "😮", "👏", "🔥", "🍿"];

function cleanAvatar(value) {
  const id = avatarId(value);
  if (id) return `preset:${id}`;
  const s = typeof value === "string" ? value : "";
  return s.length <= 500000 && AVATAR_RE.test(s) ? s : "";
}

const ICE = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" }
  ]
};

async function sha256hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function waitIceGathering(pc, timeout = 4000) {
  return new Promise((resolve) => {
    if (!pc || pc.iceGatheringState === "complete") return resolve();
    const check = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", check);
    setTimeout(resolve, timeout);
  });
}

async function topicFor(code) {
  const h = await sha256hex(`watch-together:${code.toUpperCase()}`);
  return `wt${h.slice(0, 24)}`;
}

/* ---------- signaling transport (ntfy public instance, no account) ---------- */
class Signal {
  constructor(topic) {
    this.topic = topic;
    this.es = null;
    this.handlers = new Set();
    this.closed = false;
    this.ready = false;
  }

  on(fn) { this.handlers.add(fn); }

  start() {
    return new Promise((resolve) => {
      const done = () => { if (!this.ready) { this.ready = true; resolve(true); } };
      try {
        this.es = new EventSource(`${SIGNAL_BASE}/${this.topic}/sse`);
      } catch { resolve(false); return; }
      this.es.addEventListener("open", done);
      this.es.addEventListener("error", () => {
        if (!this.ready) { setTimeout(done, 2500); } else if (this.es.readyState === 2 && !this.closed) {
          setTimeout(() => this.#reconnect(), 2000);
        }
      });
      this.es.addEventListener("message", (e) => {
        done();
        let outer;
        try { outer = JSON.parse(e.data); } catch { return; }
        if (outer.event !== "message" || !outer.message) return;
        let msg;
        try { msg = JSON.parse(outer.message); } catch { return; }
        this.handlers.forEach((fn) => { try { fn(msg); } catch {} });
      });
      setTimeout(done, 6000);
    });
  }

  #reconnect() {
    if (this.closed || this.reconnectTimer) return;
    try { this.es?.close(); } catch {}
    this.ready = false;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start();
    }, 2000);
  }

  async send(obj) {
    if (this.closed) return false;
    try {
      const res = await fetch(`${SIGNAL_BASE}/${this.topic}`, {
        method: "POST",
        body: JSON.stringify(obj),
        headers: { "Content-Type": "text/plain" }
      });
      return res.ok;
    } catch { return false; }
  }

  close() {
    this.closed = true;
    try { this.es?.close(); } catch {}
  }
}

/* ---------- media connection shim (matches the shape voice.js expects) ---------- */
class MediaConn {
  constructor(net, peer, pc) {
    this.net = net;
    this.peer = peer;
    this.pc = pc;
    this.handlers = new Map();
  }
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  }
  emit(type, data) { this.handlers.get(type)?.forEach((fn) => { try { fn(data); } catch {} }); }
  answer(stream) { this.net.answerCall(this, stream); }
  close() {
    this.net.closeVoice?.(this.peer);
    try { this.pc.close(); } catch {}
    this.emit("close");
  }
}

/**
 * Room network layer over WebRTC.
 * Star topology for data (host <-> guests), mesh for voice.
 * Signaling goes through the public ntfy instance — no account, static-host friendly.
 */
export class Net {
  constructor({ code, nick, isHost, password = "", roomName = "", capacity = 6, privacy = "public", avatar = "" }) {
    this.code = code.toUpperCase();
    this.nick = nick;
    this.avatar = cleanAvatar(avatar);
    this.isHost = isHost;
    this.password = password;
    this.roomName = roomName;
    this.capacity = capacity;
    this.privacy = privacy;

    this.selfId = "";
    this.topic = "";
    this.signal = null;
    this.handlers = new Map();
    this.pcs = new Map();      // key "d:<peer>" | "v:<peer>" -> {pc, pending, remoteSet}
    this.conns = new Map();    // host: peerId -> {dc, pc}
    this.hostConn = null;      // guest: {dc, pc}
    this.hostId = null;
    this.dc = null;
    this.joined = false;
    this.destroyed = false;
    this.role = isHost ? "owner" : "member";
    this.joinTimer = null;
    this.joinTries = 0;
    this.presenceTimer = null;
    this.screenCalls = new Map();   // peerId -> RTCPeerConnection
    this.screenOffers = new Map();  // peerId -> remote offer sdp

    if (isHost) this.#initHostState();
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  }
  emit(type, data) {
    this.handlers.get(type)?.forEach((fn) => { try { fn(data); } catch (err) { console.error(err); } });
  }

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
    this.pendingApprovals = new Map();
    this.playback = { kind: "url", url: "", playing: false, time: 0, at: Date.now(), rate: 1, by: "" };
    this.chat = [];
    this.queue = [];
    this.pwdHash = null;
    this.localFile = null;
    this.fileRx = null;
    this.subs = null;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.emit("status", "connecting");
    this.selfId = (this.isHost ? "h" : "g") + uid().slice(0, 7);
    this.topic = await topicFor(this.code);
    this.signal = new Signal(this.topic);
    this.signal.on((msg) => this.#onSignal(msg));
    const ok = await this.signal.start();
    if (!ok) { this.emit("status", "offline"); this.emit("error", "net"); return; }
    if (this.isHost) {
      if (this.privacy === "password" && this.password) this.pwdHash = await sha256hex(this.password);
      this.#hostOnline();
    } else this.#guestJoin();
  }

  /* ================= host ================= */
  #hostOnline() {
    const owner = { id: this.selfId, nick: this.nick, avatar: this.avatar, role: "owner", muted: false, voice: false, joinedAt: Date.now() };
    this.members.set(this.selfId, owner);
    this.emit("status", "online");
    this.emit("welcome", this.#snapshot(owner));
    let fails = 0;
    let warned = false;
    const beat = async () => {
      const ok = await this.#sig({ k: "presence", from: this.selfId, nick: this.nick, host: true });
      if (this.destroyed) return;
      fails = ok ? 0 : fails + 1;
      if (fails >= 3) {
        this.emit("status", "offline");
        if (!warned) { warned = true; this.emit("error", "unreachable"); }
      } else if (ok && warned) {
        warned = false;
        this.emit("status", "online");
      }
    };
    beat();
    this.presenceTimer = setInterval(beat, PRESENCE_MS);
  }

  async #guestJoin() {
    let sendFails = 0;
    const giveUp = () => {
      if (this.joined || this.destroyed) return;
      this.emit("status", "offline");
      this.emit("deny", "unreachable");
    };
    clearTimeout(this.joinDeadline);
    this.joinDeadline = setTimeout(giveUp, 60000);
    const beat = async () => {
      if (this.joined || this.destroyed) return;
      if (this.joinTries++ > JOIN_MAX_TRIES) return giveUp();
      const ok = await this.#sig({
        k: "join", from: this.selfId, nick: this.nick,
        pwdHash: this.password ? await sha256hex(this.password) : null
      });
      if (this.joined || this.destroyed) return;
      sendFails = ok ? 0 : sendFails + 1;
      if (sendFails >= 4) return giveUp();
      this.joinTimer = setTimeout(beat, ok ? JOIN_RETRY_MS : Math.min(6000, 1500 * sendFails));
    };
    beat();
  }

  #sig(obj) {
    return this.signal.send(obj);
  }

  async #onSignal(msg) {
    if (!msg || msg.from === this.selfId) return;
    if (msg.to && msg.to !== this.selfId) return;

    switch (msg.k) {
      case "presence":
        if (!this.isHost && !this.hostId) {
          this.hostId = msg.from;
          if (!this.conns.get("host-pending")) { /* join loop already running */ }
        }
        return;
      case "join":
        if (this.isHost) return this.#hostHandleJoin(msg);
        return;
      case "deny":
        if (!this.isHost) {
          clearInterval(this.joinTimer);
          clearTimeout(this.joinDeadline);
          this.emit("status", "offline");
          this.emit("deny", msg.reason);
        }
        return;
      case "offer":
        if (!this.isHost) return this.#guestAcceptOffer(msg);
        return;
      case "answer":
        if (this.isHost) return this.#applyAnswer(msg);
        return;
      case "ice":
        return this.#addIce(msg);
      case "voff":
        return this.#voiceOffer(msg);
      case "vans":
        return this.#applyAnswer(msg);
      case "vice":
        return this.#addIce(msg);
      case "soff":
        return this.#screenOffer(msg);
      case "sans":
        return this.#applyAnswer(msg);
      case "sice":
        return this.#addIce(msg);
      case "bye":
        return this.#peerBye(msg);
      default:
        return;
    }
  }

  async #hostHandleJoin(msg) {
    const existing = this.conns.get(msg.from);
    if (existing) {
      if (existing.open) return;
      if (Date.now() - (existing.createdAt || 0) < 12000) return;
      try { existing.pc.close(); } catch {}
      this.conns.delete(msg.from);
      const old = this.pcs.get(`d:${msg.from}`);
      if (old) { try { old.pc.close(); } catch {} this.pcs.delete(`d:${msg.from}`); }
    }
    const nick = String(msg.nick || "").trim().slice(0, 20) || "Guest";
    if (this.room.locked) return this.#denyGuest(msg.from, "locked");
    if (this.banned.has(nick.toLowerCase())) return this.#denyGuest(msg.from, "banned");
    const guestCount = [...this.members.keys()].filter((id) => id !== this.selfId).length;
    if (guestCount >= this.room.capacity) return this.#denyGuest(msg.from, "full");
    if (this.pwdHash && msg.pwdHash !== this.pwdHash) return this.#denyGuest(msg.from, "password");

    if (this.room.approval) {
      if (!this.pendingApprovals.has(msg.from)) {
        const ok = await new Promise((resolve) => {
          this.pendingApprovals.set(msg.from, resolve);
          this.emit("joinRequest", { peerId: msg.from, nick });
          setTimeout(() => { if (this.pendingApprovals.delete(msg.from)) resolve(false); }, 45000);
        });
        if (!ok) return this.#denyGuest(msg.from, "rejected");
      }
    }

    const { pc } = this.#createPc(`d:${msg.from}`);
    const dc = pc.createDataChannel("wt", { ordered: true });
    this.#wireHostDc(msg.from, dc, pc, nick, cleanAvatar(msg.avatar));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIceGathering(pc);
    await this.#sig({ k: "offer", to: msg.from, from: this.selfId, sdp: pc.localDescription.sdp });
  }

  #wireHostDc(guestId, dc, pc, nick, avatar = "") {
    const conn = { dc, pc, peer: guestId, nick, avatar, hello: false, createdAt: Date.now() };
    dc.binaryType = "arraybuffer";
    this.conns.set(guestId, conn);
    dc.onopen = () => { conn.open = true; };
    dc.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this.#onGuestMessage(conn, msg);
    };
    dc.onclose = () => this.#dropMember(guestId);
    pc.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
        setTimeout(() => { if (!dc || dc.readyState !== "open") this.#dropMember(guestId); }, 4000);
      }
    };
  }

  #denyGuest(peerId, reason) {
    this.#sig({ k: "deny", to: peerId, from: this.selfId, reason });
  }

  async #guestAcceptOffer(msg) {
    const key = `d:${msg.from}`;
    if (this.pcs.has(key)) {
      if (this.dc?.readyState === "open") return;
      const rec = this.pcs.get(key);
      try { rec.pc.close(); } catch {}
      this.pcs.delete(key);
      this.dc = null;
    }
    const { pc } = this.#createPc(key);
    pc.ondatachannel = (e) => {
      this.dc = e.channel;
      e.channel.binaryType = "arraybuffer";
      const conn = { dc: e.channel, pc, peer: msg.from, open: false };
      this.hostConn = conn;
      e.channel.onopen = () => {
        conn.open = true;
        this.sendHello();
      };
      e.channel.onmessage = (ev) => {
        if (typeof ev.data !== "string") return this.#onFileChunk(ev.data);
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        this.#onHostMessage(m);
      };
      e.channel.onclose = () => {
        if (this.joined) this.emit("status", "offline");
        if (this.joined) this.emit("disconnected");
      };
    };
    await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
    this.#flushIce(`d:${msg.from}`);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIceGathering(pc);
    await this.#sig({ k: "answer", to: msg.from, from: this.selfId, sdp: pc.localDescription.sdp });
  }

  async #applyAnswer(msg) {
    const kind = msg.k === "vans" ? "v" : msg.k === "sans" ? "s" : "d";
    const key = `${kind}:${msg.from}`;
    const rec = this.pcs.get(key);
    if (!rec) return;
    if (rec.pc.signalingState === "have-local-offer") {
      await rec.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
      rec.remoteSet = true;
      this.#flushIce(key);
      if (msg.k === "vans") {
        const mc = this.voiceCalls?.get(msg.from);
        if (mc) mc.emit("connected");
      }
      if (msg.k === "sans") this.emit("screenConnected", msg.from);
    }
  }
  #createPc(key) {
    const pc = new RTCPeerConnection(ICE);
    const rec = { pc, pending: [], remoteSet: false };
    this.pcs.set(key, rec);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        this.emit("error", "net");
      }
    };
    return rec;
  }

  #addIce(msg) {
    const kind = msg.k === "vice" ? "v" : msg.k === "sice" ? "s" : "d";
    const key = `${kind}:${msg.from}`;
    const rec = this.pcs.get(key);
    const cand = msg.cand;
    if (!rec || !cand) return;
    if (rec.remoteSet) {
      rec.pc.addIceCandidate(cand).catch(() => {});
    } else {
      rec.pending.push(cand);
    }
  }

  #flushIce(key) {
    const rec = this.pcs.get(key);
    if (!rec) return;
    rec.pending.splice(0).forEach((c) => rec.pc.addIceCandidate(c).catch(() => {}));
  }

  #peerBye(msg) {
    const kind = msg.s ? "s" : msg.v ? "v" : "d";
    const key = `${kind}:${msg.from}`;
    const rec = this.pcs.get(key);
    if (rec) { try { rec.pc.close(); } catch {} this.pcs.delete(key); }
    if (kind === "s") {
      this.screenCalls.delete(msg.from);
      this.screenOffers.delete(msg.from);
      this.emit("screenEnded", msg.from);
    } else if (kind === "v") {
      const mc = this.voiceCalls?.get(msg.from);
      if (mc) { this.voiceCalls.delete(msg.from); mc.emit("close"); }
    }
  }

  /* ================= host message handling ================= */
  async #onGuestMessage(conn, msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "hello") return this.#handleHello(conn, msg);
    const member = this.members.get(conn.peer);
    if (!member) return;

    switch (msg.t) {
      case "chat": return this.#hostChat(member, msg);
      case "chatEdit": return this.#hostChatEdit(member, msg);
      case "chatDelete": return this.#hostChatDelete(member, msg);
      case "chatClear": return this.#hostChatClear(member);
      case "react": return this.#hostReact(member, msg);
      case "reaction": return this.#hostReaction(member, msg);
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
      case "fileRequest": return this.#hostFileSend(conn.peer, msg.id);
      case "syncRequest": return this.#sendTo(conn.peer, { t: "playback", state: this.playback });
      default: return;
    }
  }

  async #handleHello(conn, msg) {
    if (this.members.has(conn.peer)) {
      this.#sendTo(conn.peer, { t: "welcome", ...this.#snapshot(this.members.get(conn.peer)) });
      if (this.subs) this.#sendTo(conn.peer, { t: "subs", cues: this.subs });
      return;
    }
    const nick = String(msg.nick || conn.nick || "").trim().slice(0, 20) || "Guest";
    let finalNick = nick;
    const existing = [...this.members.values()].map((m) => m.nick.toLowerCase());
    if (existing.includes(finalNick.toLowerCase())) {
      let i = 2;
      while (existing.includes(`${finalNick} ${i}`.toLowerCase())) i++;
      finalNick = `${finalNick} ${i}`;
    }
    const member = { id: conn.peer, nick: finalNick, avatar: cleanAvatar(msg.avatar || conn.avatar), role: "member", muted: false, voice: false, joinedAt: Date.now() };
    this.members.set(conn.peer, member);
    this.#sendTo(conn.peer, { t: "welcome", ...this.#snapshot(member) });
    if (this.localFile) {
      const f = this.localFile;
      this.#sendTo(conn.peer, { t: "fileOffer", id: f.id, name: f.name, size: f.size });
    }
    if (this.subs) this.#sendTo(conn.peer, { t: "subs", cues: this.subs });
    this.#broadcastMembers();
    this.emit("system", { key: "join", nick: finalNick });
  }

  #snapshot(member) {
    return {
      self: { id: member.id, nick: member.nick, avatar: member.avatar || "", role: member.role },
      room: { ...this.room },
      members: this.#membersPublic(),
      playback: this.playback,
      chat: this.chat,
      queue: this.queue
    };
  }

  #membersPublic() {
    return [...this.members.values()].map((m) => ({ id: m.id, nick: m.nick, avatar: m.avatar || "", role: m.role, muted: m.muted, voice: m.voice }));
  }

  #broadcastMembers() {
    const members = this.#membersPublic();
    this.#broadcast({ t: "members", members });
    this.emit("members", members);
  }

  #sendTo(peerId, msg) {
    if (this.isHost) {
      const conn = this.conns.get(peerId);
      try { if (conn?.dc?.readyState === "open") conn.dc.send(JSON.stringify(msg)); } catch {}
      return;
    }
    try { if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(msg)); } catch {}
  }

  #broadcast(msg, exceptId = null) {
    if (!this.isHost) return;
    const data = JSON.stringify(msg);
    for (const [id, conn] of this.conns) {
      if (id === exceptId) continue;
      try { if (conn.dc?.readyState === "open") conn.dc.send(data); } catch {}
    }
  }

  #dropMember(peerId) {
    if (!this.members.has(peerId)) return;
    this.members.delete(peerId);
    this.conns.delete(peerId);
    const rec = this.pcs.get(`d:${peerId}`);
    if (rec) { try { rec.pc.close(); } catch {} this.pcs.delete(`d:${peerId}`); }
    this.#broadcastMembers();
    this.emit("voice", { id: peerId, on: false, left: true });
  }

  canControl(member) {
    if (!member) return false;
    if (member.role === "owner") return true;
    if (this.room.control === "all") return true;
    if (this.room.control === "mods" && member.role === "mod") return true;
    return false;
  }
  isMod(member) { return member?.role === "owner" || member?.role === "mod"; }

  #hostReaction(member, msg) {
    const emoji = String(msg.emoji || "");
    if (!LIVE_REACTIONS.includes(emoji)) return;
    const now = Date.now();
    if (now - (member.lastReactionAt || 0) < 600) return;
    member.lastReactionAt = now;
    const out = { id: uid(), emoji, nick: member.nick, at: now };
    this.#broadcast({ t: "reaction", ...out });
    this.emit("reaction", out);
  }

  #hostChat(member, msg) {
    const text = String(msg.text || "").slice(0, 500).trim();
    if (!text) return;
    const now = Date.now();
    member.chatHits = (member.chatHits || []).filter((t) => now - t < 3000);
    if (member.chatHits.length >= 6) return;
    member.chatHits.push(now);
    const entry = {
      id: uid(), by: member.id, nick: member.nick, role: member.role,
      text, at: now, replyTo: msg.replyTo || null,
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
    this.emit("chatUpdate", entry);
  }

  #hostChatDelete(member, msg) {
    const entry = this.chat.find((m) => m.id === msg.id);
    if (!entry) return;
    if (entry.by !== member.id && !this.isMod(member)) return;
    entry.deleted = true; entry.text = "";
    this.#broadcast({ t: "chatUpdate", msg: entry });
    this.emit("chatUpdate", entry);
  }

  #hostChatClear(member) {
    if (!this.isMod(member) || !this.chat.length) return;
    this.chat = [];
    this.#broadcast({ t: "chatClear", by: member.nick });
    this.emit("chatClear", { by: member.nick });
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
    this.emit("chatUpdate", entry);
  }

  #hostPin(member, msg) {
    if (!this.isMod(member)) return;
    const entry = this.chat.find((m) => m.id === msg.id);
    if (!entry) return;
    entry.pinned = !entry.pinned;
    this.#broadcast({ t: "chatUpdate", msg: entry });
    this.emit("chatUpdate", entry);
  }

  #hostTyping(member) {
    this.#broadcast({ t: "typing", id: member.id, nick: member.nick }, member.id);
  }

  #hostLoadVideo(member, url) {
    if (!this.canControl(member)) return this.#sendTo(member.id, { t: "denied", reason: "control" });
    const v = validateMediaUrl(url);
    if (!v.ok) return this.#sendTo(member.id, { t: "denied", reason: v.reason });
    this.localFile = null;
    this.playback = { kind: "url", url: v.url, playing: false, time: 0, at: Date.now(), rate: 1, by: member.nick };
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
    this.queue = this.queue.filter((q) => q.id !== id);
    this.playback = { kind: "url", url: item.url, playing: false, time: 0, at: Date.now(), rate: 1, by: member.nick };
    this.#broadcast({ t: "queue", items: this.queue });
    this.emit("queue", this.queue);
    this.#broadcast({ t: "playback", state: this.playback });
    this.emit("playback", this.playback);
  }

  #hostSettings(member, patch) {
    if (member.role !== "owner" || !patch) return;
    const allowed = ["control", "locked", "approval", "capacity"];
    for (const k of allowed) {
      if (!(k in patch)) continue;
      if (k === "capacity") this.room.capacity = Math.min(24, Math.max(2, Number(patch[k]) || 6));
      else if (k === "control") this.room.control = ["host", "mods", "all"].includes(patch[k]) ? patch[k] : this.room.control;
      else this.room[k] = !!patch[k];
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
      setTimeout(() => { this.#dropMember(target.id); }, 200);
    }
  }

  #hostVoice(member, on) {
    if (member.muted && on) return;
    member.voice = on;
    this.#broadcast({ t: "voice", id: member.id, on, nick: member.nick });
    this.emit("voice", { id: member.id, on, nick: member.nick });
    this.#broadcastMembers();
  }

  /* ================= guest side receive ================= */
  #onHostMessage(msg) {
    switch (msg.t) {
      case "welcome":
        this.joined = true;
        clearInterval(this.joinTimer);
        clearTimeout(this.joinDeadline);
        this.self = msg.self;
        this.role = msg.self?.role || "member";
        this.roomState = msg.room;
        this.emit("status", "online");
        this.emit("welcome", msg);
        this.emit("members", msg.members);
        break;
      case "deny":
        clearInterval(this.joinTimer);
        clearTimeout(this.joinDeadline);
        this.emit("status", "offline");
        this.emit("deny", msg.reason);
        break;
      case "members":
        this.members = msg.members;
        this.emit("members", msg.members);
        break;
      case "chat": this.emit("chat", msg.msg); break;
      case "reaction": this.emit("reaction", msg); break;
      case "chatUpdate": this.emit("chatUpdate", msg.msg); break;
      case "chatClear": this.emit("chatClear", { by: msg.by }); break;
      case "typing": this.emit("typing", { id: msg.id, nick: msg.nick }); break;
      case "playback": this.emit("playback", msg.state); break;
      case "room": this.roomState = msg.room; this.emit("room", msg.room); break;
      case "queue": this.emit("queue", msg.items); break;
      case "kicked": this.emit("kicked", msg.reason); break;
      case "denied": this.emit("denied", msg.reason); break;
      case "forceMute": this.emit("forceMute", msg.muted); break;
      case "voice": this.emit("voice", { id: msg.id, on: msg.on, nick: msg.nick }); break;
      case "subs": this.emit("subs", msg.cues); break;
      case "fileOffer": this.emit("fileOffer", { id: msg.id, name: msg.name, size: msg.size }); break;
      case "fileStart":
        this.fileRx = { id: msg.id, name: msg.name, size: Number(msg.size) || 0, chunks: [], received: 0, lastEmit: 0 };
        this.emit("fileProgress", { id: msg.id, received: 0, size: this.fileRx.size });
        break;
      case "fileEnd": {
        const rx = this.fileRx;
        if (!rx || rx.id !== msg.id) break;
        this.fileRx = null;
        const blob = new Blob(rx.chunks, { type: "video/mp4" });
        const url = URL.createObjectURL(blob);
        this.emit("localFile", { id: rx.id, name: rx.name, size: blob.size, blob, url });
        break;
      }
      default: break;
    }
  }

  sendHello() {
    const send = () => {
      if (this.dc?.readyState !== "open") return;
      this.dc.send(JSON.stringify({ t: "hello", nick: this.nick, avatar: this.avatar }));
    };
    send();
    setTimeout(send, 400);
  }

  /* ================= unified command API ================= */
  command(type, payload = {}) {
    if (this.isHost) {
      const me = this.members.get(this.selfId);
      if (me) this.#applyLocal(me, type, payload);
      return;
    }
    try { if (this.dc?.readyState === "open") this.dc.send(JSON.stringify({ t: type, ...payload })); } catch {}
  }

  /* ================= local file sharing ================= */
  shareLocalFile(file) {
    this.localFile = file ? { id: file.id, name: file.name, size: file.size, blob: file.blob } : null;
    if (!this.isHost || !this.localFile) return;
    const f = this.localFile;
    this.#broadcast({ t: "fileOffer", id: f.id, name: f.name, size: f.size });
  }

  syncLocalState(state) {
    if (!this.isHost) return;
    const p = {
      kind: "local",
      id: state.id || this.playback?.id || "",
      url: "",
      playing: !!state.playing,
      time: Math.max(0, Number(state.time) || 0),
      rate: Number(state.rate) || 1,
      at: Date.now(),
      by: this.nick
    };
    this.playback = p;
    this.#broadcast({ t: "playback", state: p });
  }

  shareSubtitles(cues) {
    if (!this.isHost) return;
    this.subs = Array.isArray(cues) && cues.length ? cues : null;
    if (this.subs) this.#broadcast({ t: "subs", cues: this.subs });
  }

  async #hostFileSend(peerId, id) {
    const f = this.localFile;
    const conn = this.conns.get(peerId);
    if (!f || !conn || f.id !== id) return;
    const dc = conn.dc;
    if (dc?.readyState !== "open") return;
    try { dc.send(JSON.stringify({ t: "fileStart", id: f.id, name: f.name, size: f.size })); } catch { return; }
    const CHUNK = 64 * 1024;
    const HIGH = 2 * 1024 * 1024;
    for (let off = 0; off < f.size; off += CHUNK) {
      while (dc.readyState === "open" && dc.bufferedAmount > HIGH) await new Promise((r) => setTimeout(r, 25));
      if (dc.readyState !== "open") return;
      let buf;
      try { buf = await f.blob.slice(off, off + CHUNK).arrayBuffer(); } catch { return; }
      try { dc.send(buf); } catch { return; }
    }
    try { dc.send(JSON.stringify({ t: "fileEnd", id: f.id })); } catch {}
  }

  #onFileChunk(data) {
    const rx = this.fileRx;
    if (!rx) return;
    const buf = data instanceof ArrayBuffer ? data : data?.buffer;
    if (!buf) return;
    rx.chunks.push(buf);
    rx.received += buf.byteLength;
    const now = Date.now();
    if (now - rx.lastEmit > 120) {
      rx.lastEmit = now;
      this.emit("fileProgress", { id: rx.id, received: rx.received, size: rx.size });
    }
  }

  #applyLocal(me, type, payload) {
    const fn = {
      chat: () => this.#hostChat(me, payload),
      chatEdit: () => this.#hostChatEdit(me, payload),
      chatDelete: () => this.#hostChatDelete(me, payload),
      chatClear: () => this.#hostChatClear(me),
      react: () => this.#hostReact(me, payload),
      reaction: () => this.#hostReaction(me, payload),
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

  /* ================= voice (mesh) ================= */
  call(peerId, stream) {
    if (!this.voiceCalls) this.voiceCalls = new Map();
    if (this.voiceCalls.has(peerId)) return this.voiceCalls.get(peerId);
    const { pc } = this.#createPc(`v:${peerId}`);
    const mc = new MediaConn(this, peerId, pc);
    this.voiceCalls.set(peerId, mc);
    pc.ontrack = (e) => mc.emit("stream", e.streams[0] || new MediaStream([e.track]));
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitIceGathering(pc);
        await this.#sig({ k: "voff", to: peerId, from: this.selfId, sdp: pc.localDescription.sdp });
      } catch {}
    })();
    return mc;
  }

  async #voiceOffer(msg) {
    if (!this.voiceCalls) this.voiceCalls = new Map();
    if (this.voiceCalls.has(msg.from)) return;
    const { pc } = this.#createPc(`v:${msg.from}`);
    const mc = new MediaConn(this, msg.from, pc);
    this.voiceCalls.set(msg.from, mc);
    pc.ontrack = (e) => mc.emit("stream", e.streams[0] || new MediaStream([e.track]));
    mc.pendingOffer = msg;
    this.emit("incomingCall", mc);
  }

  async answerCall(mc, stream) {
    const { pc } = mc;
    await pc.setRemoteDescription({ type: "offer", sdp: mc.pendingOffer.sdp });
    this.#flushIce(`v:${mc.peer}`);
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIceGathering(pc);
    await this.#sig({ k: "vans", to: mc.peer, from: this.selfId, sdp: pc.localDescription.sdp });
  }

  closeVoice(peerId) {
    const mc = this.voiceCalls?.get(peerId);
    if (!mc) return;
    this.#sig({ k: "bye", to: peerId, from: this.selfId, v: true });
    try { mc.pc.close(); } catch {}
    this.voiceCalls.delete(peerId);
    const rec = this.pcs.get(`v:${peerId}`);
    if (rec) this.pcs.delete(`v:${peerId}`);
  }

  /* ================= screen share (mesh, video only) ================= */
  shareScreenTo(peerId, stream) {
    if (peerId === this.selfId || this.screenCalls.has(peerId)) return;
    const key = `s:${peerId}`;
    const { pc } = this.#createPc(key);
    this.screenCalls.set(peerId, pc);
    pc.onconnectionstatechange = () => {
      if (this.screenCalls.get(peerId) !== pc) return;
      if (["failed", "closed"].includes(pc.connectionState)) this.#endScreenPeer(peerId, false);
    };
    stream.getVideoTracks().forEach((t) => pc.addTrack(t, stream));
    (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitIceGathering(pc);
        await this.#sig({ k: "soff", to: peerId, from: this.selfId, sdp: pc.localDescription.sdp });
      } catch {
        this.#endScreenPeer(peerId, true);
        this.emit("error", "net");
      }
    })();
  }

  async #screenOffer(msg) {
    if (this.screenCalls.has(msg.from)) return;
    const key = `s:${msg.from}`;
    const { pc } = this.#createPc(key);
    this.screenCalls.set(msg.from, pc);
    this.screenOffers.set(msg.from, msg.sdp);
    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      this.emit("screenStream", { from: msg.from, stream });
    };
    pc.onconnectionstatechange = () => {
      if (this.screenCalls.get(msg.from) !== pc) return;
      if (pc.connectionState === "failed") this.#endScreenPeer(msg.from, false);
    };
    this.emit("incomingScreen", { from: msg.from, nick: msg.nick || "" });
  }

  async answerScreen(peerId) {
    const pc = this.screenCalls.get(peerId);
    const sdp = this.screenOffers.get(peerId);
    if (!pc || !sdp) return;
    this.screenOffers.delete(peerId);
    await pc.setRemoteDescription({ type: "offer", sdp });
    this.#flushIce(`s:${peerId}`);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIceGathering(pc);
    await this.#sig({ k: "sans", to: peerId, from: this.selfId, sdp: pc.localDescription.sdp });
  }

  closeScreen(peerId, notify = true) {
    this.#endScreenPeer(peerId, notify);
  }

  #endScreenPeer(peerId, notify) {
    const had = this.screenCalls.has(peerId);
    const pc = this.screenCalls.get(peerId);
    this.screenCalls.delete(peerId);
    this.screenOffers.delete(peerId);
    if (pc) { try { pc.close(); } catch {} }
    this.pcs.delete(`s:${peerId}`);
    if (notify) this.#sig({ k: "bye", to: peerId, from: this.selfId, s: true });
    else if (had) this.emit("screenEnded", peerId);
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this.presenceTimer);
    clearInterval(this.joinTimer);
    clearTimeout(this.joinDeadline);
    if (!this.isHost) this.signal?.send({ k: "bye", from: this.selfId });
    this.signal?.close();
    for (const [, rec] of this.pcs) { try { rec.pc.close(); } catch {} }
    this.pcs.clear();
  }
}
