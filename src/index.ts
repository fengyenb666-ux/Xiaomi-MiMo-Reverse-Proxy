/**
 * MiMo 反向代理主服务
 *
 * 提供 OpenAI 兼容接口：
 *   GET  /v1/models              模型列表
 *   POST /v1/chat/completions    对话补全（流式 / 非流式）
 *   GET  /health                 健康检查
 *
 * 管理接口（前缀 /admin）：
 *   账号 CRUD、测试、日志、统计
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';

import {
  DEFAULT_MODEL,
  callMimo,
  fetchBotConfig,
  fetchChatModels,
  resolveModel,
  type MimoUsage,
} from './mimo/client.ts';
import {
  ThinkParser,
  SafeBuffer,
  serializeMessages,
  sanitizeOutput,
  stripThink,
  type ChatMessage,
} from './mimo/serialize.ts';
import {
  generateClientSessionId,
  getOrCreateSession,
  updateSessionTokens,
} from './mimo/session.ts';
import {
  acquireAccount,
  accountStats,
  createAccount,
  deleteAccount,
  findByCredential,
  getAccountByApiKey,
  initAccounts,
  isClientKeyValid,
  listAccounts,
  listHealthChecks,
  markAccountInactive,
  moveAccountPriority,
  parseCredential,
  recordAccountError,
  releaseAccount,
  setPrimaryAccount,
  updateAccount,
  upsertAccount,
  type Account,
} from './accounts.ts';
import { addLog, initLogger, listLogs, clearLogs, logStats, logDailyStats } from './logger.ts';
import { closeDb, initDb } from './db.ts';
import {
  checkAllAccounts,
  getHealthConfig,
  getHealthRuntime,
  loadHealthConfig,
  restartHealthPolling,
  runHealthCheckNow,
  saveHealthConfig,
  startHealthPolling,
  stopHealthPolling,
} from './health.ts';
import {
  browserDiagnostics,
  closeAllCaptures,
  closeCapture,
  findBrowser,
  getCaptureSession,
  listCaptureSessions,
  startCapture,
} from './capture.ts';

const PORT = Number(process.env.PORT ?? 8788);
const HOST = process.env.HOST ?? '0.0.0.0';
const PROXY = process.env.MIMO_PROXY ?? '';
const THINK_MODE = process.env.MIMO_THINK_MODE ?? 'separate'; // passthrough | strip | separate
const SESSION_ISOLATION = process.env.MIMO_SESSION_ISOLATION ?? 'auto';

/**
 * 流式结束帧的 finish_reason 取值。
 *
 * 默认 `stop`。个别客户端只认 `stop`，也有客户端接受 `end_turn`；
 * 可在此处统一调整。
 */
const FINISH_REASON = process.env.MIMO_FINISH_REASON ?? 'stop';

