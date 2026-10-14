/**
 * 工具名校正测试
 *
 * 复现场景：模型输出 "Glob"，客户端注册的是 "glob"
 */

import { parseToolCalls, matchToolName, editDistance } from '../src/tools.ts';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (c) { pass++; console.log(`  ✅ ${n}`); }
  else { fail++; console.log(`  ❌ ${n}${d ? ' — ' + d : ''}`); }
};

console.log('\n=== matchToolName 匹配策略 ===\n');

const names = ['glob', 'pwsh', 'read_file', 'getFile'];

ok('精确匹配', matchToolName('glob', names) === 'glob');
ok('首字母大写 → 校正', matchToolName('Glob', names) === 'glob');
ok('全大写 → 校正', matchToolName('GLOB', names) === 'glob');
ok('下划线/驼峰互通', matchToolName('get_file', names) === 'getFile');
ok('驼峰转下划线', matchToolName('readFile', names) === 'read_file');
ok('未知名称 → null', matchToolName('unknown_tool', names) === null);
ok('空名称 → null', matchToolName('', names) === null);

// 歧义场景：两个名称仅大小写不同时应拒绝
const ambiguous = ['Glob', 'glob'];
ok('歧义名称 → null（不猜）', matchToolName('GLOB', ambiguous) === null);

console.log('\n=== 模糊匹配（编辑距离）===\n');

ok('拼写错误 pwdsh → pwsh', matchToolName('pwdsh', names) === 'pwsh', String(matchToolName('pwdsh', names)));
ok('少字母 pws → pwsh', matchToolName('pws', names) === 'pwsh', String(matchToolName('pws', names)));
ok('多字母 pwshh → pwsh', matchToolName('pwshh', names) === 'pwsh', String(matchToolName('pwshh', names)));
ok('gleb → glob', matchToolName('gleb', names) === 'glob', String(matchToolName('gleb', names)));

// 短名称不应模糊匹配
const short = ['ls', 'cd'];
ok('短名称不模糊匹配', matchToolName('lx', short) === null, String(matchToolName('lx', short)));

// 距离太远不应匹配
ok('距离太远 → null', matchToolName('completely_different', names) === null);

// 多个候选同样接近时应拒绝
const twins = ['pwsh', 'pwsx'];
ok('多个候选接近 → null（不猜）', matchToolName('pwsh' === 'pwsh' ? 'pwsy' : '', twins) === null);

console.log('\n=== editDistance 基本正确性 ===\n');

ok('相同字符串 → 0', editDistance('abc', 'abc') === 0);
ok('单次替换 → 1', editDistance('abc', 'abd') === 1);
ok('单次删除 → 1', editDistance('abcd', 'abc') === 1);
ok('单次插入 → 1', editDistance('abc', 'abcd') === 1);
ok('完全不同长度', editDistance('', 'abc') === 3);
ok('pwdsh ↔ pwsh = 1', editDistance('pwdsh', 'pwsh') === 1);

console.log('\n=== parseToolCalls 集成校正 ===\n');

// 你截图里的真实场景
const xml1 = `<tool_call><function=Glob><parameter=pattern>"F:/code/*"</parameter></function></tool_call>`;
const r1 = parseToolCalls(xml1, ['glob', 'pwsh']);
ok('Glob → glob 自动校正', r1[0]?.function.name === 'glob', r1[0]?.function.name);
ok('参数保持完整', JSON.parse(r1[0]?.function.arguments ?? '{}').pattern === 'F:/code/*');

const xml2 = `<tool_call><function=Glob><parameter=pattern>"F:/code/*"</parameter></function></tool_call>
<tool_call><function=PWSH><parameter=command>ls</parameter></function></tool_call>`;
const r2 = parseToolCalls(xml2, ['glob', 'pwsh']);
ok('多调用分别校正', r2[0]?.function.name === 'glob' && r2[1]?.function.name === 'pwsh',
   `${r2[0]?.function.name}, ${r2[1]?.function.name}`);

// 不传 validNames 时保持原样（向后兼容）
const r3 = parseToolCalls(xml1);
ok('不传名称列表时保持原样', r3[0]?.function.name === 'Glob', r3[0]?.function.name);

// 未知工具不被胡乱映射
const xml4 = `<tool_call><function=NotRegistered><parameter=x>1</parameter></function></tool_call>`;
const r4 = parseToolCalls(xml4, ['glob', 'pwsh']);
ok('未知工具保持原样（由客户端报错）', r4[0]?.function.name === 'NotRegistered', r4[0]?.function.name);

console.log('\n=== 名称大小写不被参数影响 ===\n');

const xml5 = `<tool_call><function=Read_File><parameter=file_path>a.txt</parameter></function></tool_call>`;
const r5 = parseToolCalls(xml5, ['read_file']);
ok('Read_File → read_file', r5[0]?.function.name === 'read_file', r5[0]?.function.name);

console.log(`\n${'='.repeat(42)}`);
console.log(`结果: ${pass} 通过, ${fail} 失败`);
console.log(`${'='.repeat(42)}\n`);

process.exit(fail > 0 ? 1 : 0);
