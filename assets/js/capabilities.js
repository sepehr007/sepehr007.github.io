/* Real capability detection for mobile/desktop browsers.
   Every flag here is measured in the current browser — nothing is assumed
   from the user agent alone. UI that depends on a flag must explain the
   limitation instead of silently failing. */

const probeVideo = () => {
  try { return document.createElement("video"); } catch { return null; }
};

function parseBrowser(ua) {
  if (/SamsungBrowser\/(\d+(?:\.\d+)?)/.test(ua)) return { name: "Samsung Internet", engine: "chromium", version: RegExp.$1 };
  if (/EdgA?\/(\d+(?:\.\d+)?)/.test(ua)) return { name: "Edge", engine: "chromium", version: RegExp.$1 };
  if (/OPR\/(\d+(?:\.\d+)?)/.test(ua)) return { name: "Opera", engine: "chromium", version: RegExp.$1 };
  if (/Firefox\/(\d+(?:\.\d+)?)/.test(ua)) return { name: "Firefox", engine: "gecko", version: RegExp.$1 };
  if (/CriOS\/(\d+(?:\.\d+)?)/.test(ua)) return { name: "Chrome iOS", engine: "webkit", version: RegExp.$1 };
  if (/Chrome\/(\d+(?:\.\d+)?)/.test(ua)) return { name: "Chrome", engine: "chromium", version: RegExp.$1 };
  if (/Version\/(\d+(?:\.\d+)?).*Safari/.test(ua)) return { name: "Safari", engine: "webkit", version: RegExp.$1 };
  return { name: "Browser", engine: "unknown", version: "" };
}

function parseOs(ua) {
  if (/Android (\d+(?:\.\d+)?)/.test(ua)) return { name: "Android", version: RegExp.$1 };
  if (/iPhone|iPad|iPod/.test(ua)) return { name: "iOS", version: "" };
  if (/Windows NT ([\d.]+)/.test(ua)) return { name: "Windows", version: RegExp.$1 };
  if (/Mac OS X/.test(ua)) return { name: "macOS", version: "" };
  if (/Linux/.test(ua)) return { name: "Linux", version: "" };
  return { name: "Unknown", version: "" };
}

export function detectCapabilities() {
  const ua = navigator.userAgent || "";
  const video = probeVideo();
  const canPlay = (type) => {
    try { return !!video?.canPlayType(type); } catch { return false; }
  };
  const secure = !!window.isSecureContext;
  const sw = "serviceWorker" in navigator;
  const media = navigator.mediaDevices;
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
  const standalone = (() => {
    try {
      if (navigator.standalone) return true;
      return window.matchMedia("(display-mode: standalone)").matches ||
        window.matchMedia("(display-mode: minimal-ui)").matches;
    } catch { return false; }
  })();

  return {
    browser: parseBrowser(ua),
    os: parseOs(ua),
    secure,
    standalone,
    mobile: /Android|iPhone|iPad|iPod|Mobile/.test(ua),
    touch: (navigator.maxTouchPoints || 0) > 0 || matchMedia("(pointer: coarse)").matches,
    coarse: matchMedia("(pointer: coarse)").matches,
    hover: matchMedia("(hover: hover)").matches,
    deviceMemory: Number(navigator.deviceMemory) || 0,
    cores: Number(navigator.hardwareConcurrency) || 0,
    dpr: Number(window.devicePixelRatio) || 1,
    connection: conn ? { type: conn.effectiveType || "", downlink: Number(conn.downlink) || 0, saveData: !!conn.saveData } : null,
    webrtc: typeof RTCPeerConnection === "function",
    mic: !!(media?.getUserMedia) && secure,
    screenShare: !!(media?.getDisplayMedia) && secure,
    fullscreen: !!document.fullscreenEnabled || !!(video?.webkitEnterFullscreen),
    pip: !!(document.pictureInPictureEnabled && video?.requestPictureInPicture) || !!(video?.webkitSetPresentationMode),
    wakeLock: "wakeLock" in navigator,
    notifications: "Notification" in window,
    push: "PushManager" in window && sw,
    sw,
    vibrate: typeof navigator.vibrate === "function",
    share: typeof navigator.share === "function",
    orientationLock: !!(screen.orientation && typeof screen.orientation.lock === "function"),
    cast: typeof HTMLVideoElement !== "undefined" && "remote" in HTMLVideoElement.prototype,
    hlsNative: canPlay("application/vnd.apple.mpegurl") || canPlay("application/x-mpegURL"),
    hlsMse: !!(window.MediaSource || window.ManagedMediaSource),
    mp4: canPlay('video/mp4; codecs="avc1.42E01E, mp4a.40.2"') === "probably" || canPlay('video/mp4; codecs="avc1.42E01E, mp4a.40.2"') === "maybe",
    mp4Hevc: canPlay('video/mp4; codecs="hvc1.1.6.L93.B0"') !== "",
    webm: canPlay('video/webm; codecs="vp9, opus"') !== "",
    ogg: canPlay('video/ogg; codecs="theora"') !== ""
  };
}

export const CAPS = detectCapabilities();

export function supports(key) {
  return !!CAPS[key];
}

const status = (ok, limited = false) => (ok ? (limited ? "limited" : "ok") : "no");

