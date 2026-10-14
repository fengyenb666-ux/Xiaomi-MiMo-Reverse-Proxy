/**
 * 分析 SSE 流的严格性
 *
 * 找出为什么桌面客户端认为 "Stream ended without finish_reason"。
 * 对比 OpenAI 官方格式与我们的实际输出。
 */

import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8788';
const db = new DatabaseSync(path.join(os.homedir(), 'mimoapi', 'data', 'mimo.db'));
const acc = db.prepare('SELECT api_key FROM accounts WHERE is_active = 1 LIMIT 1').get();
db.close();

if (!acc) { console.log('无账号'); process.exit(1); }

console.log('=== 抓取原始 SSE（逐帧）===\n');
const res = await fetch(BASE + '/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + acc.api_key },
  body: JSON.stringify({
    model: 'mimo-v2.6-flash',
    messages: [{ role: 'user', content: '说：你好' }],
    stream: true,
  }),
});

console.log('HTTP', res.status);
console.log('Content-Type:', res.headers.get('content-type'));
console.log('Transfer-Encoding:', res.headers.get('transfer-encoding'));
console.log('');

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
const frames = [];

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';
  for (const l of lines) {
    if (l.trim()) frames.push(l);
  }
}
if (buf.trim()) frames.push(buf);

console.log('=== 全部帧（前 5 + 后 6）===');
const show = [...frames.slice(0, 5), '...', ...frames.slice(-6)];
show.forEach((f, i) => console.log(`  ${String(i).padStart(2)}: ${f.slice(0, 150)}`));

console.log('\n=== 结构分析 ===');
const dataFrames = frames.filter(f => f.startsWith('data:'));
console.log('  总行数:', frames.length);
console.log('  data 帧:', dataFrames.length);
console.log('  空行:', frames.filter(f => !f.trim()).length);

const doneFrame = frames.find(f => f.includes('[DONE]'));
console.log('  [DONE] 帧:', doneFrame ? '存在' : '❌ 缺失');

// 检查最后一个 JSON 帧
const jsonFrames = dataFrames.filter(f => !f.includes('[DONE]'));
const last = jsonFrames[jsonFrames.length - 1];
console.log('\n=== 最后一个 JSON 帧 ===');
if (last) {
  const obj = JSON.parse(last.slice(5).trim());
  console.log(JSON.stringify(obj, null, 2).split('\n').map(l => '  ' + l).join('\n'));

  console.log('\n=== 严格客户端校验点 ===');
  const ch = obj.choices?.[0];
  console.log('  choices[0] 存在:', ch ? '✅' : '❌');
  console.log('  finish_reason 值:', JSON.stringify(ch?.finish_reason));
  console.log('  finish_reason 非空:', ch?.finish_reason ? '✅' : '❌ ← 客户端可能因此报错');
  console.log('  delta 为空对象:', ch?.delta && Object.keys(ch.delta).length === 0 ? '✅（规范要求）' : '⚠️');
  console.log('  usage 字段存在:', obj.usage ? '✅' : '❌');
  console.log('  object 类型:', obj.object);
}

console.log('\n=== 对比 OpenAI 官方格式要求 ===');
console.log('  官方流式结尾应为:');
console.log('    data: {"id":"...","object":"chat.completion.chunk","created":...,"model":"...",');
console.log('           "choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}');
console.log('    data: [DONE]');
console.log('');
console.log('  注意: 官方格式中 usage 出现在 finish 帧是 OpenAI 的 stream_options 扩展，');
console.log('        部分严格客户端解析到未知字段可能报错。');
