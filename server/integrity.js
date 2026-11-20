import { getDatabase, SQLITE_FILE, databaseState } from "./database/index.js";

const EXPECTED_INDEXES = [
  "idx_users_status_created",
  "idx_rooms_privacy_activity",
  "idx_audit_target",
  "idx_notifications_user_unread",
  "idx_dm_messages_conversation",
  "idx_moderation_actions_created",
  "idx_users_active_created",
  "idx_rooms_last_activity",
  "uq_media_library_item",
  "uq_lobbies_active_owner"
];

const ORPHANS = [
  ["messages", "room_id", "rooms"],
  ["dm_messages", "conversation_id", "dm_conversations"],
  ["dm_reactions", "message_id", "dm_messages"],
  ["poll_options", "poll_id", "room_polls"],
  ["poll_votes", "poll_id", "room_polls"],
  ["poll_votes", "option_id", "poll_options"],
  ["room_memberships", "room_id", "rooms"],
  ["room_memberships", "user_id", "users"],
  ["sessions", "user_id", "users"],
  ["notifications", "user_id", "users"],
  ["page_versions", "page_id", "website_pages"],
  ["automation_runs", "workflow_id", "automation_workflows"],
  ["playback_states", "room_id", "rooms"],
  ["support_messages", "ticket_id", "support_tickets"],
  ["message_reactions", "message_id", "messages"],
  ["dm_reads", "conversation_id", "dm_conversations"],
  ["user_themes", "user_id", "users"],
  ["media_library", "user_id", "users"]
];

function scalar(db, sql, ...params) {
  try {
    return Number(db.prepare(sql).get(...params)?.n || 0);
  } catch (err) {
    return { error: err.message };
  }
}

async function main() {
  const db = await getDatabase();
  if (!db) {
    console.error(JSON.stringify({ ok: false, error: "database_unavailable", file: SQLITE_FILE, state: databaseState() }, null, 2));
    process.exit(1);
  }
  const problems = [];
  const warnings = [];
  const report = { ok: true, file: SQLITE_FILE, generatedAt: new Date().toISOString() };

  report.integrity = String(db.prepare("PRAGMA integrity_check").get()?.integrity_check || "unknown");
  if (report.integrity !== "ok") problems.push({ check: "integrity_check", result: report.integrity });

  const fk = db.prepare("PRAGMA foreign_key_check").all();
  report.foreignKeyViolations = fk.length;
  if (fk.length) problems.push({ check: "foreign_key_check", violations: fk.slice(0, 20) });

  report.orphans = {};
  for (const [table, column, parent] of ORPHANS) {
    const n = scalar(
      db,
      `SELECT COUNT(*) AS n FROM ${table} t LEFT JOIN ${parent} p ON p.id = t.${column} WHERE t.${column} IS NOT NULL AND p.id IS NULL`
    );
    report.orphans[`${table}.${column}`] = n;
    if (typeof n === "number" && n > 0) problems.push({ check: "orphan", table, column, parent, rows: n });
  }

  report.invariants = {
    users: scalar(db, "SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL"),
    superOwners: scalar(db, "SELECT COUNT(*) AS n FROM users WHERE role = 'super_owner' AND deleted_at IS NULL"),
    usersMissingProfile: scalar(
      db,
      "SELECT COUNT(*) AS n FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.deleted_at IS NULL AND p.user_id IS NULL"
    ),
    roomMemberCountMismatch: scalar(
      db,
      `SELECT COUNT(*) AS n FROM rooms r
       WHERE r.deleted_at IS NULL
         AND r.member_count <> (SELECT COUNT(*) FROM room_memberships m WHERE m.room_id = r.id AND m.left_at IS NULL)`
    ),
    duplicateMediaLibrary: scalar(db, "SELECT COUNT(*) AS n FROM (SELECT user_id, kind, url FROM media_library GROUP BY user_id, kind, url HAVING COUNT(*) > 1)"),
    multipleActiveLobbies: scalar(
      db,
      "SELECT COUNT(*) AS n FROM (SELECT owner_id FROM lobbies WHERE active = 1 GROUP BY owner_id HAVING COUNT(*) > 1)"
    ),
    staleSessionRoles: scalar(
      db,
      "SELECT COUNT(*) AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.revoked_at IS NULL AND s.expires_at > strftime('%s','now')*1000 AND s.role <> u.role"
    ),
    negativePlayback: scalar(db, "SELECT COUNT(*) AS n FROM playback_states WHERE position < 0 OR rate <= 0"),
    emptyUsernames: scalar(db, "SELECT COUNT(*) AS n FROM users WHERE trim(username) = '' OR trim(email) = ''")
  };

  if (report.invariants.users > 0 && report.invariants.superOwners < 1) {
    warnings.push({ check: "no_super_owner", rows: report.invariants.users, hint: "run npm run seed or promote an owner from an existing install" });
  }
  if (report.invariants.usersMissingProfile > 0) warnings.push({ check: "profiles_missing", rows: report.invariants.usersMissingProfile });
  if (report.invariants.roomMemberCountMismatch > 0) warnings.push({ check: "room_member_count", rows: report.invariants.roomMemberCountMismatch });
  if (report.invariants.multipleActiveLobbies > 0) problems.push({ check: "invariant", name: "multiple_active_lobbies", rows: report.invariants.multipleActiveLobbies });
  if (report.invariants.staleSessionRoles > 0) warnings.push({ check: "stale_session_roles", rows: report.invariants.staleSessionRoles });
  if (report.invariants.negativePlayback > 0) problems.push({ check: "invariant", name: "invalid_playback_state", rows: report.invariants.negativePlayback });
  if (report.invariants.emptyUsernames > 0) problems.push({ check: "invariant", name: "empty_identity_fields", rows: report.invariants.emptyUsernames });

  const present = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => row.name)
  );
  report.missingIndexes = EXPECTED_INDEXES.filter((name) => !present.has(name));
  if (report.missingIndexes.length) warnings.push({ check: "missing_indexes", names: report.missingIndexes });

  report.migrations = db
    .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
    .all()
    .map((row) => `${row.version}:${row.name}`);
  report.tables = scalar(db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  report.problems = problems;
  report.warnings = warnings;
  report.ok = problems.length === 0;

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
  process.exit(1);
});
