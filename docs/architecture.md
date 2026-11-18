# معماری هم‌تماشا

نقشهٔ کوتاه و به‌روز از اجزای واقعی پروژه. هر تغییری در ساختار باید همین فایل را به‌روز کند.

## نمای کلی

- **فرانت‌اند استاتیک (PWA):** `D:\Site` — HTML + ES Modules + CSS، منتشرشده روی GitHub Pages (`sepehr007.github.io`).
- **بک‌اند اختیاری:** `D:\Site\server` — Fastify 5 روی Node ≥ 22.5 با SQLite داخلی یا MongoDB. سایت بدون آن هم با حالت محلی کار می‌کند و با `assets/data/runtime-config.json` یا `wt.apiBase` به سرور وصل می‌شود.

## فرانت‌اند

| بخش | محل |
| --- | --- |
| صفحات | `index.html` (لندینگ)، `auth.html` (ورود/ثبت‌نام/بازیابی)، `profile.html`، `owner.html` (+ مسیرهای مخفی)، `room.html` |
| طراحی | `assets/css/design-system.css` (توکن‌های واحد) سپس `style.css` و اسکین‌های `-v8` و `owner.css` |
| منطق | `assets/js/` — `core.js`، `i18n.js`، `auth.js`، `api.js`، `site-config.js`، `feature-flags.js`، `lobbies.js`، `room.js`، `player.js`، `net.js`، `voice.js`، `owner*.js` |
| ذخیرهٔ محلی | `localStorage` (نشست سبک، تنظیمات ظاهر) و IndexedDB (`db.js`: حساب‌ها، لابی‌ها، پیام‌ها، فعالیت، پلن/سفارش) |
| دو زبان | `i18n.js` با کلیدهای fa/en و سوییچ RTL/LTR |
| آفلاین | `sw.js` — کش نسخه‌دار؛ HTML/JS/CSS با `no-cache` از شبکه و fallback کش |

## بک‌اند

- **سرور:** `server/index.js` — CORS، محدودیت نرخ، WebSocket (`/ws`)، مسیرهای REST.
- **مسیرها:** `/api/auth/*` (ثبت‌نام، ورود، تأیید ایمیل، بازیابی، پروفایل، اتصال ایمیل/پیامک مالک)، `/api/lobbies/*`، `/api/billing/*`، `/api/features`، `/api/health`.
- **حافظهٔ نشست:** Redis در صورت وجود، وگرنه حافظهٔ فرآیند (`server/redis.js`). JWT با `jti` که با خروج یا تغییر رمز باطل می‌شود.
- **تنظیمات:** `server/settings.js` — DB-first، متغیرهای env فقط وقتی دیتابیس غیرفعال است؛ رازها هرگز به مرورگر برنمی‌گردند و فقط فلگ `passSet/apiKeySet/twilioTokenSet` برمی‌گردد.
- **ایمیل/پیامک:** `server/mailer.js` (nodemailer + outbox JSONL) و `server/sms.js` (کاوه‌نگار/Twilio/وبهوک + outbox JSONL).

## دیتابیس

- **SQLite درون‌ساخت (`node:sqlite`)** وقتی `MONGO_URI` تنظیم نشده باشد — فایل `server/data/wt.sqlite` (قابل تغییر با `DATA_DIR`).
- **MongoDB/Mongoose** وقتی `MONGO_URI` داده شود.
- مدل‌ها/جدول‌ها: `User`، `Setting` (app_settings)، `EmailToken`، `Lobby`، `Room`، `Message`، `Plan`، `Order`، `Subscription`.

## زمان واقعی

- اتاق: WebRTC مستقیم (P2P) با «میزبان = سرور»؛ چت/پخش/واکنش روی data channel میزبان.
- سرور: هاب WebSocket برای حضور و قواعد قابلیت‌ها؛ Redis در حد نشست/کش/نرخ است، Pub/Sub برای مقیاس چندنمونه‌ای هنوز اضافه نشده.

## احراز هویت

- محلی (بدون سرور): PBKDF2 در مرورگر، کد بازیابی یک‌بارمصرف، نشست ۳۰ روزه.
- سروری: bcrypt، JWT کوتاه‌عمر با `jti`، کد ۸ رقمی هش‌شده برای تأیید ایمیل (۳۰ دقیقه) و بازیابی (۱۵ دقیقه، ۵ تلاش)، شمارهٔ موبایل اختیاری برای بازیابی پیامکی.
- مالک: نقش `owner/super_owner`؛ کنسول با رمز محلی باز می‌شود و برای عملیات سروری (مثل اتصال ایمیل/پیامک) باید با حساب مالک به سرور وارد شود.

## استقرار

- فرانت‌اند: GitHub Pages از شاخهٔ `main` و ریشهٔ مخزن؛ کش سرویس‌ورکر با هر انتشار bump می‌شود.
- بک‌اند: هر میزبان Node؛ برای ارسال واقعی ایمیل/پیامک باید میزبانی شود و `runtime-config.json` به آن اشاره کند.

## شکاف‌های شناخته‌شده

- GitHub Pages سرور اجرا نمی‌کند؛ کدهای ایمیل/پیامک روی سایت زنده فقط با سرور میزبانی‌شده ارسال می‌شوند.
- آمار سراسری، بن سراسری، اشتراک چنددستگاهی و پرداخت واقعی هنوز به فاز بعد نیاز دارند.
- Pub/Sub و کارگر پس‌زمینه برای مقیاس افقی وجود ندارد.
