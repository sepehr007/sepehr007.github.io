import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import { loadConnections, connections } from "./settings.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(HERE, "data");
const OUTBOX_FILE = path.join(DATA_DIR, "mail-outbox.jsonl");
const FROM = process.env.MAIL_FROM || "هم‌تماشا <no-reply@hammatama.ir>";
const SITE_NAME = "هم‌تماشا";

let transport = null;
let transportMode = "";
let transportKey = "";
let lastError = "";

function envMail() {
  const host = String(process.env.SMTP_HOST || "").trim();
  if (!host) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  return {
    host,
    port,
    secure: String(process.env.SMTP_SECURE || "").toLowerCase() === "true" || port === 465,
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: FROM
  };
}

function effectiveMail() {
  const saved = connections().mail;
  if (saved?.enabled && saved.host) {
    return {
      host: saved.host,
      port: Number(saved.port) || 587,
      secure: Boolean(saved.secure) || Number(saved.port) === 465,
      user: saved.user || "",
      pass: saved.pass || "",
      from: saved.from || FROM
    };
  }
  return envMail();
}

export function applyMailSettings() {
  transport = null;
  transportKey = "";
  transportMode = "";
}

function activeTransport() {
  const cfg = effectiveMail();
  if (!cfg) {
    transport = null;
    transportKey = "";
    transportMode = "outbox";
    return { mode: "outbox", cfg: null };
  }
  const key = JSON.stringify([cfg.host, cfg.port, cfg.secure, cfg.user, cfg.pass]);
  if (!transport || key !== transportKey) {
    transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.user || cfg.pass ? { user: cfg.user, pass: cfg.pass } : undefined,
      connectionTimeout: 12_000,
      greetingTimeout: 12_000,
      socketTimeout: 20_000
    });
    transportKey = key;
    transportMode = "smtp";
  }
  return { mode: "smtp", cfg };
}

export function mailMode() {
  return effectiveMail() ? "smtp" : "outbox";
}

export function mailState() {
  const cfg = effectiveMail();
  return {
    mode: cfg ? "smtp" : "outbox",
    from: cfg?.from || FROM,
    host: cfg?.host || "",
    error: lastError
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function layout({ title, intro, code, link, cta, note }) {
  const codeBlock = code
    ? `<div style="margin:22px 0;padding:16px 10px;border-radius:14px;background:#0f1420;border:1px solid #26304a;text-align:center;font-family:Consolas,monospace;font-size:28px;letter-spacing:10px;color:#ffffff;direction:ltr">${escapeHtml(code)}</div>`
    : "";
  const button = link
    ? `<div style="text-align:center;margin:24px 0"><a href="${escapeHtml(link)}" style="display:inline-block;padding:13px 28px;border-radius:12px;background:#3d6bff;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600">${escapeHtml(cta)}</a></div>
       <p style="margin:0;color:#8a93a8;font-size:12px;direction:ltr;word-break:break-all;text-align:center">${escapeHtml(link)}</p>`
    : "";
  return `<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#07080d;font-family:Tahoma,'Segoe UI',sans-serif;color:#e8ecf5">
<div style="max-width:560px;margin:0 auto;padding:32px 20px">
  <div style="font-size:20px;font-weight:700;color:#ffffff;margin-bottom:6px">${SITE_NAME}</div>
  <div style="height:3px;width:56px;background:#3d6bff;border-radius:3px;margin-bottom:24px"></div>
  <div style="background:#101521;border:1px solid #1e2638;border-radius:18px;padding:26px">
    <h1 style="margin:0 0 14px;font-size:19px;color:#ffffff">${escapeHtml(title)}</h1>
    <p style="margin:0;font-size:14px;line-height:2;color:#c3cad9">${intro}</p>
    ${codeBlock}
    ${button}
    <p style="margin:20px 0 0;font-size:12px;line-height:1.9;color:#8a93a8">${note}</p>
  </div>
  <p style="margin:18px 0 0;font-size:11px;color:#5f6879;text-align:center">اگر این درخواست از طرف تو نبود، این ایمیل را نادیده بگیر. حسابت امن می‌ماند.</p>
</div>
</body></html>`;
}

async function deliver({ to, subject, text, html }) {
  await loadConnections();
  const { mode, cfg } = activeTransport();
  if (mode === "smtp") {
    try {
      const info = await transport.sendMail({ from: cfg.from || FROM, to, subject, text, html });
      lastError = "";
      return { ok: true, mode: "smtp", id: info.messageId || "" };
    } catch (err) {
      lastError = err.message;
      console.error("[mail] send failed:", err.message);
      return { ok: false, mode: "smtp", error: err.message };
    }
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(
      OUTBOX_FILE,
      `${JSON.stringify({ at: new Date().toISOString(), to, subject, text, html })}\n`,
      "utf8"
    );
    lastError = "";
    return { ok: true, mode: "outbox", id: "" };
  } catch (err) {
    lastError = err.message;
    return { ok: false, mode: "outbox", error: err.message };
  }
}

export async function sendVerificationMail({ to, username, code, link, minutes }) {
  const subject = `کد تأیید ایمیل ${SITE_NAME}: ${code}`;
  const intro = `سلام ${escapeHtml(username || "")}، برای فعال‌کردن ایمیل حسابت کد زیر را در سایت وارد کن.`;
  return deliver({
    to,
    subject,
    text: `${intro}\n\nکد تأیید: ${code}\nیا از این لینک استفاده کن: ${link}\n\nاین کد ${minutes} دقیقه معتبر است.`,
    html: layout({
      title: "تأیید ایمیل",
      intro,
      code,
      link,
      cta: "تأیید ایمیل",
      note: `این کد تا ${minutes} دقیقه معتبر است و فقط یک بار قابل استفاده است.`
    })
  });
}

export async function sendResetMail({ to, username, code, link, minutes }) {
  const subject = `بازیابی رمز ${SITE_NAME}: ${code}`;
  const intro = `سلام ${escapeHtml(username || "")}، برای تعیین رمز جدید یا روی دکمه بزن یا کد زیر را در سایت وارد کن.`;
  return deliver({
    to,
    subject,
    text: `${intro}\n\nکد بازیابی: ${code}\nلینک تعیین رمز جدید: ${link}\n\nاین کد ${minutes} دقیقه معتبر است. اگر خودت درخواست ندادی، کاری نکن.`,
    html: layout({
      title: "تعیین رمز جدید",
      intro,
      code,
      link,
      cta: "تعیین رمز جدید",
      note: `این کد تا ${minutes} دقیقه معتبر است. بعد از تغییر رمز، همهٔ نشست‌های قبلی بسته می‌شوند.`
    })
  });
}

export async function sendTestMail({ to }) {
  return deliver({
    to,
    subject: `آزمایش اتصال ایمیل ${SITE_NAME}`,
    text: "این یک ایمیل آزمایشی از کنسول مالک هم‌تماشا است. اگر آن را دیدی، SMTP درست وصل شده.",
    html: layout({
      title: "اتصال ایمیل برقرار است",
      intro: "این یک پیام آزمایشی از کنسول مالک هم‌تماشا است. اگر این ایمیل را دریافت کردی، SMTP درست وصل شده و کدهای ورود هم ارسال می‌شوند.",
      note: "اگر این پیام را انتظار نداشتی، تنظیمات SMTP را در کنسول مالک بررسی کن."
    })
  });
}
