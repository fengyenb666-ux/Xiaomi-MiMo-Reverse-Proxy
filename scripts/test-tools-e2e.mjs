/**
 * 工具调用端到端测试
 *
 * 模拟客户端传 tools，验证模型输出被正确转换为结构化 tool_calls。
 */

import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

const db = new DatabaseSync(path.join(os.homedir(), 'mimoapi', 'data', 'mimo.db'));
const acc = db.prepare('SELECT api_key FROM accounts WHERE is_active = 1 LIMIT 1').get();
db.close();

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'glob',
      description: '按通配符查找文件路径，返回匹配的文件列表',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '通配符模式，例如 src/**/*.ts' },
        },
        required: ['pattern'],
      },
    },
  },
];

function request(body, timeoutMs = 120000) {
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
console.log(' 工具调用端到端测试');
console.log('═══════════════════════════════════════════');

/* ---------- 非流式 ---------- */
console.log('\n[1] 非流式 + tools');
const r1 = await request({
  model: 'mimo-v2.6-flash',
  messages: [{ role: 'user', content: '列出 F:/code/demo 目录下所有 .ts 文件' }],
  tools: TOOLS,
  stream: false,
});

console.log(`  HTTP ${r1.status} | ${r1.ms}ms`);
if (r1.status === 200) {
  const j = JSON.parse(r1.raw);
  const m = j.choices?.[0]?.message;
  const fr = j.choices?.[0]?.finish_reason;
  console.log(`  finish_reason: ${fr}`);
  console.log(`  content: ${JSON.stringify(String(m?.content ?? '').slice(0, 80))}`);
  console.log(`  tool_calls: ${m?.tool_calls ? m.tool_calls.length + ' 个' : '无'}`);
  if (m?.tool_calls) {
    m.tool_calls.forEach((tc, i) => {
      console.log(`    [${i}] ${tc.function.name}(${tc.function.arguments})`);
    });
  }
  console.log(`\n  ${m?.tool_calls?.length ? '✅ 工具调用解析成功' : '⚠️ 未产生工具调用（模型选择直接回答）'}`);
} else {
  console.log('  ❌', r1.raw?.slice(0, 200) || r1.error);
}

/* ---------- 流式 ---------- */
console.log('\n[2] 流式 + tools');
const r2 = await request({
  model: 'mimo-v2.6-flash',
  messages: [{ role: 'user', content: '搜索 src 目录下的所有 TypeScript 文件' }],
  tools: TOOLS,
  stream: true,
});

console.log(`  HTTP ${r2.status} | ${r2.ms}ms`);
if (r2.status === 200) {
  const frames = r2.raw.split('\n\n').filter(f => f.trim());
  let toolCalls = 0, finishReason = null, content = '';

  frames.forEach(f => {
    const p = f.replace(/^data:\s*/, '').trim();
    if (p === '[DONE]') return;
    try {
      const o = JSON.parse(p);
      const ch = o.choices?.[0];
      if (ch?.finish_reason) finishReason = ch.finish_reason;
      if (ch?.delta?.tool_calls) toolCalls += ch.delta.tool_calls.length;
      if (ch?.delta?.content) content += ch.delta.content;
    } catch {}
  });

  console.log(`  帧数: ${frames.length}`);
  console.log(`  finish_reason: ${finishReason}`);
  console.log(`  tool_calls 帧数: ${toolCalls}`);
  console.log(`  content: ${JSON.stringify(content.slice(0, 60))}`);
  console.log(`  未把 XML 当正文输出: ${content.includes('<tool_call>') ? '❌ 仍含 XML' : '✅'}`);
  console.log(`\n  ${finishReason === 'tool_calls' ? '✅ 流式工具调用正常' : '⚠️ finish_reason=' + finishReason}`);
} else {
  console.log('  ❌', r2.error);
}

/* ---------- 不带 tools（对照）---------- */
console.log('\n[3] 不带 tools（对照）');
const r3 = await request({
  model: 'mimo-v2.6-flash',
  messages: [{ role: 'user', content: '说一句话' }],
  stream: false,
});
if (r3.status === 200) {
  const j = JSON.parse(r3.raw);
  console.log(`  finish_reason: ${j.choices?.[0]?.finish_reason}`);
  console.log(`  content: ${JSON.stringify(String(j.choices?.[0]?.message?.content ?? '').slice(0, 50))}`);
  console.log(`  tool_calls: ${j.choices?.[0]?.message?.tool_calls ? '有（异常）' : '无 ✅'}`);
}

console.log('\n═══════════════════════════════════════════');
