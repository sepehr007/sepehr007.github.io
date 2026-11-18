/* Hambamasha local database.
   Each section of the site has its own object store:
   accounts, profiles, sessions, lobbies, rooms, messages, activity, prefs.
   IndexedDB is used when available; a localStorage-backed mirror keeps the
   site usable in private modes where IndexedDB is blocked. */

const DB_NAME = "hambamasha";
const DB_VERSION = 1;
const FALLBACK_PREFIX = "wt.db.";

const STORES = {
  accounts: { keyPath: "username", indexes: [["createdAt", "createdAt"]] },
  profiles: { keyPath: "username", indexes: [] },
  sessions: { keyPath: "username", indexes: [["at", "at"]] },
  lobbies: {
    keyPath: "code",
    indexes: [["owner", "owner"], ["active", "active"], ["createdAt", "createdAt"]]
  },
  rooms: { keyPath: "code", indexes: [["host", "host"]] },
  messages: {
    keyPath: "id",
    autoIncrement: true,
    indexes: [["room", "room"], ["createdAt", "createdAt"]]
  },
  activity: {
    keyPath: "id",
    autoIncrement: true,
    indexes: [["user", "user"], ["at", "at"]]
  },
  prefs: { keyPath: "key", indexes: [] }
};

let dbPromise = null;
let backend = "idb";

function canUseIdb() {
  try {
    return typeof indexedDB !== "undefined" && !!indexedDB;
  } catch {
    return false;
  }
}

function fallbackRead(store) {
  try {
    const raw = localStorage.getItem(FALLBACK_PREFIX + store);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function fallbackWrite(store, list) {
  try {
    localStorage.setItem(FALLBACK_PREFIX + store, JSON.stringify(list.slice(0, 1200)));
  } catch {}
}

function keyOf(store, record) {
  const keyPath = STORES[store]?.keyPath || "key";
  return record?.[keyPath];
}

function matches(store, record, index, value) {
  if (!index) return true;
  return record?.[index] === value;
}

export function openDB() {
  if (dbPromise) return dbPromise;
  if (!canUseIdb()) {
    backend = "local";
    dbPromise = Promise.resolve(null);
    return dbPromise;
  }
  dbPromise = new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      backend = "local";
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, def] of Object.entries(STORES)) {
        let store;
        if (!db.objectStoreNames.contains(name)) {
          store = db.createObjectStore(name, {
            keyPath: def.keyPath,
            autoIncrement: !!def.autoIncrement
          });
        } else {
          store = req.transaction.objectStore(name);
        }
        for (const [indexName, field] of def.indexes || []) {
          if (!store.indexNames.contains(indexName)) {
            store.createIndex(indexName, field, { unique: false });
          }
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      backend = "local";
      resolve(null);
    };
    req.onblocked = () => {
      backend = "local";
      resolve(null);
    };
  });
  return dbPromise;
}

export function dbBackend() {
  return backend;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function dbGet(store, key) {
  const db = await openDB();
  if (!db) {
    return fallbackRead(store).find((r) => keyOf(store, r) === key) || null;
  }
  try {
    const res = await requestToPromise(tx(db, store, "readonly").get(key));
    return res || null;
  } catch {
    return fallbackRead(store).find((r) => keyOf(store, r) === key) || null;
  }
}

export async function dbPut(store, record) {
  if (!record) return null;
  const db = await openDB();
  if (!db) {
    const list = fallbackRead(store);
    const key = keyOf(store, record);
    const i = list.findIndex((r) => keyOf(store, r) === key);
    if (i >= 0) list[i] = record;
    else list.push(record);
    fallbackWrite(store, list);
    return record;
  }
  try {
    await requestToPromise(tx(db, store, "readwrite").put(record));
    return record;
  } catch {
    return record;
  }
}

export async function dbDelete(store, key) {
  const db = await openDB();
  if (!db) {
    fallbackWrite(store, fallbackRead(store).filter((r) => keyOf(store, r) !== key));
    return true;
  }
  try {
    await requestToPromise(tx(db, store, "readwrite").delete(key));
    return true;
  } catch {
    return false;
  }
}

export async function dbGetAll(store) {
  const db = await openDB();
  if (!db) return fallbackRead(store);
  try {
    return (await requestToPromise(tx(db, store, "readonly").getAll())) || [];
  } catch {
    return fallbackRead(store);
  }
}

export async function dbGetByIndex(store, index, value) {
  const db = await openDB();
  if (!db) return fallbackRead(store).filter((r) => matches(store, r, index, value));
  try {
    const storeObj = tx(db, store, "readonly");
    if (!storeObj.indexNames.contains(index)) {
      const all = (await requestToPromise(storeObj.getAll())) || [];
      return all.filter((r) => r?.[index] === value);
    }
    return (await requestToPromise(storeObj.index(index).getAll(value))) || [];
  } catch {
    return fallbackRead(store).filter((r) => matches(store, r, index, value));
  }
}

export async function dbCount(store) {
  const db = await openDB();
  if (!db) return fallbackRead(store).length;
  try {
    return await requestToPromise(tx(db, store, "readonly").count());
  } catch {
    return fallbackRead(store).length;
  }
}

export function uid(prefix = "id") {
  try {
    if (crypto?.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  } catch {}
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export async function recordActivity(user, type, data = {}) {
  const entry = {
    user: String(user?.username || user || "guest").toLowerCase(),
    type: String(type || "event"),
    at: Date.now(),
    data
  };
  return dbPut("activity", { ...entry, id: uid("act") });
}

/* Mirror the existing localStorage accounts into the accounts/profiles
   stores. Existing rows are never overwritten with older data. */
export async function seedAccountsFromLocal() {
  let users = {};
  try {
    users = JSON.parse(localStorage.getItem("wt.users") || "{}") || {};
  } catch {
    users = {};
  }
  let session = null;
  try {
    session = JSON.parse(localStorage.getItem("wt.session") || "null");
  } catch {
    session = null;
  }
  for (const [username, rec] of Object.entries(users)) {
    if (!rec?.u) continue;
    const existing = await dbGet("accounts", username);
    if (!existing) {
      await dbPut("accounts", {
        username,
        nick: rec.nick || username,
        email: rec.email || "",
        createdAt: rec.createdAt || Date.now(),
        salt: rec.salt || "",
        hash: rec.hash || "",
        updatedAt: rec.updatedAt || null
      });
    }
    const profile = await dbGet("profiles", username);
    if (!profile) {
      await dbPut("profiles", {
        username,
        avatar: rec.profile?.avatar || "",
        city: rec.profile?.city || "",
        birthdate: rec.profile?.birthdate || "",
        bio: rec.profile?.bio || "",
        friends: Array.isArray(rec.friends) ? rec.friends : []
      });
    }
  }
  if (session?.u && session.exp && Date.now() <= session.exp) {
    const prev = await dbGet("sessions", session.u);
    await dbPut("sessions", {
      username: session.u,
      exp: session.exp,
      at: prev?.at || Date.now()
    });
  }
  return { accounts: Object.keys(users).length };
}
