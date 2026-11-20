# دیتابیس هم‌تماشا

مرجعِ کوتاه و دقیق از ساختار، دلیل انتخاب‌ها و مسیر نگهداری داده. اگر ساختار جدول یا سیاست نگهداری عوض شد، همین فایل هم به‌روز می‌شود.

## موتور اصلی

- **SQLite (`node:sqlite`)** منبع حقیقتِ پیش‌فرض است: بدون نصب سرور جدا، WAL، تراکنش واقعی، کلید خارجی و پشتیبان‌گیری فایلِ ساده. فایل پیش‌فرض `server/data/wt.sqlite` و قابل تغییر با `SQLITE_FILE` است.
- **MongoDB** فقط وقتی `MONGO_URI` در دسترس باشد همان مسیر قبلی را ادامه می‌دهد؛ کدِ هر دو مسیر کنار هم مانده و هیچ داده‌ای حذف نمی‌شود.
- **PostgreSQL** هنوز آداپتور ندارد. اسکیما عمداً استاندارد نوشته شده (کلید متنی UUID، زمان INTEGER، CHECK و FK) تا مهاجرت آینده ساده باشد؛ ولی SQLite تنها دیتابیسی است که در این نصب واقعاً تست شده و وظیفهٔ رابطه‌ای را کامل انجام می‌دهد (WAL + FK + تراکنش). آداپتور PG بدون محیط تست ساخته نمی‌شود تا ادعای پشتیبانی بی‌پایه نباشد.
- **Favorites** جدول جدا ندارد؛ همان `media_library` با `kind='favorite'` است و با ایندکس یکتای `(user_id, kind, url)` از رکورد تکراری جلوگیری می‌شود. یک منبع حقیقت، بدون دادهٔ موازی.
- **Redis** اختیاری است: کش، نشست، محدودیت نرخ. بدون آن حافظهٔ فرآیند استفاده می‌شود و نشست‌ها در جدول `sessions` دوام دارند؛ یعنی با ری‌استارت سرور کاربر بیرون نمی‌افتد. شمارنده‌های «قفل تلاش ورود» و «سقف دعوت» هم از همین لایه رد می‌شوند.

## مالکیت داده (هر ماژول یک دامنه)

| دامنه | جدول‌ها |
| --- | --- |
| هویت و دسترسی | `users`، `profiles`، `sessions`، `roles`، `permissions`، `role_permissions`، `user_roles`، `app_settings`، `email_tokens` |
| اجتماع و اتاق | `servers`، `categories`، `channels`، `rooms`، `room_settings`، `room_memberships`، `invitations`، `lobbies`، `room_visits` |
| پیام و پخش | `messages`، `message_reactions`، `message_reports`، `dm_conversations`، `dm_messages`، `dm_reads`، `dm_prefs`، `dm_reactions`، `friendships`، `friend_requests`، `blocks`، `reports`، `moderation_actions`، `moderation_notes`، `room_polls`، `poll_options`، `poll_votes`، `playback_states`، `playback_history`، `subtitle_preferences` |
| ظاهر و اطلاع‌رسانی | `user_themes`، `notifications`، `notification_prefs`، `announcements`، `support_tickets`، `support_messages`، `media_library` |
| مالی | `subscription_plans`، `orders`، `subscriptions`، `subscription_events`، `coupons`، `coupon_redemptions`، `entitlements`، `payments`، `payment_events`، `transactions` |
| عملیات | `feature_flags`، `feature_overrides`، `feature_schedule`، `feature_history`، `audit_logs`، `website_pages`، `page_versions`، `page_form_submissions`، `page_events`، `analytics_events`، `automation_workflows`، `automation_runs`، `media_objects`، `backup_runs` |

قاعدهٔ مالکیت: هر جدول فقط از ماژول خودش نوشته و خوانده می‌شود؛ ماژول‌های دیگر با شناسه و کوئری محدود سراغش می‌روند. رسانهٔ سنگین هرگز داخل جدول نیست و فقط در `media_objects` ثبت می‌شود.

## کارایی

