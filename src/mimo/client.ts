/**
 * MiMo 网页版客户端
 *
 * 负责与 aistudio.xiaomimimo.com 通信：
 *  - 抓取模型型号列表（bot/config）
 *  - 发起对话并解析 SSE 流（bot/chat）
 *
 * 协议细节见 docs/协议逆向报告.md
 */

import { randomUUID } from 'node:crypto';
import type { Account } from '../accounts.ts';

/** MiMo 上游错误（含 HTTP 状态与登录跳转地址） */
export class MimoError extends Error {
  status: number;
  /** 上游返回的重新登录地址（凭证过期时提供） */
  loginUrl?: string;

  constructor(message: string, status: number, loginUrl?: string) {
    super(message);
    this.name = 'MimoError';
    this.status = status;
    this.loginUrl = loginUrl;
  }

  /** 是否为鉴权类错误（需要禁用账号并重新登录） */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}
/** 上游基础地址 */
const BASE_URL = 'https://aistudio.xiaomimimo.com';
const CONFIG_URL = `${BASE_URL}/open-apis/bot/config`;
const CHAT_URL = `${BASE_URL}/open-apis/bot/chat`;

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------ */
/* 代理处理                                                            */
/* ------------------------------------------------------------------ */

/**
 * 构造 fetch 选项，显式处理代理。
 *
 * 【重要】实测发现：本机 HTTP_PROXY 指向一个未运行的代理（127.0.0.1:12334），
 * 若盲目继承系统代理会导致连接失败。因此这里**不继承**环境变量，
 * 只有显式配置 proxy 时才启用代理。
 *
 * 代理实现使用 undici 的 ProxyAgent。undici 在 Node 18+ 中可通过
 * `node:undici` 之外的方式获取：优先尝试动态 import('undici')，
 * 失败则回退到 Node 内置的 undici（通过 globalThis 暴露的 dispatcher）。
 */
let cachedDispatcher: unknown = null;
let cachedProxyUrl = '';

async function buildFetchOptions(proxy?: string): Promise<RequestInit> {
  if (!proxy) return {};

  if (cachedDispatcher && cachedProxyUrl === proxy) {
    return { dispatcher: cachedDispatcher } as unknown as RequestInit;
  }

  try {
    // Node 内置 undici 的 ProxyAgent（Node 20+ 可通过 undici 包名解析到内置版本）
    const undici = (await import('undici')) as unknown as {
      ProxyAgent: new (url: string) => unknown;
    };
    cachedDispatcher = new undici.ProxyAgent(proxy);
    cachedProxyUrl = proxy;
    return { dispatcher: cachedDispatcher } as unknown as RequestInit;
  } catch {
    console.warn(
      `[MiMo] 无法加载代理模块（undici 不可用），本次请求将直连。代理配置: ${proxy}`,
    );
    return {};
  }
}

/* ------------------------------------------------------------------ */
/* 模型配置抓取                                                        */
/* ------------------------------------------------------------------ */

/** modelConfigListNg 中的条目 */
export interface ModelEntry {
  /** 模型 ID，如 mimo-v2.6-pro */
  model: string;
  /** 展示名 */
  name: string;
  /** 场景类型：chat / tts / tts-vd / tts-vc / asr */
  pageType?: string;
  /** 别名跳转目标：该模型已废弃，实际会走这里 */
  redirectTo?: string;
  /** 是否为最新模型 */
  isNew?: boolean;
  /** 其他元信息 */
  [key: string]: unknown;
}

interface BotConfigData {
  /** 旧版模型列表（15 项），含 temperature/topP 等参数 */
  modelConfigList?: ModelEntry[];
  /** 新版模型列表（24 项），含 pageType/redirectTo ★ 优先使用 */
  modelConfigListNg?: ModelEntry[];
  ext?: Record<string, unknown>;
  [key: string]: unknown;
}

interface BotConfigResponse {
  code: number;
  msg: string;
  data?: BotConfigData;
}

interface CacheEntry {
  data: BotConfigData;
  time: number;
}

/** 模型配置缓存（5 分钟 TTL） */
let configCache: CacheEntry | null = null;
const CONFIG_TTL_MS = 5 * 60 * 1000;

/**
 * 抓取上游模型配置。
 *
 * 该接口无需登录即可访问 [实测]。
 *
 * @param proxy  可选的代理地址
 * @param force  强制刷新，忽略缓存
 */
