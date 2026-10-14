/**
 * 消息序列化 + 思考链处理
 *
 * MiMo 网页版接口只接收单个 query 字符串（不是标准 messages 数组），
 * 因此需要把 OpenAI 格式的消息序列化成对话文本。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 把 OpenAI messages 序列化为 MiMo 的 query 文本 */
export function serializeMessages(messages: ChatMessage[]): string {
  const parts: string[] = [];

  for (const m of messages) {
    const text = typeof m.content === 'string' ? m.content : String(m.content ?? '');
    if (!text.trim()) continue;

    switch (m.role) {
      case 'system':
        parts.push(text.trim());
        break;
      case 'user':
        parts.push(text.trim());
        break;
      case 'assistant':
        // 助手的回复加标记，帮助模型区分轮次
        parts.push(`（你之前的回复）\n${text.trim()}`);
        break;
    }
  }

  return parts.join('\n\n');
}

/** 清理输出中的空字符等 */
export function sanitizeOutput(text: string): string {
  return text.replace(/\u0000/g, '');
}

/** 移除思考链内容 */
export function stripThink(text: string): string {
  let t = sanitizeOutput(text);
  t = t.replace(/<think>[\s\S]*?<\/think>/g, '');
  t = t.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');

  // 未闭合的开始标签：截断到标签前
  const openIdx = t.indexOf('<think>');
  if (openIdx !== -1) t = t.slice(0, openIdx);
  const openIdx2 = t.indexOf('<thinking>');
  if (openIdx2 !== -1) t = t.slice(0, openIdx2);

  return t.trimStart();
}

/**
 * 思考链状态机。
 *
 * MiMo 把推理内容内联在正文里：<think>推理</think>答案
 * 且 <think> / </think> 可能被 SSE 分片切断，因此必须用状态机跟踪。
 *
 * 产出：
 *   - reasoning: 推理内容增量
 *   - content:   正文内容增量
 */
export class ThinkParser {
  private started = false; // 是否遇到过 <think>
  private finished = false; // 是否已越过 </think>
  /** 暂存可能是被截断标签前缀的尾部，等待下一片拼接 */
  private pending = '';

  /**
   * 喂入一个分片，返回解析结果。
   *
   * @param chunk 原始文本分片
   */
  push(chunk: string): { reasoning: string; content: string } {
    // 先与上一轮暂存的尾部拼接，解决标签被分片切断的问题
    let text = sanitizeOutput(this.pending + chunk);
    this.pending = '';

    let reasoning = '';
    let content = '';

    // 已越过思考段：只需清理残留标签
    if (this.finished) {
      text = this.cleanResidual(text);
      return { reasoning: '', content: text };
    }

    // 未遇到 <think>：检查本片是否包含
    if (!this.started) {
      const idxThink = text.indexOf('<think>');
      const idxThinking = text.indexOf('<thinking>');

      // 取最早出现的那个
      let idx = -1;
      let tagLen = 0;
      if (idxThink !== -1 && (idxThinking === -1 || idxThink < idxThinking)) {
        idx = idxThink;
        tagLen = '<think>'.length;
      } else if (idxThinking !== -1) {
        idx = idxThinking;
        tagLen = '<thinking>'.length;
      }

      if (idx === -1) {
        // 没有完整标签。但要防止标签被切断：
        // 若尾部是某个标签的前缀，暂存起来等下一片
        const cut = this.splitUnsafeTail(text);
        this.pending = cut.unsafe;
        return { reasoning: '', content: cut.safe };
      }

      this.started = true;
      content += text.slice(0, idx);
      text = text.slice(idx + tagLen);
    }

    // 处于思考段内：查找结束标签
    const endThink = text.indexOf('</think>');
    const endThinking = text.indexOf('</thinking>');

    let endIdx = -1;
    let endLen = 0;
    if (endThink !== -1 && (endThinking === -1 || endThink < endThinking)) {
      endIdx = endThink;
      endLen = '</think>'.length;
    } else if (endThinking !== -1) {
      endIdx = endThinking;
      endLen = '</thinking>'.length;
    }

    if (endIdx !== -1) {
      reasoning += text.slice(0, endIdx);
      this.finished = true;
      const after = text.slice(endIdx + endLen);
      content += this.cleanResidual(after).replace(/^\s*\n/, '');
    } else {
      // 整片都还在思考段内。同样要防止结束标签被切断：
      // 若尾部是 </think> 或 </thinking> 的前缀，暂存
      const cut = this.splitUnsafeEndTail(text);
      reasoning += cut.safe;
      this.pending = cut.unsafe;
    }

    return { reasoning, content };
  }

  /** 流结束时调用，吐出仍暂存的内容 */
  flush(): { reasoning: string; content: string } {
    const rest = this.pending;
    this.pending = '';
    if (!rest) return { reasoning: '', content: '' };
    return this.finished
      ? { reasoning: '', content: this.cleanResidual(rest) }
      : { reasoning: rest, content: '' };
  }

  private cleanResidual(text: string): string {
    let t = text;
    t = t.replace(/<think>[\s\S]*?<\/think>/g, '');
    t = t.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
    const i1 = t.indexOf('<think>');
    if (i1 !== -1) t = t.slice(0, i1);
    const i2 = t.indexOf('<thinking>');
    if (i2 !== -1) t = t.slice(0, i2);
    return t;
  }

  /**
   * 若文本尾部可能是被截断的**开始**标签前缀（如 "<thi"），
   * 则拆分为 safe / unsafe 两部分，unsafe 需等下一片。
   */
  private splitUnsafeTail(text: string): { safe: string; unsafe: string } {
    return this.splitByPrefix(text, ['<think>', '<thinking>']);
  }

  /**
   * 若文本尾部可能是被截断的**结束**标签前缀（如 "</thi"），
   * 则拆分。注意结束标签必须以 '<' 开头才可能是标签。
   */
  private splitUnsafeEndTail(text: string): { safe: string; unsafe: string } {
    return this.splitByPrefix(text, ['</think>', '</thinking>']);
  }

  private splitByPrefix(
    text: string,
    tags: string[],
  ): { safe: string; unsafe: string } {
    for (const tag of tags) {
      // 最长匹配优先
      for (let len = Math.min(tag.length - 1, text.length); len > 0; len--) {
        if (text.endsWith(tag.slice(0, len))) {
          return {
            safe: text.slice(0, text.length - len),
            unsafe: text.slice(text.length - len),
          };
        }
      }
    }
    return { safe: text, unsafe: '' };
  }
}

/**
 * 流式输出的安全缓冲。
 *
 * 工具调用标记（```json / <tool_call>）可能被分片切断，
 * 因此不能收到就发，需保留尾部若干字符。
 */
export class SafeBuffer {
  private buf = '';
  private readonly tailSize: number;

  constructor(tailSize = 24) {
    this.tailSize = tailSize;
  }

  /** 追加并返回可以安全发出的部分 */
  push(chunk: string): string {
    this.buf += chunk;
    if (this.buf.length <= this.tailSize) return '';
    const emit = this.buf.slice(0, this.buf.length - this.tailSize);
    this.buf = this.buf.slice(this.buf.length - this.tailSize);
    return emit;
  }

  /** 流结束时取出剩余全部内容 */
  flush(): string {
    const rest = this.buf;
    this.buf = '';
    return rest;
  }
}
