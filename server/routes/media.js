import net from "node:net";
import dns from "node:dns/promises";
import { Readable, Transform } from "node:stream";
import { requireAuth } from "./auth.js";
import { settingNumber } from "../platformSettings.js";

const MB = 1024 * 1024;
const MAX_REDIRECTS = 4;
const HEADER_TIMEOUT_MS = 15000;
const USER_AGENT = "Hamtamasha/1.0 (+media-track check)";

const MEDIA_TYPES = [
  /^video\//,
  /^audio\//,
  /^application\/octet-stream$/,
  /^binary\/octet-stream$/,
  /^application\/(x-)?matroska$/,
  /^application\/vnd\.apple\.mpegurl$/,
  /^application\/x-mpegurl$/
];

function blockedHostname(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (/\.(local|internal|lan|home|intranet)$/.test(host)) return true;
  return false;
}

function privateAddress(address) {
  const ip = String(address || "").toLowerCase();
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    if (ip === "::" || ip === "::1") return true;
    if (/^fe[89ab]/.test(ip) || /^f[cd]/.test(ip)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
    if (mapped) return privateAddress(mapped[1]);
    if (ip.startsWith("::ffff:")) return true;
    return false;
  }
  return true;
}

async function resolveSafe(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  if (url.username || url.password) return null;
  url.hash = "";
  if (blockedHostname(url.hostname)) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return privateAddress(host) ? null : url;
  let addresses = [];
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    return null;
  }
  if (!addresses.length) return null;
  if (addresses.some((entry) => privateAddress(entry.address))) return null;
  return url;
}

function isMediaType(type) {
  const clean = String(type || "").split(";")[0].trim().toLowerCase();
  return MEDIA_TYPES.some((re) => re.test(clean));
}

function upstreamFail(reply, code, status, message) {
  return reply.code(status).send({ error: code, message });
}

export default async function mediaRoutes(app) {
  app.get("/fetch", async (req, reply) => {
    await requireAuth(req, reply);
    if (reply.sent) return undefined;
    const raw = String(req.query?.url || "").trim();
    if (!raw) return reply.code(400).send({ error: "missing_url", message: "A media URL is required." });
    const ownerMax = Math.max(1, Number(await settingNumber("player.linkMaxMB", 600)) || 600);
    const asked = Number(req.query?.maxMB) || ownerMax;
    const maxMB = Math.min(ownerMax, Math.max(1, asked));
    const maxBytes = maxMB * MB;

    let current = await resolveSafe(raw);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!current) {
        return reply.code(400).send({ error: "url_not_allowed", message: "This URL cannot be fetched." });
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(current, {
          redirect: "manual",
          signal: controller.signal,
          headers: { "user-agent": USER_AGENT, accept: "video/*,audio/*,application/octet-stream,*/*;q=0.5" }
        });
      } catch {
        clearTimeout(timer);
        return upstreamFail(reply, "upstream_unreachable", 502, "The file host did not respond.");
      }
      clearTimeout(timer);

      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        try { await res.body?.cancel(); } catch {}
        let next;
        try { next = new URL(location, current); } catch { return upstreamFail(reply, "bad_redirect", 502, "The file host redirected to an invalid address."); }
        current = await resolveSafe(next.href);
        continue;
      }
      if (!res.ok) {
        try { await res.body?.cancel(); } catch {}
        return upstreamFail(reply, "upstream_error", 502, `The file host answered with ${res.status}.`);
      }
      const type = String(res.headers.get("content-type") || "").toLowerCase();
      if (!isMediaType(type)) {
        try { await res.body?.cancel(); } catch {}
        return upstreamFail(reply, "not_media", 415, "That link is not a video or audio file.");
      }
      const len = Number(res.headers.get("content-length")) || 0;
      if (len && len > maxBytes) {
        try { await res.body?.cancel(); } catch {}
        return reply.code(413).send({ error: "media_too_large", message: `The file is larger than ${maxMB} MB.` });
      }
      reply.header("content-type", type);
      if (len) reply.header("content-length", String(len));
      reply.header("cache-control", "no-store");
      reply.header("x-content-type-options", "nosniff");
      if (!res.body) return reply.send();
      let sent = 0;
      const guard = new Transform({
        transform(chunk, _enc, done) {
          sent += chunk.length;
          if (sent > maxBytes) {
            const err = new Error("media_too_large");
            err.code = "MEDIA_TOO_LARGE";
            return done(err);
          }
          done(null, chunk);
        }
      });
      return reply.send(Readable.fromWeb(res.body).pipe(guard));
    }
    return upstreamFail(reply, "too_many_redirects", 502, "The file host redirected too many times.");
  });
}
