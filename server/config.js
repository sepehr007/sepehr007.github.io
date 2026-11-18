import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const ENV_ALIASES = {
  dev: "development",
  development: "development",
  test: "development",
  stage: "staging",
  staging: "staging",
  prod: "production",
  production: "production"
};

function normalizeEnv(value) {
  return ENV_ALIASES[String(value || "").trim().toLowerCase()] || "development";
}

function number(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function text(value, fallback = "") {
  return String(value ?? "").trim() || fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const raw = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function list(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readVersion() {
  try {
    const raw = fs.readFileSync(path.join(HERE, "package.json"), "utf8");
    return String(JSON.parse(raw).version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

const env = normalizeEnv(process.env.APP_ENV || process.env.NODE_ENV);
const isDeployed = env !== "development";

const dataDir = path.resolve(text(process.env.DATA_DIR, path.join(HERE, "data")));
const sqliteFile = path.resolve(text(process.env.SQLITE_FILE, path.join(dataDir, "wt.sqlite")));
const backupDir = path.resolve(text(process.env.BACKUP_DIR, path.join(dataDir, "backups")));

const appOrigin = text(process.env.APP_ORIGIN || process.env.PUBLIC_URL).replace(/\/+$/, "");
const explicitOrigins = list(process.env.CORS_ORIGIN).map((origin) => origin.replace(/\/+$/, ""));
const corsOrigins = explicitOrigins.length ? explicitOrigins : appOrigin ? [appOrigin] : [];
const corsAllowAll = corsOrigins.length === 0 && !isDeployed;

const jwtSecret = String(process.env.JWT_SECRET || "");

export const appConfig = Object.freeze({
  env,
  isDeployed,
  version: readVersion(),
  node: process.versions.node,
  port: Math.round(number(process.env.PORT, 3001, { min: 1, max: 65535 })),
  host: text(process.env.HOST, "0.0.0.0"),
  trustProxy: bool(process.env.TRUST_PROXY, true),
  appOrigin,
  cors: Object.freeze({
    origins: Object.freeze(corsOrigins),
    allowAll: corsAllowAll
  }),
  dataDir,
  sqliteFile,
  backupDir,
  logLevel: text(process.env.LOG_LEVEL, "info"),
  databaseRetryMs: Math.round(number(process.env.DB_RETRY_MS, isDeployed ? 15000 : 0, { min: 0, max: 600000 })),
  rateLimit: Object.freeze({
    max: Math.round(number(process.env.RATE_LIMIT_MAX, 50, { min: 1 })),
    windowMs: Math.round(number(process.env.RATE_LIMIT_WINDOW_MS, 60000, { min: 1000 }))
  }),
  hasJwtSecret: Boolean(jwtSecret)
});

export function configWarnings(envVars = process.env) {
  const warnings = [];
  if (appConfig.isDeployed && !appConfig.hasJwtSecret) {
    warnings.push({
      level: "error",
      code: "jwt_secret_missing",
      message: "JWT_SECRET is required when APP_ENV is staging or production."
    });
  } else if (appConfig.hasJwtSecret && jwtSecret.length < 32) {
    warnings.push({
      level: "warn",
      code: "jwt_secret_short",
      message: "JWT_SECRET should be at least 32 random characters."
    });
  }
  if (appConfig.isDeployed && !appConfig.cors.origins.length) {
    warnings.push({
      level: "warn",
      code: "cors_empty",
      message: "CORS_ORIGIN and APP_ORIGIN are empty: the API will only answer same-origin calls."
    });
  }
  if (appConfig.isDeployed && !appConfig.appOrigin) {
    warnings.push({
      level: "warn",
      code: "app_origin_missing",
      message: "APP_ORIGIN is not set: email links fall back to the request origin."
    });
  }
  if (!envVars.MONGO_URI && !envVars.REDIS_URL) {
    warnings.push({
      level: "info",
      code: "single_node",
      message: "SQLite + in-memory sessions: correct for one node. Set MONGO_URI/REDIS_URL to scale out."
    });
  }
  return warnings;
}

export function publicConfig() {
  return {
    env: appConfig.env,
    version: appConfig.version,
    node: appConfig.node,
    cors: appConfig.cors.allowAll ? ["*"] : [...appConfig.cors.origins],
    appOrigin: appConfig.appOrigin,
    trustProxy: appConfig.trustProxy,
    databaseRetryMs: appConfig.databaseRetryMs
  };
}