/** 是否在流式响应中发送 usage 帧（默认发送；极端兼容场景可关闭） */
const SEND_USAGE = process.env.MIMO_SEND_USAGE !== '0';

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': '*',
    // 兼容字段：与 OpenAI 响应保持一致，便于客户端正常处理
    'openai-version': '2020-10-01',
    'x-request-id': `req_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function getClientIp(req: http.IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

function extractApiKey(req: http.IncomingMessage): string | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  const xk = req.headers['x-api-key'];
  if (typeof xk === 'string' && xk) return xk.trim();
  return null;
}

/* ------------------------------------------------------------------ */
/* 对话补全                                                            */
/* ------------------------------------------------------------------ */

interface OpenAIRequestBody {
  model?: string;
  messages?: Array<{ role: string; content: unknown }>;
  stream?: boolean;
  reasoning_effort?: string;
  strip_reasoning?: boolean;
  [key: string]: unknown;
}

async function handleChatCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const startTime = Date.now();
  const ip = getClientIp(req);

  const apiKey = extractApiKey(req);
  // 只校验 Key 本身是否有效，与上游账号启用状态无关（那是两件事）
  const keyValid = apiKey ? isClientKeyValid(apiKey) : false;
  if (!keyValid) {
    return json(res, 401, {
      error: {
        message: apiKey
          ? 'Invalid API key：该 Key 不属于任何已添加的账号'
          : 'Missing API key：请在 Authorization 头中提供 Bearer <你的Key>',
        type: 'auth_error',
      },
    });
  }

  let body: OpenAIRequestBody;
  try {
    body = JSON.parse(await readBody(req)) as OpenAIRequestBody;
  } catch {
    return json(res, 400, {
      error: { message: 'Invalid JSON body', type: 'invalid_request_error' },
    });
  }

  const rawMessages = (body.messages ?? []).map((m) => ({
    role: m.role as ChatMessage['role'],
    content: typeof m.content === 'string' ? m.content : String(m.content ?? ''),
  }));

  if (!rawMessages.length) {
    return json(res, 400, {
      error: { message: 'messages 不能为空', type: 'invalid_request_error' },
    });
  }

  const isStream = body.stream === true;
  // reasoning_effort 或显式字段控制思考链
  const enableThinking =
    body.reasoning_effort !== undefined && body.reasoning_effort !== 'none'
      ? true
      : body.enable_thinking !== undefined
        ? Boolean(body.enable_thinking)
        : true;

  const stripReasoning =
    body.strip_reasoning === true ||
    req.headers['x-strip-reasoning'] === 'true' ||
    THINK_MODE === 'strip';

  let mimoModel = DEFAULT_MODEL;
  try {
    mimoModel = await resolveModel(body.model ?? '', PROXY || undefined);
  } catch {
    mimoModel = body.model || DEFAULT_MODEL;
  }

  // ============ 主备模式：自动故障转移 ============
  //
  // 优先使用优先级最高的账号。若它在上游失败（凭证过期/网络错误），
  // 自动停用它并**用下一个账号重试本次请求**，最多重试 N 次。
  // 这样客户端不会因为某个账号掉线而收到错误。
  const MAX_FAILOVER = Math.max(
    0,
    Math.min(5, Number(process.env.MIMO_MAX_FAILOVER ?? 2)),
  );

  const startedAt = Date.now();
  const attempted: string[] = [];
  let lastError: { msg: string; status?: number; loginUrl?: string } | null = null;

  for (let attempt = 0; attempt <= MAX_FAILOVER; attempt++) {
    // 选账号（主备模式下即优先级最高的可用账号）
    const picked = acquireAccount();

    if (!picked) {
      // 没有可用账号了
      if (attempted.length) {
        // 已经有账号失败过 → 返回最后一次的真实错误
        break;
      }
      const s = accountStats();
      const reason =
        s.total === 0
          ? '尚未添加任何 MiMo 账号。'
          : s.active === 0
            ? `全部 ${s.total} 个账号均已停用（通常是小米账号凭证过期）。请到管理面板查看并重新登录。`
            : `所有账号都已达到并发上限（每账号 ${s.maxConcurrentPerAccount}）。可稍后重试或调大 MIMO_MAX_CONCURRENT。`;

      return json(res, 503, {
        error: {
          message: `无可用 MiMo 账号：${reason}`,
          type: 'service_error',
          accounts: s,
        },
      });
    }

    attempted.push(picked.alias ?? picked.id.slice(0, 8));

    const result = await runChatOnce(req, res, {
      picked,
      body,
      rawMessages,
      mimoModel,
      enableThinking,
      stripReasoning,
      isStream,
      ip,
      startedAt,
    });

    // 成功：直接结束
    if (result.ok) return;

    // 失败：记录并决定是否切换账号重试
    lastError = result.error ?? { msg: '未知错误' };

    // 流式响应已经开始发送 → 无法重试，只能报错结束
    if (result.headersSent) return;

    // 客户端主动断开 → 不重试
    if (result.clientClosed) return;

    const isAuth = result.error?.status === 401 || result.error?.status === 403;
    const isRetryable = isAuth || result.error?.status === 429 || result.error?.status === 502;

    if (!isRetryable || attempt >= MAX_FAILOVER) {
      break;
    }

    // 还有备用账号 → 打印切换日志并继续循环
    console.warn(
      `[故障转移] ${picked.alias ?? picked.id.slice(0, 8)} 失败` +
        `（${result.error?.status ?? '网络错误'}），` +
        (attempt < MAX_FAILOVER ? '尝试切换下一个账号...' : '已达最大重试次数'),
    );
  }

  // ============ 所有尝试均失败 ============
  const msg = lastError?.msg ?? '所有账号均请求失败';
  const status = lastError?.status;
  const loginUrl = lastError?.loginUrl;

  const stats = accountStats();
  const tried = attempted.length > 1 ? `（已尝试 ${attempted.length} 个账号）` : '';
  const hint =
    stats.active === 0
      ? `所有账号均已失效${tried}，请到管理面板重新登录小米账号。`
      : stats.active > 0
        ? `已尝试 ${attempted.join(' → ')}，均失败。`
        : null;

  if (res.headersSent) {
    try {
      res.write(
        `data: ${JSON.stringify({ error: { message: msg, type: 'api_error' } })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
    } catch {
      /* ignore */
    }
    res.end();
    return;
  }

  return json(res, 502, {
    error: {
      message: hint ? `${msg}\n\n${hint}` : msg,
      type: status === 401 || status === 403 ? 'auth_error' : 'api_error',
      ...(loginUrl ? { login_url: loginUrl } : {}),
      attempted,
    },
  });
}

