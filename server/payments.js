import crypto from "node:crypto";

const PROVIDERS = ["manual", "hmac"];

function env(name, fallback = "") {
  const value = process.env[name];
  return value == null || value === "" ? fallback : String(value);
}

export function paymentConfig() {
  const requested = env("PAYMENT_PROVIDER", "manual").toLowerCase();
  return {
    provider: PROVIDERS.includes(requested) ? requested : "manual",
    webhookSecret: env("PAYMENT_WEBHOOK_SECRET"),
    checkoutUrl: env("PAYMENT_CHECKOUT_URL"),
    merchantId: env("PAYMENT_MERCHANT_ID"),
    currency: env("PAYMENT_CURRENCY")
  };
}

export function paymentProviderState() {
  const cfg = paymentConfig();
  const state = {
    provider: cfg.provider,
    supported: PROVIDERS,
    mode: cfg.provider === "hmac" ? "redirect" : "manual",
    configured: true,
    checkoutUrl: cfg.provider === "hmac" ? cfg.checkoutUrl : "",
    requirements: []
  };
  if (cfg.provider === "hmac") {
    if (!cfg.webhookSecret) state.requirements.push("PAYMENT_WEBHOOK_SECRET");
    if (!cfg.checkoutUrl) state.requirements.push("PAYMENT_CHECKOUT_URL");
    state.configured = state.requirements.length === 0;
  }
  return state;
}

export function initiatePayment({ order, plan }) {
  const cfg = paymentConfig();
  const state = paymentProviderState();
  const amount = Number(order?.amount || 0);
  const currency = order?.currency || plan?.currency || cfg.currency || "IRT";
  if (!state.configured) {
    return {
      ok: false,
      code: "provider_unconfigured",
      provider: cfg.provider,
      requirements: state.requirements,
      message: "درگاه پرداخت تنظیم نشده؛ متغیرهای سروری لازم است."
    };
  }
  if (cfg.provider === "hmac") {
    const url = new URL(cfg.checkoutUrl);
    url.searchParams.set("order", order.id);
    url.searchParams.set("amount", String(amount));
    url.searchParams.set("currency", currency);
    if (cfg.merchantId) url.searchParams.set("merchant", cfg.merchantId);
    return {
      ok: true,
      provider: "hmac",
      mode: "redirect",
      amount,
      currency,
      checkoutUrl: url.toString(),
      instructions: "برای تکمیل خرید به صفحهٔ پرداخت منتقل شو. فعال‌سازی فقط بعد از تأیید امضای وب‌هوک انجام می‌شود."
    };
  }
  return {
    ok: true,
    provider: "manual",
    mode: "manual",
    amount,
    currency,
    checkoutUrl: "",
    instructions: "پرداخت دستی: مبلغ را واریز کن و کد پیگیری را برای پشتیبانی بفرست. اشتراک فقط بعد از تأیید مالک فعال می‌شود."
  };
}

export function verifyWebhook({ provider, rawBody = "", headers = {} }) {
  const cfg = paymentConfig();
  if (provider !== cfg.provider) return { ok: false, status: 400, reason: "provider_mismatch" };
  if (cfg.provider === "manual") return { ok: false, status: 400, reason: "webhook_not_supported" };
  if (!cfg.webhookSecret) return { ok: false, status: 503, reason: "secret_missing" };
  const signature = String(headers["x-wt-signature"] || "").trim().toLowerCase();
  if (!signature) return { ok: false, status: 401, reason: "signature_missing" };
  const expected = crypto.createHmac("sha256", cfg.webhookSecret).update(String(rawBody), "utf8").digest("hex");
  const provided = Buffer.from(signature, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  if (provided.length !== wanted.length || !crypto.timingSafeEqual(provided, wanted)) {
    return { ok: false, status: 401, reason: "signature_invalid" };
  }
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { ok: false, status: 400, reason: "invalid_payload" };
  }
  const eventId = String(payload?.eventId || "").trim();
  const orderId = String(payload?.orderId || "").trim();
  const status = String(payload?.status || "").toLowerCase();
  if (!eventId || !orderId || !["paid", "failed"].includes(status)) {
    return { ok: false, status: 422, reason: "invalid_event" };
  }
  return {
    ok: true,
    event: {
      eventId,
      orderId,
      status,
      providerRef: String(payload.providerRef || "").slice(0, 190),
      amount: payload.amount == null ? null : Number(payload.amount),
      payload
    }
  };
}

export function signWebhookBody(body, secret) {
  return crypto.createHmac("sha256", secret).update(String(body), "utf8").digest("hex");
}
