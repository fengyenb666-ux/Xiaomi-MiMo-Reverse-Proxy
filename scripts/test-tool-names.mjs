/**
 * 端到端验证工具名校正
 *
 * 客户端注册小写工具名，看模型输出大写名称时是否被自动修正。
 */

import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

const db = new DatabaseSync(path.join(os.homedir(), 'mimoapi', 'data', 'mimo.db'));
const acc = db.prepare('SELECT api_key FROM accounts WHERE is_active = 1 LIMIT 1').get();
db.close();

// 全小写，模拟 DSH 的注册名
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'glob',
      description: '按通配符查找文件',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string', description: '通配符模式' } },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pwsh',
      description: '执行 PowerShell 命令',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: '命令内容' } },
        required: ['command'],
      },
    },
  },
];

function request(body, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const t0 = Date.now();
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve({ ms: Date.now() - t0, ...r }); } };

    const req = http.request(
      {
        hostname: '127.0.0.1', port: 8788, path: '/v1/chat/completions', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + acc.api_key,
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => done({ status: res.statusCode, raw }));
      },
    );
    req.setTimeout(timeoutMs, () => { req.destroy(); done({ status: 'TIMEOUT' }); });
    req.on('error', (e) => done({ status: 'ERROR', error: e.message }));
    req.write(payload);
    req.end();
  });
}

console.log('═══════════════════════════════════════════');
console.log(' 工具名大小写校正 — 端到端验证');
console.log('═══════════════════════════════════════════\n');

let pass = 0, fail = 0;

// 测试 1：目录读取（模型倾向用 Get-ChildItem / Glob）
console.log('[1] 请求读取目录');
const r1 = await request({
  model: 'mimo-v2.6-flash',
  messages: [{ role: 'user', content: '读取目录 F:\\code 中的内容' }],
  tools: TOOLS,
  stream: false,
});

console.log(`  HTTP ${r1.status} | ${r1.ms}ms`);
if (r1.status === 200) {
  const j = JSON.parse(r1.raw);
  const m = j.choices?.[0]?.message;
  const fr = j.choices?.[0]?.finish_reason;
  console.log(`  finish_reason: ${fr}`);
  console.log(`  tool_calls: ${m?.tool_calls?.length ?? 0}`);

  if (m?.tool_calls?.length) {
    let allMatch = true;
    m.tool_calls.forEach((tc, i) => {
      const name = tc.function.name;
      const exact = TOOLS.some(t => t.function.name === name);
      if (!exact) allMatch = false;
      console.log(`    [${i}] "${name}" ${exact ? '✅ 精确匹配' : '❌ 不匹配'}`);
      console.log(`        参数: ${tc.function.arguments}`);
    });
    if (allMatch) { pass++; console.log('  ✅ 所有工具名与客户端注册一致\n'); }
    else { fail++; console.log('  ❌ 存在不匹配的工具名\n'); }
  } else {
    console.log('  ⚠️ 未产生工具调用');
    console.log('  content:', String(m?.content ?? '').slice(0, 100), '\n');
  }
} else {
  fail++;
  console.log('  ❌', r1.raw?.slice(0, 200) || r1.error, '\n');
}

// 测试 2：执行命令（模型倾向用 Pwsh / RunCommand）
console.log('[2] 请求执行命令');
const r2 = await request({
  model: 'mimo-v2.6-flash',
  messages: [{ role: 'user', content: '用 pwsh 工具列出当前目录的文件' }],
  tools: TOOLS,
  stream: false,
});

console.log(`  HTTP ${r2.status} | ${r2.ms}ms`);
if (r2.status === 200) {
  const j = JSON.parse(r2.raw);
  const m = j.choices?.[0]?.message;
  console.log(`  finish_reason: ${j.choices?.[0]?.finish_reason}`);
  console.log(`  tool_calls: ${m?.tool_calls?.length ?? 0}`);

  if (m?.tool_calls?.length) {
    let allMatch = true;
    m.tool_calls.forEach((tc, i) => {
      const name = tc.function.name;
      const exact = TOOLS.some(t => t.function.name === name);
      if (!exact) allMatch = false;
      console.log(`    [${i}] "${name}" ${exact ? '✅' : '❌'}`);
      console.log(`        参数: ${tc.function.arguments}`);
    });
    if (allMatch) { pass++; console.log('  ✅ 名称正确\n'); }
    else { fail++; console.log('  ❌ 名称不匹配\n'); }
  } else {
    console.log('  ⚠️ 未产生工具调用，content:', String(m?.content).slice(0, 80), '\n');
  }
} else {
  fail++;
  console.log('  ❌', r2.error, '\n');
}

console.log('═══════════════════════════════════════════');
console.log(` 结果: ${pass} 通过, ${fail} 失败`);
console.log('═══════════════════════════════════════════');
