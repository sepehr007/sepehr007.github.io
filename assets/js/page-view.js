import { el } from "./core.js";
import { apiFetch, ApiError, apiHasToken } from "./api.js";
import { renderBlocks } from "./page-blocks.js";

const state = { slug: "" };
const els = {
  nav: document.getElementById("pageNav"),
  main: document.getElementById("pubMain"),
  loading: document.getElementById("pubState"),
  page: document.getElementById("pubPage"),
  title: document.getElementById("pubTitle"),
  desc: document.getElementById("pubDesc"),
  meta: document.getElementById("pubMeta"),
  blocks: document.getElementById("pubBlocks"),
  profile: document.getElementById("pubProfileLink")
};

function slugFromUrl() {
  const params = new URLSearchParams(location.search);
  const direct = String(params.get("slug") || params.get("page") || "").trim().toLowerCase();
  if (direct) return direct;
  const match = /\/p\/([a-z0-9-]{2,64})\/?$/i.exec(location.pathname);
  return match ? match[1].toLowerCase() : "";
}

function showState(title, text, { actionLabel, onAction, kind = "error" } = {}) {
  els.page.classList.add("hidden");
  els.loading.classList.remove("hidden");
  els.loading.replaceChildren(
    el("span", { class: `pub-state-ico ${kind === "members" ? "members" : ""}`, text: kind === "error" ? "!" : "🔒" }),
    el("h2", { text: title }),
    el("p", { text })
  );
  if (actionLabel) {
    const btn = el("button", { class: "btn btn-primary btn-sm", type: "button", text: actionLabel });
    btn.addEventListener("click", onAction);
    els.loading.append(btn);
  }
}

async function loadNav() {
  try {
    const data = await apiFetch("/pages/nav", { auth: false, timeoutMs: 6000 });
    const items = data?.items || [];
    const links = [el("a", { href: "./", text: "خانه" })];
    for (const item of items) {
      links.push(el("a", { href: `page.html?slug=${encodeURIComponent(item.slug)}`, text: item.title }));
    }
    els.nav.replaceChildren(...links);
  } catch {
    els.nav.replaceChildren(el("a", { href: "./", text: "خانه" }));
  }
}

function trackView(slug) {
  try {
    let sessionId = sessionStorage.getItem("wt.sid");
    if (!sessionId) {
      sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem("wt.sid", sessionId);
    }
    void apiFetch("/analytics/events", {
      method: "POST",
      auth: false,
      timeoutMs: 6000,
      body: { event: "page.view", path: `/page/${slug}`, sessionId }
    }).catch(() => {});
  } catch {}
}

async function loadPage(slug) {
  try {
    const data = await apiFetch(`/pages/${encodeURIComponent(slug)}`, { timeoutMs: 12000 });
    const page = data?.page;
    if (!page) throw new ApiError("صفحه پیدا نشد.", { status: 404, code: "page_missing" });
    document.title = `${page.title} — هم‌تماشا`;
    if (page.description) {
      let meta = document.querySelector('meta[name="description"]');
      if (!meta) {
        meta = el("meta", { name: "description" });
        document.head.append(meta);
      }
      meta.setAttribute("content", page.description);
    }
    els.title.textContent = page.title;
    if (page.description) {
      els.desc.textContent = page.description;
      els.desc.classList.remove("hidden");
    } else {
      els.desc.classList.add("hidden");
    }
    const when = page.updatedAt ? new Date(page.updatedAt).toLocaleDateString("fa-IR") : "";
    els.meta.textContent = when ? `آخرین به‌روزرسانی: ${when} · نسخهٔ ${page.version}` : "";
    renderBlocks(els.blocks, page.blocks, { slug: page.slug });
    els.loading.classList.add("hidden");
    els.page.classList.remove("hidden");
    trackView(page.slug);
  } catch (err) {
    if (err?.status === 403 || err?.code === "members_only") {
      showState("این صفحه فقط برای اعضا است", "برای دیدن این صفحه وارد حساب هم‌تماشا شو.", {
        kind: "members",
        actionLabel: "ورود به حساب",
        onAction: () => {
          location.href = `auth.html?mode=login&next=${encodeURIComponent(location.pathname + location.search)}`;
        }
      });
      return;
    }
    if (err?.status === 404) {
      showState("صفحه پیدا نشد", "این صفحه وجود ندارد یا هنوز منتشر نشده است.", { actionLabel: "خانه", onAction: () => (location.href = "./") });
      return;
    }
    showState("سرور در دسترس نیست", err?.message || "اتصال به سرور برقرار نشد.", {
      actionLabel: "تلاش دوباره",
      onAction: () => loadPage(slug)
    });
  }
}

function init() {
  if (els.profile && apiHasToken()) {
    els.profile.textContent = "پروفایل";
    els.profile.setAttribute("href", "profile.html");
  }
  void loadNav();
  const slug = slugFromUrl();
  if (!slug) {
    showState("صفحه‌ای انتخاب نشده", "از منوی سایت یک صفحه را باز کن.", { actionLabel: "خانه", onAction: () => (location.href = "./") });
    return;
  }
  state.slug = slug;
  void loadPage(slug);
}

init();

export { state };
