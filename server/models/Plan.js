import mongoose from "mongoose";

const planSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    cycle: { type: String, enum: ["monthly", "yearly", "lifetime"], default: "monthly", index: true },
    price: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "IRT", maxlength: 8 },
    days: { type: Number, default: 30, min: 1 },
    features: { type: [String], default: [] },
    active: { type: Boolean, default: true, index: true },
    popular: { type: Boolean, default: false }
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: {
      transform(_doc, ret) {
        ret.id = ret.slug;
        return ret;
      }
    }
  }
);

export const Plan = mongoose.models.Plan || mongoose.model("Plan", planSchema);
