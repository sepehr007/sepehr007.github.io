function addColumn(db, table, column, definition) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

const identity = String.raw`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    username_lower TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    email_verified INTEGER NOT NULL DEFAULT 0,
    email_verified_at INTEGER,
    phone TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    recovery_hash TEXT NOT NULL DEFAULT '',
    nick TEXT NOT NULL DEFAULT '',
    birthdate TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    bio TEXT NOT NULL DEFAULT '',
    avatar TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'active',
    locale TEXT NOT NULL DEFAULT 'fa',
    last_seen_at INTEGER,
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_login_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS profiles (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    headline TEXT NOT NULL DEFAULT '',
    website TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    social_json TEXT NOT NULL DEFAULT '{}',
    visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','unlisted','private')),
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    jti TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'user',
    ip TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_system INTEGER NOT NULL DEFAULT 1 CHECK (is_system IN (0,1)),
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS permissions (
    id TEXT PRIMARY KEY,
    group_name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS role_permissions (
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
  );
  CREATE TABLE IF NOT EXISTS user_roles (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    granted_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, role_id)
  );
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS email_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    code_hash TEXT NOT NULL DEFAULT '',
    link_hash TEXT NOT NULL DEFAULT '',
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    consumed_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
  CREATE INDEX IF NOT EXISTS idx_users_role_created ON users(role, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(user_id, revoked_at, expires_at);
  CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens(user_id, kind, created_at);
  CREATE INDEX IF NOT EXISTS idx_email_tokens_expiry ON email_tokens(expires_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_email_tokens_link ON email_tokens(link_hash) WHERE link_hash <> '';
  CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
  CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role_id);
`;

const community = String.raw`
  CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    slug TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    icon_url TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public','private')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE (server_id, name)
  );
  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    type TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text','voice','video','announcement')),
    topic TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    is_private INTEGER NOT NULL DEFAULT 0 CHECK (is_private IN (0,1)),
    created_at INTEGER NOT NULL,
    deleted_at INTEGER,
    UNIQUE (server_id, name)
  );
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    room_code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    host_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
    channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
    kind TEXT NOT NULL DEFAULT 'lobby' CHECK (kind IN ('lobby','channel','temporary')),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    privacy TEXT NOT NULL DEFAULT 'public' CHECK (privacy IN ('public','password')),
    password_hash TEXT NOT NULL DEFAULT '',
    capacity INTEGER NOT NULL DEFAULT 6 CHECK (capacity BETWEEN 2 AND 100),
    lang TEXT NOT NULL DEFAULT 'fa' CHECK (lang IN ('fa','en')),
    theme TEXT NOT NULL DEFAULT 'dark',
    member_count INTEGER NOT NULL DEFAULT 0 CHECK (member_count >= 0),
    last_activity_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    closed_at INTEGER,
    deleted_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS room_settings (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    capacity INTEGER NOT NULL DEFAULT 6 CHECK (capacity BETWEEN 2 AND 100),
    chat_enabled INTEGER NOT NULL DEFAULT 1 CHECK (chat_enabled IN (0,1)),
    voice_enabled INTEGER NOT NULL DEFAULT 1 CHECK (voice_enabled IN (0,1)),
    screen_share_enabled INTEGER NOT NULL DEFAULT 1 CHECK (screen_share_enabled IN (0,1)),
    queue_enabled INTEGER NOT NULL DEFAULT 1 CHECK (queue_enabled IN (0,1)),
    subtitles_enabled INTEGER NOT NULL DEFAULT 1 CHECK (subtitles_enabled IN (0,1)),
    local_file_enabled INTEGER NOT NULL DEFAULT 1 CHECK (local_file_enabled IN (0,1)),
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS room_memberships (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('host','moderator','member','guest')),
    joined_at INTEGER NOT NULL,
    left_at INTEGER,
    last_seen_at INTEGER,
    muted_until INTEGER,
    UNIQUE (room_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS invitations (
    id TEXT PRIMARY KEY,
    room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
    server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL UNIQUE,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    expires_at INTEGER NOT NULL,
    max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses >= 0),
    uses INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
    revoked_at INTEGER,
    created_at INTEGER NOT NULL,
    CHECK (room_id IS NOT NULL OR server_id IS NOT NULL)
  );
  CREATE TABLE IF NOT EXISTS lobbies (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    owner_username TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    capacity INTEGER NOT NULL DEFAULT 6 CHECK (capacity BETWEEN 2 AND 100),
    privacy TEXT NOT NULL DEFAULT 'public' CHECK (privacy IN ('public','password')),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    close_reason TEXT NOT NULL DEFAULT '',
    closed_at INTEGER,
    last_activity_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_servers_owner ON servers(owner_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_categories_server ON categories(server_id, position);
  CREATE INDEX IF NOT EXISTS idx_channels_server ON channels(server_id, position);
  CREATE INDEX IF NOT EXISTS idx_rooms_active ON rooms(is_active, last_activity_at DESC);
  CREATE INDEX IF NOT EXISTS idx_rooms_host ON rooms(host_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_rooms_server ON rooms(server_id, channel_id);
  CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_memberships(user_id, joined_at DESC);
  CREATE INDEX IF NOT EXISTS idx_invitations_room ON invitations(room_id, expires_at);
  CREATE INDEX IF NOT EXISTS idx_lobbies_owner ON lobbies(owner_id, active, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_lobbies_active ON lobbies(active, last_activity_at DESC);
  CREATE INDEX IF NOT EXISTS idx_lobbies_expiry ON lobbies(expires_at);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_lobbies_active_owner ON lobbies(owner_id) WHERE active = 1;
`;

