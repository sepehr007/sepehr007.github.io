# تحویل پروژه هم‌تماشا

این سند خلاصهٔ وضعیت واقعی پروژه است: چه چیزی هست، چطور اجرا می‌شود و چه چیزهایی هنوز وجود ندارد. برای جزئیات هر بخش، سند تخصصی همان بخش لینک شده است.

## ۱. معماری در یک نگاه

| بخش | فناوری | محل |
| --- | --- | --- |
| فرانت‌اند | HTML/CSS/ES Modules + PWA (Service Worker) | ریشهٔ `D:\Site`؛ منتشرشده روی GitHub Pages |
| بک‌اند | Fastify 5 روی Node ≥ 22.5 | `D:\Site\server` |
| داده | SQLite داخلی (`node:sqlite`، WAL + FK + مهاجرت نسخه‌دار) | `server/data/wt.sqlite` |
| دادهٔ اختیاری | MongoDB و Redis برای مقیاس | با `MONGO_URI` / `REDIS_URL` |
| زمان واقعی | WebSocket `/ws` برای حضور، چت، پخش و اعلان؛ WebRTC P2P برای رسانه | `server/index.js` + `assets/js/net.js` |
| صف/کارگر جدا | ندارد؛ کارها در همان فرآیند API اجرا می‌شوند | — |

فرانت‌اند دو حالت دارد:

1. **حالت محلی (بدون سرور):** حساب‌ها در `localStorage`، دوستان محلی، اتاق P2P با میزبان = مرورگر. این حالت روی GitHub Pages کار می‌کند.
2. **حالت سروری:** با تنظیم `apiBase` در `assets/data/runtime-config.json` (یا `WT_API_BASE` / `localStorage["wt.apiBase"]`)، حساب، نشست، اتاق، چت، پرداخت و پنل مالک از API و SQLite می‌آیند.

جزئیات کامل: [architecture.md](architecture.md).

## ۲. نصب و اجرای محلی

پیش‌نیاز: Node.js ≥ 22.5 (برای `node:sqlite`) و یک مرورگر جدید با WebRTC.

```bash
# فرانت‌اند (هر سرور استاتیک)
cd D:/Site
python -m http.server 8000
# http://localhost:8000

# بک‌اند
cd D:/Site/server
npm ci
cp .env.example .env      # مقادیر را ویرایش کنید
npm run config            # بررسی پیکربندی؛ باید ok:true بدهد
npm run seed              # فقط روی دیتابیس خالی؛ مالک اولیه را می‌سازد
npm run dev               # یا npm start
```

برای اتصال فرانت به بک‌اند محلی، `assets/data/runtime-config.json` را به این مقدار بگذارید:

```json
{ "apiBase": "http://localhost:3001/api" }
```

در حالت توسعه، CORS آزاد است و `JWT_SECRET` اجباری نیست. بیرون از توسعه (`staging`/`production`) سرور بدون `JWT_SECRET` بالا نمی‌آید.

## ۳. راه‌اندازی توسعه

- **لایهٔ فرانت:** تغییر در `assets/js/*` و `assets/css/*` کافی است؛ ماژول‌ها ES Module هستند و بیلد ندارند. با هر تغییر فایل‌های پوسته، نسخهٔ `CACHE` در `sw.js` را یک عدد بالا ببرید.
- **لایهٔ بک‌اند:** `npm run dev` از `node --watch` استفاده می‌کند. تست‌ها و ابزارها روی دادهٔ موقت داخل `server/.tmp` کار می‌کنند و به دیتابیس واقعی دست نمی‌زنند.
- **پیکربندی:** همهٔ متغیرها در `server/.env` (بر اساس `server/.env.example`) و در `server/config.js` یک‌جا خوانده و اعتبارسنجی می‌شوند.
- **ویژگی‌های نصب‌شده:** هیچ مرحلهٔ بیلد سمت فرانت وجود ندارد. `hls.js` به‌صورت محلی همراه پروژه است؛ تنها وابستگی خارجی زمان اجرا `ffmpeg.wasm` است که از CDN (jsdelivr/unpkg) بارگذاری می‌شود و فقط برای تبدیل فایل‌های غیرقابل‌پخش لازم است.

## ۴. متغیرهای محیطی

