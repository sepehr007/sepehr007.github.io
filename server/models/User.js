import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      minlength: 3,
      maxlength: 24
    },
    usernameLower: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true
    },
    passwordHash: {
      type: String,
      required: true,
      select: false
    },
    role: {
      type: String,
      enum: ["user", "owner", "super_owner"],
      default: "user",
      index: true
    },
    avatar: {
      type: String,
      default: "",
      maxlength: 120
    },
    lastLoginAt: {
      type: Date,
      default: null
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
        delete ret.passwordHash;
        delete ret.usernameLower;
        return ret;
      }
    }
  }
);

userSchema.pre("validate", function setUsernameLower() {
  if (this.username) this.usernameLower = String(this.username).trim().toLowerCase();
});

userSchema.index({ role: 1, createdAt: -1 });

export const User = mongoose.models.User || mongoose.model("User", userSchema);
