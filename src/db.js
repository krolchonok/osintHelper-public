const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");

const DEFAULT_DB_PATH = path.resolve(process.cwd(), "data", "app.db");

function resolveDbPath(rawPath) {
  if (!rawPath) {
    return DEFAULT_DB_PATH;
  }

  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }

  return path.resolve(process.cwd(), rawPath);
}

function nowIso() {
  return new Date().toISOString();
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      domain TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_domains (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, domain),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_project_domains_project_primary
      ON project_domains(project_id, is_primary DESC, domain ASC);

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'USER' CHECK(role IN ('ADMIN', 'USER')),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_expires ON auth_sessions(user_id, expires_at);

    CREATE TABLE IF NOT EXISTS setup_tokens (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_setup_tokens_expires_used ON setup_tokens(expires_at, used_at);

    CREATE TABLE IF NOT EXISTS scan_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('PASSIVE_SCAN', 'DNS_RESOLVE', 'ASN_LOOKUP')),
      task_kind TEXT,
      task_payload TEXT,
      scan_scope TEXT NOT NULL DEFAULT 'core' CHECK(scan_scope IN ('core', 'extended', 'dorks', 'all', 'fullypassive') OR scan_scope LIKE 'provider:%'),
      cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0, 1)),
      status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED', 'RUNNING', 'SUCCESS', 'FAILED')),
      progress INTEGER NOT NULL DEFAULT 0,
      stage TEXT,
      processed INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      started_at TEXT,
      finished_at TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_scan_runs_project_created ON scan_runs(project_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS scan_run_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      stage TEXT NOT NULL,
      processed INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES scan_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_scan_run_events_run_created ON scan_run_events(run_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS subdomains (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      host TEXT NOT NULL,
      is_root INTEGER NOT NULL DEFAULT 0 CHECK(is_root IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, host),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_subdomains_project ON subdomains(project_id);

    CREATE TABLE IF NOT EXISTS subdomain_sources (
      id TEXT PRIMARY KEY,
      subdomain_id TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(subdomain_id, source),
      FOREIGN KEY(subdomain_id) REFERENCES subdomains(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS dns_records (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      subdomain_id TEXT NOT NULL,
      resolver TEXT NOT NULL,
      record_type TEXT NOT NULL,
      value TEXT NOT NULL,
      data_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(subdomain_id) REFERENCES subdomains(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_dns_records_project_subdomain_type ON dns_records(project_id, subdomain_id, record_type);
    CREATE INDEX IF NOT EXISTS idx_dns_records_resolver ON dns_records(resolver);

    CREATE TABLE IF NOT EXISTS provider_settings (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      token_encrypted TEXT,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_whois (
      project_id TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      source TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_2ip (
      project_id TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_vt_deep (
      project_id TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      source TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_intelx_leaks (
      project_id TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      source TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_webarchive (
      project_id TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      source TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_dork_stats (
      project_id TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      source TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_asn (
      project_id TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_availability (
      project_id TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_email_overrides (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_email TEXT NOT NULL,
      email TEXT NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0 CHECK(is_deleted IN (0, 1)),
      is_manual INTEGER NOT NULL DEFAULT 0 CHECK(is_manual IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, source_email),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_project_email_overrides_project
      ON project_email_overrides(project_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS dork_captcha_sessions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      engine TEXT NOT NULL,
      captcha_html TEXT NOT NULL,
      original_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'RESOLVED')),
      cookies TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      FOREIGN KEY(run_id) REFERENCES scan_runs(id) ON DELETE CASCADE,
      UNIQUE(run_id, engine)
    );

    CREATE TABLE IF NOT EXISTS scan_jobs (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('PASSIVE_SCAN', 'DNS_RESOLVE', 'ASN_LOOKUP')),
      task_kind TEXT,
      task_payload TEXT,
      scan_scope TEXT NOT NULL DEFAULT 'core' CHECK(scan_scope IN ('core', 'extended', 'dorks', 'all', 'fullypassive') OR scan_scope LIKE 'provider:%'),
      status TEXT NOT NULL CHECK(status IN ('QUEUED', 'RUNNING')),
      created_at TEXT NOT NULL,
      started_at TEXT,
      FOREIGN KEY(run_id) REFERENCES scan_runs(id) ON DELETE CASCADE,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_scan_jobs_status_created ON scan_jobs(status, created_at);

    CREATE TABLE IF NOT EXISTS labor_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      settings_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function ensureColumnExists(db, tableName, columnName, addColumnSql) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = columns.some((column) => String(column.name) === columnName);
  if (!exists) {
    db.exec(addColumnSql);
  }
}

function repairLegacyProjectsForeignKeys(db) {
  const brokenRefs = db
    .prepare(`
      SELECT name, sql
      FROM sqlite_schema
      WHERE type = 'table'
        AND sql IS NOT NULL
        AND sql LIKE '%projects_legacy%'
    `)
    .all();

  if (!brokenRefs.length) {
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    for (const row of brokenRefs) {
      const tableName = String(row.name || "").trim();
      const createSql = String(row.sql || "").trim();
      if (!tableName || !createSql) {
        continue;
      }

      const repairTableName = `${tableName}__repair`;
      const replacedCreateSql = createSql
        .replace(
          new RegExp(`^CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?["'\`]?${tableName}["'\`]?`, "i"),
          `CREATE TABLE ${repairTableName}`,
        )
        .replace(/projects_legacy/g, "projects");

      db.exec(replacedCreateSql);

      const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
      const columnList = columns.map((column) => `"${String(column.name).replace(/"/g, "\"\"")}"`).join(", ");
      if (columnList) {
        db.exec(`
          INSERT INTO ${repairTableName} (${columnList})
          SELECT ${columnList}
          FROM ${tableName}
        `);
      }

      db.exec(`DROP TABLE ${tableName}`);
      db.exec(`ALTER TABLE ${repairTableName} RENAME TO ${tableName}`);
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function migrateProjectsTable(db) {
  const columns = db.prepare("PRAGMA table_info(projects)").all();
  const hasName = columns.some((column) => String(column.name) === "name");
  if (hasName) {
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec(`
      ALTER TABLE projects RENAME TO projects_legacy;

      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        domain TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO projects (id, name, domain, created_at, updated_at)
      SELECT
        id,
        COALESCE(NULLIF(TRIM(domain), ''), id),
        NULLIF(TRIM(domain), ''),
        created_at,
        updated_at
      FROM projects_legacy;

      DROP TABLE projects_legacy;
    `);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function migrateProjectsDomainNotUnique(db) {
  const row = db
    .prepare(`
      SELECT sql
      FROM sqlite_schema
      WHERE type = 'table'
        AND name = 'projects'
        AND sql IS NOT NULL
      LIMIT 1
    `)
    .get();
  const createSql = String(row?.sql || "");
  if (!/\bdomain\s+TEXT\s+UNIQUE\b/i.test(createSql)) {
    return;
  }

  const columns = db.prepare("PRAGMA table_info(projects)").all();
  const columnNames = new Set(columns.map((column) => String(column.name)));
  const supportedColumns = ["id", "name", "domain", "created_at", "updated_at", "labor_scope_json"];
  const copyColumns = supportedColumns.filter((column) => columnNames.has(column));
  const columnList = copyColumns.map((column) => `"${column}"`).join(", ");

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec(`
      CREATE TABLE projects__domain_scope_migration (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        domain TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        labor_scope_json TEXT
      );
    `);

    if (columnList) {
      db.exec(`
        INSERT INTO projects__domain_scope_migration (${columnList})
        SELECT ${columnList}
        FROM projects;
      `);
    }

    db.exec(`
      DROP TABLE projects;
      ALTER TABLE projects__domain_scope_migration RENAME TO projects;
    `);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function migrateProjectDomainsDomainNotUnique(db) {
  const row = db
    .prepare(`
      SELECT sql
      FROM sqlite_schema
      WHERE type = 'table'
        AND name = 'project_domains'
        AND sql IS NOT NULL
      LIMIT 1
    `)
    .get();
  const createSql = String(row?.sql || "");
  if (!/\bdomain\s+TEXT\s+NOT\s+NULL\s+UNIQUE\b/i.test(createSql)) {
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec(`
      CREATE TABLE project_domains__domain_scope_migration (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, domain),
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      INSERT INTO project_domains__domain_scope_migration (
        id, project_id, domain, is_primary, created_at, updated_at
      )
      SELECT id, project_id, domain, is_primary, created_at, updated_at
      FROM project_domains;

      DROP TABLE project_domains;
      ALTER TABLE project_domains__domain_scope_migration RENAME TO project_domains;
    `);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function migrateProviderScanScopes(db) {
  const rows = db
    .prepare(`
      SELECT name, sql
      FROM sqlite_schema
      WHERE type = 'table'
        AND name IN ('scan_runs', 'scan_jobs')
        AND sql IS NOT NULL
        AND sql LIKE '%scan_scope IN (%'
        AND sql NOT LIKE '%provider:%'
    `)
    .all();

  if (!rows.length) {
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    if (rows.some((row) => row.name === "scan_runs")) {
      db.exec(`
        CREATE TABLE scan_runs__scope_migration (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('PASSIVE_SCAN', 'DNS_RESOLVE')),
          task_kind TEXT,
          task_payload TEXT,
          scan_scope TEXT NOT NULL DEFAULT 'core' CHECK(scan_scope IN ('core', 'extended', 'dorks', 'all', 'fullypassive') OR scan_scope LIKE 'provider:%'),
          cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0, 1)),
          status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED', 'RUNNING', 'SUCCESS', 'FAILED')),
          progress INTEGER NOT NULL DEFAULT 0,
          stage TEXT,
          processed INTEGER NOT NULL DEFAULT 0,
          total INTEGER NOT NULL DEFAULT 0,
          started_at TEXT,
          finished_at TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        INSERT INTO scan_runs__scope_migration (
          id, project_id, type, task_kind, task_payload, scan_scope, cancel_requested,
          status, progress, stage, processed, total, started_at, finished_at, error, created_at
        )
        SELECT
          id, project_id, type, task_kind, task_payload, scan_scope, cancel_requested,
          status, progress, stage, processed, total, started_at, finished_at, error, created_at
        FROM scan_runs;

        DROP TABLE scan_runs;
        ALTER TABLE scan_runs__scope_migration RENAME TO scan_runs;
      `);
    }

    if (rows.some((row) => row.name === "scan_jobs")) {
      db.exec(`
        CREATE TABLE scan_jobs__scope_migration (
          run_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('PASSIVE_SCAN', 'DNS_RESOLVE')),
          task_kind TEXT,
          task_payload TEXT,
          scan_scope TEXT NOT NULL DEFAULT 'core' CHECK(scan_scope IN ('core', 'extended', 'dorks', 'all', 'fullypassive') OR scan_scope LIKE 'provider:%'),
          status TEXT NOT NULL CHECK(status IN ('QUEUED', 'RUNNING')),
          created_at TEXT NOT NULL,
          started_at TEXT,
          FOREIGN KEY(run_id) REFERENCES scan_runs(id) ON DELETE CASCADE,
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        INSERT INTO scan_jobs__scope_migration (
          run_id, project_id, type, task_kind, task_payload, scan_scope, status, created_at, started_at
        )
        SELECT run_id, project_id, type, task_kind, task_payload, scan_scope, status, created_at, started_at
        FROM scan_jobs;

        DROP TABLE scan_jobs;
        ALTER TABLE scan_jobs__scope_migration RENAME TO scan_jobs;
      `);
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function migrateScanTaskTypes(db) {
  const rows = db
    .prepare(`
      SELECT name, sql
      FROM sqlite_schema
      WHERE type = 'table'
        AND name IN ('scan_runs', 'scan_jobs')
        AND sql IS NOT NULL
        AND sql LIKE '%type IN (%'
        AND sql NOT LIKE '%ASN_LOOKUP%'
    `)
    .all();

  if (!rows.length) {
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    if (rows.some((row) => row.name === "scan_runs")) {
      db.exec(`
        CREATE TABLE scan_runs__type_migration (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('PASSIVE_SCAN', 'DNS_RESOLVE', 'ASN_LOOKUP')),
          task_kind TEXT,
          task_payload TEXT,
          scan_scope TEXT NOT NULL DEFAULT 'core' CHECK(scan_scope IN ('core', 'extended', 'dorks', 'all', 'fullypassive') OR scan_scope LIKE 'provider:%'),
          cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0, 1)),
          status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED', 'RUNNING', 'SUCCESS', 'FAILED')),
          progress INTEGER NOT NULL DEFAULT 0,
          stage TEXT,
          processed INTEGER NOT NULL DEFAULT 0,
          total INTEGER NOT NULL DEFAULT 0,
          started_at TEXT,
          finished_at TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        INSERT INTO scan_runs__type_migration (
          id, project_id, type, task_kind, task_payload, scan_scope, cancel_requested,
          status, progress, stage, processed, total, started_at, finished_at, error, created_at
        )
        SELECT
          id, project_id, type, task_kind, task_payload, scan_scope, cancel_requested,
          status, progress, stage, processed, total, started_at, finished_at, error, created_at
        FROM scan_runs;

        DROP TABLE scan_runs;
        ALTER TABLE scan_runs__type_migration RENAME TO scan_runs;
        CREATE INDEX IF NOT EXISTS idx_scan_runs_project_created ON scan_runs(project_id, created_at DESC);
      `);
    }

    if (rows.some((row) => row.name === "scan_jobs")) {
      db.exec(`
        CREATE TABLE scan_jobs__type_migration (
          run_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('PASSIVE_SCAN', 'DNS_RESOLVE', 'ASN_LOOKUP')),
          task_kind TEXT,
          task_payload TEXT,
          scan_scope TEXT NOT NULL DEFAULT 'core' CHECK(scan_scope IN ('core', 'extended', 'dorks', 'all', 'fullypassive') OR scan_scope LIKE 'provider:%'),
          status TEXT NOT NULL CHECK(status IN ('QUEUED', 'RUNNING')),
          created_at TEXT NOT NULL,
          started_at TEXT,
          FOREIGN KEY(run_id) REFERENCES scan_runs(id) ON DELETE CASCADE,
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        INSERT INTO scan_jobs__type_migration (
          run_id, project_id, type, task_kind, task_payload, scan_scope, status, created_at, started_at
        )
        SELECT run_id, project_id, type, task_kind, task_payload, scan_scope, status, created_at, started_at
        FROM scan_jobs;

        DROP TABLE scan_jobs;
        ALTER TABLE scan_jobs__type_migration RENAME TO scan_jobs;
        CREATE INDEX IF NOT EXISTS idx_scan_jobs_status_created ON scan_jobs(status, created_at);
      `);
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

let state = null;

function openDatabase(rawPath = process.env.SQLITE_PATH) {
  const dbPath = resolveDbPath(rawPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");

  initSchema(db);
  migrateProjectsTable(db);
  repairLegacyProjectsForeignKeys(db);
  migrateProjectsDomainNotUnique(db);
  migrateProjectDomainsDomainNotUnique(db);
  migrateProviderScanScopes(db);
  migrateScanTaskTypes(db);
  initSchema(db);
  ensureColumnExists(
    db,
    "scan_runs",
    "scan_scope",
    "ALTER TABLE scan_runs ADD COLUMN scan_scope TEXT NOT NULL DEFAULT 'core'",
  );
  ensureColumnExists(
    db,
    "scan_runs",
    "cancel_requested",
    "ALTER TABLE scan_runs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0",
  );
  ensureColumnExists(
    db,
    "scan_runs",
    "task_kind",
    "ALTER TABLE scan_runs ADD COLUMN task_kind TEXT",
  );
  ensureColumnExists(
    db,
    "scan_runs",
    "task_payload",
    "ALTER TABLE scan_runs ADD COLUMN task_payload TEXT",
  );
  ensureColumnExists(
    db,
    "scan_jobs",
    "scan_scope",
    "ALTER TABLE scan_jobs ADD COLUMN scan_scope TEXT NOT NULL DEFAULT 'core'",
  );
  ensureColumnExists(
    db,
    "scan_jobs",
    "task_kind",
    "ALTER TABLE scan_jobs ADD COLUMN task_kind TEXT",
  );
  ensureColumnExists(
    db,
    "scan_jobs",
    "task_payload",
    "ALTER TABLE scan_jobs ADD COLUMN task_payload TEXT",
  );
  ensureColumnExists(
    db,
    "projects",
    "labor_scope_json",
    "ALTER TABLE projects ADD COLUMN labor_scope_json TEXT",
  );
  ensureColumnExists(
    db,
    "projects",
    "ready_mode_enabled",
    "ALTER TABLE projects ADD COLUMN ready_mode_enabled INTEGER NOT NULL DEFAULT 0 CHECK(ready_mode_enabled IN (0, 1))",
  );

  const legacyProjects = db
    .prepare(`
      SELECT p.id, p.domain, p.created_at, p.updated_at
      FROM projects p
      LEFT JOIN project_domains pd
        ON pd.project_id = p.id
       AND pd.domain = p.domain
      WHERE p.domain IS NOT NULL
        AND TRIM(p.domain) <> ''
        AND pd.id IS NULL
    `)
    .all();

  if (legacyProjects.length) {
    const seedLegacyDomains = db.transaction((rows) => {
      const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO project_domains (id, project_id, domain, is_primary, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)
      `);

      for (const row of rows) {
        insertStmt.run(
          crypto.randomUUID(),
          row.id,
          row.domain,
          row.created_at || nowIso(),
          row.updated_at || row.created_at || nowIso(),
        );
      }
    });

    seedLegacyDomains(legacyProjects);
  }

  state = { db, dbPath };
  return state;
}

function getDbState() {
  if (!state) {
    return openDatabase();
  }
  return state;
}

module.exports = {
  openDatabase,
  getDbState,
  nowIso,
};
