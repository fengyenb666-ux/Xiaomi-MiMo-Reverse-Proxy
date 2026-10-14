/**
 * 账号健康检查轮询
 *
 * 目的：主动探测账号是否仍可用，避免「请求时才发现凭证过期」。
 *
 * 探测方式：调用上游的账号信息接口
 *   GET /open-apis/user/mi/get
 * 该接口返回当前登录用户信息，能直接反映 serviceToken 是否有效。
 *
 * 检查结果写入数据库（health_checks 表 + accounts 表的状态字段），
 * 前端可据此展示在线/离线/过期状态。
 */

import { getDb } from './db.ts';
import {
  autoDisableIfUnhealthy,
  listAccounts,
  recordHealthCheck,
  type Account,
  type HealthResult,
} from './accounts.ts';

const BASE_URL = 'https://aistudio.xiaomimimo.com';
const USER_INFO_URL = `${BASE_URL}/open-apis/user/mi/get`;

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 轮询配置 */
export interface HealthConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 轮询间隔（秒） */
  intervalSec: number;
  /** 单次请求超时（毫秒） */
  timeoutMs: number;
  /** 连续失败多少次自动停用（0=不停用） */
  autoDisableAfter: number;
  /** 每次检查的账号数量上限（避免一次性打太多请求） */
  batchSize: number;
}

const SETTINGS_KEY = 'health_config';

const DEFAULT_CONFIG: HealthConfig = {
  enabled: true,
  intervalSec: 300, // 5 分钟
  timeoutMs: 15000,
  autoDisableAfter: 3,
  batchSize: 5,
};

let config: HealthConfig = { ...DEFAULT_CONFIG };
let timer: NodeJS.Timeout | null = null;
let running = false;
let lastRunAt: string | null = null;
let lastRunResult: { checked: number; ok: number; failed: number } | null = null;

/* ------------------------------------------------------------------ */
/* 配置读写                                                            */
/* ------------------------------------------------------------------ */

export function loadHealthConfig(): HealthConfig {
  try {
    const row = getDb()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(SETTINGS_KEY) as { value: string } | undefined;
    if (row?.value) {
      config = { ...DEFAULT_CONFIG, ...(JSON.parse(row.value) as HealthConfig) };
    }
  } catch (err) {
    console.warn('[健康检查] 读取配置失败，使用默认值:', err);
  }
  return config;
}

export function saveHealthConfig(patch: Partial<HealthConfig>): HealthConfig {
  config = { ...config, ...patch };
  try {
    getDb()
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(SETTINGS_KEY, JSON.stringify(config));
  } catch (err) {
    console.warn('[健康检查] 保存配置失败:', err);
  }
  return config;
}

export function getHealthConfig(): HealthConfig {
  return { ...config };
}

export function getHealthRuntime() {
  return {
    running,
    enabled: config.enabled,
    intervalSec: config.intervalSec,
    lastRunAt,
    lastRunResult,
    nextRunInSec: running ? null : null,
  };
}

/* ------------------------------------------------------------------ */
/* 单个账号探测                                                        */
/* ------------------------------------------------------------------ */

/**
 * 探测单个账号是否在线。
 *
 * 依据上游 /open-apis/user/mi/get 的返回：
 *   - HTTP 200 + code 0      → 在线
 *   - HTTP 401/403 或登录跳转 → 凭证过期
 *   - 网络错误/超时           → 离线（不确定，可能是本机网络问题）
 */
export async function checkAccount(
  account: Account,
  opts: { timeoutMs?: number; proxy?: string } = {},
): Promise<HealthResult> {
  const timeout = opts.timeoutMs ?? config.timeoutMs;
  const started = Date.now();

  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), timeout);

  try {
    const headers: Record<string, string> = {
      Accept: '*/*',
      'Content-Type': 'application/json',
      Origin: BASE_URL,
      Referer: `${BASE_URL}/`,
      'User-Agent': DEFAULT_UA,
      'x-timezone': 'Asia/Shanghai',
      Cookie: [
        `serviceToken=${account.serviceToken}`,
        `userId=${account.userId}`,
        `xiaomichatbot_ph=${account.phToken}`,
      ].join('; '),
    };

    const resp = await fetch(USER_INFO_URL, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    const latencyMs = Date.now() - started;
    const text = await resp.text().catch(() => '');

    // 鉴权失败
    if (resp.status === 401 || resp.status === 403) {
      let loginUrl: string | undefined;
      try {
        const j = JSON.parse(text) as { loginUrl?: string };
        loginUrl = j.loginUrl;
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        status: 'expired',
        latencyMs,
        error: `HTTP ${resp.status}：凭证已过期`,
        loginUrl,
      };
    }

    if (!resp.ok) {
      return {
        ok: false,
        status: 'offline',
        latencyMs,
        error: `HTTP ${resp.status} ${resp.statusText}`,
      };
    }

    // 解析业务响应
    let json: {
      code?: number;
      msg?: string;
      data?: { userId?: string | number; miId?: string; nickname?: string };
    };
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      // 无法解析但 HTTP 200，视为在线（接口形态可能变化）
      return { ok: true, status: 'online', latencyMs };
    }

    if (json.code === 0) {
      return {
        ok: true,
        status: 'online',
        latencyMs,
        userId: json.data?.userId != null ? String(json.data.userId) : undefined,
      };
    }

    // code 非 0：可能是未登录
    if (json.code === 401 || json.code === 403) {
      return {
        ok: false,
        status: 'expired',
        latencyMs,
        error: `code=${json.code} ${json.msg ?? ''}`.trim(),
      };
    }

    return {
      ok: false,
      status: 'offline',
      latencyMs,
      error: `code=${json.code} ${json.msg ?? ''}`.trim(),
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.includes('abort') || msg.includes('timeout');
    return {
      ok: false,
      status: 'offline',
      latencyMs,
      error: isTimeout ? `超时（${timeout}ms）` : msg,
    };
  } finally {
    clearTimeout(timerId);
  }
}

