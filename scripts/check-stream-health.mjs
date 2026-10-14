/**
 * 定位挂起位置：逐步测试
 */

import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

const db = new DatabaseSync(path.join(os.homedir(), 'mimoapi', 'data', 'mimo.db'));
const acc = db.prepare('SELECT api_key FROM accounts WHERE is_active = 1 LIMIT 1').get();
db.close();

function test(name, body, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const t0 = Date.now();
    let resolved = false;

    const done = (result) => {
      if (resolved) return;
      resolved = true;
      resolve({ name, ms: Date.now() - t0, ...result });
    };

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
        res.on('end', () => done({ status: res.statusCode, headers: res.headers, bytes: raw.length, raw }));
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      done({ status: 'TIMEOUT', error: `超过 ${timeoutMs}ms 无响应` });
    });
    req.on('error', (e) => done({ status: 'ERROR', error: e.message }));
    req.write(payload);
    req.end();
  });
}

console.log('=== 逐步定位挂起位置 ===\n');

// 1. 非流式（最简）
const r1 = await test('非流式短对话', {
  model: 'mimo-v2.6-flash',
  messages: [{ role: 'user', content: 'hi' }],
  stream: false,
}, 45000);
console.log(`[1] 非流式: ${r1.status} | ${r1.ms}ms | ${r1.bytes ?? 0} 字节`);
if (r1.error) console.log(`    错误: ${r1.error}`);
if (r1.status === 200 && r1.raw) {
  try {
    const j = JSON.parse(r1.raw);
    console.log(`    回复: ${JSON.stringify(j.choices?.[0]?.message?.content?.slice(0, 40))}`);
  } catch {}
}

// 2. 流式（怀疑点）
const r2 = await test('流式短对话', {
  model: 'mimo-v2.6-flash',
  messages: [{ role: 'user', content: 'hi' }],
  stream: true,
}, 45000);
console.log(`\n[2] 流式: ${r2.status} | ${r2.ms}ms | ${r2.bytes ?? 0} 字节`);
if (r2.error) {
  console.log(`    错误: ${r2.error}`);
} else {
  console.log(`    openai-version: ${r2.headers?.['openai-version'] ?? '(无)'}`);
  console.log(`    x-request-id: ${r2.headers?.['x-request-id'] ?? '(无)'}`);
  if (r2.raw) {
    const frames = r2.raw.split('\n\n').filter(f => f.trim());
    console.log(`    帧数: ${frames.length}`);
    console.log(`    末帧: ${frames.at(-1)?.slice(0, 60)}`);
  }
}

console.log('\n=== 结论 ===');
if (r1.status === 200 && r2.status !== 200) {
  console.log('  ❌ 非流式正常，流式挂起 → 问题在流式路径');
} else if (r1.status !== 200) {
  console.log('  ❌ 非流式也异常 → 问题在通用路径');
} else {
  console.log('  ✅ 两种模式都正常');
}
