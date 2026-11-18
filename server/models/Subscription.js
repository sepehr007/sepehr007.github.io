import mongoose from "mongoose";

const subscriptionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    planSlug: { type: String, required: true, index: true },
    cycle: { type: String, enum: ["monthly", "yearly", "lifetime"], default: "monthly" },
    status: {
      type: String,
      enum: ["pending", "active", "expired", "cancelled"],
      default: "pending",
      index: true
    },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
    startedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null, index: true }
  },
  {
    timestamps: true,
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

subscriptionSchema.index({ user: 1, status: 1, updatedAt: -1 });

export const Subscription =
  mongoose.models.Subscription || mongoose.model("Subscription", subscriptionSchema);
