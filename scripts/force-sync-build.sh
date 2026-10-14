#!/usr/bin/env bash
# 强制全量同步 Windows 源码到 WSL 并重建
set -uo pipefail

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.local/bin"

SRC="/mnt/f/code/反代MIMO"
DST="$HOME/mimoapi"

echo "=== 1. 强制同步 ==="
# 不用 --delete，避免误删 WSL 侧的 node_modules 等
rsync -a \
  --exclude 'node_modules' --exclude 'dist' --exclude 'data' \
  --exclude '*.db' --exclude '*.db-shm' --exclude '*.db-wal' \
  --exclude '.npm-cache' --exclude '.npm-tmp' \
  "$SRC/" "$DST/" || {
    echo "  rsync 失败，改用 cp"
    for item in src public test docs scripts package.json tsconfig.json README.md install.sh; do
      [ -e "$SRC/$item" ] && cp -r "$SRC/$item" "$DST/"
    done
  }
echo "  完成"

echo ""
echo "=== 2. 校验同步结果 ==="
check() {
  local file="$1" pattern="$2" label="$3"
  if grep -q "$pattern" "$DST/$file" 2>/dev/null; then
    echo "  ✅ $label"
  else
    echo "  ❌ $label（$file 中未找到 $pattern）"
  fi
}

check "src/db.ts"        "migrateColumns"    "db.ts 含列迁移"
check "src/db.ts"        "health_checks"     "db.ts 含 health_checks 表"
check "src/health.ts"    "checkAllAccounts"  "health.ts 存在"
check "src/accounts.ts"  "healthStatus"      "accounts.ts 含健康字段"
check "src/index.ts"     "admin/health"      "index.ts 含健康接口"

echo ""
echo "=== 3. 清理并重建 ==="
cd "$DST" || exit 1
rm -rf dist
npm run build
if [ ! -f dist/index.js ]; then
  echo "  ❌ 构建失败"
  exit 1
fi
echo "  ✅ 构建完成"

echo ""
echo "=== 4. 校验构建产物 ==="
grep -q "migrateColumns" dist/db.js && echo "  ✅ dist/db.js 含迁移" || echo "  ❌ dist/db.js 缺迁移"
grep -q "health_checks" dist/db.js  && echo "  ✅ dist/db.js 含新表" || echo "  ❌ dist/db.js 缺新表"
grep -q "admin/health" dist/index.js && echo "  ✅ dist/index.js 含健康接口" || echo "  ❌ dist/index.js 缺接口"
