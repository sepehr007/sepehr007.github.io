# استقرار هم‌تماشا

این سند نحوهٔ اجرای پروژه روی محیط‌های مختلف را مشخص می‌کند: توسعهٔ محلی، استیجینگ، سرور مجازی (VPS)، داکر و میزبانی اشتراکی. هدف این است که پروژه فقط روی کامپیوتر توسعه‌دهنده کار نکند.

## ۱. دو بخش مستقل

| بخش | چیستی | محل استقرار |
| --- | --- | --- |
| فرانت‌اند | HTML/CSS/JS استاتیک + PWA | هر میزبان استاتیک؛ در این پروژه GitHub Pages از ریشهٔ مخزن |
| بک‌اند | Fastify + SQLite (و اختیاری Mongo/Redis) + WebSocket | VPS، داکر، یا هر میزبانی که فرآیند دائمی Node بدهد |

فرانت‌اند بدون بک‌اند هم بالا می‌آید و از حساب محلی مرورگر استفاده می‌کند. قابلیت‌های سروری (حساب مرکزی، اتاق‌های پایدار، مدیریت، اشتراک) فقط با بک‌اند فعال می‌شوند.

## ۲. محیط‌ها

محیط با `APP_ENV` تعیین می‌شود (اگر خالی باشد از `NODE_ENV` خوانده می‌شود).

| مقدار | کاربرد | رفتار امنیتی |
| --- | --- | --- |
| `development` | توسعهٔ محلی و تست | CORS آزاد، بدون نیاز به راز، بازکردن خودکار SQLite |
| `staging` | پیش‌تولید | مثل پروداکشن: `JWT_SECRET` اجباری، CORS هرگز `*` نمی‌شود |
| `production` | سایت واقعی | همان قواعد استیجینگ |

نکته: `staging` و `production` اگر `JWT_SECRET` نداشته باشند بالا نمی‌آیند. برای ساخت راز:

```bash
openssl rand -base64 48
```

### استیجینگ

برای استیجینگ همان تصویر/کد پروداکشن را با این تفاوت‌ها اجرا کنید: `APP_ENV=staging`، `DATA_DIR` (یا والیوم) جدا، دیتابیس خالی و seed جدا، `JWT_SECRET` متفاوت، و `CORS_ORIGIN`/`APP_ORIGIN` روی دامنهٔ استیجینگ. این کار مانع می‌شود داده یا توکن‌های تستی با پروداکشن قاطی شوند.

## ۳. پیکربندی متمرکز

همهٔ متغیرها در `server/.env` (بر اساس `server/.env.example`) تعریف می‌شوند و در `server/config.js` یک‌جا خوانده و اعتبارسنجی می‌شوند. هیچ دامنه یا مسیر تولیدی در کد سرور هاردکد نیست.

پیش از هر استقرار:

```bash
cd server
npm ci --omit=dev
npm run config
```

`npm run config` پیکربندی مؤثر را بدون نمایش رازها چاپ می‌کند و در صورت خطای مهلک با کد ۱ خارج می‌شود.

### متغیرهای کلیدی

