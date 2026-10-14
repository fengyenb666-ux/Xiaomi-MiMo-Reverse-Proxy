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
 *   - **对含空格的值要求加引号**：许多客户端会把参数拼进命令行，
 *     不加引号的路径会被空格截断（例如 `F:\code\lsp Ksu` 变成 `F:\code\lsp`）
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

## 参数值书写规则（重要）

1. **凡是可能包含空格的值（路径、命令、查询语句），必须用英文双引号包裹**。
   这是为了避免下游按空格拆分参数导致内容被截断。

   ✅ 正确：<parameter=path>"F:/my docs/lsp Ksu"</parameter>
   ❌ 错误：<parameter=path>F:/my docs/lsp Ksu</parameter>

2. 不含空格的值（单个词、数字、布尔值）**不要**加引号。

   ✅ 正确：<parameter=count>5</parameter>
   ✅ 正确：<parameter=enabled>true</parameter>

3. 反斜杠路径请统一改为正斜杠，避免转义问题。

   ✅ 推荐：<parameter=path>"F:/code/lsp Ksu"</parameter>
   ⚠️ 避免：<parameter=path>"F:\\code\\lsp Ksu"</parameter>

## 其他规则

1. **工具名称必须与下方「可用工具」中列出的完全一致，区分大小写**。
   不要改写、不要首字母大写、不要翻译。
2. 一次可以输出多个 <tool_call> 块
3. 调用工具时，**只输出 XML**，不要在前后添加解释性文字
4. 参数必须符合下方 schema 定义
5. 如果不需要调用工具，正常回答即可

## 示例

