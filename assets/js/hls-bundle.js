const MAGIC = "WTHLS1";

export function mimeFor(name) {
  const n = String(name).toLowerCase();
  if (n.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (n.endsWith(".ts")) return "video/mp2t";
  if (n.endsWith(".vtt")) return "text/vtt";
  if (n.endsWith(".m4s") || n.endsWith(".mp4")) return "video/mp4";
  if (n.endsWith(".aac")) return "audio/aac";
  return "application/octet-stream";
}

export async function packBundle(files) {
  const enc = new TextEncoder();
  const header = enc.encode(JSON.stringify({
    v: 1,
    files: files.map((f) => ({ n: f.name, t: f.type || mimeFor(f.name), s: f.data.byteLength }))
  }));
  let size = 6 + 4 + header.byteLength;
  for (const f of files) size += f.data.byteLength;
  const out = new Uint8Array(size);
  out.set(enc.encode(MAGIC), 0);
  new DataView(out.buffer).setUint32(6, header.byteLength, true);
  out.set(header, 10);
  let off = 10 + header.byteLength;
  for (const f of files) {
    out.set(f.data, off);
    off += f.data.byteLength;
  }
  return new Blob([out], { type: "application/octet-stream" });
}

export async function isBundle(blob) {
  if (!blob || blob.size < 10) return false;
  const head = await blob.slice(0, 6).arrayBuffer();
  return new TextDecoder().decode(head) === MAGIC;
}

export async function unpackBundle(blob) {
  const head = new Uint8Array(await blob.slice(0, 10).arrayBuffer());
  const hlen = new DataView(head.buffer).getUint32(6, true);
  const header = JSON.parse(new TextDecoder().decode(await blob.slice(10, 10 + hlen).arrayBuffer()));
  const files = [];
  let off = 10 + hlen;
  for (const f of header.files || []) {
    files.push({ name: f.n, type: f.t, blob: blob.slice(off, off + f.s) });
    off += f.s;
  }
  return files;
}

function controllerReady() {
  const sw = navigator.serviceWorker;
  if (!sw) return Promise.resolve(null);
  if (sw.controller) return Promise.resolve(sw.controller);
  return new Promise((resolve) => {
    let done = false;
    const fin = (c) => { if (!done) { done = true; resolve(c || null); } };
    sw.addEventListener("controllerchange", () => fin(sw.controller), { once: true });
    sw.ready.then(() => fin(sw.controller)).catch(() => fin(null));
    setTimeout(() => fin(sw.controller), 4000);
  });
}

export function bundleBase(id) {
  const dir = location.pathname.replace(/[^/]*$/, "");
  return `${dir}__hls/${id}/`;
}

export async function registerBundle(files) {
  const ctrl = await controllerReady();
  if (!ctrl) throw new Error("no-service-worker");
  const id = "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const packed = [];
  for (const f of files) {
    const buf = f.data
      ? (f.data.byteOffset === 0 && f.data.byteLength === f.data.buffer.byteLength
        ? f.data.buffer
        : f.data.slice().buffer)
      : await f.blob.arrayBuffer();
    packed.push({ name: f.name, type: f.type || mimeFor(f.name), buffer: buf });
  }
  const chan = new MessageChannel();
  const ack = new Promise((resolve) => { chan.port1.onmessage = (e) => resolve(e.data); });
  ctrl.postMessage(
    { type: "hls-bundle", id, files: packed, port: chan.port2 },
    [chan.port2, ...packed.map((p) => p.buffer)]
  );
  await Promise.race([ack, new Promise((r) => setTimeout(r, 8000))]);
  return { id, url: `${bundleBase(id)}master.m3u8` };
}

export function releaseBundle(id) {
  if (!id) return;
  try { navigator.serviceWorker?.controller?.postMessage({ type: "hls-bundle-release", id }); } catch {}
}