const messaging = String.raw`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    username TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 2000),
    type TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text','system','playback','queue','reaction')),
    meta_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    edited_at INTEGER,
    deleted_at INTEGER,
    deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS message_reactions (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL CHECK (length(emoji) BETWEEN 1 AND 64),
    created_at INTEGER NOT NULL,
    UNIQUE (message_id, user_id, emoji)
  );
  CREATE TABLE IF NOT EXISTS message_reports (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    reason TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','dismissed')),
    reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS playback_states (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    media_url TEXT NOT NULL DEFAULT '',
    media_type TEXT NOT NULL DEFAULT '',
    position REAL NOT NULL DEFAULT 0 CHECK (position >= 0),
    paused INTEGER NOT NULL DEFAULT 1 CHECK (paused IN (0,1)),
    rate REAL NOT NULL DEFAULT 1 CHECK (rate > 0),
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS playback_history (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL,
    media_url TEXT NOT NULL DEFAULT '',
    media_title TEXT NOT NULL DEFAULT '',
    position REAL NOT NULL DEFAULT 0,
    duration REAL NOT NULL DEFAULT 0,
    watched_seconds REAL NOT NULL DEFAULT 0,
    last_watched_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS subtitle_preferences (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    language TEXT NOT NULL DEFAULT 'fa',
    font_size INTEGER NOT NULL DEFAULT 22 CHECK (font_size BETWEEN 10 AND 60),
    background_opacity REAL NOT NULL DEFAULT 0.6 CHECK (background_opacity BETWEEN 0 AND 1),
    position TEXT NOT NULL DEFAULT 'bottom' CHECK (position IN ('bottom','top')),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_themes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
    tokens_json TEXT NOT NULL DEFAULT '{}',
    is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0,1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, name)
  );
  CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_room_type ON messages(room_id, type, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id);
  CREATE INDEX IF NOT EXISTS idx_reports_status ON message_reports(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_playback_history_user ON playback_history(user_id, last_watched_at DESC);
  CREATE INDEX IF NOT EXISTS idx_playback_history_room ON playback_history(room_id, last_watched_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_user_active_theme ON user_themes(user_id) WHERE is_active = 1;
`;

