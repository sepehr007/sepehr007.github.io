import { fmtTime, store } from "./core.js";

export function parseSubtitles(raw) {
  const text = String(raw).replace(/\r/g, "").trim();
  const cueBlocks = text.split(/\n{2,}/);
  const toSec = (s) => {
    const m = s.match(/(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
    if (!m) return null;
    const [, h, mm, ss, ms] = m;
    return (+h || 0) * 3600 + (+mm) * 60 + (+ss) + (+ms.padEnd(3, "0") / 1000);
  };
  const cues = [];
  for (const block of cueBlocks) {
    const lines = block.split("\n").filter(Boolean);
    const idx = lines.findIndex((l) => l.includes("-->"));
    if (idx === -1) continue;
    const [startRaw, endRaw] = lines[idx].split("-->");
    const start = toSec(startRaw);
    const end = toSec(endRaw);
    if (start == null || end == null) continue;
    const content = lines.slice(idx + 1).join("\n").replace(/<[^>]+>/g, "").trim();
    if (!content) continue;
    cues.push({ start, end, text: content });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

export class Player {
  constructor({ video, frame, onControl, onTime, onLoaded, onError, onLevels, onAudio, onText, onBuffering, canControl }) {
    this.video = video;
    this.frame = frame;
    this.onControl = onControl;
    this.onTime = onTime;
    this.onLoaded = onLoaded;
    this.onError = onError;
    this.onLevels = onLevels;
    this.onAudio = onAudio;
    this.onText = onText;
    this.onBuffering = onBuffering;
    this.canControl = canControl || (() => true);

    this.url = "";
    this.state = { url: "", playing: false, time: 0, at: Date.now(), rate: 1 };
    this.alias = new Map();
    this.applying = false;
    this.hls = null;
    this.cues = [];
    this.sets = [];
    this.activeSet = "";
    this.subsOffset = 0;
    this.subsSize = 120;
    this.lastCue = "";

    this.video.controls = false;
    this.video.addEventListener("timeupdate", () => this.#onTimeupdate());
    this.video.addEventListener("loadedmetadata", () => {
      this.onLoaded?.({ duration: this.video.duration || 0 });
      this.#restorePosition();
      this.#syncNow();
      this.#emitTime();
    });
    this.video.addEventListener("error", () => {
      const map = { 1: "aborted", 2: "network", 3: "decode", 4: "format" };
      this.onError?.(map[this.video.error?.code] || "media");
    });
    const bufferingOn = () => this.onBuffering?.(true);
    const bufferingOff = () => this.onBuffering?.(false);
    this.video.addEventListener("waiting", bufferingOn);
    this.video.addEventListener("stalled", bufferingOn);
    this.video.addEventListener("playing", bufferingOff);
    this.video.addEventListener("canplay", bufferingOff);
    this.video.addEventListener("seeked", bufferingOff);
    this.video.addEventListener("emptied", bufferingOff);
    this.video.addEventListener("play", () => { if (!this.applying) this.#request("play"); });
    this.video.addEventListener("pause", () => { if (!this.applying) this.#request("pause", { time: this.video.currentTime }); });
    this.video.addEventListener("ratechange", () => { if (!this.applying) this.#request("rate", { value: this.video.playbackRate, time: this.video.currentTime }); });
    this.video.addEventListener("seeking", () => {
      if (this.applying) return;
      if (performance.now() - (this.programmaticSeekAt || 0) < 500) return;
      this.#request("seek", { time: this.video.currentTime });
    });

    this.video.textTracks?.addEventListener?.("addtrack", () => this.#emitText());
    this.video.textTracks?.addEventListener?.("removetrack", () => this.#emitText());
    this.video.textTracks?.addEventListener?.("change", () => this.#emitText());
    this.video.audioTracks?.addEventListener?.("addtrack", () => this.#emitAudio());
    this.video.addEventListener("loadedmetadata", () => { this.#emitText(); this.#emitAudio(); });

    this.timer = setInterval(() => { if (!document.hidden) this.#syncNow(true); }, 2500);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      this.#emitTime();
      this.#syncNow(false);
    });
  }

  #request(action, payload = {}) {
    if (!this.canControl()) {
      this.onControl?.({ denied: true, action });
      return false;
    }
    this.onControl?.({ action, ...payload });
    return true;
  }

  clear() {
    this.url = "";
    this.alias.clear();
    this.state = { url: "", playing: false, time: 0, at: Date.now(), rate: 1 };
    this.destroyHls();
    this.onLevels?.(null);
    this.onAudio?.(null);
    this.onText?.(null);
    this.video.removeAttribute("src");
    this.video.load();
    this.cues = [];
    this.sets = [];
    this.activeSet = "";
    this.lastCue = "";
    this.onTime?.({ current: 0, duration: 0 });
  }

  destroyHls() {
    if (this.hls) { try { this.hls.destroy(); } catch {} this.hls = null; }
  }

  aliasSource(from, to) {
    if (from && to) this.alias.set(from, to);
  }

  setUrl(url) {
    const real = this.alias.get(url) || url;
    if (!real || real === this.url) return;
    this.url = real;
    this.destroyHls();
    this.cues = [];
    this.sets = [];
    this.activeSet = "";
    this.subsOffset = 0;
    this.lastCue = "";
    const isHls = /\.m3u8($|\?)/i.test(real);
    if (isHls) {
      if (window.Hls?.isSupported()) this.#startHls(real);
      else this.#loadHlsEngine(real);
      return;
    }
    this.onLevels?.(null);
    this.onAudio?.(null);
    this.video.src = real;
  }

  /* The HLS engine is only downloaded when a stream actually needs it. */
  async #loadHlsEngine(url) {
    if (!this.hlsLoader) {
      this.hlsLoader = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "assets/js/hls.min.js";
        script.onload = resolve;
        script.onerror = reject;
        document.head.append(script);
      }).catch(() => null);
    }
    await this.hlsLoader;
    if (this.url !== url) return;
    if (!window.Hls?.isSupported()) {
      this.onLevels?.(null);
      this.onAudio?.(null);
      return this.onError?.("format");
    }
    this.#startHls(url);
  }

  #startHls(url) {
    this.hls = new window.Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 30 });
    this.hlsErrors = { net: 0, media: 0 };
    this.hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      this.hlsErrors = { net: 0, media: 0 };
      this.#emitLevels(); this.#emitAudio(); this.#emitText();
    });
    this.hls.on(window.Hls.Events.LEVEL_SWITCHED, () => this.#emitLevels());
    this.hls.on(window.Hls.Events.AUDIO_TRACKS_UPDATED, () => this.#emitAudio());
    this.hls.on(window.Hls.Events.AUDIO_TRACK_SWITCHED, () => this.#emitAudio());
    this.hls.on(window.Hls.Events.SUBTITLE_TRACKS_UPDATED, () => this.#emitText());
    this.hls.on(window.Hls.Events.SUBTITLE_TRACK_SWITCHED, () => this.#emitText());
    this.hls.on(window.Hls.Events.ERROR, (_evt, data) => {
      if (!data?.fatal) return;
      const errs = this.hlsErrors || (this.hlsErrors = { net: 0, media: 0 });
      if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
        if (++errs.net > 6) { this.onError?.("network"); return; }
        this.hls.startLoad();
      } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
        if (++errs.media > 3) { this.onError?.("format"); return; }
        this.hls.recoverMediaError();
      } else this.onError?.("format");
    });
    this.hls.loadSource(url);
    this.hls.attachMedia(this.video);
  }

  #emitLevels() {
    if (!this.hls) return;
    const levels = (this.hls.levels || []).map((l, i) => ({
      i,
      height: l.height || 0,
      name: l.name || ""
    }));
    this.onLevels?.({ levels, current: this.hls.currentLevel, auto: this.hls.autoLevelEnabled });
  }

  setLevel(i) {
    if (!this.hls) return;
    this.hls.currentLevel = Number(i);
  }

  #emitAudio() {
    if (!this.hls) {
      const list = this.video.audioTracks;
      if (!list || list.length < 2) { this.onAudio?.(null); return; }
      const tracks = [];
      let current = 0;
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        tracks.push({ i, name: a.label || a.language || `Track ${i + 1}`, lang: a.language || "" });
        if (a.enabled) current = i;
      }
      this.onAudio?.({ tracks, current });
      return;
    }
    const list = this.hls.audioTracks || [];
    if (!list.length) { this.onAudio?.(null); return; }
    const tracks = list.map((a, i) => ({ i, name: a.name || "", lang: a.lang || "" }));
    this.onAudio?.({ tracks, current: this.hls.audioTrack ?? 0 });
  }

  setAudio(i) {
    const n = Number(i);
    if (this.hls) { this.hls.audioTrack = n; return; }
    const list = this.video.audioTracks;
    if (list) for (let k = 0; k < list.length; k++) list[k].enabled = k === n;
  }

  #emitText() {
    if (this.hls) {
      const list = this.hls.subtitleTracks || [];
      if (!list.length) { this.onText?.(null); return; }
      const tracks = list.map((s, i) => ({
        i,
        name: s.name || s.lang || `Subtitle ${i + 1}`,
        lang: s.lang || ""
      }));
      this.onText?.({ tracks, current: this.hls.subtitleTrack ?? -1 });
      return;
    }
    const list = this.video.textTracks;
    if (!list) { this.onText?.(null); return; }
    const tracks = [];
    let current = -1;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (t.kind !== "subtitles" && t.kind !== "captions") continue;
      tracks.push({ i, name: t.label || t.language || `Subtitle ${tracks.length + 1}`, lang: t.language || "" });
      if (t.mode === "showing") current = i;
    }
    if (!tracks.length) { this.onText?.(null); return; }
    this.onText?.({ tracks, current });
  }

  setTextTrack(i) {
    const want = Number(i);
    if (this.hls) {
      this.hls.subtitleTrack = Number.isFinite(want) ? want : -1;
      if (this.hls.subtitleDisplay !== undefined) this.hls.subtitleDisplay = want >= 0;
      this.#emitText();
      return;
    }
    const list = this.video.textTracks;
    if (!list) return;
    for (let n = 0; n < list.length; n++) {
      const t = list[n];
      if (t.kind !== "subtitles" && t.kind !== "captions") continue;
      t.mode = n === want ? "showing" : "disabled";
    }
    this.#emitText();
  }

  applyState(state) {
    if (!state) return;
    this.state = state;
    if (state.url) this.setUrl(state.url);
    else { this.clear(); return; }

    this.applying = true;
    const target = this.expectedTime(state);
    const diff = Math.abs((this.video.currentTime || 0) - target);
    if (diff > 1.1 || (!state.playing && diff > 0.35)) {
      this.#setTime(target);
    }
    if (Math.abs(this.video.playbackRate - state.rate) > 0.001) {
      this.video.playbackRate = state.rate;
    }
    if (state.playing) {
      const p = this.video.play();
      if (p?.catch) p.catch(() => {});
    } else {
      this.video.pause();
    }
    setTimeout(() => { this.applying = false; }, 60);
    this.#emitTime();
  }

  expectedTime(state = this.state) {
    if (!state?.playing) return state?.time || 0;
    return (state.time || 0) + ((Date.now() - state.at) / 1000) * (state.rate || 1);
  }

  #setTime(t) {
    this.programmaticSeekAt = performance.now();
    if (this.video.readyState > 0) {
      this.video.currentTime = t;
    } else {
      this.video.addEventListener("loadedmetadata", () => { this.video.currentTime = t; }, { once: true });
    }
  }

  #syncNow(soft = false) {
    if (!this.state?.url || !this.video.duration) return;
    if (this.video.seeking || this.video.readyState < 2) return;
    const host = this.canControl();
    if (!host && !this.state.playing) return;
    const target = this.expectedTime();
    const diff = target - this.video.currentTime;
    if (Math.abs(diff) > (host ? 1.6 : 2.5)) {
      this.applying = true;
      this.#setTime(target);
      setTimeout(() => { this.applying = false; }, 80);
      if (!host) this.video.play().catch(() => {});
      return;
    }
    if (!soft || !this.state.playing) return;
    const desired = this.state.rate || 1;
    let rate = desired;
    if (Math.abs(diff) > (host ? 0.4 : 0.3)) rate = desired * (diff > 0 ? (host ? 1.06 : 1.08) : (host ? 0.94 : 0.92));
    if (Math.abs(this.video.playbackRate - rate) > 0.005) {
      this.applying = true;
      this.video.playbackRate = rate;
      setTimeout(() => { this.applying = false; }, 40);
    }
  }

  #onTimeupdate() {
    this.#emitTime();
    this.#renderSubtitle();
    this.#savePosition();
  }

  #emitTime() {
    this.onTime?.({
      current: this.video.currentTime || 0,
      duration: this.video.duration || 0
    });
  }

  #savePosition() {
    if (!this.url || this.url.startsWith("blob:")) return;
    const d = this.video.duration;
    const t = this.video.currentTime;
    if (!d || !Number.isFinite(d) || t < 5 || d - t < 10) return;
    store.set(`pos:${this.url}`, Math.floor(t));
  }

  #restorePosition() {
    if (this.state?.time > 0) return;
    const saved = store.get(`pos:${this.url}`, 0);
    if (saved > 5 && Math.abs(saved - (this.video.currentTime || 0)) > 5) {
      this.video.currentTime = saved;
    }
  }

  /* ---------- subtitles ---------- */
  setCues(cues, name = "Subtitles") {
    const arr = Array.isArray(cues) ? cues : [];
    const i = this.sets.findIndex((s) => s.name === name);
    if (i >= 0) this.sets[i] = { name, cues: arr };
    else this.sets.push({ name, cues: arr });
    this.activeSet = name;
    this.cues = arr;
    this.lastCue = "";
    this.#renderSubtitle();
  }
  getSubtitleSets() {
    return this.sets.map((s) => ({ name: s.name, count: s.cues.length, active: s.name === this.activeSet }));
  }
  getSubtitleCues(name = this.activeSet) {
    const found = this.sets.find((s) => s.name === name);
    return found ? found.cues : [];
  }
  activateSubtitleSet(name) {
    const found = this.sets.find((s) => s.name === name);
    if (!found) return;
    this.activeSet = name;
    this.cues = found.cues;
    this.lastCue = "";
    this.#renderSubtitle();
  }
  removeSubtitleSet(name) {
    const i = this.sets.findIndex((s) => s.name === name);
    if (i === -1) return;
    this.sets.splice(i, 1);
    if (this.activeSet === name) {
      const next = this.sets[this.sets.length - 1];
      this.cues = next ? next.cues : [];
      this.activeSet = next ? next.name : "";
      this.lastCue = "";
      this.#renderSubtitle();
    }
  }
  setSubsOffset(sec) { this.subsOffset = Number(sec) || 0; this.lastCue = ""; this.#renderSubtitle(); }
  setSubsSize(px) { this.subsSize = Number(px) || 120; this.#applySubsSize(); }
  #applySubsSize() {
    const layer = document.getElementById("subtitleLayer");
    if (layer) layer.style.fontSize = `${this.subsSize / 10}px`;
  }
  #renderSubtitle() {
    const layer = document.getElementById("subtitleLayer");
    if (!layer) return;
    if (!this.cues.length) {
      if (this.lastCue) { layer.innerHTML = ""; this.lastCue = ""; }
      return;
    }
    const t = (this.video.currentTime || 0) - this.subsOffset;
    const cue = this.cues.find((c) => t >= c.start && t <= c.end);
    const text = cue ? cue.text : "";
    if (text === this.lastCue) return;
    this.lastCue = text;
    layer.innerHTML = "";
    if (text) {
      for (const line of text.split("\n")) {
        const span = document.createElement("span");
        span.textContent = line;
        layer.append(span);
      }
    }
    this.#applySubsSize();
  }

  /* ---------- ui actions ---------- */
  togglePlay() {
    if (this.video.paused) this.#request("play");
    else this.#request("pause", { time: this.video.currentTime });
  }
  seekBy(delta) {
    const t = Math.max(0, Math.min((this.video.duration || 0) - 0.2, (this.video.currentTime || 0) + delta));
    this.#request("seek", { time: t });
  }
  seekTo(t) { this.#request("seek", { time: t }); }
  cycleRate() {
    const rates = [1, 1.25, 1.5, 2, 0.75];
    const i = rates.indexOf(this.video.playbackRate);
    const next = rates[(i + 1) % rates.length];
    this.#request("rate", { value: next, time: this.video.currentTime });
    return next;
  }
  async toggleFullscreen() {
    const target = this.frame;
    try {
      if (document.fullscreenElement) { await document.exitFullscreen(); return true; }
      if (target.requestFullscreen) { await target.requestFullscreen(); return true; }
      if (target.webkitRequestFullscreen) { target.webkitRequestFullscreen(); return true; }
      const video = this.video;
      if (video?.webkitEnterFullscreen) { video.webkitEnterFullscreen(); return true; }
    } catch {}
    if (!document.fullscreenElement) {
      /* fullscreen failed (permissions, embedded webview, desktop headless):
         fall back to the in-page theater layout and report failure */
      target.classList.toggle("theater");
      return false;
    }
    return true;
  }
  async togglePiP() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await this.video.requestPictureInPicture();
    } catch {}
  }
  toggleTheater() {
    this.frame.classList.toggle("theater");
    return this.frame.classList.contains("theater");
  }
  fmt(sec) { return fmtTime(sec); }
  destroy() {
    clearInterval(this.timer);
    this.destroyHls();
  }
}
