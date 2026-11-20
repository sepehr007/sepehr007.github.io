import { apiUrl, apiGetToken } from "./api.js";

export function uploadFile(file, { kind, token, field = "file", onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(Object.assign(new Error("فایلی انتخاب نشده."), { code: "empty_file" }));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open("POST", apiUrl(`/uploads?kind=${encodeURIComponent(kind || "")}`));
    const bearer = token || apiGetToken();
    if (bearer) xhr.setRequestHeader("Authorization", `Bearer ${bearer}`);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name || field));
    xhr.setRequestHeader("X-File-Type", file.type || "application/octet-stream");
    xhr.timeout = 120_000;
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
    });
    xhr.addEventListener("load", () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText || "null"); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100);
        resolve(data);
        return;
      }
      reject(Object.assign(new Error(data?.message || "بارگذاری انجام نشد."), { status: xhr.status, code: data?.error || `http_${xhr.status}` }));
    });
    xhr.addEventListener("error", () => reject(Object.assign(new Error("اتصال در حین بارگذاری قطع شد؛ دوباره تلاش کن."), { code: "network_error" })));
    xhr.addEventListener("timeout", () => reject(Object.assign(new Error("بارگذاری زمان‌بر شد؛ دوباره تلاش کن."), { code: "timeout" })));
    xhr.addEventListener("abort", () => reject(Object.assign(new Error("بارگذاری لغو شد."), { code: "aborted" })));
    xhr.send(file);
  });
}

export function absoluteFileUrl(url) {
  const raw = String(url || "");
  if (!raw) return "";
  try {
    return new URL(raw, apiUrl("")).href;
  } catch {
    return raw;
  }
}

export function uploadProgressRow(label = "بارگذاری") {
  const bar = document.createElement("span");
  bar.className = "up-bar";
  const fill = document.createElement("span");
  fill.className = "up-bar-fill";
  bar.append(fill);
  const text = document.createElement("small");
  text.className = "up-text";
  const row = document.createElement("div");
  row.className = "up-row";
  row.append(bar, text);
  const set = (value) => {
    const pct = Math.max(0, Math.min(100, Number(value) || 0));
    fill.style.width = `${pct}%`;
    text.textContent = `${label}… ${pct}%`;
  };
  set(0);
  row.setProgress = set;
  return row;
}