const billing = String.raw`
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'system',
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    link TEXT NOT NULL DEFAULT '',
    read_at INTEGER,
    created_at INTEGER NOT NULL,
    expires_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all','users','owners')),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','published','archived')),
    publish_at INTEGER,
    expires_at INTEGER,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS subscription_plans (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cycle TEXT NOT NULL DEFAULT 'monthly' CHECK (cycle IN ('monthly','yearly','lifetime')),
    price INTEGER NOT NULL DEFAULT 0 CHECK (price >= 0),
    currency TEXT NOT NULL DEFAULT 'IRT',
    days INTEGER NOT NULL DEFAULT 30 CHECK (days >= 1),
    features_json TEXT NOT NULL DEFAULT '[]',
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    popular INTEGER NOT NULL DEFAULT 0 CHECK (popular IN (0,1)),
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL REFERENCES subscription_plans(id) ON DELETE RESTRICT,
    cycle TEXT NOT NULL DEFAULT 'monthly' CHECK (cycle IN ('monthly','yearly','lifetime')),
    amount INTEGER NOT NULL CHECK (amount >= 0),
    currency TEXT NOT NULL DEFAULT 'IRT',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','cancelled','refunded')),
    provider TEXT NOT NULL DEFAULT '',
    provider_ref TEXT NOT NULL DEFAULT '',
    paid_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL REFERENCES subscription_plans(id) ON DELETE RESTRICT,
    cycle TEXT NOT NULL DEFAULT 'monthly' CHECK (cycle IN ('monthly','yearly','lifetime')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','expired','cancelled')),
    order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
    started_at INTEGER,
    expires_at INTEGER,
    cancelled_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS entitlements (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    plan_id TEXT REFERENCES subscription_plans(id) ON DELETE CASCADE,
    subscription_id TEXT REFERENCES subscriptions(id) ON DELETE CASCADE,
    feature_key TEXT NOT NULL,
    value_json TEXT NOT NULL DEFAULT 'true',
    source TEXT NOT NULL DEFAULT 'plan',
    starts_at INTEGER,
    ends_at INTEGER,
    created_at INTEGER NOT NULL,
    CHECK (user_id IS NOT NULL OR plan_id IS NOT NULL)
  );
  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subscription_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
    order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
    provider TEXT NOT NULL DEFAULT '',
    provider_ref TEXT NOT NULL DEFAULT '',
    amount INTEGER NOT NULL CHECK (amount >= 0),
    currency TEXT NOT NULL DEFAULT 'IRT',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','refunded')),
    paid_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    payment_id TEXT REFERENCES payments(id) ON DELETE SET NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'charge' CHECK (kind IN ('charge','refund','credit','adjustment')),
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'IRT',
    balance_after INTEGER,
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_notifications_expiry ON notifications(expires_at);
  CREATE INDEX IF NOT EXISTS idx_announcements_status ON announcements(status, publish_at);
  CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id, status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_subscriptions_expiry ON subscriptions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_entitlements_user ON entitlements(user_id, feature_key);
  CREATE INDEX IF NOT EXISTS idx_entitlements_plan ON entitlements(plan_id, feature_key);
  CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id, created_at DESC);
`;

const operations = String.raw`
  CREATE TABLE IF NOT EXISTS feature_flags (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL DEFAULT 'true',
    description TEXT NOT NULL DEFAULT '',
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    actor_role TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    target_type TEXT NOT NULL DEFAULT '',
    target_id TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    meta_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS website_pages (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
    locale TEXT NOT NULL DEFAULT 'fa',
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    published_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS analytics_events (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    session_id TEXT NOT NULL DEFAULT '',
    event TEXT NOT NULL,
    path TEXT NOT NULL DEFAULT '',
    props_json TEXT NOT NULL DEFAULT '{}',
    ip_hash TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS automation_workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    trigger TEXT NOT NULL,
    conditions_json TEXT NOT NULL DEFAULT '{}',
    actions_json TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS media_objects (
    id TEXT PRIMARY KEY,
    owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    bucket TEXT NOT NULL,
    object_key TEXT NOT NULL,
    mime TEXT NOT NULL DEFAULT '',
    size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
    checksum TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    deleted_at INTEGER,
    UNIQUE (bucket, object_key)
  );
  CREATE TABLE IF NOT EXISTS backup_runs (
    id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    checksum TEXT NOT NULL DEFAULT '',
    integrity TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    verified_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_analytics_event ON analytics_events(event, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_analytics_user ON analytics_events(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_pages_status ON website_pages(status, locale);
  CREATE INDEX IF NOT EXISTS idx_workflows_enabled ON automation_workflows(enabled, trigger);
  CREATE INDEX IF NOT EXISTS idx_media_owner ON media_objects(owner_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_backup_created ON backup_runs(created_at DESC);
`;

