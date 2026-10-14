/**
 * 账号管理：多账号存储 + 负载均衡
 *
 * 存储方式：SQLite（Node 24 内置 node:sqlite，无原生编译依赖）
 * 并发计数保存在内存中（进程级），其余字段持久化。
 */

import { randomUUID } from 'node:crypto';
import { getDb } from './db.ts';

export interface Account {
  id: string;
  /** 备注名 */
  alias: string | null;
  serviceToken: string;
  userId: string;
  phToken: string;
  /** 为该账号分配的 API Key（客户端用它鉴权） */
  apiKey: string;
  /** 是否启用 */
  isActive: boolean;
  /** 当前并发请求数（仅内存） */
  activeRequests: number;
  /** 累计请求数 */
  requestCount: number;
  /** 累计失败数 */
  errorCount: number;
  /** 最近一次错误信息 */
  lastError: string | null;
  /** 凭证过期时的重新登录地址（由上游返回） */
  loginUrl: string | null;

  /* ---- 健康检查 ---- */
  /** 在线状态：unknown | online | offline | expired */
  healthStatus: 'unknown' | 'online' | 'offline' | 'expired';
  /** 最近一次检查时间 */
  lastCheckedAt: string | null;
  /** 最近一次成功时间 */
  lastOkAt: string | null;
  /** 最近一次延迟（毫秒） */
  lastLatencyMs: number | null;
  /** 连续失败次数（成功会归零） */
  consecutiveFailures: number;
  /** 累计检查次数 */
  checkCount: number;
  /** 来源：manual（手动粘贴）| capture（浏览器抓取） */
  source: string;

  /**
   * 优先级：数字越小越优先。
   *
   * 主备模式下，代理固定使用优先级最高的可用账号，
   * 只有它不可用时才切换到下一个。
   */
  priority: number;

  createdAt: string;
  lastUsedAt: string | null;
}

/** 数据库行结构 */
interface AccountRow {
  id: string;
  alias: string | null;
  service_token: string;
  user_id: string;
  ph_token: string;
  api_key: string;
  is_active: number;
  request_count: number;
  error_count: number;
  last_error: string | null;
  login_url: string | null;
  health_status: string | null;
  last_checked_at: string | null;
  last_ok_at: string | null;
  last_latency_ms: number | null;
  consecutive_failures: number | null;
  check_count: number | null;
  source: string | null;
  priority: number | null;
  created_at: string;
  last_used_at: string | null;
}

/** 内存中的并发计数（进程级，不落库） */
const inflight = new Map<string, number>();

function rowToAccount(r: AccountRow): Account {
  const hs = (r.health_status ?? 'unknown') as Account['healthStatus'];
  return {
    id: r.id,
    alias: r.alias,
    serviceToken: r.service_token,
    userId: r.user_id,
    phToken: r.ph_token,
    apiKey: r.api_key,
    isActive: r.is_active === 1,
    activeRequests: inflight.get(r.id) ?? 0,
    requestCount: r.request_count,
    errorCount: r.error_count,
    lastError: r.last_error,
    loginUrl: r.login_url,
    healthStatus: ['unknown', 'online', 'offline', 'expired'].includes(hs)
      ? hs
      : 'unknown',
    lastCheckedAt: r.last_checked_at,
    lastOkAt: r.last_ok_at,
    lastLatencyMs: r.last_latency_ms,
    consecutiveFailures: r.consecutive_failures ?? 0,
    checkCount: r.check_count ?? 0,
    source: r.source ?? 'manual',
    priority: r.priority ?? 100,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  };
}