| متغیر | پیش‌فرض | توضیح |
| --- | --- | --- |
| `APP_ENV` | `development` | `development` / `staging` / `production` |
| `PORT` / `HOST` | `3001` / `0.0.0.0` | شنوندهٔ HTTP |
| `TRUST_PROXY` | `true` | پشت nginx/Caddy روشن؛ اگر پورت مستقیم در معرض است خاموش کنید |
| `CORS_ORIGIN` | خالی | فهرست مبدأهای مجاز با کاما؛ خالی یعنی `APP_ORIGIN`؛ بیرون از توسعه هرگز `*` |
| `APP_ORIGIN` | `https://sepehr007.github.io` | مبدأ سایت برای لینک ایمیل/بازیابی (`PUBLIC_URL` هم پذیرفته می‌شود) |
| `JWT_SECRET` | خالی | بیرون از توسعه اجباری |
| `MONGO_URI` / `REDIS_URL` | خالی | اختیاری؛ برای مقیاس‌پذیری |
| `DATA_DIR` | `server/data` | SQLite، پشتیبان‌ها و outbox ایمیل/پیامک |
| `SQLITE_FILE` / `BACKUP_DIR` | زیر `DATA_DIR` | مسیر دقیق فایل و پشتیبان |
| `DB_RETRY_MS` | ۱۵۰۰۰ بیرون از توسعه | تلاش مجدد بازکردن SQLite |
| `FEATURE_SCOPE_CACHE_MS` | `3000` | کش کوتاه قابلیت‌ها؛ نوشتن پنل آن را فوراً پاک می‌کند |
| `SECURITY_MANDATORY_OFF` | خالی | کف امنیتی سخت‌گیرانه؛ هیچ ادمینی نمی‌تواند بازش کند |
| `AUTO_BACKUP_HOURS` / `BACKUP_KEEP` | `24` / `30` | پشتیبان خودکار و تعداد نسخه‌های نگهداری‌شده |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `50` / `60000` | سهمیهٔ پیش‌فرض هر IP |
| `PAYMENT_PROVIDER` | `manual` | `manual` (واریز دستی و تایید مالک) یا `hmac` (ریدایرکت به درگاه + وب‌هوک امضاشده) |
| `PAYMENT_WEBHOOK_SECRET` | خالی | راز HMAC-SHA256؛ با `hmac` اجباری |
| `PAYMENT_CHECKOUT_URL` | خالی | آدرس صفحهٔ پرداخت درگاه؛ با `hmac` اجباری |
| `PAYMENT_MERCHANT_ID` / `PAYMENT_CURRENCY` | خالی | شناسهٔ پذیرنده و ارز اختیاری که در لینک درگاه قرار می‌گیرد |

**نیاز بیرونی:** هیچ درگاه ایرانی از پیش متصل نیست. برای پرداخت آنلاین واقعی، قرارداد پذیرندگی لازم است و سرویس درگاه باید بدنهٔ JSON `{eventId, orderId, status: "paid"|"failed", amount, providerRef}` را با هدر `x-wt-signature` (HMAC-SHA256 روی بدنهٔ خام با `PAYMENT_WEBHOOK_SECRET`) به `POST /api/billing/webhook/hmac` بفرستد. بدون این‌ها سیستم روی «پرداخت دستی + تایید مالک» کار می‌کند و هیچ دادهٔ کارت جای‌ی ذخیره نمی‌شود.

`server/.env` در git نیست. مقادیر محرمانه را فقط در محیط استقرار نگه دارید.

## ۴. فرانت‌اند جداگانه

1. آدرس API را در `assets/data/runtime-config.json` بگذارید:

```json
{ "apiBase": "https://api.example.com/api" }
```

اولویت آدرس API: `globalThis.WT_API_BASE` → مقدار ذخیره‌شده در `localStorage.wt.apiBase` → همین فایل → `http://localhost:3001/api` فقط روی localhost.

2. در بک‌اند `CORS_ORIGIN` را دقیقاً روی مبدأ فرانت بگذارید (مثلاً `https://sepehr007.github.io`). بیرون از توسعه، خالی‌بودن آن یعنی API فقط به هم‌مبدأ پاسخ می‌دهد.
3. `APP_ORIGIN` را روی همان مبدأ فرانت بگذارید تا لینک‌های تأیید و بازیابی درست ساخته شوند.

### هویت و دامنهٔ استقرار

این مقادیر بخشی از هویت هر نصب هستند و هنگام تغییر دامنه/مخزن باید عوض شوند:

- `index.html` و `room.html`: متاتگ‌های `og:url`، `og:image`، `twitter:image`
- `assets/data/site-config.json`: متن‌های `site` (نام، شعار، رنگ، پشتیبانی). بلوک عمومی `owner` حذف شده و اطلاعات مالک جایی در فایل‌های استاتیک نیست.
- `assets/js/site-config.js`: همان مقادیر به‌عنوان پیش‌فرض وقتی JSON در دسترس نیست
- `server/.env`: هویت مالک فقط سمت سرور (`OWNER_EMAIL`، `OWNER_PHONE`، `OWNER_PASSWORD`)؛ پس از تنظیم روی دیتابیس موجود `npm run owner:setup -- --yes` را اجرا کنید
- `manifest.webmanifest`: `start_url` و `scope` نسبی‌اند و معمولاً نیاز به تغییر ندارند
- `sw.js`: با هر تغییر فایل‌های پوسته، مقدار `CACHE` را یک نسخه بالا ببرید

HTTPS برای میکروفون، دوربین، اشتراک صفحه و PWA الزامی است (localhost استثناست).