/* ------------------------------------------------------------------ */
/* 单次请求（可被故障转移重试）                                        */
/* ------------------------------------------------------------------ */

interface RunChatOptions {
  picked: Account;
  body: OpenAIRequestBody;
  rawMessages: ChatMessage[];
  mimoModel: string;
  enableThinking: boolean;
  stripReasoning: boolean;
  isStream: boolean;
  ip: string;
  startedAt: number;
}

interface RunChatResult {
  ok: boolean;
  /** 响应头是否已发送（流式开始后无法重试） */
  headersSent?: boolean;
  /** 客户端是否主动断开 */
  clientClosed?: boolean;
  error?: { msg: string; status?: number; loginUrl?: string };
}

/**
 * 执行一次对话请求。
 *
 * 成功返回 { ok: true }；失败返回错误详情供上层决定是否切换账号重试。
 */
async function runChatOnce(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: RunChatOptions,
): Promise<RunChatResult> {
  const {
    picked,
    body,
    rawMessages,
    mimoModel,
    enableThinking,
    stripReasoning,
    isStream,
    ip,
    startedAt,
  } = opts;

  let usage: MimoUsage | null = null;
  let clientClosed = false;

  // 客户端断开标记（流式场景）
  req.on('close', () => {
    clientClosed = true;
  });

  try {
    const clientSessionId = generateClientSessionId(
      SESSION_ISOLATION,
      ip,
      String(req.headers['user-agent'] ?? ''),
      (body.session_id as string) ?? null,
    );

    const session = getOrCreateSession(picked.id, clientSessionId, rawMessages);
    const conversationId = session.conversationId;

    const query = serializeMessages(rawMessages);
    const gen = callMimo(picked, conversationId, query, {
      model: mimoModel,
      enableThinking,
      proxy: PROXY || undefined,
    });

    const responseId = `chatcmpl-${randomUUID().replace(/-/g, '')}`;
    const created = Math.floor(Date.now() / 1000);

    if (isStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
        // 兼容字段：部分客户端据此判断是 OpenAI 兼容服务
        'openai-version': '2020-10-01',
        'openai-processing-ms': '0',
        'x-request-id': responseId,
      });

      const base = {
        id: responseId,
        object: 'chat.completion.chunk',
        created,
        model: mimoModel,
      };

      // 注意：这些状态变量必须在 send() 定义之前声明。
      // 否则 send() 内部引用它们时会命中 let 的暂时性死区（TDZ），
      // 首次调用即抛 ReferenceError，导致流式响应头已发送但连接挂起。
      let aborted = false;
      let finishSent = false;
      let chunkCount = 0;

      req.on('close', () => {
        aborted = true;
      });

      const send = (delta: Record<string, unknown>, finish: string | null = null) => {
        chunkCount++;
        res.write(
          `data: ${JSON.stringify({
            ...base,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`,
        );
      };

      // 首片：role
      send({ role: 'assistant', content: '' });

      const parser = new ThinkParser();
      const safe = new SafeBuffer(24);

      for await (const chunk of gen) {
        if (aborted) break;

        if (chunk.type === 'text') {
          const { reasoning, content } = parser.push(chunk.content);

          if (reasoning && !stripReasoning) {
            if (THINK_MODE === 'separate') {
              send({ reasoning_content: reasoning });
            } else if (THINK_MODE === 'passthrough') {
              send({ content: reasoning });
            }
          }

          if (content) {
            const emit = safe.push(content);
            if (emit) send({ content: emit });
          }
        } else if (chunk.type === 'usage') {
          usage = chunk.usage;
        } else if (chunk.type === 'finish') {
          // 冲掉安全缓冲
          const tail = safe.flush();
          if (tail) send({ content: tail });

          // 结束帧。
          //
          // 兼容性要点：部分桌面客户端（Cherry Studio 等）在解析结束帧时，
          // 若同一帧里带 usage 这种嵌套对象，会解析失败并把整个流判为
          // "Stream ended without finish_reason"。因此这里**只发 finish_reason**，
          // usage 放到紧随其后的独立帧（这也是 OpenAI 官方的做法）。
          res.write(
            `data: ${JSON.stringify({
              ...base,
              choices: [{ index: 0, delta: {}, finish_reason: FINISH_REASON }],
            })}\n\n`,
          );

          // usage 单独一帧（若客户端不需要可忽略；这是标准扩展行为）
          if (usage && SEND_USAGE) {
            res.write(
              `data: ${JSON.stringify({
                ...base,
                choices: [],
                usage: {
                  prompt_tokens: usage.promptTokens,
                  completion_tokens: usage.completionTokens,
                  total_tokens: usage.totalTokens,
                  completion_tokens_details: {
                    reasoning_tokens: usage.reasoningTokens,
                  },
                },
              })}\n\n`,
            );
          }

          // 收尾帧：显式再发一次空的 finish_reason，
          // 保证任何解析顺序下客户端都能读到结束标记
          res.write(
            `data: ${JSON.stringify({
              ...base,
              choices: [{ index: 0, delta: {}, finish_reason: FINISH_REASON }],
            })}\n\n`,
          );

          res.write('data: [DONE]\n\n');
          finishSent = true;
        }
      }

      // 上游流在没有 finish 事件的情况下结束（网络中断、上游异常等）。
      // 此时必须补一个结束帧，否则客户端会报
      // "Stream ended without finish_reason" 并重试。
      if (!finishSent && !aborted) {
        console.warn(
          `[流式] 上游未发送 finish 事件，补发结束帧` +
            `（已输出 ${chunkCount} 帧）`,
        );
        const tail = safe.flush();
        if (tail) send({ content: tail });
        res.write(
          `data: ${JSON.stringify({
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: FINISH_REASON }],
          })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        finishSent = true;
      }

      res.end();

      if (usage) updateSessionTokens(session.id, usage.promptTokens);

      addLog({
        accountId: picked.id,
        accountAlias: picked.alias,
        model: mimoModel,
        endpoint: '/v1/chat/completions',
        stream: true,
        status: 'success',
        durationMs: Date.now() - startedAt,
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        totalTokens: usage?.totalTokens ?? 0,
        ip,
      });

      return { ok: true, headersSent: true, clientClosed: aborted };
    }

    // 非流式
    const parser = new ThinkParser();
    let finalText = '';
    let reasoningText = '';

    for await (const chunk of gen) {
      if (chunk.type === 'text') {
        const r = parser.push(chunk.content);
        reasoningText += r.reasoning;
        finalText += r.content;
      } else if (chunk.type === 'usage') {
        usage = chunk.usage;
      }
    }

    let message: Record<string, unknown> = {
      role: 'assistant',
      content: sanitizeOutput(finalText),
    };

    if (stripReasoning) {
      message = {
        role: 'assistant',
        content: stripThink(finalText),
      };
    } else if (THINK_MODE === 'separate' && reasoningText) {
      message = {
        role: 'assistant',
        content: sanitizeOutput(finalText),
        reasoning_content: reasoningText,
      };
    }

    const usageObj = usage
      ? {
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
          total_tokens: usage.totalTokens,
          completion_tokens_details: { reasoning_tokens: usage.reasoningTokens },
        }
      : undefined;

    if (usage) updateSessionTokens(session.id, usage.promptTokens);

    addLog({
      accountId: picked.id,
      accountAlias: picked.alias,
      model: mimoModel,
      endpoint: '/v1/chat/completions',
      stream: false,
      status: 'success',
      durationMs: Date.now() - startedAt,
      promptTokens: usage?.promptTokens ?? 0,
      completionTokens: usage?.completionTokens ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
      ip,
    });

    json(res, 200, {
      id: responseId,
      object: 'chat.completion',
      created,
      model: mimoModel,
      choices: [{ index: 0, message, finish_reason: 'stop' }],
      usage: usageObj,
    });

    return { ok: true, headersSent: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number }).status;
    const loginUrl = (err as { loginUrl?: string }).loginUrl;

    // 鉴权失败 → 立即停用账号（这样下一个请求会自动切换备用账号）
    if (status === 401 || status === 403) {
      markAccountInactive(picked.id, msg, loginUrl);
    }
    recordAccountError(picked.id, msg);

    addLog({
      accountId: picked.id,
      accountAlias: picked.alias,
      model: mimoModel,
      endpoint: '/v1/chat/completions',
      stream: isStream,
      status: 'error',
      error: msg,
      durationMs: Date.now() - startedAt,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      ip,
    });

    // 返回错误详情，由上层决定是否换账号重试
    return {
      ok: false,
      headersSent: res.headersSent,
      clientClosed,
      error: { msg, status, loginUrl },
    };
  } finally {
    releaseAccount(picked.id);
  }
}

/* ------------------------------------------------------------------ */
/* 管理接口                                                            */
/* ------------------------------------------------------------------ */

async function handleAdmin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<void> {
  const method = req.method ?? 'GET';

  // GET /admin/accounts
  if (pathname === '/admin/accounts' && method === 'GET') {
    return json(res, 200, {
      accounts: listAccounts().map((a) => ({
        ...a,
        // 不完整暴露凭证
        serviceToken: mask(a.serviceToken),
        phToken: mask(a.phToken),
        userId: a.userId,
      })),
      stats: accountStats(),
    });
  }

  // POST /admin/accounts  —— 支持 cURL 导入或手动填写
  if (pathname === '/admin/accounts' && method === 'POST') {
    const raw = await readBody(req);
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return json(res, 400, { error: '无效的 JSON' });
    }

    let cred = {
      serviceToken: String(input.serviceToken ?? ''),
      userId: String(input.userId ?? ''),
      phToken: String(input.phToken ?? ''),
    };

    // 若提供了 curl 文本，则从中解析
    if (input.curl && typeof input.curl === 'string') {
      const parsed = parseCredential(input.curl);
      if (!parsed.ok || !parsed.data) {
        return json(res, 400, { error: parsed.error });
      }
      cred = parsed.data;
    }

    if (!cred.serviceToken) {
      return json(res, 400, {
        error: '缺少 serviceToken，请粘贴 cURL 或手动填写凭证',
      });
    }

    try {
      // upsert：同一账号重复添加时更新凭证而非新建
      const { account: acc, created } = upsertAccount({
        ...cred,
        alias: typeof input.alias === 'string' ? input.alias : undefined,
        source: 'manual',
      });

      // 立即做一次健康检查
      let health: unknown = null;
      try {
        const r = await checkAllAccounts([acc.id]);
        health = r.details[0] ?? null;
      } catch {
        /* ignore */
      }

      return json(res, 200, {
        ok: true,
        created,
        health,
        account: { ...acc, serviceToken: mask(acc.serviceToken), phToken: mask(acc.phToken) },
        apiKey: acc.apiKey,
      });
    } catch (err) {
      return json(res, 400, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // POST /admin/parse —— 仅解析 cURL，不保存
  if (pathname === '/admin/parse' && method === 'POST') {
    const raw = await readBody(req);
    let input: { curl?: string };
    try {
      input = JSON.parse(raw) as { curl?: string };
    } catch {
      return json(res, 400, { error: '无效的 JSON' });
    }
    const parsed = parseCredential(input.curl ?? '');
    return json(res, 200, {
      ok: parsed.ok,
      data: parsed.data
        ? {
            serviceToken: mask(parsed.data.serviceToken),
            userId: parsed.data.userId,
            phToken: mask(parsed.data.phToken),
          }
        : undefined,
      error: parsed.error,
    });
  }

  // PATCH/DELETE /admin/accounts/:id
  const m = pathname.match(/^\/admin\/accounts\/([^/]+)$/);
  if (m) {
    const id = m[1];
    if (method === 'PATCH' || method === 'PUT') {
      const raw = await readBody(req);
      let patch: { alias?: string | null; isActive?: boolean; priority?: number };
      try {
        patch = JSON.parse(raw) as typeof patch;
      } catch {
        return json(res, 400, { error: '无效的 JSON' });
      }
      const updated = updateAccount(id, patch);
      if (!updated) return json(res, 404, { error: '账号不存在' });
      return json(res, 200, { ok: true, account: updated });
    }
    if (method === 'DELETE') {
      const ok = deleteAccount(id);
      return json(res, 200, { ok });
    }
  }

  // POST /admin/accounts/:id/move —— 调整优先级顺序（主备模式）
  const mv = pathname.match(/^\/admin\/accounts\/([^/]+)\/move$/);
  if (mv && method === 'POST') {
    const raw = await readBody(req);
    let input: { direction?: 'up' | 'down' };
    try {
      input = JSON.parse(raw) as typeof input;
    } catch {
      return json(res, 400, { error: '无效的 JSON' });
    }
    if (input.direction !== 'up' && input.direction !== 'down') {
      return json(res, 400, { error: 'direction 必须是 up 或 down' });
    }
    const ok = moveAccountPriority(mv[1], input.direction);
    if (!ok) return json(res, 400, { error: '无法移动（已在首/末位）' });
    return json(res, 200, { ok: true, accounts: listAccounts().map((a) => ({
      id: a.id, alias: a.alias, priority: a.priority, isActive: a.isActive,
    })) });
  }

  // POST /admin/accounts/:id/primary —— 设为主账号
  const pm = pathname.match(/^\/admin\/accounts\/([^/]+)\/primary$/);
  if (pm && method === 'POST') {
    const ok = setPrimaryAccount(pm[1]);
    if (!ok) return json(res, 404, { error: '账号不存在' });
    return json(res, 200, { ok: true });
  }

  // GET /admin/logs
  if (pathname === '/admin/logs' && method === 'GET') {
    return json(res, 200, { logs: listLogs(200), stats: logStats() });
  }

  if (pathname === '/admin/logs' && method === 'DELETE') {
    clearLogs();
    return json(res, 200, { ok: true });
  }

  // GET /admin/models —— 实时抓取上游模型（含 redirectTo）
  if (pathname === '/admin/models' && method === 'GET') {
    try {
      const models = await fetchChatModels(PROXY || undefined);
      return json(res, 200, { models, count: models.length });
    } catch (err) {
      return json(res, 502, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // GET /admin/api-info —— 返回 API 地址与各账号 Key，便于复制接入
  if (pathname === '/admin/api-info' && method === 'GET') {
    const host = req.headers.host ?? `127.0.0.1:${PORT}`;

    // 探测本机可用的局域网地址，方便手机等其他设备接入
    const lanIps: string[] = [];
    try {
      const os = await import('node:os');
      for (const list of Object.values(os.networkInterfaces())) {
        for (const ni of list ?? []) {
          if (ni.family === 'IPv4' && !ni.internal) lanIps.push(ni.address);
        }
      }
    } catch {
      /* ignore */
    }

    const accounts = listAccounts();

    // 推荐模型：优先用上游列表里标记 isNew 的，否则用默认型号
    let recommendedModel = DEFAULT_MODEL;
    let availableModels: string[] = [];
    try {
      const models = await fetchChatModels(PROXY || undefined);
      availableModels = models.map((m) => m.model);
      const newest = models.find((m) => m.isNew && !m.redirectTo);
      if (newest) recommendedModel = newest.model;
      else if (availableModels.length) recommendedModel = availableModels[0];
    } catch {
      /* 上游不可用时回退默认值 */
    }

    const activeAccounts = accounts.filter((a) => a.isActive);

    return json(res, 200, {
      baseUrl: `http://${host}/v1`,
      chatUrl: `http://${host}/v1/chat/completions`,
      modelsUrl: `http://${host}/v1/models`,
      lanUrls: lanIps.map((ip) => `http://${ip}:${PORT}/v1`),
      port: PORT,
      // 直接可用的推荐配置
      recommendedModel,
      modelCount: availableModels.length,
      activeCount: activeAccounts.length,
      keys: accounts.map((a) => ({
        id: a.id,
        alias: a.alias,
        apiKey: a.apiKey,
        isActive: a.isActive,
        userId: a.userId,
        requestCount: a.requestCount,
        errorCount: a.errorCount,
        priority: a.priority,
      })),
    });
  }

  // GET /admin/stats/daily —— 按天统计（图表用）
  if (pathname === '/admin/stats/daily' && method === 'GET') {
    return json(res, 200, { daily: logDailyStats(7) });
  }

  /* ---------------- 账号健康检查 ---------------- */

  // GET /admin/health —— 健康检查配置 + 运行时状态 + 汇总
  if (pathname === '/admin/health' && method === 'GET') {
    return json(res, 200, {
      config: getHealthConfig(),
      runtime: getHealthRuntime(),
      summary: accountStats().health,
    });
  }

  // POST /admin/health/check —— 立即执行一次检查
  if (pathname === '/admin/health/check' && method === 'POST') {
    const raw = await readBody(req);
    let input: { ids?: string[] } = {};
    try {
      if (raw.trim()) input = JSON.parse(raw) as typeof input;
    } catch {
      /* 允许空 body */
    }

    try {
      const r = await runHealthCheckNow(input.ids);
      return json(res, 200, { ok: true, result: r });
    } catch (err) {
      return json(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // GET /admin/health/:id —— 某账号的检查历史
  const hm = pathname.match(/^\/admin\/health\/([^/]+)$/);
  if (hm && method === 'GET') {
    const id = hm[1];
    const acc = listAccounts().find((a) => a.id === id);
    if (!acc) return json(res, 404, { error: '账号不存在' });

    return json(res, 200, {
      account: {
        id: acc.id,
        alias: acc.alias,
        healthStatus: acc.healthStatus,
        lastCheckedAt: acc.lastCheckedAt,
        lastOkAt: acc.lastOkAt,
        lastLatencyMs: acc.lastLatencyMs,
        consecutiveFailures: acc.consecutiveFailures,
        checkCount: acc.checkCount,
      },
      history: listHealthChecks(id, 30),
    });
  }

  // PATCH /admin/health/config —— 修改轮询配置
  if (pathname === '/admin/health/config' && (method === 'PATCH' || method === 'PUT')) {
    const raw = await readBody(req);
    let patch: Record<string, unknown>;
    try {
      patch = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return json(res, 400, { error: '无效的 JSON' });
    }

    const clean: Record<string, number | boolean> = {};
    if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled;
    if (typeof patch.intervalSec === 'number') {
      clean.intervalSec = Math.max(30, Math.floor(patch.intervalSec));
    }
    if (typeof patch.timeoutMs === 'number') {
      clean.timeoutMs = Math.max(3000, Math.floor(patch.timeoutMs));
    }
    if (typeof patch.autoDisableAfter === 'number') {
      clean.autoDisableAfter = Math.max(0, Math.floor(patch.autoDisableAfter));
    }
    if (typeof patch.batchSize === 'number') {
      clean.batchSize = Math.max(1, Math.floor(patch.batchSize));
    }

    const cfg = saveHealthConfig(clean);
    restartHealthPolling();

    return json(res, 200, { ok: true, config: cfg });
  }

  // GET /admin/config
  if (pathname === '/admin/config' && method === 'GET') {
    return json(res, 200, {
      thinkMode: THINK_MODE,
      sessionIsolation: SESSION_ISOLATION,
      proxy: PROXY || null,
      defaultModel: DEFAULT_MODEL,
      port: PORT,
      browserPath: findBrowser(),
      browser: browserDiagnostics(),
      database: 'SQLite (node:sqlite)',
      platform: process.platform,
    });
  }

  /* ---------------- 浏览器自动抓取 ---------------- */

  // POST /admin/capture/start —— 启动浏览器自动抓取
  if (pathname === '/admin/capture/start' && method === 'POST') {
    const raw = await readBody(req);
    let opts: { timeoutMs?: number; headless?: boolean; alias?: string } = {};
    try {
      if (raw.trim()) opts = JSON.parse(raw) as typeof opts;
    } catch {
      /* 允许空 body */
    }

    // 已有进行中的会话则先关掉，避免多个浏览器窗口
    for (const s of listCaptureSessions()) {
      if (s.status === 'awaiting_login' || s.status === 'starting') {
        await closeCapture(s.id);
      }
    }

    const s = await startCapture({
      timeoutMs: opts.timeoutMs,
      headless: opts.headless,
    });
    return json(res, 200, { session: s });
  }

  // GET /admin/capture/status?id=xxx —— 轮询抓取状态
  if (pathname === '/admin/capture/status' && method === 'GET') {
    const id = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    ).searchParams.get('id');

    if (id) {
      const s = getCaptureSession(id);
      if (!s) return json(res, 404, { error: '抓取会话不存在' });
      return json(res, 200, { session: s });
    }
    return json(res, 200, { sessions: listCaptureSessions() });
  }

  // POST /admin/capture/save —— 把抓到的凭证存入数据库
  if (pathname === '/admin/capture/save' && method === 'POST') {
    const raw = await readBody(req);
    let input: { sessionId?: string; alias?: string };
    try {
      input = JSON.parse(raw) as typeof input;
    } catch {
      return json(res, 400, { error: '无效的 JSON' });
    }

    const s = input.sessionId ? getCaptureSession(input.sessionId) : undefined;
    if (!s?.credential) {
      return json(res, 400, { error: '该会话没有可用的凭证' });
    }

    try {
      // upsert：同一小米账号再次抓取时更新凭证，不产生重复条目
      const { account: acc, created } = upsertAccount({
        serviceToken: s.credential.serviceToken,
        userId: s.credential.userId,
        phToken: s.credential.phToken,
        alias: input.alias,
        source: 'capture',
      });

      await closeCapture(s.id);

      // 保存后立即做一次健康检查，确认凭证真的可用
      let health: Awaited<ReturnType<typeof checkAllAccounts>>['details'][0] | null =
        null;
      try {
        const r = await checkAllAccounts([acc.id]);
        health = r.details[0] ?? null;
      } catch {
        /* 健康检查失败不影响保存结果 */
      }

      return json(res, 200, {
        ok: true,
        created,
        apiKey: acc.apiKey,
        health,
        account: {
          ...acc,
          serviceToken: mask(acc.serviceToken),
          phToken: mask(acc.phToken),
        },
      });
    } catch (err) {
      return json(res, 400, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // POST /admin/capture/cancel —— 关闭浏览器
  if (pathname === '/admin/capture/cancel' && method === 'POST') {
    const raw = await readBody(req);
    let input: { sessionId?: string };
    try {
      input = JSON.parse(raw) as typeof input;
    } catch {
      return json(res, 400, { error: '无效的 JSON' });
    }
    if (input.sessionId) await closeCapture(input.sessionId);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'Not Found' });
}

function mask(s: string): string {
  if (!s) return '';
  if (s.length <= 12) return s.slice(0, 4) + '***';
  return `${s.slice(0, 8)}...${s.slice(-4)}`;
}

/** 托管管理面板静态页 */
const PANEL_FILE = path.resolve(process.cwd(), 'public', 'index.html');

function servePanel(res: http.ServerResponse): void {
  if (!fs.existsSync(PANEL_FILE)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('管理面板文件缺失: ' + PANEL_FILE);
    return;
  }
  const html = fs.readFileSync(PANEL_FILE, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
  });
  res.end(html);
}

/* ------------------------------------------------------------------ */
/* 主路由                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
    });
    return res.end();
  }

  try {
    if (pathname === '/health') {
      return json(res, 200, {
        status: 'ok',
        accounts: accountStats(),
        thinkMode: THINK_MODE,
      });
    }

    if (pathname === '/v1/models' && req.method === 'GET') {
      const models = await fetchChatModels(PROXY || undefined);
      return json(res, 200, {
        object: 'list',
        data: models.map((m) => ({
          id: m.model,
          object: 'model',
          created: 1700000000,
          owned_by: 'xiaomi-mimo',
          // 附加信息（非标准，但便于调试）
          name: m.name,
          redirect_to: m.redirectTo ?? null,
        })),
      });
    }

    if (pathname === '/v1/chat/completions' && req.method === 'POST') {
      return await handleChatCompletions(req, res);
    }

    // 管理面板静态页：必须在 /admin API 路由之前判断，
    // 否则 pathname.startsWith('/admin') 会把面板页也当成 API 处理
    if (
      req.method === 'GET' &&
      (pathname === '/' || pathname === '/admin' || pathname === '/panel')
    ) {
      return servePanel(res);
    }

    if (pathname.startsWith('/admin')) {
      return await handleAdmin(req, res, pathname);
    }

    return json(res, 404, { error: 'Not Found', path: pathname });
  } catch (err) {
    console.error('[服务] 未处理异常:', err);
    if (!res.headersSent) {
      return json(res, 500, {
        error: { message: err instanceof Error ? err.message : String(err) },
      });
    }
    res.end();
  }
});

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

initDb();
initAccounts();
initLogger();
loadHealthConfig();

server.listen(PORT, HOST, () => {
  const accounts = listAccounts();

  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log('  ║            MiMo 反向代理 已启动                       ║');
  console.log('  ╚══════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  API 地址:   http://127.0.0.1:${PORT}/v1`);
  console.log(`  管理面板:   http://127.0.0.1:${PORT}/admin`);
  console.log(`  数据库:     data/mimo.db (SQLite)`);
  console.log(`  思考模式:   ${THINK_MODE}`);
  console.log(`  会话隔离:   ${SESSION_ISOLATION}`);
  console.log(`  代理:       ${PROXY || '(直连)'}`);
  console.log('');

  // 打印各账号的 API Key，方便直接复制
  if (accounts.length) {
    console.log('  ── 账号 API Key ──────────────────────────────────────');
    for (const a of accounts) {
      const flag = a.isActive ? '✅' : '⛔';
      const name = a.alias ?? a.id.slice(0, 8);
      console.log(`  ${flag} ${name}`);
      console.log(`     ${a.apiKey}`);
    }
    console.log('  ──────────────────────────────────────────────────────');
    console.log('');
  } else {
    console.log('  ⚠️  尚未添加账号，请访问管理面板添加');
    console.log('');
  }

  // 启动账号健康检查轮询
  startHealthPolling();

  // 启动时预热模型列表（失败不影响启动）
  fetchBotConfig(PROXY || undefined)
    .then(async () => {
      const models = await fetchChatModels(PROXY || undefined);
      console.log(`  [模型] 已加载 ${models.length} 个 chat 模型`);
    })
    .catch((err) => {
      console.warn('  [模型] 预热失败（不影响启动）:', err.message);
    });
});

/** 优雅退出：关闭浏览器、轮询、服务与数据库 */
function shutdown(signal: string): void {
  console.log(`\n收到 ${signal}，正在关闭...`);
  stopHealthPolling();
  void closeAllCaptures().finally(() => {
    server.close(() => {
      closeDb();
      process.exit(0);
    });
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