- ایندکس روی همهٔ مسیرهای پرتکرار: ورود به‌وسیلهٔ ایمیل/یوزرنیم/تلفن، پیام‌های هر اتاق (`room_id, created_at`)، حضور، سفارش و اشتراک، گزارش‌ها، لاگ‌ها.
- ایندکس یکتای جزئی برای «یک لابی فعال برای هر مالک» و «یک تم فعال برای هر کاربر».
- پیام‌ها همیشه صفحه‌بندی‌شده خوانده می‌شوند (۵۰تایی برای تاریخچهٔ اتاق، `LIMIT` در همهٔ لیست‌ها)؛ هیچ کوئری تاریخچهٔ بی‌پایان ندارد.
- N+1 نداریم: هر صفحه یک یا چند کوئری صریح دارد و آمار با `COUNT` مستقیم گرفته می‌شود.
- کوئری‌های آماده (prepared statement) تا ۴۰۰ مورد کش می‌شوند؛ اتصال تکی با `busy_timeout` و WAL، تراکنش‌های `BEGIN IMMEDIATE` برای عملیات چندمرحله‌ای (ساخت لابی، سفارش، ثبت کاربر).
- محدودیت‌ها در سطح دیتابیس: `UNIQUE`، `CHECK`، `FOREIGN KEY` با `CASCADE/SET NULL/RESTRICT` تا دادهٔ یتیم ساخته نشود.

## مهاجرت و صحت داده

- مهاجرت‌ها نسخه‌دارند (`schema_migrations`) و چک‌سام هر مهاجرت ذخیره می‌شود؛ تغییر متن مهاجرتِ اجراشده هشدار می‌دهد و دوباره اجرا نمی‌شود.
- هر مهاجرت داخل تراکنش است؛ خطا یعنی برگشت کامل، نه دیتابیس نیمه‌کاره.
- مهاجرت روی دیتابیس‌های قدیمی تست شده: ستون‌های قدیمی حفظ می‌شوند، کاربران دست‌نخورده می‌مانند و نسخه به ۱۶ می‌رسد (v11 اتاق تماشا و پاپ‌آپ، v12 تحویل اعلان و صف پشتیبانی، v13 پلن/کوپن/پرداخت، v14 سازندهٔ سایت/فایل/آمار، v15 ایندکس‌های یکپارچگی و `moderation_actions`، v16 دو ایندکس عملکردی `idx_users_active_created` و `idx_rooms_last_activity`).
- v15 قبل از ساخت ایندکس یکتای رسانه، رکوردهای تکراری قدیمی را با نگه‌داشتن قدیمی‌ترین ردیف پاک می‌کند؛ دادهٔ دیگر دست نمی‌خورد.
- `npm run integrity` (فایل `server/integrity.js`) گزارش خواندنی می‌دهد: `PRAGMA integrity_check`، `foreign_key_check`، ردیف‌های یتیم در ۱۸ رابطه (پیام‌ها، رأی‌ها، عضویت‌ها، نشست‌ها، نسخه‌های صفحه، اجرای خودکارسازی و…)، ناسازگاری‌های منطقی (چند لابی فعال، نقش نشست قدیمی، رسانهٔ تکراری، تعداد اعضای اتاق اشتباه) و نبود ایندکس‌های انتظاری. در صورت مشکل با کد ۱ خارج می‌شود و چیزی را تغییر نمی‌دهد.
- بررسی سلامت آنی: `PRAGMA integrity_check`، `foreign_key_check` و شمارش جدول‌ها از طریق `GET /api/admin/database`.

## پشتیبان، بازیابی و خروجی

- پشتیبان با `VACUUM INTO` گرفته می‌شود (کپی سازگار حتی هنگام کار سرور) و بعد checksum و integrity آن بررسی می‌شود.
- مسیر پیش‌فرض `server/data/backups`؛ پیش‌فرض ۳۰ فایل آخر نگه داشته می‌شود (`BACKUP_KEEP`).
- حلقهٔ نگهداری هر ۶ ساعت اجرا می‌شود و اگر آخرین پشتیبان قدیمی‌تر از ۲۴ ساعت باشد یکی می‌سازد (`AUTO_BACKUP_HOURS`).
- بازیابی: فایل پشتیبان را جای `wt.sqlite` بگذارید (با سرور خاموش) و دوباره اجرا کنید؛ مهاجرت‌ها خودشان هم‌تراز می‌شوند.
- خروجی JSONL به تفکیک جدول با مانیفست از پنل مالک گرفته می‌شود (`POST /api/admin/database/export`).

