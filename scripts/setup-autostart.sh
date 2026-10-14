#!/usr/bin/env bash
# 配置 mimoapi 开机自启（可选）
#
# 两种方式：
#   1) shell 自启：打开 WSL 终端时自动拉起（轻量，推荐）
#   2) 不配置：需要时手动 mimoapi start
set -e

MARKER="# >>> mimoapi autostart >>>"
MODE="${1:-on}"

if [ "$MODE" = "off" ]; then
  if grep -q "$MARKER" "$HOME/.bashrc" 2>/dev/null; then
    # 删除标记段落
    sed -i '/# >>> mimoapi autostart >>>/,/# <<< mimoapi autostart <<</d' "$HOME/.bashrc"
    echo "✅ 已关闭自启"
  else
    echo "ℹ️  未配置自启"
  fi
  exit 0
fi

if grep -q "$MARKER" "$HOME/.bashrc" 2>/dev/null; then
  echo "ℹ️  已配置过自启，跳过"
  exit 0
fi

cat >> "$HOME/.bashrc" <<'EOF'

# >>> mimoapi autostart >>>
# 打开 WSL 终端时，若 mimoapi 未运行则在后台启动
if command -v mimoapi >/dev/null 2>&1; then
  if [ -f "$HOME/mimoapi/dist/index.js" ]; then
    if ! (mimoapi status 2>/dev/null | grep -q "运行中"); then
      (mimoapi start >/dev/null 2>&1 &) >/dev/null 2>&1 || true
    fi
  fi
fi
# <<< mimoapi autostart <<<
EOF

echo "✅ 已开启自启（打开 WSL 终端时自动启动服务）"
echo ""
echo "   关闭自启: bash ~/mimoapi/scripts/setup-autostart.sh off"
