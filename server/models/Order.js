import mongoose from "mongoose";

const orderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    planSlug: { type: String, required: true, index: true },
    cycle: { type: String, enum: ["monthly", "yearly", "lifetime"], default: "monthly" },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "IRT", maxlength: 8 },
    status: {
      type: String,
      enum: ["pending", "paid", "cancelled", "refunded"],
      default: "pending",
      index: true
    },
    provider: { type: String, default: "", maxlength: 40 },
    providerRef: { type: String, default: "", maxlength: 120 },
    paidAt: { type: Date, default: null }
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

orderSchema.index({ user: 1, status: 1, createdAt: -1 });

export const Order = mongoose.models.Order || mongoose.model("Order", orderSchema);
