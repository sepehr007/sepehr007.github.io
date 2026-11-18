import mongoose from "mongoose";

const lobbySchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
      match: [/^[A-Z0-9-]{4,16}$/, "code must be 4-16 letters, digits or dashes"]
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    ownerUsername: {
      type: String,
      trim: true,
      maxlength: 24,
      default: ""
    },
    name: {
      type: String,
      trim: true,
      maxlength: 60,
      default: "لابی من"
    },
    capacity: {
      type: Number,
      default: 6,
      min: 2,
      max: 24
    },
    privacy: {
      type: String,
      enum: ["public", "password"],
      default: "public"
    },
    active: {
      type: Boolean,
      default: true,
      index: true
    },
    closeReason: {
      type: String,
      trim: true,
      maxlength: 40,
      default: ""
    },
    closedAt: {
      type: Date,
      default: null
    },
    lastActivityAt: {
      type: Date,
      default: Date.now,
      index: true
    },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 24 * 60 * 60 * 1000),
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
        delete ret.__v;
        return ret;
      }
    }
  }
);

lobbySchema.index({ owner: 1, active: 1 }, { unique: true, partialFilterExpression: { active: true } });
lobbySchema.index({ active: 1, lastActivityAt: -1 });

export const Lobby = mongoose.models.Lobby || mongoose.model("Lobby", lobbySchema);