فهرست کامل و توضیح هر متغیر در [deployment.md](deployment.md#۳-پیکربندی-متمرکز) آمده است. خلاصهٔ گروه‌ها:

| گروه | متغیرها |
| --- | --- |
| محیط و HTTP | `APP_ENV` (`development`/`staging`/`production`)، `LOG_LEVEL`، `PORT`، `HOST`، `TRUST_PROXY`، `CORS_ORIGIN`، `APP_ORIGIN`/`PUBLIC_URL`، `RATE_LIMIT_MAX`، `RATE_LIMIT_WINDOW_MS` |
| امنیت | `JWT_SECRET` (بیرون از توسعه اجباری، ≥۳۲ کاراکتر)، `SECURITY_MANDATORY_OFF`، `FEATURE_EMERGENCY_OFF` |
| داده | `MONGO_URI`، `REDIS_URL`، `DATA_DIR`، `SQLITE_FILE`، `BACKUP_DIR`، `DB_RETRY_MS`، `DB_BUSY_TIMEOUT_MS` |
| پشتیبان و نگهداری | `AUTO_BACKUP_HOURS`، `BACKUP_KEEP`، `MAINTENANCE_INTERVAL_MS`، `RETENTION_*` |
| قابلیت‌ها | `FEATURE_CACHE_MS`، `FEATURE_SCOPE_CACHE_MS` |
| ذخیره‌سازی فایل | `UPLOAD_USER_QUOTA_MB` (پیش‌فرض ۶۰)، `UPLOAD_GLOBAL_QUOTA_MB` (پیش‌فرض ۲۰۴۸) |
| مالک اولیه | `OWNER_EMAIL`، `OWNER_USERNAME`، `OWNER_PHONE` (مثل `09121234567`)، `OWNER_PASSWORD` (≥۱۲ کاراکتر) |
| ایمیل | `SMTP_HOST`، `SMTP_PORT`، `SMTP_SECURE`، `SMTP_USER`، `SMTP_PASS`، `MAIL_FROM`، `REQUIRE_EMAIL_VERIFICATION` |
| پیامک | `SMS_PROVIDER` (`kavenegar`/`twilio`/`webhook`)، `SMS_API_KEY`، `SMS_SENDER`، `SMS_WEBHOOK_URL`، `SMS_TWILIO_*` |
| پرداخت | `PAYMENT_PROVIDER` (`manual`/`hmac`)، `PAYMENT_WEBHOOK_SECRET`، `PAYMENT_CHECKOUT_URL`، `PAYMENT_MERCHANT_ID`، `PAYMENT_CURRENCY` |

نکته: تنظیمات ایمیل/پیامک از پنل مالک هم قابل تغییر است و در دیتابیس ذخیره می‌شود؛ مقدارهای env فقط پیش‌فرض/زمان نبود دیتابیس‌اند. رازها هرگز به مرورگر برنمی‌گردند.

## ۵. دیتابیس و مهاجرت‌ها

- منبع حقیقت پیش‌فرض: SQLite با WAL، `foreign_keys=ON` و تراکنش برای هر مهاجرت.
- در اولین اجرا فایل دیتابیس و همهٔ مهاجرت‌ها خودکار ساخته می‌شوند؛ فقط `DATA_DIR` باید برای کاربر سرویس قابل نوشتن باشد. `npm run seed` فقط روی دیتابیس خالی مالک اولیه را می‌سازد.
- مهاجرت‌ها در `server/database/schema.js` تعریف شده‌اند و نسخهٔ فعلی **۱۶** است. هر مهاجرت چک‌سام دارد؛ تغییر متن مهاجرت اجراشده دوباره اجرا نمی‌شود.
- جدول‌های اصلی (۳۸ جدول در بررسی انتشار): `users`، `sessions`، `rooms`، `room_members`، `messages`، `watch_history`، `plans`، `orders`، `payments`، `subscriptions`، `notifications`، `support_tickets`، `pages`، `media_objects`، `audit_logs` و…
- ایندکس‌های عملکردی نسخهٔ ۱۶: `idx_users_active_created` و `idx_rooms_last_activity`؛ بدون اقدام دستی در اولین بالا آمدن ساخته می‌شوند.
- ابزار بررسی: `npm run integrity` (بررسی `integrity_check`، `foreign_key_check`، ردیف‌های یتیم و ایندکس‌های انتظاری؛ چیزی را تغییر نمی‌دهد).
- جزئیات: [database.md](database.md).

## ۶. استقرار

- **فرانت‌اند:** GitHub Pages از شاخهٔ `main` و ریشهٔ مخزن (`https://sepehr007.github.io`). هر `git push` سایت را به‌روز می‌کند. GitHub Pages فقط فایل استاتیک سرو می‌کند و بک‌اند/WebSocket اجرا نمی‌کند.
- **بک‌اند:** VPS با systemd یا Docker Compose؛ پیش‌نیاز Node ≥ 22.5، پروکسی معکوس با پشتیبانی Upgrade و HTTPS.
  - systemd نمونه: `server/deploy/wt-api.service`
  - nginx: `server/deploy/nginx.conf.example`
  - Caddy: `server/deploy/Caddyfile.example`
  - Docker: `server/Dockerfile` + `docker-compose.yml` در ریشه
- **پیکربندی پیش از استقرار:** `npm ci --omit=dev && npm run config`، سپس `npm run seed` فقط روی دیتابیس خالی.
- **آدرس API فرانت:** `assets/data/runtime-config.json` با `{"apiBase":"https://api.example.com/api"}`.
- **سلامت:** `GET /api/health` (liveness) و `GET /api/ready` (readiness؛ ۵۰۳ وقتی دیتابیس آماده نیست).
- راهنمای گام‌به‌گام: [deployment.md](deployment.md).

## ۷. سرویس‌های بیرونی

| سرویس | وضعیت واقعی | تنظیم |
| --- | --- | --- |
| ایمیل | بدون SMTP، پیام‌ها در `DATA_DIR/mail-outbox.jsonl` نوشته می‌شوند | `SMTP_*` یا پنل مالک |
| پیامک | کاوه‌نگار / Twilio / وب‌هوک؛ بدون تنظیم، خروجی در `DATA_DIR/sms-outbox.jsonl` | `SMS_*` یا پنل مالک |
| MongoDB | اختیاری؛ فقط وقتی `MONGO_URI` ست باشد | `MONGO_URI` |
| Redis | اختیاری؛ نشست/کش/نرخ؛ بدون آن حافظهٔ فرآیند | `REDIS_URL` |
| ntfy.sh | رلهٔ عمومی سیگنالینگ WebRTC در حالت legacy | `assets/js/net.js`؛ قابل تغییر با `?signal=` یا `localStorage["wt.signal"]` |
| درگاه پرداخت | قرارداد آماده است، درگاه واقعی وصل نیست | بخش ۹ |

## ۸. WebRTC و TURN — وضعیت واقعی

- تماس صوتی، اشتراک صفحه و انتقال فایل **P2P و mesh** هستند؛ سرور رسانه پردازش یا ترنسکد نمی‌کند.
- ICE در `assets/js/net.js` (خط ۳۰) **هاردکد** است: دو STUN گوگل و TURN عمومی `openrelay.metered.ca` با اعتبارنامهٔ عمومی `openrelayproject`. هیچ متغیر محیطی برای TURN وجود ندارد و برای TURN اختصاصی باید همین فایل تغییر کند.
- سیگنالینگ اتاق legacy از طریق `https://ntfy.sh` با موضوع مشتق‌شده از کد اتاق است (قابل تغییر با `?signal=` یا `localStorage["wt.signal"]`). این یک وابستگی بیرونی و شکاف شناخته‌شده است.
- LiveKit یا هر SFU دیگری استفاده نمی‌شود و ادعای اتاق بزرگ وجود ندارد. mesh برای اتاق‌های کوچک (حدود ۶ نفر) مناسب است.
- برای پایداری در شبکه‌های سخت‌گیرانه، سرور coturn اختصاصی توصیه می‌شود؛ میزبانی اشتراکی این امکان را نمی‌دهد.
- HTTPS برای میکروفون، دوربین، اشتراک صفحه و PWA الزامی است (localhost استثناست).

## ۹. پرداخت

- پیش‌فرض: `PAYMENT_PROVIDER=manual` — سفارش ثبت می‌شود، کاربر رسید/کد پیگیری می‌فرستد و **فقط مالک** پرداخت را تأیید می‌کند (`confirm:true`). فعال‌سازی اشتراک بعد از تأیید انجام می‌شود.
- حالت دوم: `PAYMENT_PROVIDER=hmac` — کاربر به `PAYMENT_CHECKOUT_URL` هدایت می‌شود و درگاه باید به `POST /api/billing/webhook/hmac` با بدنهٔ JSON زیر پاسخ دهد:

```json
{ "eventId": "…", "orderId": "…", "status": "paid", "amount": 199000, "providerRef": "…" }
```

- امضا: هدر `x-wt-signature` = HMAC-SHA256 روی **بدنهٔ خام** با `PAYMENT_WEBHOOK_SECRET` (هگز). امضای نامعتبر ۴۰۱، اختلاف مبلغ ۴۰۹، رویداد تکراری با `UNIQUE(provider, event_id)` خنثی می‌شود.
- هیچ درگاه ایرانی از پیش متصل نیست و هیچ دادهٔ کارت ذخیره نمی‌شود. تا بسته‌شدن قرارداد پذیرندگی، حالت `manual` تنها مسیر واقعی است.

## ۱۰. مالک و کنسول‌ها

**مالک اولیه (سمت سرور):** با `npm run seed` روی دیتابیس خالی و از روی `OWNER_EMAIL`/`OWNER_USERNAME`/`OWNER_PHONE`/`OWNER_PASSWORD` ساخته می‌شود و نقش `super_owner` می‌گیرد. رمز پیش‌فرض وجود ندارد: بدون `OWNER_PASSWORD` معتبر (≥۱۲ کاراکتر و متفاوت از نمونه) seed مالک را نمی‌سازد و فقط هشدار می‌دهد. ایمیل مالک به‌صورت تأییدشده ثبت می‌شود و `OWNER_PHONE` اختیاری است؛ برای باز شدن کنسول کافی است ایمیل تأییدشده **یا** شمارهٔ پیامک وجود داشته باشد. روی دیتابیس موجود این مقادیر را با `npm run owner:setup -- --yes` اعمال کنید؛ بدون `--yes` فقط پیش‌نمایش تغییرات است و رمز هرگز چاپ نمی‌شود.

**کنسول مالک:** مسیرهای مخفی `owner.html`، `/owner/`، `/god/`، `/admin-access/` (بدون لینک عمومی، `noindex,nofollow`). ورود فقط با ایمیل/نام‌کاربری مالک و رمز همان حساب روی سرور انجام می‌شود؛ هیچ رمز یا نشست محلی قابل جعل باقی نمانده است. اگر نه ایمیل تأییدشده و نه شمارهٔ پیامک مالک ثبت نشده باشد، کنسول باز نمی‌شود (`409 owner_contact_missing`). تغییر رمز مالک فقط از داخل کنسول و با **یک کد ۸ رقمی** (ایمیل یا پیامک، به انتخاب مالک) انجام می‌شود؛ رمز فعلی لازم نیست، رمز جدید باید متفاوت باشد و همهٔ نشست‌های قبلی باطل می‌شوند. برای حساب مالک، مسیرهای عادی `/auth/password`، `/auth/recovery-code`، `/auth/recover` و forgot بسته‌اند و فرم رمز در پروفایل عادی پنهان می‌شود؛ فقط همین صفحهٔ امنیت کنسول رمز را عوض می‌کند. ارسال واقعی کد به `SMTP_*` یا `SMS_*` نیاز دارد؛ بدون آن‌ها کد فقط در outbox فایل می‌نشیند و برای استفادهٔ واقعی کافی نیست. مقادیر واقعی مالک را فقط در `server/.env` نگه دارید؛ این فایل در `.gitignore` و `.dockerignore` است و نباید در مخزن، مستندات یا تصویر داکر قرار بگیرد.

**کنسول مالک سرور:** همان `owner.html` وقتی با حساب `owner`/`super_owner` به API وصل باشد؛ صفحات کاربران، اتاق‌ها، گزارش‌ها، مالی، اشتراک، صفحه‌ها، خودکارسازی، اعلان همگانی، حسابرسی، پشتیبان و تنظیمات را از `/api/admin/*` می‌خواند و می‌نویسد. تصمیم‌های حساس در سرور بررسی می‌شوند، نه در UI.

## ۱۱. فرمان‌های تست

```bash
cd server
npm test             # هر دو مجموعه
npm run test:sec     # امنیت و realtime (sec36-38)
npm run test:qa      # بخش ۴۲ (حساب، اتاق، رسانه، کسب‌وکار، پلتفرم)
npm run release:check # بررسی انتشار (۳۷ بررسی)
npm run config       # اعتبارسنجی پیکربندی
npm run integrity    # سلامت دیتابیس
```

- آخرین نتیجه: `release:check` **۳۷/۳۷**، `section42` **۲۷/۲۷**، `sec36-38` بدون خطا.
- بررسی مرورگر واقعی: ۹ صفحه × دسکتاپ/تبلت/موبایل = ۲۷ ترکیب بدون خطای کنسول، درخواست ناموفق یا سرریز افقی؛ ثبت‌نام کامل در ۳۹۰×۸۴۴ هم تست شد.
- تست‌ها به سرویس بیرونی، اعتبارنامه یا درگاه واقعی نیاز ندارند؛ همین موضوع در بخش محدودیت‌ها آمده است.
- جزئیات: [testing.md](testing.md).

## ۱۲. پشتیبان و بازیابی

- پشتیبان خودکار هر `AUTO_BACKUP_HOURS` (پیش‌فرض ۲۴) در `BACKUP_DIR`؛ نگهداری `BACKUP_KEEP` نسخه (پیش‌فرض ۳۰). دستی از پنل مالک یا `POST /api/admin/database/backup`.
- هر پشتیبان با `VACUUM INTO` و چک‌سام ساخته و در جدول `backup_runs` ثبت می‌شود.
- بازیابی پیش‌فرض فقط بررسی است:

```bash
npm run restore -- backups/wt-2026-11-18T12-00-00-000Z.sqlite        # dry-run
npm run restore -- backups/wt-2026-11-18T12-00-00-000Z.sqlite --yes  # جایگزینی
```

- قبل از جایگزینی سرویس را متوقف کنید. اسکریپت خودش یک نسخهٔ `pre-restore-*.sqlite` می‌گیرد و فایل‌های `-wal`/`-shm` قدیمی را پاک می‌کند.
- پشتیبان‌ها را با rsync به ماشین دیگر هم منتقل کنید؛ پشتیبان روی همان دیسک در برابر خرابی دیسک محافظت نمی‌کند.

## ۱۳. محدودیت‌های شناخته‌شده

- **تک‌نودی:** SQLite منبع اصلی است؛ دو نمونه API روی یک فایل SQLite اجرا نکنید. رویدادهای اتاق در حافظهٔ همان نود هستند و Pub/Sub بین‌نودی وجود ندارد.
- **برای مقیاس افقی** باید Mongo/Redis وصل شوند، اما بازنویسی قابلیت‌ها هنوز در SQLite محلی است و به فروشگاه مشترک منتقل نشده.
- **سیگنالینگ ntfy عمومی** و **TURN عمومی openrelay** وابستگی بیرونی‌اند؛ برای پروداکشن پایدار باید جایگزین شوند (TURN اختصاصی نیازمند تغییر `net.js` است).
- **درگاه پرداخت واقعی وصل نیست**؛ فقط `manual` و قرارداد `hmac` وجود دارد.
- **بدون SMTP/پیامک**، ایمیل و پیامک فقط در outbox فایل ذخیره می‌شوند و به کاربر نمی‌رسند.
- **آپلودها روی دیسک همان سرور** هستند (`DATA_DIR/uploads`)؛ آداپتور S3/فضای مشترک وجود ندارد.
- **GitHub Pages فقط استاتیک است:** بک‌اند، WebSocket، کرون و TURN روی آن اجرا نمی‌شوند.
- **خصوصی‌کردن Pages روی حساب شخصی ممکن نیست؛** برای مخزن خصوصی باید میزبانی دیگری برای فرانت انتخاب شود.
- **پوش وب (VAPID/Web Push) پیاده نشده**؛ اعلان درون‌برنامه‌ای و پوش مرورگر فقط با تب باز/مجوز صریح است.
- **پردازش رسانه سمت سرور ندارد**؛ محدودیت کدک به مرورگر وابسته است (HEVC/AC3 نیاز به تبدیل سمت مرورگر دارد).
- **زمان تأخیر (latency) اندازه‌گیری نمی‌شود** و آمار بازدید/تماشا فقط با دادهٔ واقعی جدول‌ها نمایش داده می‌شود، وگرنه «در دسترس نیست».
- **حالت محلی بدون سرور** حساب‌ها را فقط در همان مرورگر نگه می‌دارد؛ بازیابی رمز، دوستی بین دستگاه‌ها و مدیریت سراسری در آن حالت وجود ندارد.
- **JWT در `localStorage`** است؛ CSRF کوکی وجود ندارد اما ریسک XSS باقی است (جزئیات در [security.md](security.md)).

## ۱۴. مراجع

- [architecture.md](architecture.md) — نقشهٔ اجزا و جریان داده
- [database.md](database.md) — اسکیما، مهاجرت، ایندکس، پشتیبان
- [deployment.md](deployment.md) — محیط‌ها، VPS، داکر، میزبانی اشتراکی
- [security.md](security.md) — مدل تهدید و ریسک‌های باقی‌مانده
- [performance.md](performance.md) — اندازه‌گیری‌ها و بهینه‌سازی‌ها
- [testing.md](testing.md) — پوشش تست و نتایج
- [compatibility.md](compatibility.md) — مرورگرها و دستگاه‌ها
- [playback-sync.md](playback-sync.md) و [screen-sharing.md](screen-sharing.md) — جزئیات اتاق