/* Rows for the in-app device card. `note` explains the fallback honestly. */
export function capabilityRows(lang = "fa") {
  const fa = lang === "fa";
  const rows = [];
  const add = (key, faLabel, enLabel, ok, faNote, enNote, limited = false) =>
    rows.push({ key, label: fa ? faLabel : enLabel, status: status(ok, limited), note: fa ? faNote : enNote });

  add("webrtc", "اتصال هم‌زمان و صدای زنده", "Live sync and voice", CAPS.webrtc,
    CAPS.webrtc ? "فعال" : "این مرورگر WebRTC ندارد؛ اتاق فقط تماشای انفرادی است.",
    CAPS.webrtc ? "Available" : "No WebRTC in this browser; rooms become solo viewing.");
  add("mic", "میکروفون", "Microphone", CAPS.mic, CAPS.mic ? "فعال" : "ورودی صدا در دسترس نیست یا اتصال امن نیست.",
    CAPS.mic ? "Available" : "No microphone access, or the page is not on HTTPS.");
  add("screenShare", "اشتراک صفحه", "Screen share", CAPS.screenShare,
    CAPS.screenShare ? "فعال" : "مرورگر موبایل معمولاً پخش صفحه را نمی‌دهد؛ فایل ویدیو بفرست.",
    CAPS.screenShare ? "Available" : "Mobile browsers usually block it; send a video file instead.");
  add("fullscreen", "تمام‌صفحه", "Fullscreen", CAPS.fullscreen,
    CAPS.fullscreen ? "فعال" : "به‌جای آن حالت سینمایی داخل صفحه اجرا می‌شود.",
    CAPS.fullscreen ? "Available" : "The in-page theater mode is used instead.", true);
  add("pip", "تصویر در تصویر", "Picture-in-Picture", CAPS.pip,
    CAPS.pip ? "فعال" : "در این مرورگر نیست؛ دکمه‌اش پنهان می‌شود.",
    CAPS.pip ? "Available" : "Unavailable here; the button stays hidden.");
  add("wakeLock", "روشن ماندن صفحه", "Keep screen awake", CAPS.wakeLock,
    CAPS.wakeLock ? "فعال" : "در این مرورگر نیست؛ ممکن است صفحه هنگام تماشا خاموش شود.",
    CAPS.wakeLock ? "Available" : "Unavailable; the screen may sleep during playback.");
  add("notifications", "اعلان مرورگر", "Browser notifications", CAPS.notifications,
    CAPS.notifications ? "قابل فعال‌سازی" : "این مرورگر اعلان نمی‌دهد.",
    CAPS.notifications ? "Can be enabled" : "This browser has no notification support.");
  add("push", "اعلان در پس‌زمینه", "Background push", CAPS.push,
    CAPS.push ? "قابل استفاده با سرور" : "بدون سرور اعلان، فقط وقتی تب باز است خبر می‌دهیم.",
    CAPS.push ? "Usable with a server" : "Without a push server we only alert while the tab is open.", true);
  add("share", "اشتراک لینک", "Share sheet", CAPS.share,
    CAPS.share ? "فعال" : "لینک با دکمهٔ کپی به اشتراک گذاشته می‌شود.",
    CAPS.share ? "Available" : "Link sharing falls back to copy.");
  add("vibrate", "لرزش", "Vibration", CAPS.vibrate,
    CAPS.vibrate ? "فعال" : "در این دستگاه نیست.",
    CAPS.vibrate ? "Available" : "Not available on this device.", true);
  add("orientationLock", "قفل چرخش", "Orientation lock", CAPS.orientationLock,
    CAPS.orientationLock ? "فعال در تمام‌صفحه" : "چرخش را کاربر کنترل می‌کند.",
    CAPS.orientationLock ? "Works in fullscreen" : "The user controls rotation.", true);
  add("hlsNative", "HLS بدون افزونه", "Native HLS", CAPS.hlsNative,
    CAPS.hlsNative ? "پخش مستقیم" : (CAPS.hlsMse ? "با موتور داخلی HLS پخش می‌شود." : "HLS پخش نمی‌شود؛ MP4 بفرست."),
    CAPS.hlsNative ? "Direct playback" : (CAPS.hlsMse ? "Played through the bundled HLS engine." : "No HLS; send MP4."), true);
  add("mp4", "MP4 (H.264/AAC)", "MP4 (H.264/AAC)", CAPS.mp4,
    CAPS.mp4 ? "پخش مستقیم" : "این مرورگر H.264 را پخش نمی‌کند؛ فایل تبدیل می‌شود.",
    CAPS.mp4 ? "Direct playback" : "H.264 is not supported; local files are converted.");
  add("webm", "WebM (VP9/Opus)", "WebM (VP9/Opus)", CAPS.webm,
    CAPS.webm ? "پخش مستقیم" : "WebM در این مرورگر نیست.",
    CAPS.webm ? "Direct playback" : "WebM is not supported here.", true);
  add("hevc", "H.265/HEVC", "H.265/HEVC", CAPS.mp4Hevc,
    CAPS.mp4Hevc ? "احتمالاً پخش می‌شود" : "معمولاً پخش نمی‌شود؛ تبدیل لازم است.",
    CAPS.mp4Hevc ? "Likely supported" : "Usually unsupported; conversion needed.", true);
  return rows;
}

export function deviceSummary(lang = "fa") {
  const fa = lang === "fa";
  const bits = [];
  if (CAPS.browser.name) bits.push(`${CAPS.browser.name}${CAPS.browser.version ? " " + CAPS.browser.version.split(".")[0] : ""}`);
  if (CAPS.os.name) bits.push(CAPS.os.name);
  bits.push(fa ? (CAPS.standalone ? "نصب‌شده" : "در مرورگر") : (CAPS.standalone ? "Installed" : "In browser"));
  if (CAPS.deviceMemory) bits.push(`${CAPS.deviceMemory} GB RAM`);
  if (CAPS.cores) bits.push(`${CAPS.cores} ${fa ? "هسته" : "cores"}`);
  return bits.join(" · ");
}