假设可用工具里有名为 \`read_file\` 和 \`list_dir\` 的工具，
用户说「读取 F:\\code\\lsp Ksu 这个目录」时，你应输出：

<tool_call>
<function=list_dir>
<parameter=path>"F:/code/lsp Ksu"</parameter>
</function>
</tool_call>

用户说「读取 package.json」时（无空格，不加引号）：

<tool_call>
<function=read_file>
<parameter=file_path>package.json</parameter>
</function>
</tool_call>

> 注意示例中的 \`list_dir\` / \`read_file\` 只是**名称格式示意**。
> 实际调用时，请使用下方「可用工具」里真实存在的名称。

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
 * 主格式：
 * <tool_call>
 * <function=名称>
 * <parameter=键>值</parameter>
 * </function>
 * </tool_call>
 *
 * 变体（模型有时把函数名直接当标签名）：
 * <tool_call>
 * <pwsh>
 * <parameter=command>...</parameter>
 * </pwsh>
 * </tool_call>
 *
 * @param text        模型输出
 * @param validNames  客户端注册的工具名，用于识别「标签名即函数名」的变体
 */
function parseXmlToolCalls(text: string, validNames?: string[]): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];

  // 匹配每个 <tool_call>...</tool_call> 块
  const blockRe = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockRe.exec(text)) !== null) {
    const block = blockMatch[1];

    let fnName = '';

    // ---- 形式 1：<function=名称> 或 <function name="名称"> ----
    const nameMatch =
      block.match(/<function=([^>\s]+)/i) ??
      block.match(/<function\s+name=["']([^"']+)["']/i);
    if (nameMatch) fnName = nameMatch[1].trim();

    // ---- 形式 2：<function>名称</function> ----
    if (!fnName) {
      const inner = block.match(/<function>([\s\S]*?)<\/function>/i);
      if (inner) {
        const t = inner[1].trim();
        // 只有当内容里没有 parameter 标签时，才认为它是函数名
        if (t && !/<parameter=/i.test(t)) fnName = t;
      }
    }

    // ---- 形式 3：直接用工具名作标签，如 <pwsh>...</pwsh> ----
    if (!fnName && validNames?.length) {
      // 找出块内所有形如 <xxx> 的开标签（排除已知的结构标签）
      const reserved = new Set([
        'tool_call', 'function', 'parameter', 'parameters',
        'arguments', 'args', 'invoke', 'tool',
      ]);
      const tagRe = /<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>/g;
      let tm: RegExpExecArray | null;
      while ((tm = tagRe.exec(block)) !== null) {
        const tag = tm[1];
        if (reserved.has(tag.toLowerCase())) continue;
        // 该标签名是否匹配某个已注册工具
        const matched = matchToolName(tag, validNames);
        if (matched) {
          fnName = matched;
          break;
        }
      }
    }

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

    // 变体：<parameter name="x">值</parameter>
    const paramRe2 = /<parameter\s+name=["']([^"']+)["']>([\s\S]*?)<\/parameter>/gi;
    while ((pMatch = paramRe2.exec(block)) !== null) {
      const key = pMatch[1].trim();
      if (!(key in args)) args[key] = coerceValue(pMatch[2]);
    }

    // 变体：<parameter name="x" value="值" />（自闭合）
    const paramRe3 = /<parameter\s+name=["']([^"']+)["']\s+value=["']([^"']*)["']\s*\/?>/gi;
    while ((pMatch = paramRe3.exec(block)) !== null) {
      const key = pMatch[1].trim();
      if (!(key in args)) args[key] = coerceValue(pMatch[2]);
    }

    // 变体：直接 JSON 参数块
    if (!Object.keys(args).length) {
      const jsonArgs = block.match(/<arguments>\s*([\s\S]*?)\s*<\/arguments>/i)
        ?? block.match(/<parameters>\s*([\s\S]*?)\s*<\/parameters>/i);
      if (jsonArgs) {
        try {
          const parsed = JSON.parse(jsonArgs[1].trim());
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            Object.assign(args, parsed as Record<string, unknown>);
          }
        } catch {
          /* 保持空参数 */
        }
      }
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
 *
 * 同时处理提示词要求的「含空格值加引号」——
 * 引号仅作包裹用途，解析后要去掉，但**内部空格必须保留**。
 */
function coerceValue(raw: string): unknown {
  const v = raw.trim();

  if (v === '') return '';

  // 布尔
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  if (/^(null|undefined)$/i.test(v)) return null;

  // 数字（注意：带引号的 "42" 应视为字符串，保持模型意图）
  const isQuoted = /^["'][\s\S]*["']$/.test(v) && v.length >= 2;
  if (!isQuoted) {
    if (/^-?\d+$/.test(v)) {
      const n = Number(v);
      return Number.isSafeInteger(n) ? n : v;
    }
    if (/^-?\d*\.\d+$/.test(v)) return Number(v);
  }

  // 去掉包裹引号（只去最外层一对，内部内容原样保留）
  let inner = v;
  if (isQuoted) {
    inner = v.slice(1, -1);
  }

  // JSON 对象/数组
  if (/^[[{]/.test(inner)) {
    try {
      return JSON.parse(inner);
    } catch {
      /* 保持字符串 */
    }
  }

  return inner;
}

/**
 * 从模型输出中解析工具调用。
 *
 * 会依次尝试 XML 与 JSON 两种格式，返回首个成功的解析结果。
 *
 * @param text         模型输出文本
 * @param validNames   客户端注册的工具名列表。传入时会做名称校正：
 *                     模型偶尔会把名称首字母大写或改变大小写，
 *                     这里按「忽略大小写唯一匹配」自动修正，
 *                     避免客户端报 unknown tool。
 */
export function parseToolCalls(
  text: string,
  validNames?: string[],
): ParsedToolCall[] {
  if (!text) return [];

  let calls: ParsedToolCall[] = [];

  // 优先 XML（提示词里约定的主格式）
  if (/<tool_call>/i.test(text)) {
    calls = parseXmlToolCalls(text, validNames);
  }

  // 回退 JSON
  if (!calls.length) {
    calls = parseJsonToolCalls(text);
  }

  if (!calls.length) return [];

  // 名称校正
  if (validNames?.length) {
    for (const c of calls) {
      const fixed = matchToolName(c.function.name, validNames);
      if (fixed && fixed !== c.function.name) {
        console.warn(
          `[工具] 名称校正: "${c.function.name}" → "${fixed}"`,
        );
        c.function.name = fixed;
      }
    }
  }

  return calls;
}

/**
 * 把模型输出的工具名匹配到客户端注册的名称。
 *
 * 策略（从严格到宽松，一旦唯一命中即返回）：
 *   1. 精确匹配
 *   2. 忽略大小写唯一匹配        Glob → glob
 *   3. 忽略下划线/连字符唯一匹配  get_file → getFile
 *   4. 编辑距离足够近且唯一        pwdsh → pwsh（模型拼写错误）
 *   5. 无法唯一确定 → null（保持原样，让客户端报错更明确）
 */
export function matchToolName(
  name: string,
  validNames: string[],
): string | null {
  if (!name) return null;

  // 1. 精确
  if (validNames.includes(name)) return name;

  const lower = name.toLowerCase();

  // 2. 忽略大小写
  const ci = validNames.filter((v) => v.toLowerCase() === lower);
  if (ci.length === 1) return ci[0];

  // 3. 忽略分隔符（下划线/连字符）
  const norm = (s: string) => s.toLowerCase().replace(/[_-]/g, '');
  const target = norm(name);
  const loose = validNames.filter((v) => norm(v) === target);
  if (loose.length === 1) return loose[0];

  // 4. 模糊匹配：编辑距离
  //
  // 只对长度足够（≥3）的名称启用，避免短名称之间误配。
  // 允许的最大距离按长度自适应：短名称 1，长名称 2。
  if (target.length >= 3) {
    const maxDist = target.length >= 6 ? 2 : 1;
    const near = validNames.filter((v) => {
      const d = editDistance(target, norm(v));
      return d > 0 && d <= maxDist;
    });
    if (near.length === 1) return near[0];
  }

  return null;
}

/**
 * Levenshtein 编辑距离（迭代实现，带滚动数组）。
 *
 * 用于识别模型输出的轻微拼写错误，例如 pwdsh → pwsh。
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);

  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,      // 删除
        curr[j - 1] + 1,  // 插入
        prev[j - 1] + cost, // 替换
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[b.length];
}

/** 文本中是否含有工具调用标记 */
export function hasToolCall(text: string): boolean {
  if (/<tool_call>/i.test(text)) return true;
  if (/```(?:json)?\s*\{\s*"(?:name|function)"/i.test(text)) return true;
  // 裸 JSON 对象形态
  if (/\{\s*"(?:name|function)"\s*:/.test(text)) return true;
  return false;
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
