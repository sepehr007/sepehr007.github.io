import mongoose from "mongoose";

const roomSchema = new mongoose.Schema(
  {
    roomCode: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
      match: [/^[A-Z0-9-]{4,16}$/, "roomCode must be 4-16 letters, digits or dashes"]
    },
    name: {
      type: String,
      trim: true,
      maxlength: 60,
      default: "اتاق بدون نام"
    },
    hostId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true
    },
    settings: {
      capacity: { type: Number, default: 6, min: 2, max: 24 },
      isPrivate: { type: Boolean, default: false },
      passwordHash: { type: String, default: "", select: false },
      theme: { type: String, default: "dark", maxlength: 24 },
      lang: { type: String, enum: ["fa", "en"], default: "fa" },
      features: {
        chat: { type: Boolean, default: true },
        voice: { type: Boolean, default: true },
        screenShare: { type: Boolean, default: true },
        queue: { type: Boolean, default: true },
        subtitles: { type: Boolean, default: true },
        localFile: { type: Boolean, default: true }
      }
    },
    memberCount: {
      type: Number,
      default: 0,
      min: 0
    },
    lastActivityAt: {
      type: Date,
      default: Date.now,
      index: true
    },
    createdAt: {
      type: Date,
      default: Date.now,
      index: true
    }
  },
  {
    versionKey: false,
    toJSON: {
      transform(_doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.settings?.passwordHash;
        return ret;
      }
    }
  }
);

roomSchema.index({ isActive: 1, lastActivityAt: -1 });

export const Room = mongoose.models.Room || mongoose.model("Room", roomSchema);
