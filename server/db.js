import mongoose from "mongoose";

mongoose.set("strictQuery", true);
mongoose.set("bufferCommands", false);

let lastError = "";
let eventsBound = false;
let currentAttempt = null;

export function dbReady() {
  return mongoose.connection.readyState === 1;
}

export function dbState() {
  const names = {
    0: "disconnected",
    1: "connected",
    2: "connecting",
    3: "disconnecting"
  };
  return {
    ready: dbReady(),
    state: names[mongoose.connection.readyState] || "unknown",
    name: mongoose.connection.name || "",
    error: lastError
  };
}

function bindEvents() {
  if (eventsBound) return;
  eventsBound = true;
  mongoose.connection.on("connected", () => {
    lastError = "";
    console.log(`[mongo] connected to ${mongoose.connection.name}`);
  });
  mongoose.connection.on("error", (err) => {
    lastError = err.message;
    console.error("[mongo] error:", err.message);
  });
  mongoose.connection.on("disconnected", () => {
    console.warn("[mongo] disconnected");
  });
}

export async function connectDB(uri = process.env.MONGO_URI, { retry = true, retryDelayMs = 5000 } = {}) {
  if (!uri) {
    lastError = "MONGO_URI is not set";
    console.warn("[mongo] MONGO_URI is not set - database features are disabled");
    return null;
  }
  if (dbReady()) return mongoose.connection;
  if (currentAttempt) return currentAttempt;

  bindEvents();

  currentAttempt = (async () => {
    try {
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 8000,
        socketTimeoutMS: 45000,
        maxPoolSize: 50,
        minPoolSize: 2,
        autoIndex: process.env.NODE_ENV !== "production"
      });
      return mongoose.connection;
    } catch (err) {
      lastError = err.message;
      console.error("[mongo] connect failed:", err.message);
      if (retry) {
        const timer = setTimeout(() => {
          connectDB(uri, { retry, retryDelayMs }).catch(() => {});
        }, retryDelayMs);
        timer.unref?.();
      }
      return null;
    } finally {
      currentAttempt = null;
    }
  })();

  return currentAttempt;
}

export async function disconnectDB() {
  try {
    await mongoose.disconnect();
  } catch {}
}
