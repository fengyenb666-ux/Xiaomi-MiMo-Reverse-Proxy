/**
 * XML 变体格式测试
 *
 * 模型有时不按提示词输出 <function=名>，而是把工具名直接当标签：
 *   <tool_call><pwsh><parameter=command>...</parameter></pwsh></tool_call>
 */

import { parseToolCalls, hasToolCall, stripToolCalls } from '../src/tools.ts';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (c) { pass++; console.log(`  ✅ ${n}`); }
  else { fail++; console.log(`  ❌ ${n}${d ? ' — ' + d : ''}`); }
};

const NAMES = ['glob', 'pwsh', 'read_file'];

console.log('\n=== 变体：工具名作标签 ===\n');

// 真实场景（截取自动验证的输出）
const variant1 = `<tool_call>
<pwsh>
<parameter=command>Get-ChildItem -Path "F:/code" | Select-Object Mode, LastWriteTime, Length</parameter>
</pwsh>
</tool_call>`;
const r1 = parseToolCalls(variant1, NAMES);
ok('解析出 1 个调用', r1.length === 1, JSON.stringify(r1));
ok('函数名 = pwsh', r1[0]?.function.name === 'pwsh', r1[0]?.function.name);
ok('参数完整', (() => {
  try {
    const a = JSON.parse(r1[0]?.function.arguments ?? '{}');
    return a.command?.includes('Get-ChildItem') && a.command?.includes('F:/code');
  } catch { return false; }
})(), r1[0]?.function.arguments);

// 大小写变体
const variant2 = `<tool_call><PWSH><parameter=command>ls</parameter></PWSH></tool_call>`;
const r2 = parseToolCalls(variant2, NAMES);
ok('大写标签名也识别', r2[0]?.function.name === 'pwsh', r2[0]?.function.name);

// 下划线变体
const variant3 = `<tool_call><read_file><parameter=file_path>a.txt</parameter></read_file></tool_call>`;
const r3 = parseToolCalls(variant3, NAMES);
ok('下划线标签名识别', r3[0]?.function.name === 'read_file', r3[0]?.function.name);

console.log('\n=== 主格式仍然优先 ===\n');

const main = `<tool_call><function=pwsh><parameter=command>ls</parameter></function></tool_call>`;
const r4 = parseToolCalls(main, NAMES);
ok('<function=> 主格式正常', r4[0]?.function.name === 'pwsh', r4[0]?.function.name);

console.log('\n=== 保留标签不应误判 ===\n');

// <parameter> / <arguments> 等不应被当成工具名
const guard = `<tool_call>
<arguments>
<parameter=command>ls</parameter>
</arguments>
</tool_call>`;
const r5 = parseToolCalls(guard, NAMES);
ok('保留标签不当工具名', r5.length === 0 || r5[0]?.function.name !== 'arguments',
   JSON.stringify(r5.map(c => c.function.name)));

console.log('\n=== 未知工具名不误报 ===\n');

const unknown = `<tool_call><unknown_thing><parameter=x>1</parameter></unknown_thing></tool_call>`;
const r6 = parseToolCalls(unknown, NAMES);
ok('未注册工具 → 不解析', r6.length === 0, JSON.stringify(r6));

console.log('\n=== 检测与剥离 ===\n');

ok('hasToolCall 检出新变体', hasToolCall(variant1) === true);
ok('stripToolCalls 清空纯调用', stripToolCalls(variant1).trim() === '', JSON.stringify(stripToolCalls(variant1)));

const mixed = `我先看看。\n${variant1}`;
ok('stripToolCalls 保留正文', stripToolCalls(mixed) === '我先看看。', JSON.stringify(stripToolCalls(mixed)));

console.log('\n=== 参数名变体 ===\n');

const nameAttr = `<tool_call><function=pwsh><parameter name="command">ls -la</parameter></function></tool_call>`;
const r7 = parseToolCalls(nameAttr, NAMES);
ok('<parameter name="x"> 形式', (() => {
  try { return JSON.parse(r7[0]?.function.arguments ?? '{}').command === 'ls -la'; }
  catch { return false; }
})(), r7[0]?.function.arguments);

console.log(`\n${'='.repeat(42)}`);
console.log(`结果: ${pass} 通过, ${fail} 失败`);
console.log(`${'='.repeat(42)}\n`);

process.exit(fail > 0 ? 1 : 0);
