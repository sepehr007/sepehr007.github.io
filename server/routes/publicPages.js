import crypto from "node:crypto";
import { dbReady } from "../db.js";
import { ensureStore } from "../userStore.js";
import { all, get, run } from "../database/index.js";
import { createRateLimiter } from "../redis.js";
import { blocksFromJson } from "../pageBlocks.js";
import { readAuth } from "./auth.js";
import { deliverNoticeMany } from "../notify.js";
import { emitEvent } from "../automation.js";

const submitLimit = createRateLimiter({ max: 6, windowMs: 60_000, prefix: "wt:rl:page-form:" });

function fail(reply, status, error, message) {
  return reply.code(status).send({ error, message });
}

async function ready(reply) {
  if (dbReady()) {
    fail(reply, 503, "sqlite_only", "Website pages need the SQLite deployment.");
    return false;
  }
  if (await ensureStore()) return true;
  fail(reply, 503, "database_unavailable", "Database is not connected yet.");
  return false;
}

function publicPage(row, { preview = false } = {}) {
  return {
    slug: row.slug,
    title: row.title,
    description: row.description || "",
    locale: row.locale || "fa",
    visibility: row.visibility || "public",
    blocks: blocksFromJson(row.blocks_json || row.body),
    version: Number(row.version || 1),
    publishedAt: row.published_at ? Number(row.published_at) : null,
    updatedAt: Number(row.updated_at || 0),
    preview
  };
}

function visibleNow(row) {
  if (row.status !== "published") return false;
  if (row.scheduled_at && Number(row.scheduled_at) > Date.now()) return false;
  return true;
}

export default async function publicPageRoutes(app) {
  app.get("/nav", async (req, reply) => {
    if (!(await ready(reply))) return undefined;
    const rows = all(
      "SELECT slug, title FROM website_pages WHERE status = 'published' AND show_in_nav = 1 AND visibility = 'public' AND (scheduled_at IS NULL OR scheduled_at <= ?) ORDER BY nav_order ASC, title ASC LIMIT 20",
      Date.now()
    );
    return { ok: true, items: rows.map((row) => ({ slug: row.slug, title: row.title })) };
  });

  app.get("/:slug", async (req, reply) => {
    if (!(await ready(reply))) return undefined;
    const row = get("SELECT * FROM website_pages WHERE slug = ?", String(req.params.slug || "").toLowerCase());
    if (!row) return fail(reply, 404, "page_missing", "That page does not exist.");
    if (row.status === "archived" || !visibleNow(row)) return fail(reply, 404, "page_missing", "That page does not exist.");
    if (row.visibility === "members") {
      const auth = readAuth(req);
      if (!auth?.sub) return fail(reply, 403, "members_only", "This page is available to signed-in members.");
      const member = get("SELECT id FROM users WHERE id = ? AND deleted_at IS NULL", String(auth.sub));
      if (!member) return fail(reply, 403, "members_only", "This page is available to signed-in members.");
    }
    return { ok: true, page: publicPage(row) };
  });

  app.post("/:slug/submit", { preHandler: [submitLimit] }, async (req, reply) => {
    if (!(await ready(reply))) return undefined;
    const row = get("SELECT * FROM website_pages WHERE slug = ?", String(req.params.slug || "").toLowerCase());
    if (!row || row.status !== "published" || !visibleNow(row)) return fail(reply, 404, "page_missing", "That page does not exist.");
    const blocks = blocksFromJson(row.blocks_json || row.body);
    if (!blocks.some((block) => block.type === "form")) return fail(reply, 400, "no_form", "This page has no form.");
    const input = req.body && typeof req.body === "object" ? req.body : {};
    const name = String(input.name || "").trim().slice(0, 120);
    const email = String(input.email || "").trim().slice(0, 190);
    const phone = String(input.phone || "").trim().slice(0, 30);
    const message = String(input.message || "").trim().slice(0, 2000);
    if (!name && !email && !message) return fail(reply, 400, "empty_submission", "Please fill in the form.");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(reply, 400, "invalid_email", "Email address is not valid.");
    const ip = req.ip || "";
    const ipHash = crypto.createHash("sha256").update(String(ip) + "wt-page").digest("hex").slice(0, 32);
    const id = crypto.randomUUID();
    run(
      "INSERT INTO page_submissions (id, page_id, name, email, message, meta_json, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      row.id,
      name,
      email,
      message || phone,
      JSON.stringify({ phone }).slice(0, 1000),
      ipHash,
      Date.now()
    );
    const owners = all("SELECT id FROM users WHERE role IN ('owner','super_owner') AND deleted_at IS NULL LIMIT 20").map((item) => item.id);
    if (owners.length) {
      await deliverNoticeMany(app, owners, () => ({
        kind: "system",
        title: `پیام جدید در «${row.title}»`,
        body: `${name || "کاربر"}${email ? ` · ${email}` : ""}: ${message || phone}`.slice(0, 240),
        link: "owner.html",
        dedupeKey: `page-form:${id}`
      }));
    }
    await emitEvent(app, "page.form_submitted", { pageId: row.id, slug: row.slug, name, email, submissionId: id });
    return { ok: true, submission: { id, successText: blocks.find((block) => block.type === "form")?.successText || "پیام شما ثبت شد." } };
  });
}
