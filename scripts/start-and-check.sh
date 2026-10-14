#!/usr/bin/env bash
# 启动服务并验证
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.local/bin"
cd "$HOME/mimoapi" || exit 1

echo "=== 停止旧实例 ==="
for d in /proc/[0-9]*; do
  p=${d#/proc/}
  [ "$p" = "$$" ] && continue
  [ "$p" = "$PPID" ] && continue
  cmd=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null) || continue
  case "$cmd" in
    *node*dist/index.js*) case "$cmd" in *bash*|*sh\ -*) continue ;; esac
      kill -9 "$p" 2>/dev/null && echo "  结束 PID $p" ;;
  esac
done
sleep 2

echo ""
echo "=== 启动 ==="
mkdir -p data
export PORT=8788
export MIMO_BROWSER_PATH="$HOME/.local/chromium/chrome-linux/chrome"
export LD_LIBRARY_PATH="$HOME/.local/chromium-libs/lib:${LD_LIBRARY_PATH:-}"

setsid nohup node dist/index.js >> data/mimoapi.log 2>&1 < /dev/null &
NEW=$!
echo "$NEW" > data/mimoapi.pid

sleep 5
if kill -0 "$NEW" 2>/dev/null; then
  echo "  ✅ 已启动 PID $NEW"
else
  echo "  ❌ 启动失败，日志:"
  tail -25 data/mimoapi.log
  exit 1
fi

echo ""
echo "=== 就绪检查 ==="
for i in $(seq 1 10); do
  sleep 1
  if curl -s -m 3 -o /dev/null http://127.0.0.1:8788/health 2>/dev/null; then
    echo "  ✅ 就绪 (${i}s)"
    break
  fi
done

echo ""
echo "=== 启动日志关键行 ==="
tail -30 data/mimoapi.log | grep -E "数据库|账号|健康检查|迁移|已补充|启动|模型"

echo ""
echo "=== 数据库状态 ==="
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.env.HOME+'/mimoapi/data/mimo.db');
const cols=db.prepare('PRAGMA table_info(accounts)').all().map(c=>c.name);
console.log('  priority 列: '+(cols.includes('priority')?'✅':'❌'));
const idx=db.prepare(\"SELECT name FROM sqlite_master WHERE type='index' AND name='idx_accounts_priority'\").get();
console.log('  priority 索引: '+(idx?'✅':'❌'));
const rows=db.prepare('SELECT alias,user_id,health_status,priority,is_active FROM accounts').all();
console.log('  账号数: '+rows.length);
rows.forEach(r=>console.log('    '+r.alias+' | uid='+r.user_id+' | '+r.health_status+' | prio='+r.priority+' | active='+r.is_active));
db.close();
" 2>&1