## ۵. VPS با systemd و پروکسی معکوس

پیش‌نیازها: Node.js 22.5 یا بالاتر (برای `node:sqlite`)، nginx یا Caddy، گواهی TLS.

```bash
# روی سرور
sudo useradd --system --home /opt/hammatama --shell /usr/sbin/nologin hammatama
sudo mkdir -p /opt/hammatama
sudo chown -R hammatama:hammatama /opt/hammatama
# کد را در /opt/hammatama/server قرار دهید، سپس:
cd /opt/hammatama/server
npm ci --omit=dev
cp .env.example .env      # مقادیر را ویرایش کنید
npm run config            # باید ok:true بدهد
npm run seed              # فقط روی دیتابیس خالی
sudo chown -R hammatama:hammatama /opt/hammatama/server/data
```

- سرویس نمونه: `server/deploy/wt-api.service` → `/etc/systemd/system/hammatama-api.service`
- nginx نمونه: `server/deploy/nginx.conf.example` (هدرهای `Upgrade` برای WebSocket و تایم‌اوت طولانی)
- Caddy نمونه: `server/deploy/Caddyfile.example` (گواهی و WebSocket خودکار)

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hammatama-api
curl -fsS http://127.0.0.1:3001/api/ready
```

لاگ‌ها: `journalctl -u hammatama-api -f` (خروجی JSON از Fastify/pino). سطح لاگ با `LOG_LEVEL` کنترل می‌شود.

## ۶. داکر و Compose

`server/Dockerfile` روی `node:24-slim` با کاربر غیر root، هلث‌چک داخلی و والیوم داده ساخته شده است. `docker-compose.yml` در ریشهٔ مخزن (Compose v2.24+ برای `env_file` اختیاری):

```bash
cp server/.env.example server/.env    # ویرایش مقادیر
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:3001/api/health
```

- پورت فقط روی `127.0.0.1` باز می‌شود؛ nginx/Caddy روی هاست جلوی آن قرار می‌گیرد.
- داده در والیوم `wt-data` می‌ماند؛ `docker compose down` بدون `-v` آن را پاک نمی‌کند.
- Redis اختیاری: `docker compose --profile redis up -d` و سپس `REDIS_URL=redis://redis:6379` در `server/.env`.
- Mongo اختیاری: `docker compose --profile mongo up -d` و سپس `MONGO_URI=mongodb://mongo:27017/hammatama`.

ری‌استارت خودکار با `restart: unless-stopped` و هلث‌چک تصویر انجام می‌شود.

## ۷. سازگاری با میزبانی اشتراکی

| قابلیت | نیاز فنی | میزبانی اشتراکی |
| --- | --- | --- |
| فرانت‌اند و PWA | فایل استاتیک + HTTPS | بله |
| بک‌اند Node | فرآیند دائمی Node ≥22.5 | معمولاً نه (فقط برخی هاست‌ها) |
| WebSocket (`/ws`) | پشتیبانی Upgrade در پروکسی | اغلب بسته یا محدود |
| SQLite | فایل‌سیستم پایدار و قابل نوشتن | گاهی، اما قفل فایل و ظرفیت محدود است |
| Redis / Mongo | سرویس جداگانه | معمولاً نه |
| TURN | سرور UDP/TCP جدا (مثلاً coturn) | نه |
| کارهای زمان‌بندی‌شده | پروسهٔ زنده یا cron | وابسته به خواب فرآیند؛ غیرقابل اتکا |
| ایمیل خروجی | SMTP یا API | اغلب بسته؛ از SMTP خارجی استفاده کنید |
| HTTPS | گواهی معتبر | معمولاً بله |

نتیجه: **اگر میزبان فرآیند دائمی Node و WebSocket نمی‌دهد، فقط فرانت‌اند را آنجا بگذارید و بک‌اند را روی VPS اجرا کنید.** هیچ قابلیتی از بک‌اند به پورت اختصاصی یا دسترسی root نیاز ندارد، اما به فرآیند زنده، فایل‌سیستم نوشتنی و پروکسی WebSocket نیاز دارد.

### TURN و صدا

