#!/usr/bin/env bash
# 安装 Linux 版 Node.js 到 ~/.local（无需 sudo）
set -e

NODE_VERSION="${1:-v24.22.0}"
ARCH="linux-x64"
PKG="node-${NODE_VERSION}-${ARCH}"
MIRROR="https://npmmirror.com/mirrors/node/${NODE_VERSION}/${PKG}.tar.xz"

echo "==> 安装 Node ${NODE_VERSION} (${ARCH})"
echo "    来源: ${MIRROR}"

mkdir -p "$HOME/.local"
cd /tmp

if [ -f "${PKG}.tar.xz" ]; then
  echo "    使用已下载的包"
else
  echo "    下载中..."
  curl -fL --progress-bar -o "${PKG}.tar.xz" "$MIRROR"
fi

echo "    解压到 ~/.local ..."
rm -rf "$HOME/.local/${PKG}"
tar -xf "${PKG}.tar.xz" -C "$HOME/.local"

# 创建软链接到 ~/.local/bin
mkdir -p "$HOME/.local/bin"
ln -sf "$HOME/.local/${PKG}/bin/node" "$HOME/.local/bin/node"
ln -sf "$HOME/.local/${PKG}/bin/npm"  "$HOME/.local/bin/npm"
ln -sf "$HOME/.local/${PKG}/bin/npx"  "$HOME/.local/bin/npx"

echo "==> 完成"
"$HOME/.local/bin/node" --version
"$HOME/.local/bin/npm" --version

# 清理
rm -f "/tmp/${PKG}.tar.xz"
