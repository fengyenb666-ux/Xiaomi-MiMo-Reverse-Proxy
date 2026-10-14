// Windows 侧部署验证
const BASE = 'http://localhost:8788';

async function get(path) {
  const r = await fetch(BASE + path);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
}

console.log('=== 接口验证 ===');
for (const ep of ['/health', '/admin', '/admin/accounts', '/admin/health', '/admin/api-info', '/admin/logs', '/admin/config']) {
  try {
    const r = await get(ep);
    console.log(`  ${r.status === 200 ? '✅' : '❌'} ${ep} → HTTP ${r.status}`);
  } catch (e) {
    console.log(`  ❌ ${ep} → ${e.message}`);
  }
}

console.log('\n=== 服务信息 ===');
const cfg = await get('/admin/config');
if (cfg.json) {
  console.log('  平台:   ', cfg.json.platform);
  console.log('  浏览器: ', cfg.json.browser?.version || '(无)');
  console.log('  可执行: ', cfg.json.browser?.runnable);
  console.log('  数据库: ', cfg.json.database);
}

console.log('\n=== 健康检查 ===');
const h = await get('/admin/health');
if (h.json) {
  const c = h.json.config;
  console.log(`  启用=${c.enabled} 间隔=${c.intervalSec}s 阈值=${c.autoDisableAfter}次 超时=${c.timeoutMs}ms`);
  console.log(`  汇总: 在线=${h.json.summary.online} 离线=${h.json.summary.offline} 过期=${h.json.summary.expired} 未检测=${h.json.summary.unknown}`);
}

console.log('\n=== 面板响应式 ===');
const p = await get('/admin');
const media = (p.text.match(/@media/g) || []).length;
const clamp = (p.text.match(/clamp\(/g) || []).length;
const tables = (p.text.match(/<table>/g) || []).length;
const wraps = (p.text.match(/table-wrap/g) || []).length / 2;
console.log(`  大小: ${p.text.length} bytes`);
console.log(`  @media: ${media} 处  clamp(): ${clamp} 处`);
console.log(`  表格: ${tables} 个 / 包裹 ${wraps} 个  ${tables === wraps ? '✅' : '❌'}`);
const zhOk = /账号管理|健康检查/.test(p.text);
console.log(`  中文完整: ${zhOk ? '✅' : '❌'}`);

console.log('\n=== 模型 ===');
const m = await fetch(BASE + '/v1/models').then(r => r.json());
console.log(`  ✅ ${m.data.length} 个 chat 模型`);
console.log(`  示例: ${m.data.slice(0, 3).map(x => x.id).join(', ')}`);
