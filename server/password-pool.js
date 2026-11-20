import os from "node:os";
import { Worker } from "node:worker_threads";

const WORKER_URL = new URL("./password-worker.js", import.meta.url);
const MAX_WORKERS = Math.max(1, Math.min(3, (os.availableParallelism?.() || os.cpus().length || 2) - 1));

const workers = [];
const idle = [];
const queue = [];
const pending = new Map();
let seq = 0;
let idleTimer = null;

function scheduleIdleShutdown() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (queue.length || pending.size) return;
    for (const worker of workers) {
      worker.dead = true;
      worker.terminate();
    }
    workers.length = 0;
    idle.length = 0;
  }, 2000);
}

function createWorker() {
  const worker = new Worker(WORKER_URL);
  worker.unref();
  worker.on("message", (msg) => {
    const task = pending.get(msg.id);
    pending.delete(msg.id);
    if (!worker.dead) {
      idle.push(worker);
      pump();
    }
    if (!task) return;
    if (msg.ok) task.resolve(msg.result);
    else task.reject(new Error(msg.error || "password worker failed"));
    if (!queue.length && pending.size === 0) scheduleIdleShutdown();
  });
  worker.on("error", (err) => retire(worker, err));
  worker.on("exit", (code) => retire(worker, new Error(`password worker exited (${code})`)));
  return worker;
}

function retire(worker, err) {
  if (worker.dead) return;
  worker.dead = true;
  for (const [id, task] of pending) {
    if (task.worker === worker) {
      pending.delete(id);
      task.reject(err);
    }
  }
  const i = idle.indexOf(worker);
  if (i >= 0) idle.splice(i, 1);
  const j = workers.indexOf(worker);
  if (j >= 0) workers.splice(j, 1);
  pump();
}

function pump() {
  while (queue.length) {
    let worker = idle.pop();
    if (!worker) {
      if (workers.length >= MAX_WORKERS) return;
      worker = createWorker();
      workers.push(worker);
    }
    const task = queue.shift();
    pending.set(task.id, { ...task, worker });
    worker.postMessage({ id: task.id, op: task.op, args: task.args });
  }
}

function enqueue(op, args) {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  return new Promise((resolve, reject) => {
    queue.push({ id: ++seq, op, args, resolve, reject });
    pump();
  });
}

export function hashPassword(value, rounds = 12) {
  return enqueue("hash", [String(value), rounds]);
}

export function verifyPassword(value, hash) {
  if (!hash) return Promise.resolve(false);
  return enqueue("compare", [String(value), String(hash)]);
}
