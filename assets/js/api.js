const TOKEN_KEY = "wt.jwt";
const LEGACY_TOKEN_KEY = "wt.apiToken";
const BASE_KEY = "wt.apiBase";
const DEFAULT_BASE = "http://localhost:3001/api";

export class ApiError extends Error {
  constructor(message, { status = 0, code = "network_error", payload = null } = {}) {
    super(message || "Request failed");
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

function readStorage(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function writeStorage(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {}
}

function resolveBase() {
  const override = globalThis.WT_API_BASE;
  if (typeof override === "string" && override.trim()) return override.trim().replace(/\/+$/, "");
  const stored = readStorage(BASE_KEY);
  if (stored) return stored.replace(/\/+$/, "");
  return DEFAULT_BASE;
}

let apiBase = resolveBase();

export function getApiBase() {
  return apiBase;
}

export function setApiBase(base) {
  const clean = String(base || "").trim().replace(/\/+$/, "");
  apiBase = clean || DEFAULT_BASE;
  writeStorage(BASE_KEY, clean ? apiBase : "");
  return apiBase;
}

export function apiUrl(path = "") {
  const clean = String(path || "");
  if (!clean) return apiBase;
  return `${apiBase}${clean.startsWith("/") ? clean : `/${clean}`}`;
}

export function apiGetToken() {
  const token = readStorage(TOKEN_KEY);
  if (token) return token;
  const legacy = readStorage(LEGACY_TOKEN_KEY);
  if (legacy) {
    writeStorage(TOKEN_KEY, legacy);
    writeStorage(LEGACY_TOKEN_KEY, "");
    return legacy;
  }
  return "";
}

export function apiSetToken(token) {
  writeStorage(TOKEN_KEY, String(token || ""));
  writeStorage(LEGACY_TOKEN_KEY, "");
  return apiGetToken();
}

export function apiClearToken() {
  writeStorage(TOKEN_KEY, "");
  writeStorage(LEGACY_TOKEN_KEY, "");
}

export function apiHasToken() {
  return Boolean(apiGetToken());
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !(value instanceof FormData) && !(value instanceof Blob);
}

export async function apiFetch(path, options = {}) {
  const {
    method = "GET",
    body,
    headers = {},
    token,
    auth = true,
    timeoutMs = 15000,
    signal,
    credentials = "omit"
  } = options;

  const bearer = token === false ? "" : token || (auth ? apiGetToken() : "");
  const controller = new AbortController();
  const timeout = Number(timeoutMs) > 0 ? setTimeout(() => controller.abort(), Number(timeoutMs)) : 0;

  const abortFromCaller = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortFromCaller, { once: true });
  }

  const finalHeaders = { Accept: "application/json", ...headers };
  let payload = body;

  if (isPlainObject(body)) {
    finalHeaders["Content-Type"] = finalHeaders["Content-Type"] || "application/json";
    payload = JSON.stringify(body);
  }
  if (bearer) finalHeaders.Authorization = `Bearer ${bearer}`;

  let res;
  try {
    res = await fetch(apiUrl(path), {
      method,
      headers: finalHeaders,
      body: payload,
      signal: controller.signal,
      credentials,
      cache: "no-store"
    });
  } catch (err) {
    const aborted = err?.name === "AbortError";
    throw new ApiError(aborted ? "Request timed out" : "Cannot reach the server", {
      status: 0,
      code: aborted ? "timeout" : "network_error"
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signal) signal.removeEventListener("abort", abortFromCaller);
  }

  const type = res.headers.get("content-type") || "";
  let data = null;
  try {
    data = type.includes("application/json") ? await res.json() : await res.text();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const message = (data && typeof data === "object" && data.message) || res.statusText || "Request failed";
    const code = (data && typeof data === "object" && data.error) || `http_${res.status}`;
    if (res.status === 401 && bearer) {
      apiClearToken();
      try {
        globalThis.dispatchEvent?.(new CustomEvent("wt:api-unauthorized"));
      } catch {}
    }
    throw new ApiError(message, { status: res.status, code, payload: data });
  }

  return data;
}

export function apiHealth() {
  return apiFetch("/health", { auth: false, timeoutMs: 5000 });
}

export const authApi = {
  register({ username, email, password, avatar }) {
    return apiFetch("/auth/register", {
      method: "POST",
      auth: false,
      body: { username, email, password, avatar }
    });
  },
  login({ identifier, email, username, password }) {
    return apiFetch("/auth/login", {
      method: "POST",
      auth: false,
      body: { identifier: identifier || email || username, password }
    }).then((res) => {
      if (res?.token) apiSetToken(res.token);
      return res;
    });
  },
  me() {
    return apiFetch("/auth/me");
  },
  logout() {
    return apiFetch("/auth/logout", { method: "POST" }).finally(() => apiClearToken());
  }
};

export function apiConnectSocket({ url, onMessage, onOpen, onClose, onError } = {}) {
  const base = apiBase.replace(/\/api\/?$/, "");
  const target = url || `${base.replace(/^http/, "ws")}/ws`;
  const socket = new WebSocket(target);
  socket.addEventListener("open", (event) => onOpen?.(event));
  socket.addEventListener("close", (event) => onClose?.(event));
  socket.addEventListener("error", (event) => onError?.(event));
  socket.addEventListener("message", (event) => {
    let data = null;
    try {
      data = JSON.parse(event.data);
    } catch {
      data = event.data;
    }
    onMessage?.(data, event);
  });
  return socket;
}
