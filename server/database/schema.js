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
    phone_verified INTEGER NOT NULL DEFAULT 0,
    phone_verified_at INTEGER,
    verified_channel TEXT NOT NULL DEFAULT '',
    recovery_channel TEXT NOT NULL DEFAULT '',
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
    channel TEXT NOT NULL DEFAULT 'email',
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
    watched_at INTEGER,
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

const governance = String.raw`
  CREATE TABLE IF NOT EXISTS feature_overrides (
    id TEXT PRIMARY KEY,
    feature_key TEXT NOT NULL,
    scope_type TEXT NOT NULL CHECK (scope_type IN ('global','user','role','server','room','plan')),
    scope_id TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
    config_json TEXT NOT NULL DEFAULT '{}',
    note TEXT NOT NULL DEFAULT '',
    updated_by TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    UNIQUE (feature_key, scope_type, scope_id)
  );
  CREATE TABLE IF NOT EXISTS feature_schedule (
    id TEXT PRIMARY KEY,
    feature_key TEXT NOT NULL,
    scope_type TEXT NOT NULL CHECK (scope_type IN ('global','user','role','server','room','plan')),
    scope_id TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
    note TEXT NOT NULL DEFAULT '',
    effective_at INTEGER NOT NULL,
    created_by TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    applied_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS feature_history (
    id TEXT PRIMARY KEY,
    feature_key TEXT NOT NULL,
    scope_type TEXT NOT NULL DEFAULT 'global',
    scope_id TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    actor TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_feature_overrides_scope ON feature_overrides(scope_type, scope_id);
  CREATE INDEX IF NOT EXISTS idx_feature_schedule_due ON feature_schedule(applied_at, effective_at);
  CREATE INDEX IF NOT EXISTS idx_feature_history_key ON feature_history(feature_key, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_feature_history_created ON feature_history(created_at DESC);
`;