## نگهداری و حذف ایمن

- حذف آبشاری فقط برای داده‌های وابستهٔ خودِ کاربر (پروفایل، نشست، اعضا) است.
- پاک‌سازی دوره‌ای فقط ردیف‌های عملیاتی منقضی را می‌زند: توکن‌های منقضی، نشست‌های باطل‌شده (با مهلت)، لاگ حسابرسی، آنالیتیکس، تاریخچهٔ پخش و اعلان‌های قدیمی.
- پیام‌های چت به‌طور پیش‌فرض حذف نمی‌شوند؛ `RETENTION_MESSAGE_DAYS=0` یعنی خاموش و هر مقدار مثبت فقط آرشیو می‌کند.
- هر عملیات مدیریتی (پشتیبان، بررسی، خروجی، پاک‌سازی) در `audit_logs` ثبت می‌شود و رمز/توکن/کد در لاگ‌ها سانسور می‌شود.

## کنترل قابلیت

- سه جدول مستقل: `feature_overrides` (وضعیت نهایی هر قابلیت در هر دامنه)، `feature_schedule` (تغییر آیندهٔ زمان‌دار) و `feature_history` (تاریخچهٔ تغییرها با منبع و عامل).
- دامنه‌ها: `global`، `user`، `room`، `server`، `role`، `plan`؛ ترتیب اختیار از بالا به پایین: محدودیت امنیتی (env) ← سراسری ← پلن ← نقش ← سرور ← اتاق ← کاربر. هیچ لایهٔ پایین‌تری نمی‌تواند محدودیت بالاتر را باز کند و خاموشی در هر لایه نهایی است؛ منبع گزارش‌شده همیشه بالاترین لایهٔ بسته است.
- پیکربندی اتاق از ستون‌های `room_settings` (چت، صدا، اشتراک صفحه، صف، زیرنویس، فایل محلی) هم خوانده می‌شود و پلن فعال کاربر خودکار از `subscriptions` حل می‌شود.
- وابستگی‌ها در سرور حل می‌شوند: اگر `features.realtimeEnabled` خاموش شود، چت، پخش مشترک، صف، صدا و اشتراک صفحه هم به‌صورت مؤثر خاموش گزارش می‌شوند (منبع `dependency`).
- زمان‌بندی‌ها با فاصلهٔ چند ثانیه و داخل تراکنش اعمال می‌شوند و در تاریخچه با منبع `schedule` ثبت می‌شوند.
- `FEATURE_EMERGENCY_OFF` با کاما فهرست کلیدها را می‌گیرد و مستقل از دیتابیس همه را خاموش می‌کند.
- تنظیمات سایت در `app_settings` با کلید `platform.settings` (JSON) نگه داشته می‌شوند؛ رجیستری سمت سرور نوع، بازه و اعتبار هر مقدار را کنترل می‌کند و مقدار عمومی از `GET /api/settings/public` به سایت و API می‌رسد.

## پنل مالک

