import mongoose from "mongoose";

const emailTokenSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    kind: { type: String, enum: ["verify", "reset"], required: true, index: true },
    codeHash: { type: String, default: "", select: false },
    linkHash: { type: String, default: "", index: true, sparse: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    consumedAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now }
  },
  { versionKey: false }
);

emailTokenSchema.index({ userId: 1, kind: 1, createdAt: -1 });
emailTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const EmailToken = mongoose.models.EmailToken || mongoose.model("EmailToken", emailTokenSchema);
