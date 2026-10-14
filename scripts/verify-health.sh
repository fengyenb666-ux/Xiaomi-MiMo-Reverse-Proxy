#!/usr/bin/env bash
# 验证健康检查功能与数据库迁移
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.local/bin"
cd "$HOME/mimoapi" || exit 1

cat > /tmp/verify-health.mjs <<'EOF'
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.homedir(), 'mimoapi', 'data', 'mimo.db');
const db = new DatabaseSync(dbPath);

console.log('=== 1. accounts 表列 ===');
const cols = db.prepare('PRAGMA table_info(accounts)').all().map(c => c.name);
cols.forEach(c => console.log('   ' + c));

const needed = ['health_status','last_checked_at','last_ok_at','last_latency_ms',
                'consecutive_failures','check_count','source'];
const missing = needed.filter(c => !cols.includes(c));
console.log(missing.length ? '   ❌ 缺少: ' + missing.join(', ') : '   ✅ 新增列齐全');

console.log('');
console.log('=== 2. 所有表 ===');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
tables.forEach(t => console.log('   ' + t.name));
console.log(tables.some(t => t.name === 'health_checks') ? '   ✅ health_checks 表已创建' : '   ❌ 缺 health_checks');

console.log('');
console.log('=== 3. health_checks 表结构 ===');
db.prepare('PRAGMA table_info(health_checks)').all().forEach(c =>
  console.log('   ' + c.name + ' ' + c.type));

console.log('');
console.log('=== 4. 索引 ===');
db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name").all()
  .forEach(i => console.log('   ' + i.name));

db.close();
EOF

node /tmp/verify-health.mjs
rm -f /tmp/verify-health.mjs