export async function fetchBotConfig(
  proxy?: string,
  force = false,
): Promise<BotConfigData> {
  const now = Date.now();
  if (!force && configCache && now - configCache.time < CONFIG_TTL_MS) {
    return configCache.data;
  }

  const fetchOpts = await buildFetchOptions(proxy);
  const maxAttempts = 3;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await fetch(CONFIG_URL, {
        method: 'GET',
        headers: {
          Accept: '*/*',
          'Content-Type': 'application/json',
          Origin: BASE_URL,
          Referer: `${BASE_URL}/`,
          'User-Agent': DEFAULT_UA,
        },
        ...fetchOpts,
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      }

      const json = (await resp.json()) as BotConfigResponse;
      if (json.code !== 0 || !json.data) {
        throw new Error(`上游返回错误: code=${json.code} msg=${json.msg}`);
      }

      configCache = { data: json.data, time: now };
      return json.data;
    } catch (err) {
      lastErr = err;
      console.warn(
        `[MiMo] 抓取模型配置失败 (第 ${attempt}/${maxAttempts} 次):`,
        err instanceof Error ? err.message : err,
      );
      if (attempt < maxAttempts) {
        await sleep(1000 * attempt);
      }
    }
  }

  // 全部失败时回退到旧缓存（若有）
  if (configCache) {
    console.warn('[MiMo] 使用过期缓存中的模型配置');
    return configCache.data;
  }

  throw lastErr instanceof Error ? lastErr : new Error('抓取模型配置失败');
}

/**
 * 提取全部 chat 类模型。
 *
 * 优先读 modelConfigListNg，缺失时回退 modelConfigList，
 * 最后回退到内置静态列表。
 */
export async function fetchChatModels(proxy?: string): Promise<ModelEntry[]> {
  try {
    const cfg = await fetchBotConfig(proxy);
    const source = cfg.modelConfigListNg?.length
      ? cfg.modelConfigListNg
      : cfg.modelConfigList;

    if (!source?.length) return FALLBACK_MODELS;

    const chatModels = source.filter((m) => m.pageType === 'chat' || !m.pageType);

    // 合并 modelConfigList 中的附加参数（temperature/topP/nParam 等）
    const enriched = new Map<string, ModelEntry>();
    for (const m of chatModels) enriched.set(m.model, { ...m });
    for (const m of cfg.modelConfigList ?? []) {
      const hit = enriched.get(m.model);
      if (hit) enriched.set(m.model, { ...m, ...hit });
    }

    const result = [...enriched.values()];
    return result.length ? result : FALLBACK_MODELS;
  } catch (err) {
    console.warn('[MiMo] 抓取模型列表失败，使用内置兜底列表');
    return FALLBACK_MODELS;
  }
}

/**
 * 解析模型别名。
 *
 * redirectTo 表示该模型已废弃并自动升级，转发前必须解析 [推断]。
 * 例如 mimo-v2-pro → mimo-v2.6-pro
 */
export async function resolveModel(
  requested: string,
  proxy?: string,
): Promise<string> {
  if (!requested) return DEFAULT_MODEL;
  try {
    const models = await fetchChatModels(proxy);
    const hit = models.find((m) => m.model === requested);
    if (hit) return hit.redirectTo ?? hit.model;

    // 未找到：检查是否本身是合法目标
    const isTarget = models.some((m) => m.model === requested);
    if (isTarget) return requested;
  } catch {
    /* 忽略，走兜底 */
  }
  return requested || DEFAULT_MODEL;
}

/** 内置兜底模型列表（上游不可用时使用）[实测 2026-10-15] */
export const FALLBACK_MODELS: ModelEntry[] = [
  { model: 'mimo-v2.6-pro', name: 'MiMo-V2.6-Pro', pageType: 'chat', isNew: true },
  { model: 'mimo-v2.6-flash', name: 'MiMo-V2.6-Flash', pageType: 'chat', isNew: true },
  { model: 'mimo-v2-pro', name: 'MiMo-V2-Pro', pageType: 'chat', redirectTo: 'mimo-v2.6-pro' },
  { model: 'mimo-v2-flash', name: 'MiMo-V2-Flash', pageType: 'chat', redirectTo: 'mimo-v2.6-flash' },
  { model: 'mimo-v2-omni', name: 'MiMo-V2-Omni', pageType: 'chat', redirectTo: 'mimo-v2.6-flash' },
  { model: 'mimo-v2.5', name: 'MiMo-V2.5', pageType: 'chat', redirectTo: 'mimo-v2.6-flash' },
  { model: 'mimo-v2.5-pro', name: 'MiMo-V2.5-Pro', pageType: 'chat', redirectTo: 'mimo-v2.6-pro' },
  { model: 'mimo-v2.1-pro', name: 'MiMo-V2.1-Pro', pageType: 'chat', redirectTo: 'mimo-v2.6-pro' },
  { model: 'mimo-v2.1-omni', name: 'MiMo-V2.1-Omni', pageType: 'chat', redirectTo: 'mimo-v2.6-flash' },
];

export const DEFAULT_MODEL = 'mimo-v2.6-pro';

/* ------------------------------------------------------------------ */
/* 对话流                                                              */
/* ------------------------------------------------------------------ */

export interface MimoUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
}

export type MimoChunk =
  | { type: 'text'; content: string }
  | { type: 'usage'; usage: MimoUsage }
  | { type: 'dialogId'; content: string }
  | { type: 'finish' };

