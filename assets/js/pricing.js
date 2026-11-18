import { normalizePlan, publicPricingPlans, effectivePrice, CURRENCIES, formatMoney } from "./billing-model.js";
import { summarizeEntitlements, FREE_ENTITLEMENTS } from "./entitlements.js";
import { isFlagOn } from "./feature-flags.js";

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "on" && typeof v === "function") node.addEventListener("click", v);
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

function isFree(plan) {
  return !Number(plan.prices?.monthly) && !Number(plan.prices?.yearly) && !Number(plan.prices?.lifetime) && !Number(plan.prices?.custom?.amount);
}

function primaryCycle(plan) {
  if (Number(plan.prices?.monthly) > 0) return "monthly";
  if (Number(plan.prices?.yearly) > 0) return "yearly";
  if (Number(plan.prices?.lifetime) > 0) return "lifetime";
  return "custom";
}

const CYCLE_LABEL = { monthly: "ماهانه", yearly: "سالانه", lifetime: "مادام‌العمر", custom: "دورهٔ سفارشی" };

function priceNode(plan, currency, now, showPromo = true) {
  const cycle = primaryCycle(plan);
  const price = effectivePrice(plan, cycle, now);
  const shown = showPromo ? price : { ...price, original: price.amount, discountPercent: 0 };
  const wrap = el("div", { class: "price-val" });
  if (isFree(plan)) {
    wrap.append(el("strong", { text: "۰" }), el("span", { text: (CURRENCIES[currency] || CURRENCIES.IRT).fa }));
    return wrap;
  }
  if (shown.original > shown.amount) wrap.append(el("s", { class: "price-old", text: formatMoney(shown.original, currency) }));
  wrap.append(el("strong", { text: formatMoney(price.amount, currency) }), el("span", { text: CYCLE_LABEL[cycle] }));
  if (shown.discountPercent > 0) wrap.append(el("em", { class: "price-off", text: `٪${shown.discountPercent.toLocaleString("fa-IR")} تخفیف` }));
  return wrap;
}

export function planCard(plan, { currency = "IRT", now = Date.now(), onSelect = null, promotions = true, payments = true } = {}) {
  const card = el("article", { class: `price-card plan-card-public${plan.popular ? " is-popular" : ""}` });
  if (plan.color) card.style.borderColor = `${plan.color}55`;
  const tag = el("span", { class: "price-tag" });
  if (plan.icon) tag.append(el("i", { class: "plan-ico", text: plan.icon }));
  tag.append(plan.name);
  card.append(tag);
  const badges = el("div", { class: "plan-badges" });
  if (promotions && plan.popular) badges.append(el("span", { class: "plan-badge hot", text: "پرفروش" }));
  if (plan.recommended) badges.append(el("span", { class: "plan-badge rec", text: "پیشنهادی" }));
  if (plan.badge) badges.append(el("span", { class: "plan-badge custom", text: plan.badge }));
  if (badges.children.length) card.append(badges);
  card.append(priceNode(plan, currency, now, promotions));
  if (plan.description) card.append(el("p", { class: "hint", text: plan.description }));
  if (Number(plan.trialDays) > 0) card.append(el("p", { class: "plan-trial", text: `${plan.trialDays.toLocaleString("fa-IR")} روز آزمایشی` }));
  const list = el("ul", { class: "price-list" });
  const features = summarizeEntitlements({ ...FREE_ENTITLEMENTS, ...plan.entitlements }).slice(0, 7);
  if (isFree(plan)) {
    features.unshift({ id: "free", text: "همهٔ قابلیت‌های پایه" });
  }
  for (const f of features) list.append(el("li", { text: f.text }));
  if (!features.length) list.append(el("li", { text: "جزئیات دسترسی در پلن تعریف نشده است." }));
  card.append(list);
  const cta = el("button", { class: "btn btn-block", type: "button", text: isFree(plan) ? "شروع رایگان" : "انتخاب پلن" });
  cta.classList.add(isFree(plan) ? "btn-primary" : "btn-secondary");
  if (!payments && !isFree(plan)) {
    cta.disabled = true;
    cta.textContent = "پرداخت موقتاً غیرفعال است";
  }
  cta.addEventListener("click", () => {
    if (cta.disabled) return;
    if (onSelect) return onSelect(plan);
    if (plan.ctaUrl) window.open(plan.ctaUrl, "_blank", "noopener");
    else document.getElementById("create")?.scrollIntoView({ behavior: "smooth" });
  });
  card.append(cta);
  return card;
}

export function configPlans(config) {
  const raw = config?.billing?.plans;
  if (!Array.isArray(raw) || !raw.length) return [];
  if (!isFlagOn(config, "business.subscriptions")) return [];
  const freeOn = isFlagOn(config, "business.freePlans");
  const premiumOn = isFlagOn(config, "business.premiumPlans");
  return publicPricingPlans(raw.map((p, i) => normalizePlan(p, i)))
    .filter((plan) => (isFree(plan) ? freeOn : premiumOn));
}

export function renderPricingGrid(grid, plans, opts = {}) {
  if (!grid || !plans.length) return false;
  const frag = document.createDocumentFragment();
  for (const plan of plans) frag.append(planCard(plan, opts));
  grid.replaceChildren(frag);
  grid.dataset.dynamic = "1";
  grid.classList.remove("feature-off");
  grid.classList.toggle("pricing-single", plans.length === 1);
  return true;
}

export function renderPricingSection(config, root = document) {
  const grid = root.querySelector(".pricing-grid");
  if (!grid) return 0;
  const plans = configPlans(config);
  if (!plans.length) {
    if (!isFlagOn(config, "business.subscriptions") || !isFlagOn(config, "business.premiumPlans") || !isFlagOn(config, "business.freePlans")) {
      grid.classList.add("feature-off");
    }
    return 0;
  }
  const currency = config?.billing?.currency || "IRT";
  renderPricingGrid(grid, plans, {
    currency,
    promotions: isFlagOn(config, "business.promotions"),
    payments: isFlagOn(config, "business.payments")
  });
  return plans.length;
}
