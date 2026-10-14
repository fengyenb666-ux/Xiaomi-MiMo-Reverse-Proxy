#!/usr/bin/env bash
# 部署 MiMo 反代到 WSL 的 ~/mimoapi
set -e

SRC="/mnt/f/code/反代MIMO"
DEST="$HOME/mimoapi"

echo "==> 部署到 $DEST"

# 创建目标目录
mkdir -p "$DEST"

# 复制源码（排除 Windows 侧的 node_modules / dist / data / 缓存）
echo "    复制项目文件..."
rsync -a --delete \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'data' \
  --exclude '.npm-cache' \
  --exclude '.npm-tmp' \
  --exclude '*.db' \
  --exclude '*.db-shm' \
  --exclude '*.db-wal' \
  "$SRC/" "$DEST/" 2>/dev/null || {
    echo "    rsync 不可用，改用 cp"
    rm -rf "$DEST"
    mkdir -p "$DEST"
    cd "$SRC"
    for item in src public test docs scripts package.json tsconfig.json README.md .gitignore; do
      [ -e "$item" ] && cp -r "$item" "$DEST/"
    done
  }

echo "    文件清单:"
cd "$DEST"
find . -type f -not -path './node_modules/*' -not -path './data/*' | sort | head -30

echo ""
echo "==> 部署完成: $DEST"