const social = String.raw`
  CREATE TABLE IF NOT EXISTS friendships (
    id TEXT PRIMARY KEY,
    user_a TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    UNIQUE (user_a, user_b),
    CHECK (user_a < user_b)
  );
  CREATE TABLE IF NOT EXISTS friend_requests (
    id TEXT PRIMARY KEY,
    from_user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','cancelled')),
    created_at INTEGER NOT NULL,
    responded_at INTEGER,
    CHECK (from_user <> to_user)
  );
  CREATE TABLE IF NOT EXISTS blocks (
    id TEXT PRIMARY KEY,
    blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    UNIQUE (blocker_id, blocked_id),
    CHECK (blocker_id <> blocked_id)
  );
  CREATE TABLE IF NOT EXISTS dm_conversations (
    id TEXT PRIMARY KEY,
    user_a TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_a, user_b),
    CHECK (user_a < user_b)
  );
  CREATE TABLE IF NOT EXISTS dm_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL DEFAULT '',
    attachment_json TEXT NOT NULL DEFAULT '',
    edited_at INTEGER,
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    CHECK (length(body) <= 4000)
  );
  CREATE TABLE IF NOT EXISTS dm_reads (
    conversation_id TEXT NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS dm_prefs (
    conversation_id TEXT NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0,1)),
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
    PRIMARY KEY (conversation_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS dm_reactions (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES dm_messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (message_id, user_id, emoji),
    CHECK (length(emoji) BETWEEN 1 AND 32)
  );
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK (target_type IN ('user','message','room','server','content','activity')),
    target_id TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'other',
    details TEXT NOT NULL DEFAULT '',
    evidence TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','resolved','dismissed')),
    assigned_to TEXT REFERENCES users(id) ON DELETE SET NULL,
    resolution TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS moderation_notes (
    id TEXT PRIMARY KEY,
    report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS room_polls (
    id TEXT PRIMARY KEY,
    room_code TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    multi INTEGER NOT NULL DEFAULT 0 CHECK (multi IN (0,1)),
    anonymous INTEGER NOT NULL DEFAULT 0 CHECK (anonymous IN (0,1)),
    closes_at INTEGER,
    closed_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS poll_options (
    id TEXT PRIMARY KEY,
    poll_id TEXT NOT NULL REFERENCES room_polls(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS poll_votes (
    id TEXT PRIMARY KEY,
    poll_id TEXT NOT NULL REFERENCES room_polls(id) ON DELETE CASCADE,
    option_id TEXT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    UNIQUE (poll_id, option_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS media_library (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('saved','favorite','recent','upload','subtitle')),
    title TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL,
    meta_json TEXT NOT NULL DEFAULT '{}',
    last_used_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS support_tickets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','resolved','closed')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS support_messages (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    attachment_json TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notification_prefs (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    prefs_json TEXT NOT NULL DEFAULT '{}',
    quiet_from INTEGER,
    quiet_to INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_friend_requests_pending ON friend_requests(from_user, to_user) WHERE status = 'pending';
  CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_user, status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_friend_requests_from ON friend_requests(from_user, status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_friend_requests_pair ON friend_requests(from_user, to_user, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_friendships_b ON friendships(user_b, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_dm_conversations_a ON dm_conversations(user_a, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_dm_conversations_b ON dm_conversations(user_b, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_dm_messages_conversation ON dm_messages(conversation_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_dm_messages_sender ON dm_messages(sender_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_dm_reads_user ON dm_reads(user_id);
  CREATE INDEX IF NOT EXISTS idx_dm_reactions_message ON dm_reactions(message_id);
  CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_type, target_id);
  CREATE INDEX IF NOT EXISTS idx_moderation_notes_report ON moderation_notes(report_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_room_polls_room ON room_polls(room_code, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options(poll_id, position);
  CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes(poll_id, option_id);
  CREATE INDEX IF NOT EXISTS idx_poll_votes_user ON poll_votes(user_id, poll_id);
  CREATE INDEX IF NOT EXISTS idx_media_library_user ON media_library(user_id, kind, last_used_at DESC);
  CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets(user_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_support_messages_ticket ON support_messages(ticket_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_invitations_created_by ON invitations(created_by, created_at DESC);
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
  },
  {
    version: 8,
    name: "feature-governance",
    up(db) {
      db.exec(governance);
    }
  },
  {
    version: 9,
    name: "social-and-moderation",
    up(db) {
      db.exec(social);
      addColumn(db, "invitations", "code_hint", "TEXT NOT NULL DEFAULT ''");
    }
  },
  {
    version: 10,
    name: "profile-privacy",
    up(db) {
      addColumn(db, "profiles", "last_active_visibility", "TEXT NOT NULL DEFAULT 'friends'");
      addColumn(db, "profiles", "activity_visibility", "TEXT NOT NULL DEFAULT 'friends'");
    }
  },
  {
    version: 11,
    name: "watch-room-management",
    up(db) {
      addColumn(db, "rooms", "description", "TEXT NOT NULL DEFAULT ''");
      addColumn(db, "rooms", "rules", "TEXT NOT NULL DEFAULT ''");
      addColumn(db, "rooms", "icon_url", "TEXT NOT NULL DEFAULT ''");
      addColumn(db, "rooms", "cover_url", "TEXT NOT NULL DEFAULT ''");
      addColumn(db, "rooms", "color", "TEXT NOT NULL DEFAULT ''");
      addColumn(db, "rooms", "visibility", "TEXT NOT NULL DEFAULT 'public'");
      addColumn(db, "rooms", "updated_at", "INTEGER");
      addColumn(db, "rooms", "closed_by", "TEXT");
      db.exec(`
        CREATE TABLE IF NOT EXISTS room_visits (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
          last_visited_at INTEGER NOT NULL,
          visits INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (user_id, room_id)
        );
        CREATE INDEX IF NOT EXISTS idx_room_visits_user ON room_visits(user_id, last_visited_at DESC);
        CREATE INDEX IF NOT EXISTS idx_rooms_visibility ON rooms(visibility, is_active, last_activity_at DESC);
      `);
      db.prepare("UPDATE rooms SET updated_at = created_at WHERE updated_at IS NULL").run();
    }
  },
  {
    version: 12,
    name: "notification-delivery-and-support-ops",
    up(db) {
      addColumn(db, "notifications", "delivered_at", "INTEGER");
      addColumn(db, "notifications", "dedupe_key", "TEXT NOT NULL DEFAULT ''");
      addColumn(db, "support_tickets", "assigned_to", "TEXT");
      addColumn(db, "support_tickets", "resolved_at", "INTEGER");
      addColumn(db, "support_tickets", "resolution", "TEXT NOT NULL DEFAULT ''");
      addColumn(db, "support_messages", "kind", "TEXT NOT NULL DEFAULT 'message'");
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, read_at, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications(user_id, dedupe_key, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_support_tickets_assignee ON support_tickets(assigned_to, status, updated_at DESC);
      `);
    }
  },
  {
    version: 13,
    name: "plans-coupons-payments",
    up(db) {
      addColumn(db, "subscription_plans", "description", "TEXT NOT NULL DEFAULT ''");
      addColumn(db, "subscription_plans", "trial_days", "INTEGER NOT NULL DEFAULT 0");
      addColumn(db, "subscription_plans", "archived", "INTEGER NOT NULL DEFAULT 0");
      addColumn(db, "subscription_plans", "quota_json", "TEXT NOT NULL DEFAULT '{}'");
      addColumn(db, "orders", "coupon_code", "TEXT NOT NULL DEFAULT ''");
      addColumn(db, "orders", "discount", "INTEGER NOT NULL DEFAULT 0");
      addColumn(db, "orders", "trial", "INTEGER NOT NULL DEFAULT 0");
      addColumn(db, "orders", "meta_json", "TEXT NOT NULL DEFAULT '{}'");
      addColumn(db, "subscriptions", "trial_ends_at", "INTEGER");
      addColumn(db, "subscriptions", "cancel_at_period_end", "INTEGER NOT NULL DEFAULT 0");
      addColumn(db, "subscriptions", "renewal_status", "TEXT NOT NULL DEFAULT 'auto'");
      addColumn(db, "payments", "idempotency_key", "TEXT NOT NULL DEFAULT ''");
      addColumn(db, "payments", "payload_json", "TEXT NOT NULL DEFAULT '{}'");
      addColumn(db, "payments", "verified_at", "INTEGER");
      addColumn(db, "payments", "refunded_at", "INTEGER");
      addColumn(db, "payments", "refund_reason", "TEXT NOT NULL DEFAULT ''");
      db.exec(`
        CREATE TABLE IF NOT EXISTS coupons (
          id TEXT PRIMARY KEY,
          code TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL DEFAULT 'percent' CHECK (kind IN ('percent','fixed')),
          value INTEGER NOT NULL CHECK (value > 0),
          plan_id TEXT REFERENCES subscription_plans(id) ON DELETE SET NULL,
          max_redemptions INTEGER NOT NULL DEFAULT 0,
          redemptions INTEGER NOT NULL DEFAULT 0,
          valid_from INTEGER,
          valid_until INTEGER,
          active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS coupon_redemptions (
          id TEXT PRIMARY KEY,
          coupon_id TEXT NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          order_id TEXT NOT NULL,
          amount INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          UNIQUE (coupon_id, order_id)
        );
        CREATE TABLE IF NOT EXISTS subscription_events (
          id TEXT PRIMARY KEY,
          subscription_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          type TEXT NOT NULL,
          meta_json TEXT NOT NULL DEFAULT '{}',
          actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS payment_events (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          event_id TEXT NOT NULL,
          payment_id TEXT,
          payload_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          UNIQUE (provider, event_id)
        );
        CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons(code);
        CREATE INDEX IF NOT EXISTS idx_coupons_active ON coupons(active, valid_until);
        CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_user ON coupon_redemptions(user_id, coupon_id);
        CREATE INDEX IF NOT EXISTS idx_subscription_events_sub ON subscription_events(subscription_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_payment_events_payment ON payment_events(payment_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_idempotency ON payments(idempotency_key) WHERE idempotency_key <> '';
      `);
    }
  },
  {
    version: 14,
    name: "website-builder-automation-runs-uploads",
    up(db) {
      addColumn(db, "website_pages", "description", "TEXT NOT NULL DEFAULT ''");
      addColumn(db, "website_pages", "blocks_json", "TEXT NOT NULL DEFAULT '[]'");
      addColumn(db, "website_pages", "visibility", "TEXT NOT NULL DEFAULT 'public'");
      addColumn(db, "website_pages", "scheduled_at", "INTEGER");
      addColumn(db, "website_pages", "show_in_nav", "INTEGER NOT NULL DEFAULT 0");
      addColumn(db, "website_pages", "nav_order", "INTEGER NOT NULL DEFAULT 0");
      addColumn(db, "website_pages", "version", "INTEGER NOT NULL DEFAULT 1");
      addColumn(db, "automation_workflows", "description", "TEXT NOT NULL DEFAULT ''");
      addColumn(db, "automation_workflows", "last_run_at", "INTEGER");
      addColumn(db, "automation_workflows", "last_status", "TEXT NOT NULL DEFAULT ''");
      addColumn(db, "automation_workflows", "last_error", "TEXT NOT NULL DEFAULT ''");
      addColumn(db, "automation_workflows", "run_count", "INTEGER NOT NULL DEFAULT 0");
      addColumn(db, "automation_workflows", "error_count", "INTEGER NOT NULL DEFAULT 0");
      addColumn(db, "rooms", "cover_url", "TEXT NOT NULL DEFAULT ''");
      addColumn(db, "media_objects", "visibility", "TEXT NOT NULL DEFAULT 'private'");
      addColumn(db, "media_objects", "purpose", "TEXT NOT NULL DEFAULT ''");
      db.exec(`
        CREATE TABLE IF NOT EXISTS page_versions (
          id TEXT PRIMARY KEY,
          page_id TEXT NOT NULL REFERENCES website_pages(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          blocks_json TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'draft',
          visibility TEXT NOT NULL DEFAULT 'public',
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (page_id, version)
        );
        CREATE TABLE IF NOT EXISTS page_submissions (
          id TEXT PRIMARY KEY,
          page_id TEXT NOT NULL REFERENCES website_pages(id) ON DELETE CASCADE,
          name TEXT NOT NULL DEFAULT '',
          email TEXT NOT NULL DEFAULT '',
          message TEXT NOT NULL DEFAULT '',
          meta_json TEXT NOT NULL DEFAULT '{}',
          ip_hash TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS automation_runs (
          id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL REFERENCES automation_workflows(id) ON DELETE CASCADE,
          trigger TEXT NOT NULL,
          event_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'running',
          attempts INTEGER NOT NULL DEFAULT 1,
          actions_json TEXT NOT NULL DEFAULT '[]',
          error TEXT NOT NULL DEFAULT '',
          retry_of TEXT,
          started_at INTEGER NOT NULL,
          finished_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_page_versions_page ON page_versions(page_id, version DESC);
        CREATE INDEX IF NOT EXISTS idx_page_submissions_page ON page_submissions(page_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_automation_runs_workflow ON automation_runs(workflow_id, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_automation_runs_status ON automation_runs(status, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_pages_nav ON website_pages(show_in_nav, nav_order, status);
        CREATE INDEX IF NOT EXISTS idx_media_owner ON media_objects(owner_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_media_purpose ON media_objects(purpose, created_at DESC);
      `);
    }
  },
  {
    version: 15,
    name: "integrity-indexes-moderation-actions",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS moderation_actions (
          id TEXT PRIMARY KEY,
          moderator_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          action TEXT NOT NULL CHECK (action IN (
            'kick','role_change','room_close','room_reopen','report_resolve','report_dismiss',
            'user_role','user_status','content_remove'
          )),
          target_type TEXT NOT NULL DEFAULT '',
          target_id TEXT NOT NULL DEFAULT '',
          room_code TEXT NOT NULL DEFAULT '',
          reason TEXT NOT NULL DEFAULT '',
          meta_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_moderation_actions_target ON moderation_actions(target_type, target_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_moderation_actions_created ON moderation_actions(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_moderation_actions_moderator ON moderation_actions(moderator_id, created_at DESC);
      `);
      db.exec(`
        DELETE FROM media_library
        WHERE rowid NOT IN (SELECT MIN(rowid) FROM media_library GROUP BY user_id, kind, url);
        CREATE UNIQUE INDEX IF NOT EXISTS uq_media_library_item ON media_library(user_id, kind, url);
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_users_status_created ON users(status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_rooms_privacy_activity ON rooms(privacy, is_active, last_activity_at DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(target_type, target_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_sessions_expiry_active ON sessions(expires_at, revoked_at);
        CREATE INDEX IF NOT EXISTS idx_media_objects_visibility ON media_objects(visibility, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_page_submissions_created ON page_submissions(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_automation_runs_started ON automation_runs(started_at DESC);
      `);
    }
  },
  {
    version: 16,
    name: "performance-indexes",
    up(db) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_users_active_created ON users(created_at DESC) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_rooms_last_activity ON rooms(last_activity_at DESC);
      `);
    }
  },
  {
    version: 17,
    name: "media-watch-tracking",
    up(db) {
      addColumn(db, "media_objects", "watched_at", "INTEGER");
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_media_watched ON media_objects(kind, watched_at);
        CREATE INDEX IF NOT EXISTS idx_media_created_kind ON media_objects(kind, created_at);
      `);
    }
  },
  {
    version: 18,
    name: "account-verification-and-room-access",
    up(db) {
      addColumn(db, "users", "phone_verified", "INTEGER NOT NULL DEFAULT 0");
      addColumn(db, "users", "phone_verified_at", "INTEGER");
      addColumn(db, "users", "verified_channel", "TEXT NOT NULL DEFAULT ''");
      addColumn(db, "users", "recovery_channel", "TEXT NOT NULL DEFAULT ''");
      addColumn(db, "email_tokens", "channel", "TEXT NOT NULL DEFAULT 'email'");
      db.exec(`
        CREATE TABLE IF NOT EXISTS room_access (
          room_code TEXT NOT NULL,
          user_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (room_code, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_room_access_expiry ON room_access(expires_at);
      `);
    }
  },
  {
    version: 19,
    name: "room-access-modes-and-join-requests",
    up(db) {
      addColumn(db, "rooms", "join_mode", "TEXT NOT NULL DEFAULT 'open'");
      addColumn(db, "rooms", "deleted_by", "TEXT");
      db.exec(`
        CREATE TABLE IF NOT EXISTS room_join_requests (
          id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','cancelled')),
          note TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          decided_at INTEGER,
          decided_by TEXT,
          UNIQUE (room_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_room_requests_room ON room_join_requests(room_id, status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_room_requests_user ON room_join_requests(user_id, status);
      `);
      db.prepare(
        `UPDATE rooms SET join_mode = CASE
           WHEN COALESCE(password_hash, '') <> '' THEN 'password'
           WHEN visibility = 'private' THEN 'invite'
           ELSE 'open' END`
      ).run();
    }
  },
  {
    version: 20,
    name: "room-member-roles-and-permissions",
    up(db) {
      db.exec(`
        CREATE TABLE room_memberships_v20 (
          id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('host','administrator','moderator','member','guest')),
          permissions_json TEXT NOT NULL DEFAULT '{}',
          joined_at INTEGER NOT NULL,
          left_at INTEGER,
          last_seen_at INTEGER,
          muted_until INTEGER,
          UNIQUE (room_id, user_id)
        );
        INSERT INTO room_memberships_v20
          (id, room_id, user_id, role, permissions_json, joined_at, left_at, last_seen_at, muted_until)
        SELECT id, room_id, user_id, role, '{}', joined_at, left_at, last_seen_at, muted_until
        FROM room_memberships;
        DROP TABLE room_memberships;
        ALTER TABLE room_memberships_v20 RENAME TO room_memberships;
        CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_memberships(user_id, joined_at DESC);
        CREATE INDEX IF NOT EXISTS idx_room_members_room ON room_memberships(room_id, left_at);
      `);
    }
  },
  {
    version: 21,
    name: "dm-reliability-and-requests",
    up(db) {
      addColumn(db, "dm_messages", "client_id", "TEXT NOT NULL DEFAULT ''");
      addColumn(db, "dm_messages", "reply_to_id", "TEXT");
      addColumn(db, "dm_reads", "last_read_seq", "INTEGER NOT NULL DEFAULT 0");
      addColumn(db, "dm_conversations", "status", "TEXT NOT NULL DEFAULT 'accepted'");
      addColumn(db, "dm_conversations", "requested_by", "TEXT");
      addColumn(db, "dm_conversations", "requested_at", "INTEGER");
      addColumn(db, "dm_conversations", "responded_at", "INTEGER");
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_client
          ON dm_messages(sender_id, client_id) WHERE client_id <> '';
        CREATE INDEX IF NOT EXISTS idx_dm_messages_conv_created
          ON dm_messages(conversation_id, created_at, id);
        CREATE INDEX IF NOT EXISTS idx_dm_requests
          ON dm_conversations(status, requested_at DESC);
      `);
      db.prepare(
        `UPDATE dm_conversations SET status = 'accepted',
           requested_at = COALESCE(requested_at, created_at),
           responded_at = COALESCE(responded_at, created_at)
         WHERE status = 'accepted'`
      ).run();
    }
  }
];