تماس صوتی و اشتراک صفحه با WebRTC کار می‌کند. تنظیمات فعلی `assets/js/net.js` از STUN عمومی و یک رلهٔ TURN عمومی استفاده می‌کند؛ این مقادیر در کد ثابت‌اند و متغیر محیطی برای TURN وجود ندارد. برای پایداری در شبکه‌های سخت‌گیرانه، یک سرور coturn روی VPS جدا توصیه می‌شود و باید آدرس/اعتبارنامهٔ آن در همین فایل جایگزین شود؛ میزبانی اشتراکی این امکان را نمی‌دهد. پردازش رسانه سمت سرور لازم نیست: پخش و ترنسکد در مرورگر انجام می‌شود.

## ۸. سلامت، پایش و بازیابی

- **Liveness:** `GET /api/health` همیشه وضعیت سرویس، ذخیره‌سازی، Redis، ایمیل/پیامک و محیط را برمی‌گرداند. مناسب هلث‌چک داکر و پایش خارجی.
- **Readiness:** `GET /api/ready` تا وقتی SQLite یا Mongo آماده است `200` و در غیر این صورت `503` می‌دهد. مناسب لودبالانسر.
- **Graceful shutdown:** با `SIGTERM`/`SIGINT` اتصال‌های WebSocket با کد 1001 بسته می‌شوند، حلقهٔ نگهداری متوقف، SQLite بسته و Redis/Mongo قطع می‌شوند. `TimeoutStopSec=25` در unit نمونه همین را فرض کرده است.
- **اتصال مجدد:** Mongo با تأخیر ۵ ثانیه‌ای دوباره تلاش می‌کند؛ Redis با backoff و در نبود آن به حافظه برمی‌گردد؛ SQLite با `DB_RETRY_MS` دوباره باز می‌شود.
- **پشتیبان‌گیری:** خودکار هر `AUTO_BACKUP_HOURS` در `BACKUP_DIR` (پیش‌فرض ۲۴ ساعت، نگهداری ۳۰ نسخه) و دستی از کنسول مالک یا `POST /api/admin/database/backup`. فایل‌های پشتیبان را با rsync به ماشین دیگر هم منتقل کنید.
- **صحت دیتابیس:** `PRAGMA integrity_check` و `foreign_key_check` در سلامت پنل و اسکریپت بازیابی اجرا می‌شوند.

### بازیابی از پشتیبان

اسکریپت بازیابی به‌صورت پیش‌فرض فقط بررسی می‌کند و چیزی را عوض نمی‌کند:

```bash
cd /opt/hammatama/server
sudo systemctl stop hammatama-api
npm run restore -- backups/wt-2026-11-18T12-00-00-000Z.sqlite          # بررسی
npm run restore -- backups/wt-2026-11-18T12-00-00-000Z.sqlite --yes    # جایگزینی
sudo systemctl start hammatama-api
curl -fsS http://127.0.0.1:3001/api/ready
```

اسکریپت قبل از جایگزینی، از دیتابیس فعلی یک نسخهٔ `pre-restore-*.sqlite` می‌گیرد و فایل‌های `-wal`/`-shm` قدیمی را پاک می‌کند. **حتماً سرویس را قبل از اجرا متوقف کنید.** در داکر:

```bash
docker compose stop api
docker compose run --rm api node restore.js /app/data/backups/wt-....sqlite --yes
docker compose start api
```

## ۹. مقیاس و محدودیت‌ها

