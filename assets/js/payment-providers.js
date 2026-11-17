export const PROVIDERS = [
  {
    id: "stripe",
    label: "Stripe",
    note: "کارت بین‌المللی؛ پرداخت با Checkout و وب‌هوک.",
    publicFields: [
      { key: "accountId", label: "Account ID", placeholder: "acct_…" },
      { key: "publishableKey", label: "Publishable key", placeholder: "pk_live_…", pattern: "^pk_" }
    ],
    secretFields: [
      { key: "secretKey", env: "STRIPE_SECRET_KEY" },
      { key: "webhookSecret", env: "STRIPE_WEBHOOK_SECRET" }
    ]
  },
  {
    id: "zarinpal",
    label: "زرین‌پال",
    note: "درگاه ایرانی؛ پرداخت ریالی و تأیید سروری.",
    publicFields: [{ key: "terminalId", label: "Terminal ID", placeholder: "شناسهٔ پذیرنده" }],
    secretFields: [{ key: "merchantId", env: "ZARINPAL_MERCHANT_ID" }]
  },
  {
    id: "idpay",
    label: "آیدی‌پی",
    note: "درگاه ایرانی؛ ایجاد تراکنش و verify در سرور.",
    publicFields: [{ key: "terminalId", label: "Terminal ID", placeholder: "شناسهٔ ترمینال" }],
    secretFields: [{ key: "apiKey", env: "IDPAY_API_KEY" }]
  },
  {
    id: "paypal",
    label: "PayPal",
    note: "پرداخت بین‌المللی؛ Orders API و وب‌هوک.",
    publicFields: [{ key: "clientId", label: "Client ID", placeholder: "AaBb…" }],
    secretFields: [{ key: "clientSecret", env: "PAYPAL_CLIENT_SECRET" }]
  },
  {
    id: "custom",
    label: "درگاه سفارشی",
    note: "اتصال به هر درگاه دیگر با قرارداد یکسان.",
    publicFields: [{ key: "name", label: "نام نمایشی", placeholder: "درگاه سازمانی" }],
    secretFields: [{ key: "token", env: "CUSTOM_PROVIDER_TOKEN" }]
  }
];

export const PROVIDER_MODES = {
  disabled: "غیرفعال",
  sandbox: "سندباکس",
  live: "عملیاتی"
};

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

export function providerMeta(id) {
  return BY_ID.get(id) || null;
}

export function sanitizeProviderConfig(raw = {}) {
  const meta = providerMeta(raw.id);
  if (!meta) return null;
  const allowed = new Set(meta.publicFields.map((f) => f.key));
  const fields = {};
  const src = raw.fields && typeof raw.fields === "object" ? raw.fields : {};
  for (const key of allowed) fields[key] = String(src[key] || "").trim().slice(0, 120);
  return {
    id: meta.id,
    mode: Object.prototype.hasOwnProperty.call(PROVIDER_MODES, raw.mode) ? raw.mode : "disabled",
    callbackUrl: String(raw.callbackUrl || "").trim().slice(0, 200),
    fields,
    secretsRef: Boolean(raw.secretsRef),
    updatedAt: Number(raw.updatedAt) || Date.now()
  };
}

export function stripSecrets(input = {}) {
  const out = { ...input };
  for (const meta of PROVIDERS) {
    for (const secret of meta.secretFields) delete out[secret.key];
  }
  delete out.apiKey;
  delete out.secretKey;
  delete out.webhookSecret;
  delete out.merchantId;
  delete out.clientSecret;
  delete out.token;
  return out;
}

export function providerHealth(config) {
  const meta = providerMeta(config?.id);
  const checks = [];
  if (!meta) return { level: "unknown", checks };
  if (!config || config.mode === "disabled") {
    checks.push({ ok: false, text: "درگاه غیرفعال است." });
    return { level: "disabled", checks };
  }
  const missing = meta.publicFields.filter((f) => !String(config.fields?.[f.key] || "").trim());
  checks.push({ ok: missing.length === 0, text: missing.length ? `فیلد عمومی ناقص: ${missing.map((f) => f.label).join("، ")}` : "فیلدهای عمومی کامل است." });
  const cb = String(config.callbackUrl || "");
  let cbOk = false;
  try { const u = new URL(cb); cbOk = u.protocol === "https:"; } catch {}
  checks.push({ ok: cbOk, text: cbOk ? "آدرس بازگشت معتبر است." : "آدرس بازگشت باید HTTPS باشد." });
  checks.push({ ok: false, text: `کلیدهای محرمانه فقط در سرور (${meta.secretFields.map((s) => s.env).join("، ")}) تنظیم می‌شوند.` });
  const configured = missing.length === 0 && cbOk;
  return { level: configured ? "configured" : "incomplete", checks };
}

export function createCheckout(providerId, config, order = {}) {
  const meta = providerMeta(providerId);
  if (!meta) throw Object.assign(new Error("درگاه ناشناخته است."), { code: "unknown_provider" });
  if (!config || config.mode === "disabled") throw Object.assign(new Error("درگاه غیرفعال است."), { code: "provider_disabled" });
  throw Object.assign(new Error("ایجاد تراکنش نیازمند سرور است."), { code: "backend_required", provider: meta.id, order });
}

export function verifyWebhook(providerId) {
  const meta = providerMeta(providerId);
  if (!meta) throw Object.assign(new Error("درگاه ناشناخته است."), { code: "unknown_provider" });
  throw Object.assign(new Error("اعتبارسنجی وب‌هوک فقط در سرور انجام می‌شود."), { code: "backend_required", provider: meta.id });
}