export interface ChatOptions {
  /** 模型 ID（应已解析 redirectTo） */
  model?: string;
  /** 是否开启思考链 */
  enableThinking?: boolean;
  /** 联网搜索状态 */
  webSearchStatus?: 'auto' | 'disabled';
  /** 代理地址 */
  proxy?: string;
}

/**
 * 调用 MiMo 对话接口，产出 SSE 事件流。
 *
 * @param account        使用的账号
 * @param conversationId 会话 ID（复用可保持上下文）
 * @param query          序列化后的对话文本
 * @param options        模型/思考等选项
 */
export async function* callMimo(
  account: Account,
  conversationId: string,
  query: string,
  options: ChatOptions = {},
): AsyncGenerator<MimoChunk> {
  const {
    model = DEFAULT_MODEL,
    enableThinking = true,
    webSearchStatus = 'disabled',
    proxy,
  } = options;

  const body = {
    msgId: randomUUID().replace(/-/g, ''),
    conversationId,
    query,
    modelConfig: { model, enableThinking, webSearchStatus },
    multiMedias: [] as unknown[],
  };

  const url = `${CHAT_URL}?xiaomichatbot_ph=${encodeURIComponent(account.phToken)}`;
  const fetchOpts = await buildFetchOptions(proxy);

  // Cookie 中保留多种写法，最大化兼容上游前端行为 [源码]
  const cookie = [
    `serviceToken=${account.serviceToken}`,
    `xiaomichatbot_serviceToken="${account.serviceToken}"`,
    `xiaomichatbot_serviceToken=${account.serviceToken}`,
    `userId=${account.userId}`,
    `xiaomichatbot_ph="${account.phToken}"`,
    `xiaomichatbot_ph=${account.phToken}`,
  ].join('; ');

  const maxAttempts = 3;
  let resp: Response | null = null;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          Origin: BASE_URL,
          Referer: `${BASE_URL}/`,
          'User-Agent': DEFAULT_UA,
          'x-timezone': 'Asia/Shanghai',
        },
        body: JSON.stringify(body),
        ...fetchOpts,
      });

      if (!resp.ok) {
        let errBody = '';
        try {
          errBody = await resp.text();
        } catch {
          /* ignore */
        }

        // 上游在凭证过期时会返回 loginUrl，解析出来供上层提示用户重新登录
        let loginUrl: string | undefined;
        try {
          const parsed = JSON.parse(errBody) as { loginUrl?: string };
          loginUrl = parsed.loginUrl;
        } catch {
          /* 非 JSON，忽略 */
        }

        throw new MimoError(
          `MiMo 返回 ${resp.status}: ${errBody.slice(0, 500)}`,
          resp.status,
          loginUrl,
        );
      }
      break;
    } catch (err) {
      lastErr = err;
      // 鉴权类错误不重试，直接抛出交由上层禁用账号
      if (err instanceof MimoError && err.isAuthError) throw err;

      console.warn(
        `[MiMo] 对话请求失败 (第 ${attempt}/${maxAttempts} 次):`,
        err instanceof Error ? err.message : err,
      );
      if (attempt < maxAttempts) await sleep(1000 * attempt);
    }
  }

  if (!resp || !resp.ok) {
    throw lastErr instanceof Error ? lastErr : new MimoError('MiMo 对话请求失败', 502);
  }
  if (!resp.body) throw new Error('MiMo 响应无 body');

  yield* parseSSE(resp.body);
}

/**
 * 解析 MiMo 的 SSE 流。
 *
 * 格式：event: <类型>\ndata: <JSON>\n
 * 事件类型：message / usage / dialogId / finish
 */
async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<MimoChunk> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // 按行处理，保留最后不完整的一行
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
          continue;
        }

        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let data: Record<string, unknown>;
        try {
          data = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          // 分片导致的解析失败：忽略该行（不完整的数据在完整 SSE 中不应出现）
          continue;
        }

        switch (currentEvent) {
          case 'message':
            yield { type: 'text', content: String(data.content ?? '') };
            break;

          case 'usage': {
            const native = data.nativeUsage as
              | { completion_tokens_details?: { reasoning_tokens?: number } }
              | undefined;
            yield {
              type: 'usage',
              usage: {
                promptTokens: Number(data.promptTokens ?? 0),
                completionTokens: Number(data.completionTokens ?? 0),
                totalTokens: Number(data.totalTokens ?? 0),
                reasoningTokens: Number(
                  native?.completion_tokens_details?.reasoning_tokens ?? 0,
                ),
              },
            };
            break;
          }

          case 'dialogId':
            yield { type: 'dialogId', content: String(data.content ?? '') };
            break;

          case 'finish':
            yield { type: 'finish' };
            break;

          default:
            // 未知事件类型：忽略，保持前向兼容
            break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