- طراحی فعلی **تک‌نودی** است: SQLite منبع اصلی داده و بازنویسی قابلیت‌هاست. دو نمونه API را روی یک فایل SQLite (خصوصاً روی فایل‌سیستم شبکه‌ای) اجرا نکنید.
- برای مقیاس افقی، Mongo و Redis را وصل کنید؛ اما ذخیرهٔ override قابلیت‌ها هنوز SQLite محلی است و برای چند نود نیاز به انتقال آن به یک فروشگاه مشترک دارد. این کار انجام نشده و ادعا نمی‌شود.
- نامهٔ تأیید/بازیابی بدون SMTP در فایل outbox ذخیره می‌شود؛ در پروداکشن SMTP یا API واقعی وصل کنید.
- فایل‌های آپلودی روی دیسک همان سرور در `DATA_DIR/uploads` می‌نشینند و فقط ردیفشان در `media_objects` است. برای چند نود باید فضای مشترک یا آداپتور S3 اضافه شود. سهمیه‌ها با `UPLOAD_USER_QUOTA_MB` (پیش‌فرض ۶۰) و `UPLOAD_GLOBAL_QUOTA_MB` (پیش‌فرض ۲۰۴۸) کنترل می‌شوند و پاک‌سازی فایل‌های رهاشده از پنل مالک انجام می‌شود.
- ویدیوهای آپلودی در پنل مالک (`تنظیمات سایت ← ذخیره‌سازی`) کنترل می‌شوند: `upload.maxFileMB` سقف حجم (پیش‌فرض ۵۰، حداکثر ۱۰۰)، `upload.storageQuotaMB` سهمیهٔ کاربر، `upload.deleteAfterWatch` حذف خودکار پس از تماشا، `upload.deleteGraceMinutes` مهلت بعد از آخرین تماشا (پیش‌فرض ۳۰ دقیقه) و `upload.mediaKeepHours` حذف ویدیوی تماشانشده (پیش‌فرض ۴۸ ساعت، ۰=خاموش). هر درخواست پخش یک فایل `media` زمان تماشا را تازه می‌کند و یک سوییپ هر ۶۰ ثانیه فایل‌های مهلت‌گذشته را از دیسک و جدول پاک می‌کند. پخش اتاق همچنان محلی/همتا به همتاست و بایت ویدیو از سرور عبور نمی‌کند؛ فایل آپلودشده فقط با لینک `/api/files/:id` از سرور سرو می‌شود.
- روشن/خاموشکردن اشتراک فایل در اتاق‌ها: تنظیم `room.allowFileUpload` (پنل مالک ← تنظیمات سایت ← اتاق‌ها). با خاموششدن، دکمهٔ بارگذاری پنهان می‌شود و درگ‌اند‌دراپ هم رد می‌شود؛ پرچم قدیمی `features.localFile` هم مستقل از آن مسیر را می‌بندد.
- موتور خودکارسازی و ثبت `automation_runs` درون همان فرآیند API اجرا می‌شود؛ صف و کارگر جدا ندارد.

### کارایی و فشرده‌سازی

- پاسخ‌های JSON بزرگ‌تر از ۱KB خود سرور با gzip/deflate فشرده می‌شوند (`@fastify/compress`)؛ فایل‌ها و استریم ویدیو فشرده نمی‌شوند. اگر nginx جلوی API هم gzip دارد، هدر `Accept-Encoding` را دست‌نخورده رد کنید تا دوباره فشرده نشود.
- مایگریشن ۱۶ سه ایندکس عملکردی اضافه می‌کند (`idx_users_active_created`، `idx_rooms_last_activity`)؛ نیازی به اقدام دستی نیست، در اولین بالا آمدن اجرا می‌شود.
- اعداد قبل/بعد و روش سنجش در [performance.md](performance.md) آمده است. برای بازتولید، `server/.tmp/perf-baseline.mjs` را با Node 24 اجرا کنید (خارج از گیت است).
- WebSocket یک صف سریال برای هر اتصال، بافر ۲۰۰ رویدادی و سقف فریم ۶۴KB دارد؛ اگر تعداد اتاق‌های هم‌زمان زیاد شد، وضعیت اتاق‌ها در حافظهٔ همان نود است و بین نودها هم‌گام نمی‌شود (نیازمند Pub/Sub).

## ۱۰. چک‌لیست امنیتی پروداکشن

- [ ] `APP_ENV=production` و `JWT_SECRET` تصادفی ≥۳۲ کاراکتر
- [ ] `CORS_ORIGIN` دقیقاً مبدأ فرانت (بدون `*`)
- [ ] HTTPS اجباری و `TRUST_PROXY` متناسب با پروکسی
- [ ] رمز مالک از مقدار نمونه/پیش‌فرض عوض شده و جایی منتشر نشده
- [ ] `DATA_DIR` فقط برای کاربر سرویس قابل نوشتن است
- [ ] پشتیبان خودکار روشن و نسخه‌ها به سرور دیگر منتقل می‌شوند
- [ ] `npm run config` بدون خطا
- [ ] `npm run release:check` سبز (۳۷ بررسی: استاتیک، پیکربندی، مهاجرت، پشتیبان، مسیرها، هدرها، احراز هویت)
- [ ] `GET /api/ready` بعد از استارت `200` می‌دهد
- [ ] اگر پرداخت آنلاین لازم است: `PAYMENT_PROVIDER=hmac`، راز وب‌هوک و آدرس درگاه ست و قرارداد پذیرندگی با درگاه بسته شده؛ در غیر این صورت عمداً روی `manual` بمانید و پنل را در دسترس مالک نگه دارید

