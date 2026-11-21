/* Reads only a few hundred kilobytes from a remote video (HTTP Range) and
   reports its container, size and track list. Works for Matroska and MP4;
   returns null for anything it cannot parse. */

const HEAD_BYTES = 1024 * 1024;
const TAIL_BYTES = 4 * 1024 * 1024;

async function readRange(url, start, end) {
  const res = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` },
    mode: "cors",
    cache: "no-store"
  });
  if (!res.ok && res.status !== 206) throw new Error(`http-${res.status}`);
  const total = Number((res.headers.get("content-range") || "").split("/")[1]) ||
    (res.status === 200 ? Number(res.headers.get("content-length")) || 0 : 0);
  const want = end - start + 1;
  if (res.status === 200 && !res.headers.get("content-range")) {
    /* the host ignored Range: read only the prefix and drop the rest */
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    while (got < want) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = value.subarray(0, Math.min(value.length, want - got));
      chunks.push(take);
      got += take.length;
    }
    await reader.cancel().catch(() => {});
    const buf = new Uint8Array(got);
    let at = 0;
    for (const c of chunks) { buf.set(c, at); at += c.length; }
    return { bytes: buf, total: total || got };
  }
  return { bytes: new Uint8Array(await res.arrayBuffer()), total };
}

const clz8 = (b) => (b & 0x80 ? 0 : b & 0x40 ? 1 : b & 0x20 ? 2 : b & 0x10 ? 3 : b & 0x08 ? 4 : b & 0x04 ? 5 : b & 0x02 ? 6 : b & 0x01 ? 7 : 8);
const utf8 = (bytes) => { try { return new TextDecoder().decode(bytes); } catch { return ""; } };

function ebmlId(bytes, pos) {
  if (pos >= bytes.length) return null;
  const first = bytes[pos];
  if (first === 0) return null;
  const len = clz8(first) + 1;
  if (len > 4 || pos + len > bytes.length) return null;
  let value = 0;
  for (let i = 0; i < len; i++) value = value * 256 + bytes[pos + i];
  return { value, next: pos + len };
}

function ebmlSize(bytes, pos) {
  if (pos >= bytes.length) return null;
  const first = bytes[pos];
  if (first === 0) return null;
  const len = clz8(first) + 1;
  if (len > 8 || pos + len > bytes.length) return null;
  let value = first & (0xff >> len);
  let allOnes = value === (0xff >> len);
  for (let i = 1; i < len; i++) {
    const b = bytes[pos + i];
    value = value * 256 + b;
    if (b !== 0xff) allOnes = false;
  }
  return { value, unknown: allOnes, next: pos + len };
}

function ebmlUint(bytes, start, end) {
  let n = 0;
  for (let i = start; i < end; i++) n = n * 256 + bytes[i];
  return n;
}

const MKV_TRACK = 0xae;
const MKV_TRACKS = 0x1654ae6b;
const MKV_SEGMENT = 0x18538067;
const MKV_ENTRY = { number: 0xd7, type: 0x83, codec: 0x86, lang: 0x22b59c, langIETF: 0x22b59d, name: 0x536e };

function parseTrackEntry(bytes, start, end) {
  const t = { number: 0, type: 0, codec: "", lang: "", name: "" };
  let pos = start;
  while (pos < end) {
    const id = ebmlId(bytes, pos);
    if (!id) break;
    const size = ebmlSize(bytes, id.next);
    if (!size) break;
    const dataStart = size.next;
    const dataEnd = size.unknown ? end : Math.min(end, dataStart + size.value);
    if (id.value === MKV_ENTRY.number) t.number = ebmlUint(bytes, dataStart, dataEnd);
    else if (id.value === MKV_ENTRY.type) t.type = ebmlUint(bytes, dataStart, dataEnd);
    else if (id.value === MKV_ENTRY.codec) t.codec = utf8(bytes.subarray(dataStart, dataEnd)).trim();
    else if (id.value === MKV_ENTRY.lang) t.lang = utf8(bytes.subarray(dataStart, dataEnd)).trim();
    else if (id.value === MKV_ENTRY.langIETF) t.lang = utf8(bytes.subarray(dataStart, dataEnd)).trim() || t.lang;
    else if (id.value === MKV_ENTRY.name && !t.name) t.name = utf8(bytes.subarray(dataStart, dataEnd)).trim();
    if (dataEnd <= pos) break;
    pos = dataEnd;
  }
  return t;
}

function parseMkv(bytes) {
  const tracks = [];
  const walk = (start, end, depth) => {
    let pos = start;
    while (pos < end && depth < 8) {
      const id = ebmlId(bytes, pos);
      if (!id) break;
      const size = ebmlSize(bytes, id.next);
      if (!size) break;
      const dataStart = size.next;
      const dataEnd = size.unknown ? end : Math.min(end, dataStart + size.value);
      if (id.value === MKV_SEGMENT || id.value === MKV_TRACKS) walk(dataStart, dataEnd, depth + 1);
      else if (id.value === MKV_TRACK) tracks.push(parseTrackEntry(bytes, dataStart, dataEnd));
      if (dataEnd <= pos) break;
      pos = dataEnd;
    }
  };
  walk(0, bytes.length, 0);
  return tracks.length ? tracks : null;
}

function mp4Boxes(bytes, start, end) {
  const out = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
    const type = utf8(bytes.subarray(pos + 4, pos + 8));
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) break;
      size = 0;
      for (let i = 8; i < 16; i++) size = size * 256 + bytes[pos + i];
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) break;
    out.push({ type, start: pos, dataStart: pos + header, end: pos + size });
    pos += size;
  }
  return out;
}

const MP4_CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "udta"]);

function collectMp4Handlers(bytes, start, end, depth, tracks) {
  for (const box of mp4Boxes(bytes, start, end)) {
    if (depth < 10 && MP4_CONTAINERS.has(box.type)) {
      collectMp4Handlers(bytes, box.dataStart, box.end, depth + 1, tracks);
    } else if (box.type === "hdlr") {
      const handler = utf8(bytes.subarray(box.dataStart + 8, box.dataStart + 12));
      if (handler) tracks.push({ handler });
    }
  }
}

function findMoov(bytes) {
  const top = mp4Boxes(bytes, 0, bytes.length).find((b) => b.type === "moov");
  if (top) return top;
  /* tail slice: the moov box starts mid-buffer, locate it by its type tag */
  for (let i = 4; i + 4 <= bytes.length; i++) {
    if (bytes[i] === 0x6d && bytes[i + 1] === 0x6f && bytes[i + 2] === 0x6f && bytes[i + 3] === 0x76) {
      const size = ((bytes[i - 4] << 24) | (bytes[i - 3] << 16) | (bytes[i - 2] << 8) | bytes[i - 1]) >>> 0;
      if (size >= 8 && i - 4 + size <= bytes.length) {
        return { type: "moov", start: i - 4, dataStart: i + 4, end: i - 4 + size };
      }
    }
  }
  return null;
}

function parseMp4(bytes) {
  const moov = findMoov(bytes);
  if (!moov) return null;
  const tracks = [];
  collectMp4Handlers(bytes, moov.dataStart, moov.end, 0, tracks);
  return tracks.length ? tracks : null;
}

function summarize(container, tracks) {
  const out = { container, audio: 0, textSubs: 0, imageSubs: 0, video: 0, audioLangs: [], subLangs: [] };
  if (container === "mkv") {
    for (const t of tracks) {
      if (t.type === 2) {
        out.audio++;
        out.audioLangs.push(t.lang || "");
      } else if (t.type === 17) {
        if (/^(S_TEXT|S_SSA|S_ASS|S_SUB|S_SAMI)/i.test(t.codec) || /webvtt|subrip/i.test(t.codec)) {
          out.textSubs++;
          out.subLangs.push(t.lang || "");
        } else {
          out.imageSubs++;
        }
      } else if (t.type === 1) out.video++;
    }
  } else {
    for (const t of tracks) {
      if (t.handler === "soun") { out.audio++; out.audioLangs.push(""); }
      else if (t.handler === "subt" || t.handler === "text" || t.handler === "sbtl") { out.textSubs++; out.subLangs.push(""); }
      else if (t.handler === "vide") out.video++;
    }
  }
  return out;
}

export async function probeRemoteTracks(url, { headBytes = HEAD_BYTES } = {}) {
  try {
    const head = await readRange(url, 0, headBytes - 1);
    const bytes = head.bytes;
    if (bytes.length < 16) return null;
    const total = head.total || bytes.length;
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
      const tracks = parseMkv(bytes);
      if (tracks) return { ...summarize("mkv", tracks), sizeBytes: total };
      return { container: "mkv", unknownTracks: true, sizeBytes: total };
    }
    if (utf8(bytes.subarray(4, 8)) === "ftyp") {
      let tracks = parseMp4(bytes);
      if (!tracks && total > bytes.length) {
        const tailStart = Math.max(0, total - TAIL_BYTES);
        const tail = await readRange(url, tailStart, total - 1);
        tracks = parseMp4(tail.bytes);
        if (tracks?.length) {
          const info = summarize("mp4", tracks);
          return { ...info, sizeBytes: total };
        }
      }
      if (tracks) return { ...summarize("mp4", tracks), sizeBytes: total };
      return { container: "mp4", unknownTracks: true, sizeBytes: total };
    }
    return { container: "other", unknownTracks: true, sizeBytes: total };
  } catch {
    return null;
  }
}
