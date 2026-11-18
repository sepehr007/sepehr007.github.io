// Configuration authority order. Earlier layers outrank later ones.
// The rule is ceiling-based: every layer may tighten, none may loosen a layer above it.
export const CONFIG_LAYERS = [
  { id: "security", rank: 1, label: "محدودیت امنیتی سراسری", kind: "security", locked: true },
  { id: "global", rank: 2, label: "محدودیت قابلیت سراسری", kind: "feature" },
  { id: "plan", rank: 3, label: "استحقاق اشتراک", kind: "scope", scope: "plan" },
  { id: "role", rank: 4, label: "مجوز نقش", kind: "scope", scope: "role" },
  { id: "server", rank: 5, label: "پیکربندی سرور", kind: "scope", scope: "server" },
  { id: "room", rank: 6, label: "پیکربندی اتاق", kind: "scope", scope: "room" },
  { id: "user", rank: 7, label: "ترجیح شخصی", kind: "scope", scope: "user" }
];

export const LAYER_IDS = CONFIG_LAYERS.map((layer) => layer.id);

export const CONFLICT_RULE =
  "هر لایه فقط می‌تواند محدودتر کند. اگر لایهٔ بالاتر قابلیتی را ببندد، هیچ لایهٔ پایین‌تری نمی‌تواند بازش کند؛ خاموشی در هر لایه یعنی خاموشی نهایی. وقتی چند لایه هم‌زمان می‌بندند، بالاترین لایه به‌عنوان منبع گزارش می‌شود.";

// Maps room_settings columns to the feature keys they govern.
// Anything that depends on those keys is switched off by the dependency resolver.
export const ROOM_SETTING_FEATURES = {
  chat_enabled: ["features.chat"],
  voice_enabled: ["features.voice"],
  screen_share_enabled: ["features.screenShare"],
  queue_enabled: ["features.queue"],
  subtitles_enabled: ["features.subtitles"],
  local_file_enabled: ["features.localFile"]
};

export function securityFloorKeys(env = process.env) {
  return String(env.SECURITY_MANDATORY_OFF || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function matchesFloorKey(list, key) {
  const text = String(key || "");
  return (list || []).some((id) => text === id || text.endsWith(`.${id}`));
}

export function layerRank(id) {
  return CONFIG_LAYERS.find((layer) => layer.id === id)?.rank || 99;
}
