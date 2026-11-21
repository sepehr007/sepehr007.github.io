import { getLang } from "./i18n.js";

const CDNS = [
  "https://cdn.jsdelivr.net/npm",
  "https://unpkg.com"
];
const FFMPEG_VER = "0.12.10";
const CORE_VER = "0.12.6";
const UTIL_VER = "0.12.1";

const VIDEO_OK = new Set(["h264", "vp8", "vp9", "av1"]);
const AUDIO_OK = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);
const TEXT_SUB_CODECS = new Set([
  "subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text",
  "sami", "microdvd", "subviewer", "subviewer1", "mpl2", "pjs", "realtext", "jacosub"
]);

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
  const info = {
    video: "", videoIndex: 0, pixFmt: "", tenBit: false,
    audio: 0, acodecs: [], audioLangs: [],
    subs: 0, textSubs: 0, subIdx: [], subLangs: [], imageSubs: 0
  };
  let vi = 0;
  let si = 0;
  for (const line of lines) {
    const m = line.match(/Stream #\d+:\d+(?:\[[^\]]*\])?(?:\(([^)]*)\))?: (Video|Audio|Subtitle): ([a-z0-9_]+)/i);
    if (!m) continue;
    const lang = (m[1] || "").split(",")[0].trim();
    const kind = m[2].toLowerCase();
    const codec = m[3].toLowerCase();
    if (kind === "video") {
      const idx = vi++;
      if (/attached pic/i.test(line) || info.video) continue;
      info.video = codec;
      info.videoIndex = idx;
      const px = line.match(/Video: [^,]+, ([^(,]+)/);
      info.pixFmt = px ? px[1].trim() : "";
    } else if (kind === "audio") {
      info.audio++;
      info.acodecs.push(codec);
      info.audioLangs.push(lang);
    } else {
      const idx = si++;
      info.subs++;
      if (TEXT_SUB_CODECS.has(codec)) {
        info.textSubs++;
        info.subIdx.push(idx);
        info.subLangs.push(lang);
      } else {
        info.imageSubs++;
      }
    }
  }
  info.tenBit = /10le|12le|p010|p016/i.test(info.pixFmt);
  return info;
}

function videoCopyable(probe) {
  return probe.video === "h264" && !probe.tenBit && !/444|422/.test(probe.pixFmt);
}

/** True when the browser cannot play every codec in the file as-is. */
function needsCodecFix(probe) {
  const badVideo = !VIDEO_OK.has(probe.video) || (probe.video === "h264" && !videoCopyable(probe));
  const badAudio = probe.acodecs.some((c) => !AUDIO_OK.has(c));
  return badVideo || badAudio;
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

function buildMaster({ audio, subs, audioLangs = [], subLangs = [] }) {
  const fa = getLang() === "fa";
  const num = (n) => (fa ? "۰۱۲۳۴۵۶۷۸۹"[n] || String(n) : String(n));
  const langTag = (l) => (l && l !== "und" ? ` (${l})` : "");
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
  const audioAttrs = [];
  for (let i = 0; i < audio; i++) {
    const name = (fa ? `صدای ${num(i + 1)}` : `Audio ${i + 1}`) + langTag(audioLangs[i]);
    audioAttrs.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="${name}",DEFAULT=${i === 0 ? "YES" : "NO"},AUTOSELECT=YES,URI="audio_${i}.m3u8"`
    );
  }
  lines.push(...audioAttrs);
  for (let i = 0; i < subs; i++) {
    const name = (fa ? `زیرنویس ${num(i + 1)}` : `Subtitle ${i + 1}`) + langTag(subLangs[i]);
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
    const videoArgs = videoCopyable(probe)
      ? ["-c:v", "copy"]
      : ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-vf", "scale='min(1280,iw)':-2", "-pix_fmt", "yuv420p"];
    await runFF(ff, [
      "-hide_banner", "-i", inName, "-map", `0:v:${probe.videoIndex}`, "-an", "-sn",
      ...videoArgs,
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
  const textIdx = probe.subIdx.slice(0, 8);
  for (let i = 0; i < textIdx.length; i++) {
    const src = textIdx[i];
    try {
      await runFF(ff, [
        "-hide_banner", "-i", inName, "-map", `0:s:${src}`,
        "-c:s", "webvtt",
        ...HLS_OUT, "-hls_segment_filename", `s${i}_%03d.vtt`, `sub_${i}.m3u8`
      ], { log: true });
      subsDone++;
    } catch {
      try {
        await runFF(ff, ["-hide_banner", "-i", inName, "-map", `0:s:${src}`, "-c:s", "webvtt", `s${i}.vtt`], { log: true });
        await makeSubPlaylist(ff, i, await hlsDuration(ff));
        subsDone++;
      } catch (err) {
        console.warn("hls subs failed", i, err?.message);
        try { await ff.deleteFile(`sub_${i}.m3u8`); } catch {}
      }
    }
  }
  onProgress?.(0.9);

  await ff.writeFile("master.m3u8", buildMaster({
    audio: audioDone,
    subs: subsDone,
    audioLangs: probe.audioLangs,
    subLangs: probe.subLangs
  }));
  const files = await readAndClear(ff, inName);
  if (!files.some((f) => f.name === "master.m3u8")) throw new Error("hls-master-missing");
  return { files, audio: audioDone, subs: subsDone };
}

async function fallbackMp4(ff, inName, probe, onProgress) {
  onProgress?.(0);
  await purgeOutputs(ff);
  const maps = ["-map", `0:v:${probe.videoIndex}`, "-map", "0:a:0?"];
  const copy = videoCopyable(probe) && AUDIO_OK.has(probe.acodecs[0] || "");
  try {
    if (!copy) throw new Error("reencode");
    await runFF(ff, ["-i", inName, ...maps, "-c", "copy", "-movflags", "+faststart", "out.mp4"]);
  } catch {
    await runFF(ff, [
      "-i", inName, ...maps,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
      "-vf", "scale='min(1280,iw)':-2", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart", "out.mp4"
    ]);
  }
  const data = await ff.readFile("out.mp4");
  try { await ff.deleteFile("out.mp4"); } catch {}
  return new Blob([data.buffer], { type: "video/mp4" });
}

/**
 * Converts a file into an HLS bundle when the browser needs it: several audio
 * tracks, text subtitles, or codecs it cannot play (HEVC, 10-bit, AC3/DTS…).
 * Returns null when the file already plays fine as-is.
 */
export async function upgradeLocalVideo(source, name, { onProgress } = {}) {
  const inName = `in.${extOf(name)}`;
  return withEngine(async () => {
    const ff = await getFFmpeg(onProgress);
    const { fetchFile } = await import(`${activeBase}/@ffmpeg/util@${UTIL_VER}/dist/esm/index.js`);
    try {
      await ff.writeFile(inName, await fetchFile(source));
      const probe = await probeMedia(ff, inName);
      if (!probe.video) return null;
      const fixed = needsCodecFix(probe);
      if (!fixed && probe.audio < 2 && probe.textSubs < 1) return null;
      return { ...(await convertToHls(ff, inName, probe, onProgress)), fixed };
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
        const probe = await probeMedia(ff, inName);
        if (!probe.video) throw new Error("no-video-stream");
        return await fallbackMp4(ff, inName, probe, onProgress);
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
