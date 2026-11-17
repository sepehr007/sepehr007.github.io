const CDNS = [
  "https://cdn.jsdelivr.net/npm",
  "https://unpkg.com"
];
const FFMPEG_VER = "0.12.10";
const CORE_VER = "0.12.6";
const UTIL_VER = "0.12.1";

let ffmpegPromise = null;
let activeBase = "";

async function resolveBase() {
  if (activeBase) return activeBase;
  for (const base of CDNS) {
    try {
      const res = await fetch(`${base}/@ffmpeg/ffmpeg@${FFMPEG_VER}/dist/esm/index.js`, { cache: "force-cache" });
      if (res.ok) {
        activeBase = base;
        return base;
      }
    } catch {}
  }
  throw new Error("cdn-unavailable");
}

async function workerBlobUrl(base) {
  const baseUrl = `${base}/@ffmpeg/ffmpeg@${FFMPEG_VER}/dist/esm/`;
  const src = await (await fetch(`${baseUrl}worker.js`)).text();
  const patched = src.replace(/(["'])\.\/([^"']+)\1/g, (_m, q, rel) => `${q}${baseUrl}${rel}${q}`);
  return URL.createObjectURL(new Blob([patched], { type: "text/javascript" }));
}

async function getFFmpeg(onProgress) {
  if (ffmpegPromise) return ffmpegPromise;
  ffmpegPromise = (async () => {
    const base = await resolveBase();
    const { FFmpeg } = await import(`${base}/@ffmpeg/ffmpeg@${FFMPEG_VER}/dist/esm/index.js`);
    const { toBlobURL } = await import(`${base}/@ffmpeg/util@${UTIL_VER}/dist/esm/index.js`);
    const ff = new FFmpeg();
    ff.on("progress", ({ progress }) => {
      if (Number.isFinite(progress)) onProgress?.(Math.max(0, Math.min(1, progress)));
    });
    const coreBase = `${base}/@ffmpeg/core@${CORE_VER}/dist/esm`;
    const loadTask = (async () => {
      await ff.load({
        coreURL: await toBlobURL(`${coreBase}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${coreBase}/ffmpeg-core.wasm`, "application/wasm"),
        classWorkerURL: await workerBlobUrl(base)
      });
    })();
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("converter-timeout")), 90000);
    });
    await Promise.race([loadTask, timeout]);
    return ff;
  })().catch((err) => { ffmpegPromise = null; throw err; });
  return ffmpegPromise;
}

export async function canPlayUrl(url, timeoutMs = 9000) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "metadata";
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      v.removeAttribute("src");
      v.load();
      resolve(ok);
    };
    v.onloadedmetadata = () => finish(true);
    v.onerror = () => finish(false);
    setTimeout(() => finish(false), timeoutMs);
    v.src = url;
  });
}

/**
 * Converts an arbitrary local video file into something Chrome can play.
 * Fast path: remux streams into MP4. Slow path: transcode to H.264/AAC.
 */
export async function prepareLocalVideo(file, { onStatus, onProgress } = {}) {
  const nativeUrl = URL.createObjectURL(file);
  onStatus?.("probe");
  if (await canPlayUrl(nativeUrl, 7000)) {
    return { url: nativeUrl, converted: false };
  }

  try {
    onStatus?.("loading");
    const ff = await getFFmpeg(onProgress);
    const { fetchFile } = await import(`${activeBase}/@ffmpeg/util@${UTIL_VER}/dist/esm/index.js`);
    const inName = `in.${(file.name.split(".").pop() || "bin").toLowerCase()}`;

    await ff.writeFile(inName, await fetchFile(file));

    onStatus?.("remux");
    onProgress?.(0);
    let ok = true;
    try {
      await ff.exec(["-i", inName, "-map", "0:v:0?", "-map", "0:a:0?", "-c", "copy", "-movflags", "+faststart", "out.mp4"]);
    } catch { ok = false; }

    if (ok) {
      try {
        const data = await ff.readFile("out.mp4");
        const blob = new Blob([data.buffer], { type: "video/mp4" });
        const url = URL.createObjectURL(blob);
        onStatus?.("verify");
        if (await canPlayUrl(url, 7000)) {
          URL.revokeObjectURL(nativeUrl);
          return { url, converted: true };
        }
        URL.revokeObjectURL(url);
      } catch { /* fall through to transcode */ }
    }

    onStatus?.("transcode");
    onProgress?.(0);
    try { await ff.deleteFile("out.mp4"); } catch {}
    await ff.exec([
      "-i", inName,
      "-map", "0:v:0?", "-map", "0:a:0?",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
      "-vf", "scale='min(1280,iw)':-2",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      "out.mp4"
    ]);
    const data = await ff.readFile("out.mp4");
    const blob = new Blob([data.buffer], { type: "video/mp4" });
    const url = URL.createObjectURL(blob);
    URL.revokeObjectURL(nativeUrl);
    try { await ff.deleteFile(inName); } catch {}
    onStatus?.("done");
    return { url, converted: true };
  } catch (err) {
    URL.revokeObjectURL(nativeUrl);
    throw err;
  }
}
