import { store } from "./core.js";

const LOG_KEY = "wt.modlog";
const MAX = 200;

export function readModLog() {
  const list = store.get(LOG_KEY, []);
  return Array.isArray(list) ? list : [];
}

export function logModeration(kind, detail = "", meta = null) {
  const list = readModLog();
  list.unshift({ at: Date.now(), kind: String(kind || "event"), detail: String(detail || "").slice(0, 240), meta });
  store.set(LOG_KEY, list.slice(0, MAX));
}

export function clearModLog() {
  store.set(LOG_KEY, []);
}