### دربارهٔ کوکی‌ها

این API هیچ کوکی نمی‌نویسد؛ احراز هویت با `Authorization: Bearer` و JWT انجام می‌شود. بنابراین سطح حملهٔ CSRF کوکی وجود ندارد، اما توکن در `localStorage` مرورگر نگه داشته می‌شود و امنیت آن به نبود XSS و CSP مناسب بستگی دارد. اگر در آینده احراز هویت کوکی اضافه شد، کوکی باید `HttpOnly; Secure; SameSite=None` باشد (چون فرانت و API می‌توانند دامنه‌های جدا داشته باشند) و محافظت CSRF هم اضافه شود.

## ۱۱. استقرار گام‌به‌گام روی cPanel

### ۱) قبل از خرید، این‌ها را از فروشنده بپرسید

| نیاز | چرا |
| --- | --- |
| افزونهٔ **Setup Node.js App** (Phusion Passenger) | بدون آن فقط فایل استاتیک اجرا می‌شود |
| **Node.js 24** (حداقل 22.5) | داده‌ها با `node:sqlite` ذخیره می‌شوند؛ Node قدیمی‌تر خطا می‌دهد |
| پشتیبانی **WebSocket** روی اپ Node | اتاق‌های هم‌زمان (`/ws`) به آن نیاز دارند |
| **Terminal/SSH** در cPanel | اختیاری: مالک در اولین اجرا با `OWNER_*` خودکار ساخته می‌شود؛ ترمینال فقط برای اسکریپت‌های دستی و لاگ |
| ساخت **ساب‌دامین** | API روی `api.دامنه` می‌نشیند |
| **AutoSSL** (HTTPS رایگان) | PWA و دوربین/میکروفون بدون HTTPS کار نمی‌کنند |

اگر میزبان Node 24 یا WebSocket ندارد، فقط فرانت‌اند را آنجا بگذارید و API را روی VPS اجرا کنید (بخش ۷ همین سند).

### ۲) معماری

- `دامنه.com` ← پوشهٔ `public_html` (فرانت استاتیک)
- `api.دامنه.com` ← اپ Node (پوشهٔ جدا، بیرون از `public_html`)

### ۳) آپلود فرانت‌اند

1. روی ویندوز، `scripts\package-deploy.bat` را اجرا کنید تا `deploy\site.zip` و `deploy\api.zip` ساخته شود.
2. در cPanel → File Manager → `public_html` → Upload → فایل `site.zip` → Extract.
3. مطمئن شوید `index.html` مستقیماً داخل `public_html` است (نه یک پوشه تودرتو).

### ۴) ساخت اپ Node برای API

1. cPanel → **Domains** → Create a subdomain: `api` روی دامنهٔ اصلی. Document Root را چیزی مثل `api_domain` بگذارید.
2. cPanel → **Setup Node.js App** → Create Application:
   - Node.js version: **24** (اگر 22 داشت، بعداً `NODE_OPTIONS=--experimental-sqlite` را اضافه کنید)
   - Application root: همان پوشهٔ ساب‌دامین (مثلاً `api_domain`)
   - Application URL: `api.دامنه.com`
   - Application startup file: `index.js`
3. فایل `api.zip` را داخل همان Application root آپلود و Extract کنید (پوشهٔ `node_modules` و `data` نباید داخل زیپ باشد؛ اسکریپت این‌ها را حذف می‌کند).
4. در همان صفحه **Run NPM Install** را بزنید.

### ۵) فایل `.env`

در Application root یک فایل `.env` بسازید (از `server/.env.example` الگو بگیرید) و این مقادیر را حتماً ست کنید:

```
APP_ENV=production
TRUST_PROXY=true
CORS_ORIGIN=https://دامنه.com,https://www.دامنه.com
APP_ORIGIN=https://دامنه.com
JWT_SECRET=<یک رشتهٔ تصادفی ۶۴ کاراکتری>
DATA_DIR=
REQUIRE_EMAIL_VERIFICATION=true
OWNER_EMAIL=ایمیل-مالک
OWNER_USERNAME=owner
OWNER_PHONE=09xxxxxxxxx
OWNER_PASSWORD=<رمز قوی ۱۲+ کاراکتری؛ فقط اینجا>
```

