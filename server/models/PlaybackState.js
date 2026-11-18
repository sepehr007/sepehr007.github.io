import mongoose from "mongoose";

const playbackStateSchema = new mongoose.Schema(
  {
    roomCode: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      index: true
    },
    mediaUrl: { type: String, default: "", maxlength: 2000 },
    mediaType: { type: String, default: "", maxlength: 40 },
    position: { type: Number, default: 0, min: 0 },
    paused: { type: Boolean, default: true },
    rate: { type: Number, default: 1, min: 0.1, max: 16 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    updatedAt: { type: Date, default: Date.now, index: true }
  },
  { versionKey: false }
);

export const PlaybackState =
  mongoose.models.PlaybackState || mongoose.model("PlaybackState", playbackStateSchema);
