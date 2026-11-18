import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.SITE_CONFIG_PATH || path.join(HERE, "..", "assets", "data", "site-config.json");
const CACHE_MS = Number(process.env.FEATURE_CACHE_MS || 5000);

const DEFAULTS = {
  features: { chat: true, voice: true, liveReactions: true, screenShare: true, queue: true, subtitles: true, localFile: true, realtimeEnabled: true },
  access: { registration: true, login: true, roomCreate: true, roomJoin: true },
  featureRules: {}
};

let cache = { at: 0, state: null };

function envEmergency() {
  return String(process.env.FEATURE_EMERGENCY_OFF || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
}

function normalizeRules(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, rule] of Object.entries(raw)) {
    if (!rule || typeof rule !== "object") continue;
    const clean = {};
    if (rule.emergency) clean.emergency = true;
    for (const field of ["enableAt", "disableAt"]) {
      const n = Number(rule[field]);
      if (Number.isFinite(n) && n > 0) clean[field] = n;
    }
    if (Object.keys(clean).length) out[key] = clean;
  }
  return out;
}

export async function loadFeatureState() {
  const now = Date.now();
  if (cache.state && now - cache.at < CACHE_MS) return cache.state;
  let raw = {};
  try {
    raw = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
  } catch {}
  const state = {
    source: "site-config.json",
    updatedAt: raw.updatedAt || "",
    features: { ...DEFAULTS.features, ...(raw.features || {}) },
    access: { ...DEFAULTS.access, ...(raw.access || {}) },
    featureRules: normalizeRules(raw.featureRules)
  };
  cache = { at: now, state };
  return state;
}

function ruleRejects(rule, now) {
  if (!rule) return false;
  if (rule.emergency) return true;
  const enableAt = Number(rule.enableAt) || 0;
  const disableAt = Number(rule.disableAt) || 0;
  if (enableAt && disableAt && enableAt >= disableAt) return true;
  if (enableAt && now < enableAt) return true;
  if (disableAt && now >= disableAt) return true;
  return false;
}

export function isEnabled(state, pathName, now = Date.now()) {
  if (!state) return true;
  const rule = state.featureRules?.[pathName];
  if (ruleRejects(rule, now)) return false;
  if (envEmergency().some((id) => pathName === id || pathName.endsWith(`.${id}`))) return false;
  const [root, leaf] = String(pathName).split(".");
  const group = state[root];
  if (!group || !Object.prototype.hasOwnProperty.call(group, leaf)) return true;
  return group[leaf] !== false;
}

export function summarizeFeatures(state) {
  return {
    realtime: isEnabled(state, "features.realtimeEnabled"),
    chat: isEnabled(state, "features.chat"),
    voice: isEnabled(state, "features.voice"),
    screenShare: isEnabled(state, "features.screenShare"),
    sharedPlayback: isEnabled(state, "features.sharedPlayback"),
    queue: isEnabled(state, "features.queue"),
    roomsCreate: isEnabled(state, "access.roomCreate"),
    roomsJoin: isEnabled(state, "access.roomJoin"),
    registration: isEnabled(state, "access.registration"),
    login: isEnabled(state, "access.login")
  };
}