/** 初始化（进程启动时调用一次，建表由 db.ts 负责） */
export function initAccounts(): void {
  const n = (
    getDb().prepare('SELECT COUNT(*) AS c FROM accounts').get() as { c: number }
  ).c;
  console.log(`[账号] 已加载 ${n} 个账号`);
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                */
/* ------------------------------------------------------------------ */

export function listAccounts(): Account[] {
  const rows = getDb()
    .prepare(
      // 主备模式下这个顺序即「使用优先级」：靠前的先用
      'SELECT * FROM accounts ORDER BY priority ASC, created_at ASC',
    )
    .all() as unknown as AccountRow[];
  return rows.map(rowToAccount);
}

export function getAccountById(id: string): Account | undefined {
  const row = getDb()
    .prepare('SELECT * FROM accounts WHERE id = ?')
    .get(id) as unknown as AccountRow | undefined;
  return row ? rowToAccount(row) : undefined;
}

export function getAccountByApiKey(apiKey: string): Account | undefined {
  const row = getDb()
    .prepare('SELECT * FROM accounts WHERE api_key = ? AND is_active = 1')
    .get(apiKey) as unknown as AccountRow | undefined;
  return row ? rowToAccount(row) : undefined;
}

/**
 * 校验客户端 API Key 是否有效（**不考虑**上游账号的启用状态）。
 *
 * 客户端 Key 与上游 MiMo 账号的可用性是两件事：
 * 上游账号因凭证过期被自动停用时，客户端仍然持有合法的 Key，
 * 此时应返回「无可用账号(503)」而不是「Key 无效(401)」，
 * 否则会让 OpenAI 客户端误判为鉴权失败。
 */
export function isClientKeyValid(apiKey: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS ok FROM accounts WHERE api_key = ? LIMIT 1')
    .get(apiKey);
  return !!row;
}

export interface CreateAccountInput {
  serviceToken: string;
  userId: string;
  phToken: string;
  alias?: string;
  /** 来源标记：manual | capture */
  source?: string;
  /** 优先级：数字越小越优先（主备模式用），默认 100 */
  priority?: number;
}

/**
 * 计算新账号的优先级。
 *
 * 规则：取当前最大 priority + 10，让新账号**排到末尾**。
 * 这样「主账号」始终是你最早添加/手动指定的那个，
 * 新加的账号默认作为备用，符合主备模式的直觉。
 */
function nextPriority(): number {
  const row = getDb()
    .prepare('SELECT MAX(priority) AS mx FROM accounts')
    .get() as { mx: number | null };
  const mx = row.mx ?? 0;
  return mx + 10;
}

/** 创建账号，返回含生成的 API Key 的账号 */
export function createAccount(input: CreateAccountInput): Account {
  if (!input.serviceToken) {
    throw new Error('serviceToken 不能为空');
  }

  const now = new Date().toISOString();
  const account: Account = {
    id: randomUUID(),
    alias: input.alias?.trim() || null,
    serviceToken: input.serviceToken.trim(),
    userId: (input.userId ?? '').trim(),
    phToken: (input.phToken ?? '').trim(),
    apiKey: 'sk-mimo-' + randomUUID().replace(/-/g, ''),
    isActive: true,
    activeRequests: 0,
    requestCount: 0,
    errorCount: 0,
    lastError: null,
    loginUrl: null,
    healthStatus: 'unknown',
    lastCheckedAt: null,
    lastOkAt: null,
    lastLatencyMs: null,
    consecutiveFailures: 0,
    checkCount: 0,
    source: input.source ?? 'manual',
    // 未指定则排到末尾（作为备用账号）
    priority: input.priority ?? nextPriority(),
    createdAt: now,
    lastUsedAt: null,
  };

  getDb()
    .prepare(
      `INSERT INTO accounts
       (id, alias, service_token, user_id, ph_token, api_key, is_active,
        request_count, error_count, health_status, consecutive_failures,
        check_count, source, priority, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0, 'unknown', 0, 0, ?, ?, ?)`,
    )
    .run(
      account.id,
      account.alias,
      account.serviceToken,
      account.userId,
      account.phToken,
      account.apiKey,
      account.source,
      account.priority,
      account.createdAt,
    );

  return account;
}

/**
 * 按凭证查找账号（用于抓取时去重）。
 *
 * 同一小米账号重复抓取时，应更新凭证而不是新建重复条目。
 */
export function findByCredential(
  serviceToken: string,
  userId: string,
): Account | undefined {
  const row = getDb()
    .prepare(
      `SELECT * FROM accounts
       WHERE service_token = ? OR (user_id != '' AND user_id = ?)
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get(serviceToken, userId) as unknown as AccountRow | undefined;
  return row ? rowToAccount(row) : undefined;
}

/**
 * 更新账号凭证（重新登录后覆盖旧 token）。
 */
export function updateCredential(
  id: string,
  cred: { serviceToken: string; userId?: string; phToken?: string },
): Account | undefined {
  const existing = getAccountById(id);
  if (!existing) return undefined;

  getDb()
    .prepare(
      `UPDATE accounts SET
         service_token = ?,
         user_id = COALESCE(NULLIF(?, ''), user_id),
         ph_token = COALESCE(NULLIF(?, ''), ph_token),
         is_active = 1,
         last_error = NULL,
         login_url = NULL,
         health_status = 'unknown',
         consecutive_failures = 0
       WHERE id = ?`,
    )
    .run(
      cred.serviceToken.trim(),
      cred.userId?.trim() ?? '',
      cred.phToken?.trim() ?? '',
      id,
    );

  return getAccountById(id);
}

/**
 * 智能保存：同账号则更新凭证，否则新建。
 *
 * @returns { account, created } created=false 表示更新了已有账号
 */
export function upsertAccount(input: CreateAccountInput): {
  account: Account;
  created: boolean;
} {
  const found = findByCredential(input.serviceToken, input.userId ?? '');

  if (found) {
    const updated = updateCredential(found.id, {
      serviceToken: input.serviceToken,
      userId: input.userId,
      phToken: input.phToken,
    });
    return { account: updated ?? found, created: false };
  }

  return { account: createAccount(input), created: true };
}

export function updateAccount(
  id: string,
  patch: { alias?: string | null; isActive?: boolean; priority?: number },
): Account | undefined {
  const existing = getAccountById(id);
  if (!existing) return undefined;

  const sets: string[] = [];
  const vals: Array<string | number | null> = [];

  if (patch.alias !== undefined) {
    sets.push('alias = ?');
    vals.push(patch.alias?.trim() || null);
  }
  if (patch.isActive !== undefined) {
    sets.push('is_active = ?');
    vals.push(patch.isActive ? 1 : 0);
    // 手动启用时，清空连续失败计数，让它重新参与调度
    if (patch.isActive) {
      sets.push('consecutive_failures = 0');
      sets.push('health_status = ?');
      vals.push('unknown');
    }
  }
  if (patch.priority !== undefined) {
    sets.push('priority = ?');
    vals.push(Math.floor(patch.priority));
  }

  if (!sets.length) return existing;

  vals.push(id);
  getDb()
    .prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`)
    .run(...vals);

  return getAccountById(id);
}

/**
 * 调整账号顺序（主备模式下决定优先使用哪个）。
 *
 * 把所有账号按当前顺序重新编号（10, 20, 30...），
 * 并交换目标账号与相邻账号的位置。
 *
 * @param id        要移动的账号
 * @param direction 'up' 提高优先级 | 'down' 降低优先级
 */
export function moveAccountPriority(
  id: string,
  direction: 'up' | 'down',
): boolean {
  const list = listAccounts(); // 已按 priority, created_at 排序
  const idx = list.findIndex((a) => a.id === id);
  if (idx === -1) return false;

  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= list.length) return false;

  // 交换两个账号
  const arr = [...list];
  [arr[idx], arr[swapIdx]] = [arr[swapIdx], arr[idx]];

  // 重新编号（步长 10，便于以后插入）
  // 注意：node:sqlite 没有 better-sqlite3 的 transaction() 包装，用显式 BEGIN/COMMIT
  const db = getDb();
  const stmt = db.prepare('UPDATE accounts SET priority = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    arr.forEach((a, i) => stmt.run((i + 1) * 10, a.id));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return true;
}

/**
 * 把指定账号设为主账号（优先级最高）。
 */
export function setPrimaryAccount(id: string): boolean {
  const list = listAccounts();
  const target = list.find((a) => a.id === id);
  if (!target) return false;

  // 目标排最前，其余保持相对顺序
  const arr = [target, ...list.filter((a) => a.id !== id)];

  const db = getDb();
  const stmt = db.prepare('UPDATE accounts SET priority = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    arr.forEach((a, i) => stmt.run((i + 1) * 10, a.id));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return true;
}

export function deleteAccount(id: string): boolean {
  const r = getDb().prepare('DELETE FROM accounts WHERE id = ?').run(id);
  inflight.delete(id);
  return Number(r.changes) > 0;
}

/** 标记账号失效（上游返回鉴权错误时调用） */
export function markAccountInactive(
  id: string,
  reason?: string,
  loginUrl?: string,
): void {
  getDb()
    .prepare(
      'UPDATE accounts SET is_active = 0, last_error = COALESCE(?, last_error), ' +
        'login_url = COALESCE(?, login_url) WHERE id = ?',
    )
    .run(reason ?? null, loginUrl ?? null, id);

  const acc = getAccountById(id);
  if (acc) {
    console.warn(
      `[账号] 账号 ${acc.alias ?? acc.id.slice(0, 8)} 已标记为失效` +
        (loginUrl ? '（需重新登录）' : ''),
    );
  }
}

/* ------------------------------------------------------------------ */
/* 账号选择：主备模式（failover）                                       */
/* ------------------------------------------------------------------ */

/** 单账号最大并发（可通过环境变量覆盖） */
const MAX_CONCURRENT = Number(process.env.MIMO_MAX_CONCURRENT ?? 4);

/**
 * 选择模式：
 *   primary（默认）—— 主备模式：固定优先使用优先级最高的账号，
 *                     只有它不可用时（停用/并发满/连续失败）才切到下一个
 *   balance         —— 负载均衡：选并发数最少的账号，请求分散到各账号
 */
type SelectMode = 'primary' | 'balance';

function getSelectMode(): SelectMode {
  const m = (process.env.MIMO_SELECT_MODE ?? 'primary').toLowerCase();
  return m === 'balance' ? 'balance' : 'primary';
}

/**
 * 账号可用性判断。
 *
 * 以下情况视为**不可用**，需要切换到备用账号：
 *   - is_active = 0（被停用，通常是凭证过期）
 *   - ph_token 为空（凭证不完整）
 *   - 并发数已达上限
 *   - 健康状态为 expired（凭证明确失效）
 */
function isUsable(a: Account): boolean {
  if (!a.isActive) return false;
  if (!a.phToken) return false;
  if (a.healthStatus === 'expired') return false;
  if ((inflight.get(a.id) ?? 0) >= MAX_CONCURRENT) return false;
  return true;
}

/**
 * 选取一个可用账号并占用一个并发位。
 *
 * **主备模式（默认）**：
 *   按 priority 升序（数字小的优先）→ created_at 升序（先添加的优先）
 *   取第一个可用账号。只有它不可用时才用下一个。
 *
 * **负载均衡模式**（MIMO_SELECT_MODE=balance）：
 *   选并发数最少、累计请求最少的账号。
 *
 * Node 单线程执行，因此选取+占用并发位的过程是原子的。
 */
export function acquireAccount(): Account | null {
  const mode = getSelectMode();

  const rows = getDb()
    .prepare(
      `SELECT * FROM accounts
       WHERE is_active = 1 AND ph_token != ''
       ORDER BY priority ASC, created_at ASC`,
    )
    .all() as unknown as AccountRow[];

  if (!rows.length) return null;

  const all = rows.map(rowToAccount);
  const usable = all.filter(isUsable);

  if (!usable.length) {
    // 全部不可用：区分原因便于上层给出准确提示
    const busy = all.filter((a) => (inflight.get(a.id) ?? 0) >= MAX_CONCURRENT);
    if (busy.length === all.length) {
      console.warn(`[账号] 全部 ${all.length} 个账号均已达并发上限`);
    }
    return null;
  }

  let chosen: Account;

  if (mode === 'primary') {
    // 主备：直接取优先级最高的可用账号
    chosen = usable[0];

    // 记录发生了故障转移（便于排查）
    const primary = all[0];
    if (primary && primary.id !== chosen.id) {
      const reason = !primary.isActive
        ? '已停用'
        : primary.healthStatus === 'expired'
          ? '凭证过期'
          : !primary.phToken
            ? '凭证不完整'
            : '并发已满';
      console.log(
        `[账号] 主账号 ${primary.alias ?? primary.id.slice(0, 8)} 不可用（${reason}），` +
          `切换到 ${chosen.alias ?? chosen.id.slice(0, 8)}`,
      );
    }
  } else {
    // 负载均衡：并发最少 → 请求最少
    usable.sort((x, y) => {
      const cx = inflight.get(x.id) ?? 0;
      const cy = inflight.get(y.id) ?? 0;
      if (cx !== cy) return cx - cy;
      return x.requestCount - y.requestCount;
    });
    chosen = usable[0];
  }

  const next = (inflight.get(chosen.id) ?? 0) + 1;
  inflight.set(chosen.id, next);

  const now = new Date().toISOString();
  getDb()
    .prepare(
      'UPDATE accounts SET request_count = request_count + 1, last_used_at = ? WHERE id = ?',
    )
    .run(now, chosen.id);

  return { ...chosen, activeRequests: next, requestCount: chosen.requestCount + 1 };
}

/** 释放并发位（必须在 finally 中调用） */
export function releaseAccount(id: string): void {
  const cur = inflight.get(id) ?? 0;
  if (cur <= 1) inflight.delete(id);
  else inflight.set(id, cur - 1);
}

/** 记录一次失败 */
export function recordAccountError(id: string, error?: string): void {
  getDb()
    .prepare(
      'UPDATE accounts SET error_count = error_count + 1, ' +
        'last_error = COALESCE(?, last_error) WHERE id = ?',
    )
    .run(error ? error.slice(0, 300) : null, id);
}

/* ------------------------------------------------------------------ */
/* 健康检查                                                            */
/* ------------------------------------------------------------------ */

export interface HealthResult {
  ok: boolean;
  /** online | offline | expired */
  status: 'online' | 'offline' | 'expired';
  latencyMs: number;
  error?: string;
  loginUrl?: string;
  /** 上游返回的账号信息（可用于校验 user_id 是否匹配） */
  userId?: string;
}

/**
 * 记录一次健康检查结果。
 *
 * 成功的判定：healthStatus 置为 online，连续失败清零，刷新 lastOkAt；
 * 失败：累加连续失败次数。连续失败达到阈值时可自动停用（由调用方决定）。
 */
export function recordHealthCheck(accountId: string, result: HealthResult): void {
  const now = new Date().toISOString();
  const db = getDb();

  // 写入检查历史
  try {
    db.prepare(
      `INSERT INTO health_checks (account_id, time, ok, latency_ms, status, error)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      accountId,
      now,
      result.ok ? 1 : 0,
      result.latencyMs,
      result.status,
      result.error?.slice(0, 300) ?? null,
    );
  } catch (err) {
    console.warn('[健康检查] 写入历史失败:', err);
  }

  if (result.ok) {
    db.prepare(
      `UPDATE accounts SET
         health_status = 'online',
         last_checked_at = ?,
         last_ok_at = ?,
         last_latency_ms = ?,
         consecutive_failures = 0,
         check_count = check_count + 1,
         last_error = NULL,
         login_url = NULL
       WHERE id = ?`,
    ).run(now, now, result.latencyMs, accountId);
  } else {
    db.prepare(
      `UPDATE accounts SET
         health_status = ?,
         last_checked_at = ?,
         last_latency_ms = ?,
         consecutive_failures = consecutive_failures + 1,
         check_count = check_count + 1,
         last_error = COALESCE(?, last_error),
         login_url = COALESCE(?, login_url)
       WHERE id = ?`,
    ).run(
      result.status,
      now,
      result.latencyMs,
      result.error?.slice(0, 300) ?? null,
      result.loginUrl ?? null,
      accountId,
    );
  }
}

/**
 * 根据连续失败次数决定是否自动停用账号。
 *
 * @param threshold 连续失败达到该次数即停用（0 表示不停用）
 * @returns 是否已停用
 */
export function autoDisableIfUnhealthy(
  accountId: string,
  threshold: number,
): boolean {
  if (threshold <= 0) return false;

  const acc = getAccountById(accountId);
  if (!acc) return false;
  if (acc.consecutiveFailures < threshold) return false;
  if (!acc.isActive) return true; // 已停用

  getDb()
    .prepare(
      `UPDATE accounts SET is_active = 0,
         last_error = COALESCE(last_error, '连续健康检查失败，已自动停用')
       WHERE id = ?`,
    )
    .run(accountId);

  console.warn(
    `[健康检查] 账号 ${acc.alias ?? acc.id.slice(0, 8)} 连续失败 ${acc.consecutiveFailures} 次，已自动停用`,
  );
  return true;
}

/** 查询某账号最近若干次检查记录 */
export function listHealthChecks(
  accountId: string,
  limit = 20,
): Array<{
  time: string;
  ok: boolean;
  latencyMs: number;
  status: string | null;
  error: string | null;
}> {
  const rows = getDb()
    .prepare(
      `SELECT time, ok, latency_ms, status, error FROM health_checks
       WHERE account_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(accountId, limit) as unknown as Array<{
    time: string;
    ok: number;
    latency_ms: number;
    status: string | null;
    error: string | null;
  }>;

  return rows.map((r) => ({
    time: r.time,
    ok: r.ok === 1,
    latencyMs: r.latency_ms,
    status: r.status,
    error: r.error,
  }));
}

/** 清理过期的检查历史（保留最近 N 天） */
export function pruneHealthChecks(days = 7): number {
  const r = getDb()
    .prepare(
      `DELETE FROM health_checks
       WHERE time < datetime('now', '-${Number(days)} days')`,
    )
    .run();
  return Number(r.changes);
}

/** 健康状态汇总 */
export function healthSummary() {
  const row = getDb()
    .prepare(
      `SELECT
         SUM(CASE WHEN health_status = 'online'  THEN 1 ELSE 0 END) AS online,
         SUM(CASE WHEN health_status = 'offline' THEN 1 ELSE 0 END) AS offline,
         SUM(CASE WHEN health_status = 'expired' THEN 1 ELSE 0 END) AS expired,
         SUM(CASE WHEN health_status = 'unknown' OR health_status IS NULL
                  THEN 1 ELSE 0 END) AS unknown
       FROM accounts`,
    )
    .get() as {
    online: number | null;
    offline: number | null;
    expired: number | null;
    unknown: number | null;
  };

  return {
    online: row.online ?? 0,
    offline: row.offline ?? 0,
    expired: row.expired ?? 0,
    unknown: row.unknown ?? 0,
  };
}

/** 统计信息 */
export function accountStats() {
  const row = getDb()
    .prepare(
      `SELECT
         COUNT(*)                              AS total,
         SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active,
         SUM(request_count)                    AS total_requests,
         SUM(error_count)                      AS total_errors
       FROM accounts`,
    )
    .get() as {
    total: number;
    active: number | null;
    total_requests: number | null;
    total_errors: number | null;
  };

  let inFlight = 0;
  for (const v of inflight.values()) inFlight += v;

  return {
    total: row.total ?? 0,
    active: row.active ?? 0,
    totalRequests: row.total_requests ?? 0,
    totalErrors: row.total_errors ?? 0,
    inFlight,
    maxConcurrentPerAccount: MAX_CONCURRENT,
    health: healthSummary(),
  };
}

/* ------------------------------------------------------------------ */
/* cURL / 凭证解析                                                     */
/* ------------------------------------------------------------------ */

export interface ParsedCredential {
  serviceToken: string;
  userId: string;
  phToken: string;
}

export interface ParseResult {
  ok: boolean;
  data?: ParsedCredential;
  error?: string;
}

/**
 * 从 cURL 命令或裸 Cookie 字符串中解析凭证。
 *
 * 支持格式：
 *   - curl '...' -H 'Cookie: serviceToken=...; userId=...'
 *   - curl '...' -b 'serviceToken=...'
 *   - 直接粘贴含 serviceToken= 的 Cookie 字符串
 */
export function parseCredential(input: string): ParseResult {
  if (!input || !input.trim()) {
    return { ok: false, error: '请粘贴 cURL 命令或凭证' };
  }

  const text = input.trim();

  // 1. 提取 Cookie
  const cookieMatch =
    text.match(/-H\s+'[Cc]ookie:\s*([^']+)'/i) ??
    text.match(/-H\s+"[Cc]ookie:\s*([^"]+)"/i) ??
    text.match(/-H\s+[Cc]ookie:\s*([^\r\n\\]+)/i);

  const cookieFlag =
    text.match(/(?:-b|--cookie)\s+'([^']+)'/) ??
    text.match(/(?:-b|--cookie)\s+"([^"]+)"/) ??
    text.match(/(?:-b|--cookie)\s+([^\s\r\n]+)/);

  let cookies: string | null = cookieMatch?.[1] ?? cookieFlag?.[1] ?? null;

  // 裸 Cookie 字符串
  if (!cookies && text.includes('serviceToken=') && !text.startsWith('curl')) {
    cookies = text;
  }

  // 2. 提取 ph_token：优先 Cookie，其次 URL query
  let phToken = cookies?.match(/xiaomichatbot_ph=["']?([^"';\s]+)["']?/)?.[1];
  if (!phToken) {
    const urlPh = text.match(/[?&]xiaomichatbot_ph=([^&'"\s\\]+)/);
    if (urlPh) {
      try {
        phToken = decodeURIComponent(urlPh[1]);
      } catch {
        phToken = urlPh[1];
      }
    }
  }

  if (!cookies) {
    return {
      ok: false,
      error:
        '未找到 Cookie。注意：Chrome 130+ 在 "Copy as cURL" 时默认剥离 Cookie。' +
        '请在 DevTools → 设置(⚙️) → Preferences 中勾选 ' +
        '「Allow to generate HAR with sensitive data」后重新复制，或改用「一键自动抓取」。',
    };
  }

  const st = cookies.match(/serviceToken=["']?([^"';\s]+)["']?/);
  if (!st) {
    return {
      ok: false,
      error:
        'Cookie 中未找到 serviceToken。请确认已在 aistudio.xiaomimimo.com 登录小米账号。',
    };
  }

  const uid = cookies.match(/userId=["']?([^"';\s]+)["']?/);

  return {
    ok: true,
    data: {
      serviceToken: st[1],
      userId: uid?.[1] ?? '',
      phToken: phToken ?? '',
    },
  };
}