/* ------------------------------------------------------------------ */
/* 批量检查                                                            */
/* ------------------------------------------------------------------ */

export interface CheckAllResult {
  checked: number;
  ok: number;
  failed: number;
  disabled: number;
  details: Array<{
    id: string;
    alias: string | null;
    ok: boolean;
    status: string;
    latencyMs: number;
    error?: string;
  }>;
}

/**
 * 检查全部（或指定）账号。
 *
 * @param ids        只检查这些账号（为空则检查全部）
 * @param includeInactive 是否也检查已停用的账号（默认检查，便于发现可恢复的）
 */
export async function checkAllAccounts(
  ids?: string[],
  includeInactive = true,
): Promise<CheckAllResult> {
  const all = listAccounts().filter((a) => (includeInactive ? true : a.isActive));
  const targets = ids?.length ? all.filter((a) => ids.includes(a.id)) : all;

  const result: CheckAllResult = {
    checked: 0,
    ok: 0,
    failed: 0,
    disabled: 0,
    details: [],
  };

  // 分批并发，避免瞬时打太多请求
  for (let i = 0; i < targets.length; i += config.batchSize) {
    const batch = targets.slice(i, i + config.batchSize);

    const settled = await Promise.all(
      batch.map(async (acc) => {
        const r = await checkAccount(acc);
        return { acc, r };
      }),
    );

    for (const { acc, r } of settled) {
      recordHealthCheck(acc.id, r);
      result.checked++;
      if (r.ok) {
        result.ok++;
      } else {
        result.failed++;
        if (autoDisableIfUnhealthy(acc.id, config.autoDisableAfter)) {
          result.disabled++;
        }
      }
      result.details.push({
        id: acc.id,
        alias: acc.alias,
        ok: r.ok,
        status: r.status,
        latencyMs: r.latencyMs,
        error: r.error,
      });
    }
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* 轮询调度                                                            */
/* ------------------------------------------------------------------ */

async function tick(): Promise<void> {
  if (running) return; // 上一轮还没结束
  running = true;
  try {
    console.log('[健康检查] 开始轮询...');
    const r = await checkAllAccounts();
    lastRunAt = new Date().toISOString();
    lastRunResult = { checked: r.checked, ok: r.ok, failed: r.failed };
    console.log(
      `[健康检查] 完成：检查 ${r.checked}，在线 ${r.ok}，异常 ${r.failed}` +
        (r.disabled ? `，自动停用 ${r.disabled}` : ''),
    );
  } catch (err) {
    console.error('[健康检查] 轮询异常:', err);
  } finally {
    running = false;
  }
}

/** 启动定时轮询 */
export function startHealthPolling(): void {
  stopHealthPolling();

  if (!config.enabled) {
    console.log('[健康检查] 已禁用，不启动轮询');
    return;
  }

  const intervalMs = Math.max(30, config.intervalSec) * 1000;
  console.log(
    `[健康检查] 轮询已启动，间隔 ${config.intervalSec} 秒` +
      (config.autoDisableAfter > 0
        ? `，连续失败 ${config.autoDisableAfter} 次自动停用`
        : ''),
  );

  // 启动后延迟 20 秒做首轮，避开启动高峰
  setTimeout(() => {
    void tick();
    timer = setInterval(() => void tick(), intervalMs);
  }, 20000);
}

export function stopHealthPolling(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** 重启轮询（配置变更后调用） */
export function restartHealthPolling(): void {
  stopHealthPolling();
  startHealthPolling();
}

/** 立即执行一次（手动触发） */
export async function runHealthCheckNow(
  ids?: string[],
): Promise<CheckAllResult> {
  const r = await checkAllAccounts(ids);
  lastRunAt = new Date().toISOString();
  lastRunResult = { checked: r.checked, ok: r.ok, failed: r.failed };
  return r;
}
