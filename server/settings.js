import { ensureStore, getAppSetting, setAppSetting } from "./userStore.js";

const KEY = "connections";

function emptyConnections() {
  return {
    mail: {
      enabled: false,
      host: "",
      port: 587,
      secure: false,
      user: "",
      pass: "",
      from: ""
    },
    sms: {
      enabled: false,
      provider: "",
      apiKey: "",
      sender: "",
      webhookUrl: "",
      twilioSid: "",
      twilioToken: "",
      twilioFrom: ""
    }
  };
}

let state = null;
let loading = null;

function clean(value, max = 300) {
  return String(value ?? "").trim().slice(0, max);
}

function normalize(raw) {
  const base = emptyConnections();
  const src = raw && typeof raw === "object" ? raw : {};
  const mail = src.mail && typeof src.mail === "object" ? src.mail : {};
  const sms = src.sms && typeof src.sms === "object" ? src.sms : {};
  const port = Number(mail.port);
  base.mail = {
    enabled: Boolean(mail.enabled),
    host: clean(mail.host, 200),
    port: Number.isFinite(port) && port > 0 && port < 65536 ? Math.round(port) : 587,
    secure: Boolean(mail.secure),
    user: clean(mail.user, 200),
    pass: String(mail.pass ?? "").slice(0, 400),
    from: clean(mail.from, 200)
  };
  base.sms = {
    enabled: Boolean(sms.enabled),
    provider: ["kavenegar", "twilio", "webhook"].includes(sms.provider) ? sms.provider : "",
    apiKey: String(sms.apiKey ?? "").slice(0, 400),
    sender: clean(sms.sender, 40),
    webhookUrl: clean(sms.webhookUrl, 300),
    twilioSid: clean(sms.twilioSid, 80),
    twilioToken: String(sms.twilioToken ?? "").slice(0, 400),
    twilioFrom: clean(sms.twilioFrom, 40)
  };
  return base;
}

export async function loadConnections(force = false) {
  if (state && !force) return state;
  if (loading && !force) return loading;
  loading = (async () => {
    try {
      await ensureStore();
      const raw = await getAppSetting(KEY);
      state = raw ? normalize(JSON.parse(raw)) : emptyConnections();
    } catch {
      state = state || emptyConnections();
    } finally {
      loading = null;
    }
    return state;
  })();
  return loading;
}

export function connections() {
  return state || emptyConnections();
}

const SECRET_FIELDS = {
  mail: ["pass"],
  sms: ["apiKey", "twilioToken"]
};

export async function saveConnections(patch) {
  const current = await loadConnections();
  const merged = normalize(current);
  const input = patch && typeof patch === "object" ? patch : {};
  for (const section of ["mail", "sms"]) {
    const next = input[section];
    if (!next || typeof next !== "object") continue;
    for (const key of Object.keys(merged[section])) {
      if (!(key in next)) continue;
      const isSecret = SECRET_FIELDS[section].includes(key);
      if (isSecret && (next[key] === "" || next[key] === undefined || next[key] === null)) continue;
      merged[section][key] = next[key];
    }
    if (Array.isArray(next.clear)) {
      for (const key of next.clear) {
        if (SECRET_FIELDS[section].includes(key)) merged[section][key] = "";
      }
    }
  }
  const normalized = normalize(merged);
  await ensureStore();
  try {
    await setAppSetting(KEY, JSON.stringify(normalized));
  } catch {
    return { ok: false, error: "store_unavailable" };
  }
  state = normalized;
  return { ok: true, connections: normalized };
}

export function safeConnections() {
  const cfg = connections();
  return {
    mail: {
      enabled: cfg.mail.enabled,
      host: cfg.mail.host,
      port: cfg.mail.port,
      secure: cfg.mail.secure,
      user: cfg.mail.user,
      from: cfg.mail.from,
      passSet: Boolean(cfg.mail.pass)
    },
    sms: {
      enabled: cfg.sms.enabled,
      provider: cfg.sms.provider,
      sender: cfg.sms.sender,
      webhookUrl: cfg.sms.webhookUrl,
      twilioSid: cfg.sms.twilioSid,
      twilioFrom: cfg.sms.twilioFrom,
      apiKeySet: Boolean(cfg.sms.apiKey),
      twilioTokenSet: Boolean(cfg.sms.twilioToken)
    }
  };
}
