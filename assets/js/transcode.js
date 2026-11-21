import { getLang } from "./i18n.js";

const CDNS = [
  "https://cdn.jsdelivr.net/npm",
  "https://unpkg.com"
];
const FFMPEG_VER = "0.12.10";
const CORE_VER = "0.12.6";
const UTIL_VER = "0.12.1";

let ffmpegPromise = null;
let activeBase = "";
let engineQueue = Promise.resolve();

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

function withEngine(task) {
  const run = engineQueue.then(task, task);
  engineQueue = run.catch(() => {});
  return run;
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

function extOf(name) {
  return (String(name || "").split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
}

function parseProbe(lines) {
  const info = { video: "", audio: 0, subs: 0, audioLangs: [], subLangs: [] };
  for (const line of lines) {
    const m = line.match(/Stream #\d+:\d+(?:\[[^\]]*\])?(?:\(([^)]*)\))?: (Video|Audio|Subtitle): ([a-z0-9_]+)/i);
    if (!m) continue;
    const lang = (m[1] || "").split(",")[0].trim();
    const kind = m[2].toLowerCase();
    const codec = m[3].toLowerCase();
    if (kind === "video" && !info.video) info.video = codec;
    if (kind === "audio") { info.audio++; info.audioLangs.push(lang); }
    if (kind === "subtitle") { info.subs++; info.subLangs.push(lang); }
  }
  return info;
}

async function probeMedia(ff, inName) {
  const lines = [];
  const onLog = ({ message }) => { if (message) lines.push(message); };
  ff.on("log", onLog);
  try {
    await ff.exec(["-hide_banner", "-i", inName]);
  } catch {
    /* older ffmpeg.wasm builds reject on a non-zero exit; the stream info is in the log */
  } finally {
    try { ff.off("log", onLog); } catch {}
  }
  return parseProbe(lines);
}

async function runFF(ff, args, { log = false } = {}) {
  const lines = [];
  const onLog = log ? ({ message }) => { if (message) lines.push(message); } : null;
  if (onLog) ff.on("log", onLog);
  let code = 0;
  try {
    code = await ff.exec(args);
  } finally {
    if (onLog) { try { ff.off("log", onLog); } catch {} }
  }
  if (typeof code === "number" && code !== 0) {
    const tail = lines.slice(-30).join(" | ");
    console.warn("ffmpeg failed", code, tail);
    throw new Error(`ffmpeg-exit-${code}`);
  }
  return code;
}

async function readAndClear(ff, inName) {
  const entries = await ff.listDir("/");
  const files = [];
  for (const entry of entries) {
    const name = entry.name;
    if (entry.isDir || name === inName || name === "." || name === "..") continue;
    const data = await ff.readFile(name);
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    files.push({ name, data: new Uint8Array(bytes) });
    try { await ff.deleteFile(name); } catch {}
  }
  return files;
}

async function purgeOutputs(ff) {
  try {
    const entries = await ff.listDir("/");
    for (const entry of entries) {
      if (entry.isDir) continue;
      if (/^(master\.m3u8|video\.m3u8|audio_\d+\.m3u8|sub_\d+\.m3u8|v_\d+\.ts|a\d+_\d+\.ts|s\d+_\d+\.vtt|s\d+\.vtt|out\.mp4)$/i.test(entry.name)) {
        try { await ff.deleteFile(entry.name); } catch {}
      }
    }
  } catch {}
}

async function cleanInput(ff, inName) {
  try { await ff.deleteFile(inName); } catch {}
}

const HLS_OUT = ["-f", "hls", "-hls_time", "4", "-hls_list_size", "0", "-hls_playlist_type", "vod"];

async function hlsDuration(ff) {
  try {
    const raw = await ff.readFile("video.m3u8");
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    let total = 0;
    for (const m of text.matchAll(/#EXTINF:\s*([\d.]+)/g)) total += Number(m[1]) || 0;
    if (total > 0) return total;
  } catch {}
  return 3600;
}

async function makeSubPlaylist(ff, index, duration) {
  const target = Math.max(1, Math.ceil(duration));
  const playlist = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${target}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXTINF:${duration.toFixed(3)},`,
    `s${index}.vtt`,
    "#EXT-X-ENDLIST",
    ""
  ].join("\n");
  await ff.writeFile(`sub_${index}.m3u8`, playlist);
}

function buildMaster({ audio, subs }) {
  const fa = getLang() === "fa";
  const num = (n) => (fa ? "۰۱۲۳۴۵۶۷۸۹"[n] || String(n) : String(n));
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
  const audioAttrs = [];
  for (let i = 0; i < audio; i++) {
    const name = fa ? `صدای ${num(i + 1)}` : `Audio ${i + 1}`;
    audioAttrs.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="${name}",DEFAULT=${i === 0 ? "YES" : "NO"},AUTOSELECT=YES,URI="audio_${i}.m3u8"`
    );
  }
  lines.push(...audioAttrs);
  for (let i = 0; i < subs; i++) {
    const name = fa ? `زیرنویس ${num(i + 1)}` : `Subtitle ${i + 1}`;
    lines.push(
      `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="${name}",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,URI="sub_${i}.m3u8"`
    );
  }
  const attrs = ["BANDWIDTH=1800000"];
  if (audio) attrs.push('AUDIO="aud"');
  if (subs) attrs.push('SUBTITLES="sub"');
  lines.push(`#EXT-X-STREAM-INF:${attrs.join(",")}`, "video.m3u8", "");
  return lines.join("\n");
}

async function convertToHls(ff, inName, probe, onProgress) {
  onProgress?.(0);
  await purgeOutputs(ff);
  try {
    await runFF(ff, [
      "-hide_banner", "-i", inName, "-map", "0:v:0", "-an", "-sn",
      ...(probe.video === "h264" ? ["-c:v", "copy"] : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-vf", "scale='min(1280,iw)':-2", "-pix_fmt", "yuv420p"]),
      ...HLS_OUT, "-hls_flags", "independent_segments",
      "-hls_segment_filename", "v_%03d.ts", "video.m3u8"
    ], { log: true });
  } catch (err) {
    console.warn("hls video failed", err?.message);
    throw err;
  }
  onProgress?.(0.5);

  const audio = Math.min(probe.audio, 8);
  let audioDone = 0;
  for (let i = 0; i < audio; i++) {
    try {
      await runFF(ff, [
        "-hide_banner", "-i", inName, "-map", `0:a:${i}`, "-vn", "-sn",
        "-c:a", "aac", "-b:a", "128k",
        ...HLS_OUT, "-hls_segment_filename", `a${i}_%03d.ts`, `audio_${i}.m3u8`
      ], { log: true });
      audioDone++;
    } catch (err) {
      console.warn("hls audio failed", i, err?.message);
      break;
    }
  }
  onProgress?.(0.7);

  let subsDone = 0;
  const subLimit = Math.min(probe.subs, 8);
  for (let i = 0; i < subLimit; i++) {
    try {
      await runFF(ff, [
        "-hide_banner", "-i", inName, "-map", `0:s:${i}`,
        "-c:s", "webvtt",
        ...HLS_OUT, "-hls_segment_filename", `s${i}_%03d.vtt`, `sub_${i}.m3u8`
      ], { log: true });
      subsDone++;
    } catch {
      try {
        await runFF(ff, ["-hide_banner", "-i", inName, "-map", `0:s:${i}`, "-c:s", "webvtt", `s${i}.vtt`], { log: true });
        await makeSubPlaylist(ff, i, await hlsDuration(ff));
        subsDone++;
      } catch (err) {
        console.warn("hls subs failed", i, err?.message);
        try { await ff.deleteFile(`sub_${i}.m3u8`); } catch {}
      }
    }
  }
  onProgress?.(0.9);

  await ff.writeFile("master.m3u8", buildMaster({ audio: audioDone, subs: subsDone }));
  const files = await readAndClear(ff, inName);
  if (!files.some((f) => f.name === "master.m3u8")) throw new Error("hls-master-missing");
  return { files, audio: audioDone, subs: subsDone };
}

async function fallbackMp4(ff, inName, onProgress) {
  onProgress?.(0);
  await purgeOutputs(ff);
  try {
    await runFF(ff, ["-i", inName, "-map", "0:v:0?", "-map", "0:a:0?", "-c", "copy", "-movflags", "+faststart", "out.mp4"]);
  } catch {
    await runFF(ff, [
      "-i", inName, "-map", "0:v:0?", "-map", "0:a:0?",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
      "-vf", "scale='min(1280,iw)':-2",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart", "out.mp4"
    ]);
  }
  const data = await ff.readFile("out.mp4");
  try { await ff.deleteFile("out.mp4"); } catch {}
  return new Blob([data.buffer], { type: "video/mp4" });
}

/**
 * Converts a local file into an HLS bundle that keeps every audio track and
 * every text subtitle. Returns null when the file has nothing extra to offer.
 */
export async function upgradeLocalVideo(source, name, { onProgress } = {}) {
  const inName = `in.${extOf(name)}`;
  return withEngine(async () => {
    const ff = await getFFmpeg(onProgress);
    const { fetchFile } = await import(`${activeBase}/@ffmpeg/util@${UTIL_VER}/dist/esm/index.js`);
    try {
      await ff.writeFile(inName, await fetchFile(source));
      const probe = await probeMedia(ff, inName);
      if (!probe.video || (probe.audio < 2 && probe.subs < 1)) return null;
      return await convertToHls(ff, inName, probe, onProgress);
    } finally {
      await cleanInput(ff, inName);
    }
  });
}

/**
 * Converts an arbitrary local video file into something Chrome can play.
 * Fast path: play it natively. Multi-track path: HLS with every audio and
 * subtitle stream. Last resort: single-audio MP4.
 */
export async function prepareLocalVideo(file, { onStatus, onProgress } = {}) {
  const nativeUrl = URL.createObjectURL(file);
  onStatus?.("probe");
  if (await canPlayUrl(nativeUrl, 7000)) {
    return { url: nativeUrl, converted: false, hls: false };
  }

  try {
    onStatus?.("loading");
    const { files, audio, subs } = await withEngine(async () => {
      const ff = await getFFmpeg(onProgress);
      const { fetchFile } = await import(`${activeBase}/@ffmpeg/util@${UTIL_VER}/dist/esm/index.js`);
      const inName = `in.${extOf(file.name)}`;
      try {
        await ff.writeFile(inName, await fetchFile(file));
        const probe = await probeMedia(ff, inName);
        if (!probe.video) throw new Error("no-video-stream");
        onStatus?.("remux");
        try {
          return await convertToHls(ff, inName, probe, onProgress);
        } catch {
          return { files: null, audio: 0, subs: 0 };
        }
      } finally {
        await cleanInput(ff, inName);
      }
    });

    if (files) {
      URL.revokeObjectURL(nativeUrl);
      onStatus?.("verify");
      return { files, audio, subs, converted: true, hls: true };
    }

    onStatus?.("transcode");
    const blob = await withEngine(async () => {
      const ff = await getFFmpeg(onProgress);
      const { fetchFile } = await import(`${activeBase}/@ffmpeg/util@${UTIL_VER}/dist/esm/index.js`);
      const inName = `in.${extOf(file.name)}`;
      try {
        await ff.writeFile(inName, await fetchFile(file));
        return await fallbackMp4(ff, inName, onProgress);
      } finally {
        await cleanInput(ff, inName);
      }
    });
    const url = URL.createObjectURL(blob);
    URL.revokeObjectURL(nativeUrl);
    onStatus?.("done");
    return { url, converted: true, hls: false };
  } catch (err) {
    URL.revokeObjectURL(nativeUrl);
    throw err;
  }
}
