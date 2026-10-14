#!/usr/bin/env bash
#
# 完整部署最新版本到 WSL
#
# 流程：同步源码 → 校验 → 清理重建 → 重启服务 → 验证
#
set -uo pipefail

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.local/bin"

SRC="/mnt/f/code/反代MIMO"
DST="$HOME/mimoapi"
PORT=8788

echo "═══════════════════════════════════════════════"
echo " 部署最新版本到 WSL"
echo "═══════════════════════════════════════════════"
echo "  源目录: $SRC"
echo "  目标:   $DST"
echo ""

# ============ 1. 停止服务 ============
echo "==> 1/6 停止现有服务"

# 精确结束 node 进程（避免 pkill -f 误杀脚本自身）
for d in /proc/[0-9]*; do
  p=${d#/proc/}
  [ "$p" = "$$" ] && continue
  [ "$p" = "$PPID" ] && continue
  cmd=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null) || continue
  case "$cmd" in
    *node*dist/index.js*)
      case "$cmd" in *bash*|*sh\ -*) continue ;; esac
      echo "    结束 PID $p"
      kill "$p" 2>/dev/null || true
      ;;
  esac
done
sleep 2

# 强制清理残留
for d in /proc/[0-9]*; do
  p=${d#/proc/}
  [ "$p" = "$$" ] && continue
  cmd=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null) || continue
  case "$cmd" in
    *node*dist/index.js*)
      case "$cmd" in *bash*|*sh\ -*) continue ;; esac
      kill -9 "$p" 2>/dev/null || true
      ;;
  esac
done
rm -f "$DST/data/mimoapi.pid"
echo "    已停止"

# ============ 2. 同步源码 ============
echo ""
echo "==> 2/6 同步源码"

if [ ! -d "$SRC" ]; then
  echo "    ❌ 源目录不存在: $SRC"
  exit 1
fi

# 保留 WSL 侧的 data/ 和 node_modules/，其余全量同步
rsync -a \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'data' \
  --exclude '.git' \
  --exclude '.npm-cache' \
  --exclude '.npm-tmp' \
  --exclude '*.db' --exclude '*.db-shm' --exclude '*.db-wal' \
  --exclude '*.broken' \
  "$SRC/" "$DST/" && echo "    rsync 完成" || {
    echo "    rsync 失败，改用 cp"
    for item in src public test docs scripts package.json tsconfig.json README.md CONTRIBUTING.md LICENSE install.sh .gitignore .gitattributes; do
      if [ -e "$SRC/$item" ]; then
        rm -rf "$DST/$item"
        cp -r "$SRC/$item" "$DST/"
      fi
    done
    echo "    cp 完成"
  }

# 清理 WSL 中已删除的脚本（rsync 未用 --delete，需手动同步 scripts 目录）
if [ -d "$SRC/scripts" ]; then
  rsync -a --delete \
    --exclude '*.broken' \
    "$SRC/scripts/" "$DST/scripts/" 2>/dev/null && echo "    scripts 目录已同步（含删除）"
fi

# ============ 3. 校验同步结果 ============
echo ""
echo "==> 3/6 校验同步"

FAIL=0
check_file() {
  local f="$1"
  if [ -f "$DST/$f" ]; then
    echo "    ✅ $f"
  else
    echo "    ❌ 缺失 $f"
    FAIL=1
  fi
}

for f in src/index.ts src/db.ts src/health.ts src/accounts.ts src/capture.ts \
         src/logger.ts src/mimo/client.ts src/mimo/serialize.ts src/mimo/session.ts \
         public/index.html package.json tsconfig.json README.md LICENSE CONTRIBUTING.md; do
  check_file "$f"
done

# 关键内容校验
echo ""
echo "    内容校验:"
grep -q "migrateColumns" "$DST/src/db.ts"     && echo "      ✅ db.ts 含列迁移"
grep -q "checkAllAccounts" "$DST/src/health.ts" && echo "      ✅ health.ts 含健康检查"
grep -q "admin/health" "$DST/src/index.ts"    && echo "      ✅ index.ts 含健康接口"
grep -q "@media" "$DST/public/index.html"     && echo "      ✅ 面板含响应式断点"

if [ "$FAIL" = "1" ]; then
  echo ""
  echo "    ❌ 同步不完整，中止"
  exit 1
fi

# ============ 4. 重建 ============
echo ""
echo "==> 4/6 清理并重建"
cd "$DST" || exit 1

rm -rf dist
npm run build 2>&1 | tail -5

if [ ! -f dist/index.js ]; then
  echo "    ❌ 构建失败"
  exit 1
fi

echo "    构建产物:"
for f in index.js accounts.js db.js health.js capture.js logger.js; do
  [ -f "dist/$f" ] && echo "      ✅ dist/$f"
done

# ============ 5. 启动服务 ============
echo ""
echo "==> 5/6 启动服务"

mkdir -p data
export PORT
export MIMO_BROWSER_PATH="$HOME/.local/chromium/chrome-linux/chrome"
export LD_LIBRARY_PATH="$HOME/.local/chromium-libs/lib:${LD_LIBRARY_PATH:-}"

setsid nohup node dist/index.js >>"$DST/data/mimoapi.log" 2>&1 < /dev/null &
NEW_PID=$!
echo "$NEW_PID" > "$DST/data/mimoapi.pid"

sleep 4
if kill -0 "$NEW_PID" 2>/dev/null; then
  echo "    ✅ 服务已启动 (PID $NEW_PID)"
else
  echo "    ❌ 启动失败"
  tail -20 "$DST/data/mimoapi.log"
  exit 1
fi

# 等待就绪
for i in $(seq 1 10); do
  sleep 1
  if curl -s -m 3 -o /dev/null "http://127.0.0.1:$PORT/health" 2>/dev/null; then
    echo "    ✅ 就绪 (${i}s)"
    break
  fi
done

# ============ 6. 验证 ============
echo ""
echo "==> 6/6 验证"

echo "    接口:"
for ep in /health /admin /admin/accounts /admin/health /admin/api-info; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -m 10 "http://127.0.0.1:$PORT$ep")
  if [ "$code" = "200" ]; then
    echo "      ✅ $ep"
  else
    echo "      ❌ $ep (HTTP $code)"
  fi
done

echo ""
echo "    数据库:"
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.env.HOME+'/mimoapi/data/mimo.db');
const t=db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map(r=>r.name);
console.log('      表: '+t.join(', '));
const n=db.prepare('SELECT COUNT(*) c FROM accounts').get().c;
console.log('      账号数: '+n);
db.close();
" 2>/dev/null

echo ""
echo "    模型:"
curl -s -m 25 "http://127.0.0.1:$PORT/v1/models" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{const j=JSON.parse(s);console.log('      ✅ '+j.data.length+' 个 chat 模型');}
  catch(e){console.log('      ⚠️ 解析失败');}
});" 2>/dev/null

echo ""
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo "═══════════════════════════════════════════════"
echo " 部署完成"
echo "═══════════════════════════════════════════════"
echo ""
echo "  访问地址:"
echo "    Windows:  http://localhost:$PORT/admin"
echo "    WSL:      http://127.0.0.1:$PORT/admin"
[ -n "$IP" ] && echo "    局域网:   http://$IP:$PORT/admin"
echo ""
