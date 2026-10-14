#!/usr/bin/env bash
#
# 下载免安装 Chromium 到用户目录（无需 sudo）
#
# 用于 WSL 环境：系统无浏览器、且 sudo 需要密码时，
# 从 Chromium 官方快照源下载独立的 headless shell。
#
set -euo pipefail

CHROMIUM_DIR="$HOME/.local/chromium"
BIN="$CHROMIUM_DIR/chrome"

echo "==> 安装 Chromium（免安装版）"
echo "    目标目录: $CHROMIUM_DIR"

mkdir -p "$CHROMIUM_DIR"

# ---------- 1. 获取可用的版本号 ----------
echo ""
echo "==> 1/4 获取最新可用版本"

# 使用 LAST_CHANGE 获取稳定版本
LAST_CHANGE=""
for base in \
  "https://storage.googleapis.com/chromium-browser-snapshots/Linux_x64" \
  ; do
  LAST_CHANGE=$(curl -fsSL -m 20 "$base/LAST_CHANGE" 2>/dev/null || echo "")
  [ -n "$LAST_CHANGE" ] && echo "    来源: $base" && break
done

if [ -z "$LAST_CHANGE" ]; then
  echo "❌ 无法获取 Chromium 版本号，请检查网络"
  exit 1
fi
echo "    版本: $LAST_CHANGE"

# ---------- 2. 下载 ----------
ZIP="$CHROMIUM_DIR/chrome-linux.zip"
URL="https://storage.googleapis.com/chromium-browser-snapshots/Linux_x64/${LAST_CHANGE}/chrome-linux.zip"

echo ""
echo "==> 2/4 下载 Chromium"
echo "    $URL"

if [ -f "$BIN" ]; then
  echo "    已存在，跳过下载"
else
  if ! curl -fL --progress-bar -o "$ZIP" "$URL"; then
    echo "❌ 下载失败"
    rm -f "$ZIP"
    exit 1
  fi
  echo "    下载完成: $(du -h "$ZIP" | cut -f1)"

  # ---------- 3. 解压 ----------
  echo ""
  echo "==> 3/4 解压"
  rm -rf "$CHROMIUM_DIR/chrome-linux"

  # unzip 可能未安装，依次尝试多种解压方式
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "$ZIP" -d "$CHROMIUM_DIR"
  elif command -v python3 >/dev/null 2>&1; then
    echo "    (使用 python3 解压)"
    python3 -c "
import zipfile, sys, os
zp = '$ZIP'
dst = '$CHROMIUM_DIR'
with zipfile.ZipFile(zp) as z:
    z.extractall(dst)
# 保留可执行权限
for root, dirs, files in os.walk(dst):
    for f in files:
        p = os.path.join(root, f)
        if f in ('chrome', 'chrome_sandbox', 'xdg-mime', 'xdg-settings') or 'chrome_crashpad' in f:
            os.chmod(p, 0o755)
print('    解压完成')
"
  elif command -v busybox >/dev/null 2>&1; then
    busybox unzip -q "$ZIP" -d "$CHROMIUM_DIR"
  else
    echo "❌ 没有可用的解压工具（unzip / python3 / busybox 均不可用）"
    exit 1
  fi
  rm -f "$ZIP"

  # 快照包里可执行文件名为 chrome
  if [ -f "$CHROMIUM_DIR/chrome-linux/chrome" ]; then
    ln -sf "$CHROMIUM_DIR/chrome-linux/chrome" "$BIN"
    chmod +x "$CHROMIUM_DIR/chrome-linux/chrome"
  else
    echo "❌ 解压后未找到 chrome 可执行文件"
    ls -la "$CHROMIUM_DIR/chrome-linux" | head -20
    exit 1
  fi
fi

# ---------- 4. 验证 ----------
echo ""
echo "==> 4/4 验证"
if "$BIN" --version 2>/dev/null; then
  echo "    ✅ Chromium 可用: $BIN"
else
  echo "    ⚠️  直接调用失败，尝试补齐依赖后重试"
  # 常见缺失库，尝试用已有权限处理
  if command -v ldd >/dev/null 2>&1; then
    MISSING=$(ldd "$CHROMIUM_DIR/chrome-linux/chrome" 2>/dev/null | grep "not found" | awk '{print $1}' | sort -u || true)
    if [ -n "$MISSING" ]; then
      echo "    缺失的库:"
      echo "$MISSING" | sed 's/^/      - /'
      echo ""
      echo "    这些是系统库，需要 sudo 安装。请手动执行："
      echo "      sudo apt-get update && sudo apt-get install -y \\"
      echo "        libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 \\"
      echo "        libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \\"
      echo "        libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 \\"
      echo "        libasound2t64 libatspi2.0-0t64 libx11-6 libxcb1 libxext6"
    fi
  fi
  exit 1
fi

echo ""
echo "==> 完成"
echo "    Chromium: $BIN"
echo ""
echo "    已自动设置到项目配置，重启服务即可生效:"
echo "      mimoapi restart"
