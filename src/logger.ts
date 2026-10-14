/**
 * 请求日志：SQLite 持久化
 *
 * 使用 node:sqlite，支持分页查询与聚合统计。
 */

import { getDb, initDb } from './db.ts';

export interface LogEntry {
  id: number;
  time: string;
  accountId: string;
  accountAlias: string | null;
  model: string;
  endpoint: string;
  stream: boolean;
  status: 'success' | 'error';
  error?: string;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  ip: string;
}

interface LogRow {
  id: number;
  time: string;
  account_id: string;
  account_alias: string | null;
  model: string;
  endpoint: string;
  stream: number;
  status: string;
  error: string | null;
  duration_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  ip: string;
}

function rowToLog(r: LogRow): LogEntry {
  return {
    id: r.id,
    time: r.time,
    accountId: r.account_id,
    accountAlias: r.account_alias,
    model: r.model,
    endpoint: r.endpoint,
    stream: r.stream === 1,
    status: r.status === 'success' ? 'success' : 'error',
    error: r.error ?? undefined,
    durationMs: r.duration_ms,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    totalTokens: r.total_tokens,
    ip: r.ip,
  };
}

export function initLogger(): void {
  initDb();
  const row = getDb().prepare('SELECT COUNT(*) AS c FROM logs').get() as {
    c: number;
  };
  console.log(`[日志] 已加载 ${row.c} 条历史记录`);
}

/** 写入一条日志 */
export function addLog(entry: Omit<LogEntry, 'id' | 'time'>): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO logs
         (time, account_id, account_alias, model, endpoint, stream, status, error,
          duration_ms, prompt_tokens, completion_tokens, total_tokens, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        entry.accountId,
        entry.accountAlias,
        entry.model,
        entry.endpoint,
        entry.stream ? 1 : 0,
        entry.status,
        entry.error ?? null,
        entry.durationMs,
        entry.promptTokens,
        entry.completionTokens,
        entry.totalTokens,
        entry.ip,
      );
  } catch (err) {
    // 日志失败不应影响主流程
    console.warn('[日志] 写入失败:', err);
  }
}

/** 查询日志（按时间倒序） */
export function listLogs(limit = 100, offset = 0): LogEntry[] {
  const rows = getDb()
    .prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(limit, offset) as unknown as LogRow[];
  return rows.map(rowToLog);
}

/** 清空日志 */
export function clearLogs(): void {
  getDb().exec('DELETE FROM logs');
}

/** 聚合统计（可选限定最近 N 小时） */
export function logStats(recentHours?: number): {
  total: number;
  success: number;
  error: number;
  totalTokens: number;
  avgDurationMs: number;
} {
  const where = recentHours
    ? `WHERE time >= datetime('now', '-${Number(recentHours)} hours')`
    : '';

  const row = getDb()
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
         SUM(CASE WHEN status = 'error'   THEN 1 ELSE 0 END) AS error,
         SUM(total_tokens) AS tokens,
         AVG(duration_ms)  AS avg_ms
       FROM logs ${where}`,
    )
    .get() as {
    total: number;
    success: number | null;
    error: number | null;
    tokens: number | null;
    avg_ms: number | null;
  };

  return {
    total: row.total ?? 0,
    success: row.success ?? 0,
    error: row.error ?? 0,
    totalTokens: row.tokens ?? 0,
    avgDurationMs: Math.round(row.avg_ms ?? 0),
  };
}

/** 按天统计（用于图表） */
export function logDailyStats(days = 7): Array<{
  day: string;
  total: number;
  success: number;
  error: number;
  tokens: number;
}> {
  const rows = getDb()
    .prepare(
      `SELECT
         substr(time, 1, 10) AS day,
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
         SUM(CASE WHEN status = 'error'   THEN 1 ELSE 0 END) AS error,
         SUM(total_tokens) AS tokens
       FROM logs
       WHERE time >= datetime('now', '-${Number(days)} days')
       GROUP BY day
       ORDER BY day DESC`,
    )
    .all() as unknown as Array<{
    day: string;
    total: number;
    success: number | null;
    error: number | null;
    tokens: number | null;
  }>;

  return rows.map((r) => ({
    day: r.day,
    total: r.total,
    success: r.success ?? 0,
    error: r.error ?? 0,
    tokens: r.tokens ?? 0,
  }));
}

/** 按账号统计 */
export function logAccountStats(): Array<{
  accountId: string;
  alias: string | null;
  total: number;
  errors: number;
  tokens: number;
}> {
  const rows = getDb()
    .prepare(
      `SELECT
         account_id,
         MAX(account_alias) AS alias,
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
         SUM(total_tokens) AS tokens
       FROM logs
       GROUP BY account_id
       ORDER BY total DESC`,
    )
    .all() as unknown as Array<{
    account_id: string;
    alias: string | null;
    total: number;
    errors: number | null;
    tokens: number | null;
  }>;

  return rows.map((r) => ({
    accountId: r.account_id,
    alias: r.alias,
    total: r.total,
    errors: r.errors ?? 0,
    tokens: r.tokens ?? 0,
  }));
}
