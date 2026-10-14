#!/usr/bin/env bash
# 干净重建 WSL 项目（完整输出，不掩盖错误）
set -uo pipefail

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.local/bin"
cd "$HOME/mimoapi" || exit 1

echo "=== 环境 ==="
echo "  node: $(command -v node) $(node --version)"
echo "  npm:  $(command -v npm)"
echo "  cwd:  $(pwd)"

echo ""
echo "=== 校验源码含最新修复 ==="
grep -q "migrateColumns" src/db.ts && echo "  ✅ db.ts 含迁移函数" || echo "  ❌ 缺迁移函数"
grep -q "idx_accounts_priority" src/db.ts && echo "  ✅ 索引移到迁移之后" || echo "  ❌ 索引顺序未修复"
grep -q "isUsable" src/accounts.ts && echo "  ✅ accounts.ts 含主备逻辑" || echo "  ❌ 缺主备逻辑"
grep -q "moveAccountPriority" src/accounts.ts && echo "  ✅ 含优先级排序函数" || echo "  ❌ 缺排序函数"

echo ""
echo "=== 清理旧产物 ==="
rm -rf dist
echo "  已删除 dist/"

echo ""
echo "=== 构建（完整输出）==="
npm run build
BUILD_RC=$?
echo "  构建退出码: $BUILD_RC"

echo ""
echo "=== 验证产物 ==="
FAIL=0
for f in index.js accounts.js db.js health.js capture.js logger.js mimo/client.js; do
  if [ -f "dist/$f" ]; then
    echo "  ✅ dist/$f"
  else
    echo "  ❌ 缺失 dist/$f"
    FAIL=1
  fi
done

grep -q "idx_accounts_priority" dist/db.js 2>/dev/null && echo "  ✅ dist/db.js 含索引修复" || { echo "  ❌ dist/db.js 缺索引修复"; FAIL=1; }
grep -q "isUsable" dist/accounts.js 2>/dev/null && echo "  ✅ dist/accounts.js 含主备逻辑" || { echo "  ❌ dist/accounts.js 缺主备逻辑"; FAIL=1; }

if [ "$FAIL" = "1" ]; then
  echo ""
  echo "❌ 构建验证失败"
  exit 1
fi

echo ""
echo "✅ 构建完成且验证通过"
