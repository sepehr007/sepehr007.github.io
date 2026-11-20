import { el, toast } from "./core.js";
import { apiFetch, getApiBase } from "./api.js";

const SAFE_HREF = /^(https:\/\/|\/|#|mailto:)/i;
const SAFE_SRC = /^(https:\/\/|\/)/i;

function safeHref(value) {
  const href = String(value || "").trim();
  return SAFE_HREF.test(href) ? href : "";
}

function safeSrc(value) {
  const src = String(value || "").trim();
  return SAFE_SRC.test(src) ? src : "";
}

function resolvedSrc(value) {
  const src = safeSrc(value);
  if (!src) return "";
  if (src.startsWith("/api/")) {
    try {
      const base = getApiBase();
      return base ? new URL(src, base).href : src;
    } catch {
      return src;
    }
  }
  return src;
}

function layoutClass(block) {
  const layout = block?.layout || {};
  const classes = ["pb-block"];
  classes.push(layout.width === "full" ? "pb-wide" : "pb-narrow");
  if (layout.tone === "soft") classes.push("pb-tone-soft");
  if (layout.tone === "strong") classes.push("pb-tone-strong");
  if (layout.align === "center") classes.push("pb-center");
  else if (layout.align === "end") classes.push("pb-end");
  return classes.join(" ");
}

function textBlock(text) {
  return el("p", { class: "pb-text", text: String(text || "") });
}

function renderBlock(block, ctx) {
  const node = el("div", { class: layoutClass(block) });
  switch (block.type) {
    case "heading": {
      const level = [1, 2, 3].includes(Number(block.level)) ? Number(block.level) : 2;
      node.append(el(`h${level}`, { class: "pb-heading", text: String(block.text || "") }));
      break;
    }
    case "text":
      node.append(textBlock(block.text));
      break;
    case "image": {
      const src = resolvedSrc(block.src);
      if (src) {
        const img = el("img", { class: "pb-image", src, alt: String(block.alt || ""), loading: "lazy", decoding: "async" });
        node.append(img);
      }
      if (block.caption) node.append(el("p", { class: "pb-caption", text: String(block.caption) }));
      break;
    }
    case "button": {
      const href = safeHref(block.href);
      if (!href) break;
      const link = el("a", { class: `btn ${block.style === "ghost" ? "btn-ghost" : "btn-primary"} pb-button`, href, text: String(block.label || "") });
      node.append(link);
      break;
    }
    case "link": {
      const href = safeHref(block.href);
      if (!href) break;
      node.append(el("a", { class: "pb-link", href, text: String(block.label || "") }));
      break;
    }
    case "banner": {
      const banner = el("section", { class: `pb-banner pb-banner-${block.tone || "primary"}` });
      const image = resolvedSrc(block.image);
      if (image) banner.style.setProperty("--pb-banner-image", `url("${image}")`);
      banner.append(el("h2", { class: "pb-banner-title", text: String(block.title || "") }));
      if (block.text) banner.append(el("p", { class: "pb-banner-text", text: String(block.text) }));
      const ctaHref = safeHref(block.ctaHref);
      if (block.ctaLabel && ctaHref) banner.append(el("a", { class: "btn btn-primary pb-button", href: ctaHref, text: String(block.ctaLabel) }));
      node.append(banner);
      break;
    }
    case "nav": {
      const nav = el("nav", { class: "pb-nav", "aria-label": "ناوبری صفحه" });
      for (const item of Array.isArray(block.items) ? block.items : []) {
        const href = safeHref(item?.href);
        if (href && item?.label) nav.append(el("a", { href, text: String(item.label) }));
      }
      node.append(nav);
      break;
    }
    case "form":
      node.append(renderForm(block, ctx));
      break;
    case "spacer":
      node.append(el("div", { class: `pb-spacer pb-spacer-${block.size || "md"}`, "aria-hidden": "true" }));
      break;
    default:
      return null;
  }
  return node;
}

function renderForm(block, ctx) {
  const form = el("form", { class: "pb-form" });
  form.noValidate = true;
  if (block.title) form.append(el("h3", { class: "pb-form-title", text: String(block.title) }));
  if (block.text) form.append(el("p", { class: "pb-form-text", text: String(block.text) }));
  const fields = Array.isArray(block.fields) ? block.fields : ["name", "email", "message"];
  const inputs = {};
  const config = {
    name: { label: "نام", type: "text", required: true, maxlength: 120 },
    email: { label: "ایمیل", type: "email", required: false, maxlength: 190 },
    phone: { label: "شماره موبایل", type: "tel", required: false, maxlength: 30, dir: "ltr" },
    message: { label: "پیام", type: "textarea", required: true, maxlength: 2000 }
  };
  for (const key of fields) {
    const meta = config[key];
    if (!meta) continue;
    const label = el("label", { class: "pb-field" }, [el("span", { text: meta.label })]);
    const input =
      meta.type === "textarea"
        ? el("textarea", { rows: "4", maxlength: String(meta.maxlength) })
        : el("input", { type: meta.type, maxlength: String(meta.maxlength), dir: meta.dir || "auto" });
    if (meta.required) input.required = true;
    label.append(input);
    form.append(label);
    inputs[key] = input;
  }
  const status = el("p", { class: "pb-form-status", role: "status" });
  const submit = el("button", { class: "btn btn-primary pb-button", type: "submit", text: String(block.submitLabel || "ارسال") });
  form.append(el("div", { class: "pb-form-actions" }, [submit]), status);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (ctx?.preview) {
      toast("پیش‌نمایش است؛ ارسال واقعی انجام نشد.", "info");
      return;
    }
    if (!ctx?.slug) return;
    const payload = {};
    for (const [key, input] of Object.entries(inputs)) payload[key] = input.value.trim();
    if (!payload.name && !payload.email && !payload.message) {
      status.textContent = "لطفاً نام یا پیام را وارد کن.";
      status.className = "pb-form-status pb-err";
      return;
    }
    submit.disabled = true;
    status.textContent = "در حال ارسال…";
    status.className = "pb-form-status";
    try {
      const res = await apiFetch(`/pages/${encodeURIComponent(ctx.slug)}/submit`, { method: "POST", auth: false, body: payload });
      status.textContent = res?.submission?.successText || "پیام شما ثبت شد.";
      status.className = "pb-form-status pb-ok";
      form.reset();
    } catch (err) {
      status.textContent = err?.message || "ارسال نشد؛ دوباره تلاش کن.";
      status.className = "pb-form-status pb-err";
    } finally {
      submit.disabled = false;
    }
  });
  return form;
}

export function renderBlocks(root, blocks, ctx = {}) {
  root.replaceChildren();
  const list = Array.isArray(blocks) ? blocks : [];
  if (!list.length) {
    root.append(el("p", { class: "pb-empty", text: "این صفحه هنوز محتوایی ندارد." }));
    return root;
  }
  for (const block of list) {
    const node = renderBlock(block, ctx);
    if (node) root.append(node);
  }
  return root;
}
