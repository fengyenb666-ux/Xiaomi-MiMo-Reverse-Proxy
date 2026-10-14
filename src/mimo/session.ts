/**
 * 会话管理（Context Replay）
 *
 * MiMo 接口靠 conversationId 维持上下文。为了复用会话，
 * 用「消息指纹」判断当前请求是否延续了上一次的对话。
 */

import { createHash, randomUUID } from 'node:crypto';
import type { ChatMessage } from './serialize.ts';

export interface Session {
  id: string;
  accountId: string;
  clientSessionId: string;
  conversationId: string;
  lastFingerprint: string;
  cumulativePromptTokens: number;
  createdAt: number;
  lastUsedAt: number;
}

/** 内存会话表 */
const sessions = new Map<string, Session>();

/** 超过该 token 数则重置会话 */
const RESET_THRESHOLD = Number(process.env.MIMO_CONTEXT_RESET_TOKENS ?? 150000);

/** 会话 TTL */
const TTL_MS = Number(process.env.MIMO_SESSION_TTL_HOURS ?? 24) * 3600 * 1000;

/** 计算消息列表指纹（忽略 system 消息） */
export function fingerprint(messages: ChatMessage[]): string {
  const payload = messages
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role}:${m.content}`)
    .join('\u0001');
  return createHash('sha256').update(payload).digest('hex');
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastUsedAt > TTL_MS) sessions.delete(id);
  }
}

/**
 * 获取或创建会话。
 *
 * 逻辑：查找该账号下是否有会话的指纹是当前消息列表的前缀，
 * 是则复用（说明客户端带上了历史），否则新建。
 */
export function getOrCreateSession(
  accountId: string,
  clientSessionId: string,
  messages: ChatMessage[],
): Session {
  pruneExpired();

  const now = Date.now();
  const fp = fingerprint(messages);
  const nonSystem = messages.filter((m) => m.role !== 'system');

  // 1. 显式会话 ID：客户端主动指定，直接复用
  if (
    clientSessionId.startsWith('explicit_') ||
    clientSessionId.startsWith('auto_')
  ) {
    const pinned = [...sessions.values()].find(
      (s) => s.accountId === accountId && s.clientSessionId === clientSessionId,
    );
    if (pinned && pinned.cumulativePromptTokens <= RESET_THRESHOLD) {
      pinned.lastFingerprint = fp;
      pinned.lastUsedAt = now;
      return pinned;
    }
  }

  // 2. 通过消息连续性匹配
  const candidates = [...sessions.values()]
    .filter((s) => s.accountId === accountId)
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, 10);

  for (const s of candidates) {
    if (s.cumulativePromptTokens > RESET_THRESHOLD) continue;

    // 尝试所有前缀长度，看是否匹配历史指纹
    for (let i = Math.max(1, nonSystem.length - 1); i >= 1; i--) {
      const slice = nonSystem.slice(0, i);
      const sysMsgs = messages.filter((m) => m.role === 'system');
      const sliceFp = fingerprint([...sysMsgs, ...slice]);
      if (sliceFp === s.lastFingerprint) {
        s.lastFingerprint = fp;
        s.lastUsedAt = now;
        return s;
      }
    }
  }

  // 3. 新建会话
  const session: Session = {
    id: randomUUID(),
    accountId,
    clientSessionId,
    conversationId: randomUUID().replace(/-/g, ''),
    lastFingerprint: fp,
    cumulativePromptTokens: 0,
    createdAt: now,
    lastUsedAt: now,
  };

  // 清理同 clientSessionId 的旧会话
  for (const [id, s] of sessions) {
    if (s.accountId === accountId && s.clientSessionId === clientSessionId) {
      sessions.delete(id);
    }
  }

  sessions.set(session.id, session);
  return session;
}

/** 累加会话 token 消耗 */
export function updateSessionTokens(sessionId: string, promptTokens: number): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.cumulativePromptTokens += promptTokens;
  s.lastUsedAt = Date.now();
}

export function listSessions(): Session[] {
  pruneExpired();
  return [...sessions.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

export function clearSessions(): number {
  const n = sessions.size;
  sessions.clear();
  return n;
}

/**
 * 生成客户端会话标识。
 *
 * 隔离模式：
 *   - auto:        按 IP + User-Agent 隔离（推荐）
 *   - manual:      仅在客户端提供 x-session-id 时隔离
 *   - per-request: 每请求新建会话（禁用记忆）
 */
export function generateClientSessionId(
  mode: string,
  ip: string,
  userAgent: string,
  explicitId?: string | null,
): string {
  if (mode === 'per-request') return `perreq_${randomUUID()}`;

  if (explicitId) {
    return mode === 'manual' || mode === 'auto'
      ? `explicit_${explicitId}`
      : `perreq_${randomUUID()}`;
  }

  if (mode === 'manual') return `manual_${randomUUID()}`;

  // auto
  const h = createHash('sha256').update(`${ip}|${userAgent}`).digest('hex');
  return `auto_${h.slice(0, 32)}`;
}
