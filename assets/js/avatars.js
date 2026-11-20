export const AVATAR_PRESETS = [
  { id: "girl-1", gender: "girl", src: "./assets/avatars/girl-1.webp", labelFa: "موی بلند مشکی", labelEn: "Long black hair" },
  { id: "girl-2", gender: "girl", src: "./assets/avatars/girl-2.webp", labelFa: "فر قهوه‌ای", labelEn: "Curly brown hair" },
  { id: "girl-3", gender: "girl", src: "./assets/avatars/girl-3.webp", labelFa: "دم‌اسب بلوند", labelEn: "Blonde ponytail" },
  { id: "girl-4", gender: "girl", src: "./assets/avatars/girl-4.webp", labelFa: "فر طبیعی", labelEn: "Natural curls" },
  { id: "girl-5", gender: "girl", src: "./assets/avatars/girl-5.webp", labelFa: "حجاب نعنایی", labelEn: "Mint hijab" },
  { id: "girl-6", gender: "girl", src: "./assets/avatars/girl-6.webp", labelFa: "باب قرمز", labelEn: "Auburn bob" },
  { id: "boy-1", gender: "boy", src: "./assets/avatars/boy-1.webp", labelFa: "موی کوتاه مشکی", labelEn: "Short black hair" },
  { id: "boy-2", gender: "boy", src: "./assets/avatars/boy-2.webp", labelFa: "فر با عینک", labelEn: "Curly & glasses" },
  { id: "boy-3", gender: "boy", src: "./assets/avatars/boy-3.webp", labelFa: "بلوند خندان", labelEn: "Blond smile" },
  { id: "boy-4", gender: "boy", src: "./assets/avatars/boy-4.webp", labelFa: "فید و ریش", labelEn: "Fade & beard" },
  { id: "boy-5", gender: "boy", src: "./assets/avatars/boy-5.webp", labelFa: "موی موجی", labelEn: "Wavy brown hair" },
  { id: "boy-6", gender: "boy", src: "./assets/avatars/boy-6.webp", labelFa: "موی شانه‌ای", labelEn: "Swept chestnut hair" }
];

const MAP = new Map(AVATAR_PRESETS.map((p) => [p.id, p]));

export function presetValue(id) {
  return `preset:${id}`;
}

export function avatarId(value) {
  if (typeof value !== "string") return "";
  const id = value.startsWith("preset:") ? value.slice(7) : value;
  return MAP.has(id) ? id : "";
}

export function isAvatarId(value) {
  return !!avatarId(value);
}

export function avatarSrc(value) {
  if (!value) return "";
  if (/^data:image\/(?:png|jpe?g|webp);base64,/i.test(value)) return value;
  if (/^https?:\/\/[^\s"'<>]+$/i.test(value)) return value;
  const p = MAP.get(avatarId(value));
  return p ? p.src : "";
}