function seed(db) {
  const now = Date.now();
  const roles = [
    ["user", "کاربر", "دسترسی پایهٔ حساب‌های عادی"],
    ["moderator", "ناظم", "مدیریت پیام‌ها و اعضای اتاق"],
    ["owner", "مالک", "مدیریت کامل سایت و داده‌ها"],
    ["super_owner", "مالک ارشد", "دسترسی کامل بدون محدودیت"]
  ];
  const permissions = [
    ["rooms.create", "rooms", "ساخت اتاق و لابی"],
    ["rooms.join", "rooms", "ورود به اتاق"],
    ["rooms.moderate", "rooms", "مدیریت اعضا و محتوای اتاق"],
    ["rooms.close", "rooms", "بستن اتاق"],
    ["chat.send", "chat", "ارسال پیام"],
    ["chat.moderate", "chat", "حذف پیام و رسیدگی به گزارش"],
    ["billing.manage", "billing", "مدیریت پلن‌ها و پرداخت‌ها"],
    ["users.manage", "users", "مدیریت حساب کاربران"],
    ["site.manage", "site", "مدیریت تنظیمات سایت"],
    ["features.manage", "site", "مدیریت فیچر فلگ‌ها"],
    ["content.manage", "site", "مدیریت صفحات و اعلان‌ها"],
    ["audit.read", "ops", "مشاهدهٔ گزارش رویدادها"],
    ["backups.manage", "ops", "پشتیبان‌گیری و بازیابی"]
  ];
  const insRole = db.prepare(
    "INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at) VALUES (?, ?, ?, 1, ?)"
  );
  for (const [id, name, description] of roles) insRole.run(id, name, description, now);
  const insPerm = db.prepare(
    "INSERT OR IGNORE INTO permissions (id, group_name, description, created_at) VALUES (?, ?, ?, ?)"
  );
  for (const [id, group, description] of permissions) insPerm.run(id, group, description, now);

  const grant = db.prepare("INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)");
  const base = ["rooms.create", "rooms.join", "chat.send"];
  const moderate = [...base, "rooms.moderate", "rooms.close", "chat.moderate", "content.manage"];
  for (const id of base) grant.run("user", id);
  for (const id of moderate) grant.run("moderator", id);
  for (const id of permissions.map(([id]) => id)) {
    grant.run("owner", id);
    grant.run("super_owner", id);
  }

  const plan = db.prepare(
    `INSERT OR IGNORE INTO subscription_plans
     (id, name, cycle, price, currency, days, features_json, active, popular, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
  );
  plan.run("monthly", "ماهانه", "monthly", 49000, "IRT", 30, "[]", 0, 0, now, now);
  plan.run("yearly", "سالانه", "yearly", 490000, "IRT", 365, "[]", 1, 1, now, now);

  db.prepare(
    "INSERT OR IGNORE INTO profiles (user_id, updated_at) SELECT id, COALESCE(updated_at, created_at) FROM users"
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_at)
     SELECT u.id, u.role, COALESCE(u.created_at, ?) FROM users u WHERE EXISTS (SELECT 1 FROM roles r WHERE r.id = u.role)`
  ).run(now);
}

export const MIGRATIONS = [
  {
    version: 1,
    name: "identity-and-access",
    up(db) {
      const usersExist = Boolean(
        db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()
      );
      if (usersExist) {
        addColumn(db, "users", "email_verified", "INTEGER NOT NULL DEFAULT 0");
        addColumn(db, "users", "email_verified_at", "INTEGER");
        addColumn(db, "users", "phone", "TEXT NOT NULL DEFAULT ''");
        addColumn(db, "users", "recovery_hash", "TEXT NOT NULL DEFAULT ''");
        addColumn(db, "users", "nick", "TEXT NOT NULL DEFAULT ''");
        addColumn(db, "users", "birthdate", "TEXT NOT NULL DEFAULT ''");
        addColumn(db, "users", "city", "TEXT NOT NULL DEFAULT ''");
        addColumn(db, "users", "bio", "TEXT NOT NULL DEFAULT ''");
        addColumn(db, "users", "avatar", "TEXT NOT NULL DEFAULT ''");
        addColumn(db, "users", "role", "TEXT NOT NULL DEFAULT 'user'");
        addColumn(db, "users", "last_login_at", "INTEGER");
        addColumn(db, "users", "created_at", "INTEGER NOT NULL DEFAULT 0");
      }
      db.exec(identity);
      addColumn(db, "users", "status", "TEXT NOT NULL DEFAULT 'active'");
      addColumn(db, "users", "locale", "TEXT NOT NULL DEFAULT 'fa'");
      addColumn(db, "users", "last_seen_at", "INTEGER");
      addColumn(db, "users", "deleted_at", "INTEGER");
      addColumn(db, "users", "updated_at", "INTEGER");
      db.prepare("UPDATE users SET updated_at = created_at WHERE updated_at IS NULL").run();
      db.exec("CREATE INDEX IF NOT EXISTS idx_users_status ON users(status)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone)");
    }
  },
  {
    version: 2,
    name: "communities-and-rooms",
    up(db) {
      db.exec(community);
    }
  },
  {
    version: 3,
    name: "messages-and-playback",
    up(db) {
      db.exec(messaging);
    }
  },
  {
    version: 4,
    name: "notifications-and-billing",
    up(db) {
      db.exec(billing);
    }
  },
  {
    version: 5,
    name: "operations-and-storage",
    up(db) {
      db.exec(operations);
    }
  },
  {
    version: 6,
    name: "seed-roles-permissions-plans",
    up(db) {
      seed(db);
    }
  },
  {
    version: 7,
    name: "users-last-login-column",
    up(db) {
      addColumn(db, "users", "last_login_at", "INTEGER");
    }
  }
];