- `GET /api/admin/database` — وضعیت، نسخهٔ اسکیما، مسیر فایل، سلامت.
- `GET /api/admin/database/tables` — تعداد ردیف هر جدول.
- `POST /api/admin/database/backup|verify|export|prune` — عملیات نگهداری.
- `GET /api/admin/audit` — تاریخچهٔ عملیات با صفحه‌بندی ساده (`limit`, `before`).
- `GET /api/admin/overview|users|rooms|messages|reports|finance|analytics|storage` — دادهٔ زندهٔ داشبورد.
- `PATCH /api/admin/users/:id` — تغییر نقش و وضعیت با محافظت از آخرین مالک ارشد.
- `GET/PUT /api/admin/settings` — خواندن رجیستری و ذخیرهٔ امن تنظیمات.
- `GET/PUT/DELETE /api/admin/features*` و `POST /api/admin/features/schedule` — کنترل دامنه‌دار قابلیت‌ها، زمان‌بندی و تاریخچه.
- `GET/POST/PATCH/DELETE /api/admin/billing/plans*` — پلن‌ها، تکثیر، ترتیب، آرشیو و حذف ایمن (پلن استفاده‌شده آرشیو می‌شود، نه حذف).
- `GET/POST /api/admin/billing/coupons` — کوپن درصدی/ثابتی، محدود به پلن یا آزاد، سقف استفاده و پنجرهٔ اعتبار.
- `GET /api/admin/billing/payments|subscriptions`، `POST .../payments/:id/verify|refund` و `POST .../subscriptions/:id/adjust` — تایید دستی، برگشت وجه، تمدید/لغو/تغییر پلن با ثبت در `subscription_events`.
- `GET /api/admin/support` و `GET/PATCH /api/admin/support/:id` — صف پشتیبانی با وضعیت، اولویت، مسئول و نتیجه.
- `GET/POST/PATCH/DELETE /api/admin/pages` — مدیریت صفحه‌های سایت؛ هر ذخیره یک نسخه در `page_versions` می‌سازد و `GET .../versions`/`POST .../rollback` بازیابی می‌کند. `GET .../submissions` فرم‌های ارسالی را برمی‌گرداند. صفحه‌های عمومی از `/api/pages/:slug` (+ `/nav` و `POST .../submit`) سرو می‌شوند.
- `GET/POST/PATCH/DELETE /api/admin/automation` و `GET .../runs`، `POST .../runs/:id/retry`، `POST .../:id/simulate` — گردش‌کارهای واقعی؛ هر اجرا در `automation_runs` با وضعیت، تلاش و خطا ثبت می‌شود.
- `GET /api/admin/analytics/report` و `GET /api/admin/analytics/export?dataset=...` — گزارش بازه‌ای از جدول‌های واقعی با فلگ «در دسترس نیست» برای دادهٔ ناموجود؛ CSV با BOM.
- `GET /api/admin/storage/usage`، `GET /api/admin/storage/files`، `POST /api/admin/storage/cleanup` — مصرف دیسک، فهرست فایل‌ها و پاک‌سازی فایل‌های رهاشده؛ آپلود کاربران از `/api/uploads` و تحویل از `/api/files/:id`.
- `POST /api/admin/notifications/broadcast` — اعلان همگانی/نقش‌محور با `confirm: true` و شمارش تحویل.
- `GET /api/admin/roles` و `PUT /api/admin/roles/:role/permissions` — فهرست نقش‌ها و مجوزها و ذخیرهٔ مجوزهای نقش (نقش‌های سیستمی مالک قفل‌اند).
- `GET /api/admin/restrictions`، `DELETE /api/admin/restrictions/blocks/:id` و `GET/PATCH /api/admin/reports/social` — مسدودی‌ها و صف گزارش‌های اجتماعی.
- `POST /api/admin/users/bulk`، `PATCH /api/admin/rooms/:id` — اقدام گروهی روی کاربران (با `confirm: true`) و بستن/بازکردن اتاق.

همه فقط با نقش `owner`/`super_owner` یا مجوز مشخصِ همان دامنه، با محدودیت نرخ؛ عملیات حساس بدون `confirm: true` با 428 رد می‌شود.

## شکاف‌های صادقانه

- آداپتور PostgreSQL و S3/فضای ابری برای فایل‌ها هنوز نوشته نشده؛ فایل‌ها روی دیسک `DATA_DIR/uploads` ذخیره و فقط در `media_objects` ثبت می‌شوند.
- موتور خودکارسازی درون همان فرآیند API اجرا می‌شود؛ صف/کارگر جدا و اجرای توزیع‌شده ندارد.
- زمان تماشا و تأخیر سرور فقط وقتی عدد دارند که داده‌شان ثبت شده باشد؛ در غیر این صورت گزارش صریحاً «در دسترس نیست» می‌گوید، نه صفر.
- درگاه پرداخت واقعی وصل نیست: مرزِ اتصال (`manual` و `hmac` با وب‌هوک امضاشده) آماده است اما تا وقتی `PAYMENT_PROVIDER=hmac` و اعتبارنامه‌های درگاه ست نشوند، پرداخت دستی است.
- مسیر MongoDB مهاجرت داده‌ای به SQLite ندارد؛ نصب فعلی که Mongo ندارد مستقیم روی SQLite است.
- کنترل دامنه‌ای قابلیت‌ها روی HTTP و مسیرهای اتاق کاملاً اعمال می‌شود؛ جریان‌های WebRTC که مستقیم بین مرورگرها باز شده‌اند از سمت سرور قابل قطع نیستند و فقط از لایهٔ رابط و توکن‌های اتصال بسته می‌شوند.
