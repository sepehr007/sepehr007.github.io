import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    roomId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Room",
      required: true,
      index: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true
    },
    username: {
      type: String,
      trim: true,
      maxlength: 24,
      default: ""
    },
    content: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000
    },
    type: {
      type: String,
      enum: ["text", "system", "playback", "queue", "reaction"],
      default: "text",
      index: true
    },
    meta: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined
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
        return ret;
      }
    }
  }
);

messageSchema.index({ roomId: 1, createdAt: -1 });
messageSchema.index({ roomId: 1, type: 1, createdAt: -1 });

export const Message = mongoose.models.Message || mongoose.model("Message", messageSchema);
