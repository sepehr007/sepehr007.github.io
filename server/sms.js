import fs from "node:fs";
import path from "node:path";
import { loadConnections, connections } from "./settings.js";
import { appConfig } from "./config.js";

const DATA_DIR = appConfig.dataDir;
const OUTBOX_FILE = path.join(DATA_DIR, "sms-outbox.jsonl");
const SITE_NAME = "هم‌تماشا";
const TIMEOUT_MS = 15_000;

let lastError = "";

function envSms() {
  const provider = String(process.env.SMS_PROVIDER || "").trim().toLowerCase();
  if (!["kavenegar", "twilio", "webhook"].includes(provider)) return null;
  return {
    provider,
    apiKey: process.env.SMS_API_KEY || "",
    sender: process.env.SMS_SENDER || "",
    webhookUrl: process.env.SMS_WEBHOOK_URL || "",
    twilioSid: process.env.SMS_TWILIO_SID || "",
    twilioToken: process.env.SMS_TWILIO_TOKEN || "",
    twilioFrom: process.env.SMS_TWILIO_FROM || ""
  };
}

function effectiveSms() {
  const saved = connections().sms;
  if (saved?.enabled && ["kavenegar", "twilio", "webhook"].includes(saved.provider)) return saved;
  return envSms();
}

export function smsMode() {
  const cfg = effectiveSms();
  return cfg ? cfg.provider : "outbox";
}

export function smsState() {
  const cfg = effectiveSms();
  return {
    mode: cfg ? cfg.provider : "outbox",
    sender: cfg?.sender || cfg?.twilioFrom || "",
    error: lastError
  };
}

function twilioAddress(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("98")) return `+${digits}`;
  if (digits.startsWith("0")) return `+98${digits.slice(1)}`;
  return `+${digits}`;
}

async function fetchJson(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { ok: res.ok, status: res.status, data, text };
  } finally {
    clearTimeout(timer);
  }
}

async function sendKavenegar(cfg, to, text) {
  const params = new URLSearchParams({ receptor: to, message: text });
  if (cfg.sender) params.set("sender", cfg.sender);
  const url = `https://api.kavenegar.com/v1/${encodeURIComponent(cfg.apiKey)}/sms/send.json`;
  const res = await fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
  const status = Number(res.data?.return?.status || 0);
  if (!res.ok || status !== 200) {
    const message = res.data?.return?.message || `HTTP ${res.status}`;
    throw new Error(`kavenegar: ${message}`);
  }
  return { id: String(res.data?.entries?.[0]?.messageid || "") };
}

async function sendTwilio(cfg, to, text) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.twilioSid)}/Messages.json`;
  const body = new URLSearchParams({ To: twilioAddress(to), From: cfg.twilioFrom, Body: text });
  const auth = Buffer.from(`${cfg.twilioSid}:${cfg.twilioToken}`).toString("base64");
  const res = await fetchJson(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${auth}`
    },
    body: body.toString()
  });
  if (!res.ok) {
    const message = res.data?.message || `HTTP ${res.status}`;
    throw new Error(`twilio: ${message}`);
  }
  return { id: String(res.data?.sid || "") };
}

async function sendWebhook(cfg, to, text) {
  const res = await fetchJson(cfg.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to, message: text, sender: cfg.sender || "", apiKey: cfg.apiKey || "", site: SITE_NAME })
  });
  if (!res.ok) throw new Error(`webhook: HTTP ${res.status}`);
  return { id: String(res.data?.id || "") };
}

export async function sendSms({ to, text }) {
  await loadConnections();
  const cfg = effectiveSms();
  if (!cfg) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.appendFileSync(
        OUTBOX_FILE,
        `${JSON.stringify({ at: new Date().toISOString(), to, text })}\n`,
        "utf8"
      );
      lastError = "";
      return { ok: true, mode: "outbox", id: "" };
    } catch (err) {
      lastError = err.message;
      return { ok: false, mode: "outbox", error: err.message };
    }
  }
  try {
    let out;
    if (cfg.provider === "kavenegar") out = await sendKavenegar(cfg, to, text);
    else if (cfg.provider === "twilio") out = await sendTwilio(cfg, to, text);
    else out = await sendWebhook(cfg, to, text);
    lastError = "";
    return { ok: true, mode: cfg.provider, id: out?.id || "" };
  } catch (err) {
    lastError = err.message;
    console.error("[sms] send failed:", err.message);
    return { ok: false, mode: cfg.provider, error: err.message };
  }
}

export function resetSmsText(code, minutes) {
  return `${SITE_NAME}: کد بازیابی ${code} — ${minutes} دقیقه معتبر است. اگر خودت درخواست ندادی، نادیده بگیر.`;
}

export function sendResetSms({ to, code, minutes }) {
  return sendSms({ to, text: resetSmsText(code, minutes) });
}

export function sendTestSms({ to }) {
  return sendSms({ to, text: `${SITE_NAME}: این یک پیام آزمایشی از کنسول مالک است. اتصال پیامک درست کار می‌کند.` });
}
