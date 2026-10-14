/**
 * 工具调用解析测试
 *
 * 运行：node --experimental-strip-types test/tool-calls.test.ts
 */

import {
  buildToolPrompt,
  hasToolCall,
  parseToolCalls,
  stripToolCalls,
  type ToolDefinition,
} from '../src/tools.ts';

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const tools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取文件内容',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
];

console.log('\n=== 提示词构建 ===\n');

const prompt = buildToolPrompt(tools);
ok('包含工具名', prompt.includes('read_file'));
ok('包含调用格式说明', prompt.includes('<tool_call>'));
ok('包含参数说明', prompt.includes('<parameter='));
ok('包含示例', prompt.includes('示例'));
ok('包含 schema', prompt.includes('"path"'));

console.log('\n=== 格式 A：XML（主格式）===\n');

// 单个调用
const xml1 = `好的，我来读取。
<tool_call>
<function=read_file>
<parameter=path>package.json</parameter>
</function>
</tool_call>`;
const r1 = parseToolCalls(xml1);
ok('解析出 1 个调用', r1.length === 1, JSON.stringify(r1));
ok('函数名正确', r1[0]?.function.name === 'read_file');
ok('参数正确', JSON.parse(r1[0]?.function.arguments ?? '{}').path === 'package.json');
ok('有 id', !!r1[0]?.id);
ok('type 为 function', r1[0]?.type === 'function');

// 你截图里的真实格式（glob）
const xml2 = `好的，我来读取 f:\\code\\lsp Ksu 这个目录的内容。<tool_call><function=glob><parameter=pattern>F:/code/lsp Ksu/*</parameter></function></tool_call>`;
const r2 = parseToolCalls(xml2);
ok('解析截图中的 glob 调用', r2.length === 1, JSON.stringify(r2));
ok('  glob 名称正确', r2[0]?.function.name === 'glob');
ok('  pattern 正确', JSON.parse(r2[0]?.function.arguments ?? '{}').pattern === 'F:/code/lsp Ksu/*');

// 多个调用
const xml3 = `<tool_call><function=a><parameter=x>1</parameter></function></tool_call>
<tool_call><function=b><parameter=y>2</parameter></function></tool_call>`;
const r3 = parseToolCalls(xml3);
ok('解析多个调用', r3.length === 2, `得到 ${r3.length}`);
ok('id 各不相同', r3[0]?.id !== r3[1]?.id);

// 多个参数
const xml4 = `<tool_call><function=write><parameter=path>a.txt</parameter><parameter=content>hello</parameter></function></tool_call>`;
const r4 = parseToolCalls(xml4);
const args4 = JSON.parse(r4[0]?.function.arguments ?? '{}');
ok('多参数解析', args4.path === 'a.txt' && args4.content === 'hello', JSON.stringify(args4));

console.log('\n=== 类型推断 ===\n');

const xml5 = `<tool_call><function=t>
<parameter=num>42</parameter>
<parameter=float>3.14</parameter>
<parameter=bool>true</parameter>
<parameter=text>hello</parameter>
</function></tool_call>`;
const args5 = JSON.parse(parseToolCalls(xml5)[0]?.function.arguments ?? '{}');
ok('整数 → number', args5.num === 42, typeof args5.num);
ok('小数 → number', args5.float === 3.14, typeof args5.float);
ok('true → boolean', args5.bool === true, typeof args5.bool);
ok('普通文本 → string', args5.text === 'hello');

console.log('\n=== 格式 B：JSON 代码块 ===\n');

const json1 = '```json\n{"name":"read_file","arguments":{"path":"a.txt"}}\n```';
const r6 = parseToolCalls(json1);
ok('解析 JSON 代码块', r6.length === 1, JSON.stringify(r6));
ok('  名称正确', r6[0]?.function.name === 'read_file');

const json2 = '```json\n{"function":{"name":"glob","arguments":{"pattern":"*.ts"}}}\n```';
const r7 = parseToolCalls(json2);
ok('解析嵌套 function 形态', r7.length === 1);
ok('  名称正确', r7[0]?.function.name === 'glob');

console.log('\n=== 边界情况 ===\n');

ok('空文本 → 空数组', parseToolCalls('').length === 0);
ok('纯文本 → 空数组', parseToolCalls('这是一段普通回答，没有工具调用').length === 0);
ok('未闭合标签 → 空数组', parseToolCalls('<tool_call><function=a>').length === 0);
ok('无函数名 → 空数组', parseToolCalls('<tool_call><parameter=x>1</parameter></tool_call>').length === 0);

console.log('\n=== 检测与剥离 ===\n');

ok('hasToolCall 检出 XML', hasToolCall('<tool_call><function=a>') === true);
ok('hasToolCall 检出 JSON', hasToolCall('```json\n{"name":"a"}') === true);
ok('hasToolCall 普通文本为 false', hasToolCall('普通文本') === false);

const mixed = '先说点什么。<tool_call><function=a><parameter=x>1</parameter></function></tool_call>';
ok('stripToolCalls 保留正文', stripToolCalls(mixed) === '先说点什么。', JSON.stringify(stripToolCalls(mixed)));
ok('stripToolCalls 纯调用 → 空', stripToolCalls('<tool_call><function=a></function></tool_call>') === '');

console.log('\n=== 参数含特殊字符 ===\n');

const special = `<tool_call><function=run><parameter=cmd>echo "hi" > out.txt</parameter></function></tool_call>`;
const args8 = JSON.parse(parseToolCalls(special)[0]?.function.arguments ?? '{}');
ok('保留引号与重定向符', args8.cmd === 'echo "hi" > out.txt', JSON.stringify(args8.cmd));

const multiline = `<tool_call><function=write><parameter=content>第一行
第二行
第三行</parameter></function></tool_call>`;
const args9 = JSON.parse(parseToolCalls(multiline)[0]?.function.arguments ?? '{}');
ok('保留多行内容', args9.content.includes('第二行'), JSON.stringify(args9.content));

console.log(`\n${'='.repeat(40)}`);
console.log(`结果: ${passed} 通过, ${failed} 失败`);
console.log(`${'='.repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
