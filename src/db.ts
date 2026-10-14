/**
 * SQLite 持久化层
 *
 * 使用 Node 24 内置的 node:sqlite（DatabaseSync），
 * 无需 better-sqlite3 等原生模块，避免 Windows 下的编译问题。
 *
 * 表结构：
 *   accounts  —— 账号（含 API Key）
 *   logs      —— 请求日志
 *   sessions  —— 会话映射（可选持久化）
 *   settings  —— 键值配置
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'mimo.db');

let db: DatabaseSync | null = null;

/** 初始化数据库与表结构 */
export function initDb(): DatabaseSync {
  if (db) return db;

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  db = new DatabaseSync(DB_FILE);

  // WAL 模式：并发读写更友好
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id             TEXT PRIMARY KEY,
      alias          TEXT,
      service_token  TEXT NOT NULL,
      user_id        TEXT NOT NULL DEFAULT '',
      ph_token       TEXT NOT NULL DEFAULT '',
      api_key        TEXT NOT NULL UNIQUE,
      is_active      INTEGER NOT NULL DEFAULT 1,
      request_count  INTEGER NOT NULL DEFAULT 0,
      error_count    INTEGER NOT NULL DEFAULT 0,
      last_error     TEXT,
      login_url      TEXT,
      health_status  TEXT DEFAULT 'unknown',
      last_checked_at TEXT,
      last_ok_at     TEXT,
      last_latency_ms INTEGER,
      consecutive_failures INTEGER DEFAULT 0,
      check_count    INTEGER DEFAULT 0,
      source         TEXT DEFAULT 'manual',
      priority       INTEGER DEFAULT 100,
      created_at     TEXT NOT NULL,
      last_used_at   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_accounts_api_key ON accounts(api_key);
    CREATE INDEX IF NOT EXISTS idx_accounts_active  ON accounts(is_active);

    CREATE TABLE IF NOT EXISTS logs (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      time              TEXT NOT NULL,
      account_id        TEXT,
      account_alias     TEXT,
      model             TEXT,
      endpoint          TEXT,
      stream            INTEGER NOT NULL DEFAULT 0,
      status            TEXT NOT NULL,
      error             TEXT,
      duration_ms       INTEGER NOT NULL DEFAULT 0,
      prompt_tokens     INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens      INTEGER NOT NULL DEFAULT 0,
      ip                TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_logs_time ON logs(time DESC);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS health_checks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id  TEXT NOT NULL,
      time        TEXT NOT NULL,
      ok          INTEGER NOT NULL,
      latency_ms  INTEGER NOT NULL DEFAULT 0,
      status      TEXT,
      error       TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_health_account ON health_checks(account_id, time DESC);
    CREATE INDEX IF NOT EXISTS idx_health_time    ON health_checks(time DESC);
  `);

  // 为旧库补充新增列。
  //
  // 必须在建索引之前执行：索引可能引用新增的列（如 priority），
  // 若先建索引会因「列不存在」直接报错，导致整个初始化失败。
  migrateColumns(db);

  // 依赖新列的索引，放在迁移之后创建
  try {
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_accounts_priority ON accounts(priority, created_at)',
    );
  } catch (err) {
    // 索引创建失败不应阻止服务启动
    console.warn('[数据库] 创建 priority 索引失败:', err);
  }

  console.log(`[数据库] 已就绪: ${DB_FILE}`);
  return db;
}

/**
 * 为已存在的数据库补充新增列。
 *
 * 先查 PRAGMA table_info，缺列才 ALTER TABLE ADD COLUMN，
 * 这样对已有数据库是安全的（不会丢数据）。
 */
function migrateColumns(database: DatabaseSync): void {
  const wanted: Array<[string, string]> = [
    // 健康检查
    ['health_status', "TEXT DEFAULT 'unknown'"], // unknown | online | offline | expired
    ['last_checked_at', 'TEXT'],
    ['last_ok_at', 'TEXT'],
    ['last_latency_ms', 'INTEGER'],
    ['consecutive_failures', 'INTEGER DEFAULT 0'],
    ['check_count', 'INTEGER DEFAULT 0'],
    // 来源标记
    ['source', "TEXT DEFAULT 'manual'"], // manual | capture
    // 优先级（主备模式：数字越小越优先）
    ['priority', 'INTEGER DEFAULT 100'],
  ];

  const cols = new Set(
    (
      database.prepare('PRAGMA table_info(accounts)').all() as Array<{
        name: string;
      }>
    ).map((c) => c.name),
  );

  const added: string[] = [];
  for (const [name, def] of wanted) {
    if (cols.has(name)) continue;
    try {
      database.exec(`ALTER TABLE accounts ADD COLUMN ${name} ${def}`);
      added.push(name);
    } catch (err) {
      console.warn(`[数据库] 添加列 ${name} 失败:`, err);
    }
  }

  if (added.length) {
    console.log(`[数据库] 已补充列: ${added.join(', ')}`);
  }
}

/** 获取数据库实例（须先 initDb） */
export function getDb(): DatabaseSync {
  if (!db) return initDb();
  return db;
}

export function closeDb(): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    db = null;
  }
}

/* ------------------------------------------------------------------ */
/* settings 键值表                                                     */
/* ------------------------------------------------------------------ */

export function getSetting(key: string): string | null {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(key, value);
}

export function allSettings(): Record<string, string> {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as Array<{
    key: string;
    value: string;
  }>;
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}