- `PORT` را دست نزنید؛ Passenger خودش می‌دهد.
- تأیید حساب اجباری است؛ قبل از انتشار SMTP (یا درگاه پیامک) را وصل کنید تا کد تأیید واقعاً به کاربر برسد. فقط برای تست موقت می‌توانید `REQUIRE_EMAIL_VERIFICATION=false` بگذارید و بعد آن را true کنید.
- `JWT_SECRET` و رمز مالک را هیچ‌جا (چت، گیت، مستندات) ننویسید و در `.env` نگه دارید.

سپس در UI اپ، **Restart** را بزنید.

### ۶) تست API

مرورگر: `https://api.دامنه.com/api/health` باید `ok: true` بدهد و `https://api.دامنه.com/api/ready` باید `200` باشد. اگر `503` بود، `data` قابل نوشتن نیست یا Node قدیمی است (لاگ اپ را در UI ببینید).

### ۷) ساخت هویت مالک

اگر `OWNER_EMAIL` و `OWNER_PASSWORD` (و در صورت تمایل `OWNER_PHONE`) را در `.env` ست کرده باشید، هنگام اولین استارت روی دیتابیس خالی، مالک `super_owner` **خودکار** ساخته می‌شود و در لاگ اپ خط `[owner] bootstrap super_owner created` دیده می‌شود. نیازی به Terminal نیست.

فقط اگر به هر دلیل مالک ساخته نشد (مثلاً ثبت‌نام کاربر دیگری زودتر انجام شده)، در cPanel → Terminal:

```bash
cd ~/api_domain        # همان Application root
node seed.js           # فقط روی دیتابیس خالی
# یا روی دیتابیس موجود:
node owner-set.js --yes
```

بعد از آن، ورود مالک فقط از `owner.html` و با یک کد ۸ رقمی (ایمیل/پیامک) انجام می‌شود.

### ۸) اتصال فرانت به API

در File Manager فایل `public_html/assets/data/runtime-config.json` را باز کنید و بنویسید:

```json
{ "apiBase": "https://api.دامنه.com/api" }
```

(بدون اسلش آخر.) سپس سایت را با `Ctrl+F5` باز کنید.

### ۹) تست نهایی

1. ثبت‌نام و ورود یک کاربر تستی.
2. ساخت لابی + باز کردن لینک دعوت در مرورگر دوم → باید «آنلاین» شود و پیام دوطرفه رد و بدل شود.
3. باز کردن `owner.html` با حساب مالک.
4. اگر اتاق وصل نشد ولی سایت بالا بود، WebSocket میزبان مشکل دارد (بخش ۷)؛ اتاق‌ها در این حالت به مسیر جایگزین ntfy برمی‌گردند که پایدار نیست.

### ۱۰) بعد از هر آپدیت

1. `scripts\package-deploy.bat` را دوباره اجرا کنید.
2. `site.zip` را در `public_html` جایگزین و Extract کنید (Overwrite).
3. اگر `server/` تغییر کرده، `api.zip` را هم جایگزین کنید و در UI اپ **Restart** بزنید.
4. نسخهٔ کش `sw.js` در هر آپدیت فرانت عوض می‌شود؛ اگر عوض نشد، یک عدد `wt-vXXX` را بالا ببرید.

### ۱۱) مشکلات رایج

| علامت | علت احتمالی | راه‌حل |
| --- | --- | --- |
| `/api/health` جواب نمی‌دهد | اپ Node بالا نیامده | Startup file = `index.js`؛ لاگ Passenger در UI |
| `sqlite unavailable` در لاگ | Node < 22.5 یا پوشهٔ `data` غیرقابل نوشتن | Node 24 انتخاب کنید؛ مجوز پوشه `755` |
| ثبت‌نام می‌گوید تأیید ایمیل لازم است | SMTP وصل نیست | SMTP یا درگاه پیامک را وصل کنید؛ `REQUIRE_EMAIL_VERIFICATION` را true نگه دارید |
| اتاق «در حال اتصال» می‌ماند | WebSocket توسط میزبان بسته شده | پشتیبانی میزبان؛ یا API روی VPS |
| سایت قدیمی می‌ماند | کش سرویس‌ورکر | نسخهٔ `CACHE` در `sw.js` را بالا ببرید |
