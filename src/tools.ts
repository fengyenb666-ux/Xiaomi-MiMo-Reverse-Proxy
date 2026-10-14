/**
 * 工具调用（Tool Calling）适配
 *
 * MiMo 网页版接口**原生不支持** tools 参数，因此采用提示词模拟方案：
 *
 *   1. 客户端传入 tools 定义
 *   2. 本模块把工具定义转成系统提示词，教模型用固定 XML 格式调用
 *   3. 模型输出含 <tool_call> 的文本
 *   4. 本模块解析 XML，还原成 OpenAI 标准的 tool_calls 结构
 *
 * 支持的输出格式（按可靠性排序）：
 *   A. <tool_call><function=名称><parameter=键>值</parameter></function></tool_call>
 *   B. ```json {"name":..., "arguments":{...}} ```
 *   C. 裸 JSON {"name":..., "arguments":{...}}
 */

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ParsedToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/* ------------------------------------------------------------------ */
/* 提示词构建                                                          */
/* ------------------------------------------------------------------ */

/**
 * 把工具定义转换为系统提示词片段。
 *
 * 关键设计：
 *   - 用简洁明确的格式说明，降低模型格式错误率
 *   - 给出完整示例（模型对示例的模仿率最高）
 *   - 强调「不要用 markdown 代码块包裹」
 */
export function buildToolPrompt(tools: ToolDefinition[]): string {
  const defs = tools
    .map((t) => {
      const fn = t.function;
      const params = fn.parameters
        ? JSON.stringify(fn.parameters, null, 2)
        : '{}';
      return [
        `### ${fn.name}`,
        fn.description ? `${fn.description}` : '',
        '参数 schema:',
        '```json',
        params,
        '```',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  return `# 工具调用能力

你可以调用以下工具来完成任务。当需要调用工具时，**必须**严格按下面的
XML 格式输出，不要使用 markdown 代码块，不要添加额外说明文字。

## 调用格式

<tool_call>
<function=工具名称>
<parameter=参数名>参数值</parameter>
</function>
</tool_call>

## 规则

1. 一次可以输出多个 <tool_call> 块
2. 参数值直接写内容，不要加引号或转义（除非内容本身包含 XML 特殊字符）
3. 调用工具时，**只输出 XML**，不要在前后添加解释性文字
4. 参数必须符合下方 schema 定义
5. 如果不需要调用工具，正常回答即可

## 示例

用户问「读取 package.json 文件」时，你应输出：

<tool_call>
<function=read_file>
<parameter=path>package.json</parameter>
</function>
</tool_call>

## 可用工具

${defs}`;
}

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

/** 生成 tool_call id */
function makeId(index: number): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `call_${Date.now().toString(36)}_${index}_${rand}`;
}

/**
 * 解析格式 A：XML 风格
 *
 * <tool_call>
 * <function=名称>
 * <parameter=键>值</parameter>
 * </function>
 * </tool_call>
 */
function parseXmlToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];

  // 匹配每个 <tool_call>...</tool_call> 块
  const blockRe = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockRe.exec(text)) !== null) {
    const block = blockMatch[1];

    // 提取函数名：<function=名称> 或 <function name="名称">
    let fnName = '';
    const nameMatch =
      block.match(/<function=([^>\s]+)/i) ??
      block.match(/<function\s+name=["']([^"']+)["']/i) ??
      block.match(/<function>([\s\S]*?)<\/function>/i);
    if (nameMatch) fnName = nameMatch[1].trim();
    if (!fnName) continue;

    // 提取参数
    const args: Record<string, unknown> = {};
    const paramRe = /<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/gi;
    let pMatch: RegExpExecArray | null;
    while ((pMatch = paramRe.exec(block)) !== null) {
      const key = pMatch[1].trim();
      const raw = pMatch[2];
      args[key] = coerceValue(raw);
    }

    calls.push({
      id: makeId(calls.length),
      type: 'function',
      function: { name: fnName, arguments: JSON.stringify(args) },
    });
  }

  return calls;
}

/**
 * 解析格式 B/C：JSON（含 markdown 代码块包裹）
 */
function parseJsonToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];

  // 先剥离 markdown 代码块，避免同一段 JSON 被下面两条规则重复匹配
  const codeBlocks: string[] = [];
  const withoutCode = text.replace(/```(?:json)?\s*([\s\S]*?)```/gi, (_, inner) => {
    codeBlocks.push(String(inner).trim());
    return '\u0000'; // 占位符，保持位置但不参与裸 JSON 匹配
  });

  const candidates: string[] = [...codeBlocks];

  // 裸 JSON：在移除了代码块之后的文本里查找
  const bareRe = /\{\s*"(?:name|function)"\s*:[\s\S]*?\}\s*\}/g;
  const bare = withoutCode.match(bareRe);
  if (bare) candidates.push(...bare);

  for (const c of candidates) {
    try {
      const obj = JSON.parse(c) as Record<string, unknown>;

      // 形态 1：{"name":"x","arguments":{...}}
      // 形态 2：{"function":{"name":"x","arguments":{...}}}
      const fn = (obj.function as Record<string, unknown>) ?? obj;
      const name = String(fn.name ?? '');
      if (!name) continue;

      let args = fn.arguments ?? {};
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = { value: args };
        }
      }

      calls.push({
        id: makeId(calls.length),
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      });
    } catch {
      /* 跳过无法解析的片段 */
    }
  }

  return calls;
}

/**
 * 值类型推断：把 XML 里的文本转成合适的 JSON 类型。
 *
 * 模型输出 `<parameter=count>5</parameter>` 时，
 * 期望得到数字 5 而不是字符串 "5"。
 */
function coerceValue(raw: string): unknown {
  const v = raw.trim();

  // 去掉可能的包裹引号
  const unquoted = v.replace(/^["']|["']$/g, '');

  if (v === '') return '';
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  if (/^-?\d+$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : v;
  }
  if (/^-?\d*\.\d+$/.test(v)) return Number(v);
  if (/^(null|undefined)$/i.test(v)) return null;

  // JSON 对象/数组
  if (/^[[{]/.test(v)) {
    try {
      return JSON.parse(v);
    } catch {
      /* 保持字符串 */
    }
  }

  return unquoted;
}

/**
 * 从模型输出中解析工具调用。
 *
 * 会依次尝试 XML 与 JSON 两种格式，返回首个成功的解析结果。
 */
export function parseToolCalls(text: string): ParsedToolCall[] {
  if (!text) return [];

  // 优先 XML（提示词里约定的主格式）
  if (/<tool_call>/i.test(text)) {
    const xml = parseXmlToolCalls(text);
    if (xml.length) return xml;
  }

  // 回退 JSON
  const json = parseJsonToolCalls(text);
  if (json.length) return json;

  return [];
}

/** 文本中是否含有工具调用标记 */
export function hasToolCall(text: string): boolean {
  return /<tool_call>/i.test(text) || /```(?:json)?\s*\{\s*"(?:name|function)"/i.test(text);
}

/**
 * 从模型输出中剥离工具调用部分，返回纯文本正文。
 *
 * 用于同时有正文和工具调用的场景。
 */
export function stripToolCalls(text: string): string {
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/```(?:json)?\s*\{\s*"(?:name|function)"[\s\S]*?```/gi, '')
    .trim();
}

/* ------------------------------------------------------------------ */
/* 输出转换                                                            */
/* ------------------------------------------------------------------ */

/**
 * 转换为 OpenAI 流式增量格式。
 *
 * 流式场景下 tool_calls 需要分片发送：
 *   第一片带 id/name，后续片只带 arguments 增量。
 */
export function toStreamToolCallDelta(
  calls: ParsedToolCall[],
): Array<Record<string, unknown>> {
  return calls.map((c, i) => ({
    index: i,
    id: c.id,
    type: 'function',
    function: {
      name: c.function.name,
      arguments: c.function.arguments,
    },
  }));
}

/** 解析后的工具调用名称列表（用于日志） */
export function toolCallNames(calls: ParsedToolCall[]): string[] {
  return calls.map((c) => c.function.name);
}
