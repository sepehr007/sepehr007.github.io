const BLOCK_TYPES = ["heading", "text", "image", "button", "link", "banner", "form", "nav", "spacer"];
const WIDTHS = ["narrow", "full"];
const TONES = ["none", "soft", "strong"];
const ALIGNS = ["start", "center", "end"];
const FORM_FIELDS = ["name", "email", "phone", "message"];

function clean(value, max) {
  return String(value == null ? "" : value).slice(0, max);
}

function cleanHref(value) {
  const href = clean(value, 500).trim();
  if (!href) return "";
  if (href.startsWith("/") || href.startsWith("#")) return href;
  if (/^https:\/\//i.test(href)) return href;
  if (/^mailto:[^\s]+$/i.test(href)) return href;
  return "";
}

function cleanImage(value) {
  const src = clean(value, 800).trim();
  if (!src) return "";
  if (src.startsWith("/")) return src;
  if (/^https:\/\//i.test(src)) return src;
  return "";
}

function cleanLayout(input) {
  return {
    width: WIDTHS.includes(input?.width) ? input.width : "narrow",
    tone: TONES.includes(input?.tone) ? input.tone : "none",
    align: ALIGNS.includes(input?.align) ? input.align : "start"
  };
}

function sanitizeBlock(block) {
  if (!block || typeof block !== "object") return null;
  const type = BLOCK_TYPES.includes(block.type) ? block.type : "";
  if (!type) return null;
  const layout = cleanLayout(block.layout);
  const base = { type, layout };
  switch (type) {
    case "heading": {
      const text = clean(block.text, 200).trim();
      if (!text) return null;
      return { ...base, text, level: [1, 2, 3].includes(Number(block.level)) ? Number(block.level) : 2 };
    }
    case "text": {
      const text = clean(block.text, 5000).trim();
      if (!text) return null;
      return { ...base, text };
    }
    case "image": {
      const src = cleanImage(block.src);
      if (!src) return null;
      return { ...base, src, alt: clean(block.alt, 200), caption: clean(block.caption, 300) };
    }
    case "button": {
      const label = clean(block.label, 80).trim();
      const href = cleanHref(block.href);
      if (!label || !href) return null;
      return { ...base, label, href, style: block.style === "ghost" ? "ghost" : "primary" };
    }
    case "link": {
      const label = clean(block.label, 80).trim();
      const href = cleanHref(block.href);
      if (!label || !href) return null;
      return { ...base, label, href };
    }
    case "banner": {
      const title = clean(block.title, 160).trim();
      if (!title) return null;
      return {
        ...base,
        title,
        text: clean(block.text, 1000),
        image: cleanImage(block.image),
        ctaLabel: clean(block.ctaLabel, 60),
        ctaHref: cleanHref(block.ctaHref),
        tone: ["primary", "soft", "dark"].includes(block.tone) ? block.tone : "primary"
      };
    }
    case "form": {
      const fields = Array.isArray(block.fields)
        ? block.fields.filter((field) => FORM_FIELDS.includes(field)).slice(0, 4)
        : ["name", "email", "message"];
      if (!fields.length) return null;
      return {
        ...base,
        title: clean(block.title, 160),
        text: clean(block.text, 600),
        fields,
        submitLabel: clean(block.submitLabel, 60) || "ارسال",
        successText: clean(block.successText, 300) || "پیام شما ثبت شد."
      };
    }
    case "nav": {
      const items = (Array.isArray(block.items) ? block.items : [])
        .map((item) => ({ label: clean(item?.label, 40).trim(), href: cleanHref(item?.href) }))
        .filter((item) => item.label && item.href)
        .slice(0, 8);
      if (!items.length) return null;
      return { ...base, items };
    }
    case "spacer": {
      const size = ["sm", "md", "lg"].includes(block.size) ? block.size : "md";
      return { ...base, size };
    }
    default:
      return null;
  }
}

export function sanitizeBlocks(input) {
  const list = Array.isArray(input) ? input : [];
  if (list.length > 60) return { ok: false, error: "too_many_blocks", blocks: [] };
  const blocks = [];
  for (const item of list) {
    const block = sanitizeBlock(item);
    if (!block) return { ok: false, error: "invalid_block", blocks: [] };
    blocks.push(block);
  }
  return { ok: true, blocks };
}

export function blocksFromJson(json) {
  try {
    const parsed = JSON.parse(json || "[]");
    const result = sanitizeBlocks(parsed);
    return result.ok ? result.blocks : [];
  } catch {
    return [];
  }
}

export function sanitizeVisibility(value) {
  return ["public", "unlisted", "members"].includes(value) ? value : "public";
}
