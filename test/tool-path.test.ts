/**
 * 测试含空格/特殊字符的路径参数解析
 *
 * 复现问题：F:\code\lsp Ksu 这类含空格的路径是否正确传递
 */

import { parseToolCalls, buildToolPrompt } from '../src/tools.ts';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (c) { pass++; console.log(`  ✅ ${n}`); }
  else { fail++; console.log(`  ❌ ${n}${d ? ' — ' + d : ''}`); }
};

console.log('\n=== 含空格路径的解析 ===\n');

// 场景 1：路径含空格（你截图里的情况）
const cases = [
  {
    name: '简单含空格路径',
    xml: `<tool_call><function=glob><parameter=pattern>F:\\code\\lsp Ksu/*</parameter></function></tool_call>`,
    expect: 'F:\\code\\lsp Ksu/*',
  },
  {
    name: '正斜杠含空格',
    xml: `<tool_call><function=glob><parameter=pattern>F:/code/lsp Ksu/*</parameter></function></tool_call>`,
    expect: 'F:/code/lsp Ksu/*',
  },
  {
    name: '空格在末尾',
    xml: `<tool_call><function=glob><parameter=pattern>F:/code/lsp Ksu</parameter></function></tool_call>`,
    expect: 'F:/code/lsp Ksu',
  },
  {
    name: '多个空格',
    xml: `<tool_call><function=glob><parameter=pattern>F:/my  docs/some  file.txt</parameter></function></tool_call>`,
    expect: 'F:/my  docs/some  file.txt',
  },
  {
    name: '含中文路径',
    xml: `<tool_call><function=glob><parameter=pattern>F:/code/反代 MIMO/*.ts</parameter></function></tool_call>`,
    expect: 'F:/code/反代 MIMO/*.ts',
  },
];

for (const c of cases) {
  const r = parseToolCalls(c.xml);
  const got = r.length ? JSON.parse(r[0].function.arguments).pattern : '(未解析)';
  ok(c.name, got === c.expect, `期望 ${JSON.stringify(c.expect)}，实际 ${JSON.stringify(got)}`);
}

console.log('\n=== 完整 XML（多行，带缩进）===\n');

const multiline = `<tool_call>
  <function=glob>
    <parameter=pattern>F:/code/lsp Ksu/*</parameter>
  </function>
</tool_call>`;
const r1 = parseToolCalls(multiline);
const got1 = r1.length ? JSON.parse(r1[0].function.arguments).pattern : '(未解析)';
ok('多行缩进 XML', got1 === 'F:/code/lsp Ksu/*', JSON.stringify(got1));

console.log('\n=== 带引号的参数（提示词要求含空格值加引号）===\n');

const quoted = `<tool_call><function=glob><parameter=pattern>"F:/code/lsp Ksu/*"</parameter></function></tool_call>`;
const r2 = parseToolCalls(quoted);
const got2 = r2.length ? JSON.parse(r2[0].function.arguments).pattern : '(未解析)';
ok('双引号包裹：去引号且保留空格', got2 === 'F:/code/lsp Ksu/*', JSON.stringify(got2));

const quoted2 = `<tool_call><function=glob><parameter=pattern>"F:\\code\\lsp Ksu"</parameter></function></tool_call>`;
const r3 = parseToolCalls(quoted2);
const got3 = r3.length ? JSON.parse(r3[0].function.arguments).pattern : '(未解析)';
ok('反斜杠路径 + 引号', got3 === 'F:\\code\\lsp Ksu', JSON.stringify(got3));

const quoted3 = `<tool_call><function=run><parameter=cmd>"echo hello world"</parameter></function></tool_call>`;
const r4 = parseToolCalls(quoted3);
const got4 = r4.length ? JSON.parse(r4[0].function.arguments).cmd : '(未解析)';
ok('命令含空格（引号包裹）', got4 === 'echo hello world', JSON.stringify(got4));

console.log('\n=== 引号不应破坏类型推断 ===\n');

const quotedNum = `<tool_call><function=f><parameter=n>"42"</parameter></function></tool_call>`;
const r5 = parseToolCalls(quotedNum);
const got5 = r5.length ? JSON.parse(r5[0].function.arguments).n : null;
ok('"42" 保持字符串（模型显式加引号）', got5 === '42', `${JSON.stringify(got5)} (${typeof got5})`);

const bareNum = `<tool_call><function=f><parameter=n>42</parameter></function></tool_call>`;
const r6 = parseToolCalls(bareNum);
const got6 = r6.length ? JSON.parse(r6[0].function.arguments).n : null;
ok('42 推断为数字', got6 === 42, `${JSON.stringify(got6)} (${typeof got6})`);

console.log('\n=== 提示词是否说明引号规则 ===\n');

const prompt = buildToolPrompt([
  { type: 'function', function: { name: 'glob', parameters: {} } },
]);
ok('提示词要求含空格值加引号', /必须用英文双引号包裹/.test(prompt));
ok('提示词给出含空格示例', /lsp Ksu/.test(prompt));
ok('提示词建议用正斜杠', /正斜杠/.test(prompt));
ok('提示词说明无空格不加引号', /不要\*\*加引号|不含空格的值/.test(prompt));

console.log(`\n${'='.repeat(42)}`);
console.log(`结果: ${pass} 通过, ${fail} 失败`);
console.log(`${'='.repeat(42)}\n`);

process.exit(fail > 0 ? 1 : 0);
