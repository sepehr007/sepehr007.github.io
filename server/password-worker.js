import { parentPort } from "node:worker_threads";
import bcrypt from "bcryptjs";

parentPort.on("message", async ({ id, op, args }) => {
  try {
    let result;
    if (op === "hash") {
      result = await bcrypt.hash(args[0], args[1]);
    } else if (op === "compare") {
      try {
        result = await bcrypt.compare(args[0], args[1]);
      } catch {
        result = false;
      }
    } else {
      throw new Error(`unknown password op: ${op}`);
    }
    parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err?.message || "password worker failed" });
  }
});
