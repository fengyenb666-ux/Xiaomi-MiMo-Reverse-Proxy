#!/usr/bin/env bash
#
# MiMo 反向代理 · 一键安装脚本（WSL / Linux）
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/<用户>/<仓库>/main/install.sh | bash
#
# 或指定源目录（本地安装）：
#   bash install.sh --source /mnt/f/code/反代MIMO
#
set -euo pipefail

# ==================== 配置 ====================
APP_NAME="mimoapi"
APP_DIR="$HOME/mimoapi"
BIN_DIR="$HOME/.local/bin"
NODE_VERSION="${NODE_VERSION:-v24.22.0}"

# 源码来源：优先环境变量，其次参数，最后尝试 git clone
SRC_DIR="${MIMO_SRC:-}"
REPO_URL="${MIMO_REPO:-}"

# 颜色
if [ -t 1 ]; then
  R='\033[0;31m'; G='\033[0;32m'; Y='\033[0;33m'; B='\033[0;34m'; N='\033[0m'
else
  R=''; G=''; Y=''; B=''; N=''
fi

info()  { echo -e "${B}==>${N} $*"; }
ok()    { echo -e "    ${G}✅${N} $*"; }
warn()  { echo -e "    ${Y}⚠️${N}  $*"; }
err()   { echo -e "    ${R}❌${N} $*"; }
die()   { err "$*"; exit 1; }

# ==================== 参数解析 ====================
while [ $# -gt 0 ]; do
  case "$1" in
    --source) SRC_DIR="$2"; shift 2 ;;
    --repo)   REPO_URL="$2"; shift 2 ;;
    --help|-h)
      cat <<EOF
MiMo 反向代理 · 安装脚本

用法:
  install.sh [选项]

选项:
  --source <目录>   从本地目录安装（开发用）
  --repo <URL>      从 git 仓库克隆安装
  --help            显示帮助

环境变量:
  MIMO_SRC          同 --source
  MIMO_REPO         同 --repo
  NODE_VERSION      Node 版本（默认 v24.22.0）
  PORT              服务端口（默认 8788）
EOF
      exit 0 ;;
    *) die "未知参数: $1（用 --help 查看用法）" ;;
  esac
done

echo ""
echo "  ╔══════════════════════════════════════════════════╗"
echo "  ║      MiMo 反向代理 · 一键安装                     ║"
echo "  ╚══════════════════════════════════════════════════╝"
echo ""

# ==================== 1. 环境检查 ====================
info "1/6 检查系统环境"

if [ "$(uname -s)" != "Linux" ]; then
  die "此脚本用于 Linux / WSL。Windows 请直接运行 npm start"
fi
ok "系统: $(uname -s) $(uname -m)"

if [ -f /etc/os-release ]; then
  . /etc/os-release
  ok "发行版: ${PRETTY_NAME:-未知}"
fi

# ==================== 2. 安装 Node ====================
info "2/6 检查 Node.js"

need_node=1
if command -v node >/dev/null 2>&1; then
  CUR_MAJOR=$(node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/')
  if [ -n "$CUR_MAJOR" ] && [ "$CUR_MAJOR" -ge 22 ]; then
    # 必须确认是 Linux 版（不是 Windows 挂载的 exe 包装）
    NODE_REAL=$(command -v node)
    case "$NODE_REAL" in
      /mnt/*) warn "检测到 Windows 版 Node（$NODE_REAL），将安装 Linux 版" ;;
      *)
        ok "已安装: $(node --version) ($NODE_REAL)"
        need_node=0
        ;;
    esac
  else
    warn "Node 版本过低 ($(node -v 2>/dev/null || echo 无))，需要 >= 22"
  fi
fi

if [ "$need_node" -eq 1 ]; then
  ok "下载 Node $NODE_VERSION ..."
  ARCH="linux-x64"
  [ "$(uname -m)" = "aarch64" ] && ARCH="linux-arm64"
  PKG="node-${NODE_VERSION}-${ARCH}"

  mkdir -p "$HOME/.local"
  TMP=$(mktemp -d)
  MIRRORS=(
    "https://npmmirror.com/mirrors/node/${NODE_VERSION}/${PKG}.tar.xz"
    "https://nodejs.org/dist/${NODE_VERSION}/${PKG}.tar.xz"
  )

  DL=0
  for M in "${MIRRORS[@]}"; do
    if curl -fL --progress-bar -o "$TMP/$PKG.tar.xz" "$M" 2>/dev/null; then
      DL=1; break
    fi
  done
  [ "$DL" -eq 1 ] || die "Node 下载失败，请检查网络"

  tar -xf "$TMP/$PKG.tar.xz" -C "$HOME/.local"
  rm -rf "$TMP"

  mkdir -p "$BIN_DIR"
  for b in node npm npx; do
    ln -sf "$HOME/.local/$PKG/bin/$b" "$BIN_DIR/$b"
  done
  export PATH="$BIN_DIR:$PATH"
  ok "Node 安装完成: $(node --version)"
fi

# ==================== 3. 获取源码 ====================
info "3/6 获取项目源码"

if [ -n "$SRC_DIR" ] && [ -d "$SRC_DIR" ]; then
  ok "从本地目录安装: $SRC_DIR"
  mkdir -p "$APP_DIR"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude 'node_modules' --exclude 'dist' --exclude 'data' \
      --exclude '.npm-cache' --exclude '.npm-tmp' \
      --exclude '*.db' --exclude '*.db-shm' --exclude '*.db-wal' \
      "$SRC_DIR/" "$APP_DIR/"
  else
    for item in src public test docs scripts package.json tsconfig.json README.md; do
      [ -e "$SRC_DIR/$item" ] && cp -r "$SRC_DIR/$item" "$APP_DIR/"
    done
  fi
elif [ -n "$REPO_URL" ]; then
  ok "从仓库克隆: $REPO_URL"
  if ! command -v git >/dev/null 2>&1; then
    die "需要 git，请先安装（sudo apt install git）"
  fi
  rm -rf "$APP_DIR"
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
else
  die "未指定源码来源。请用 --source <目录> 或 --repo <URL>，或设置 MIMO_SRC"
fi
ok "源码就绪: $APP_DIR"

# ==================== 4. 安装依赖并构建 ====================
info "4/6 安装依赖并构建"

cd "$APP_DIR"

# 使用国内镜像加速
if [ -z "${npm_config_registry:-}" ]; then
  npm config set registry https://registry.npmmirror.com >/dev/null 2>&1 || true
fi

npm install --no-audit --no-fund 2>&1 | tail -3
ok "依赖安装完成"

npm run build 2>&1 | tail -3
[ -f dist/index.js ] || die "构建失败"
ok "构建完成"

# ==================== 5. 安装 Chromium（可选） ====================
info "5/6 安装浏览器（用于自动抓取凭证）"

BROWSER_FOUND=""
for b in \
  "$HOME/.local/chromium/chrome-linux/chrome" \
  /usr/bin/google-chrome /usr/bin/chromium /usr/bin/chromium-browser
do
  [ -x "$b" ] && BROWSER_FOUND="$b" && break
done

if [ -n "$BROWSER_FOUND" ]; then
  ok "已存在浏览器: $BROWSER_FOUND"
else
  warn "未找到浏览器，尝试安装免安装版 Chromium（约 240MB）"
  if [ -f "$APP_DIR/scripts/install-chromium.sh" ]; then
    if bash "$APP_DIR/scripts/install-chromium.sh" >/tmp/mimo-chromium.log 2>&1; then
      ok "Chromium 安装完成"
      # 补齐依赖
      if [ -f "$APP_DIR/scripts/fix-chromium-deps.sh" ]; then
        bash "$APP_DIR/scripts/fix-chromium-deps.sh" >>/tmp/mimo-chromium.log 2>&1 \
          && ok "依赖补齐完成" \
          || warn "依赖补齐未完全成功，详见 /tmp/mimo-chromium.log"
      fi
    else
      warn "Chromium 安装失败，详见 /tmp/mimo-chromium.log"
      warn "不影响使用，可用「手动粘贴 cURL」方式添加账号"
    fi
  fi
fi

# ==================== 6. 安装命令 ====================
info "6/6 安装 $APP_NAME 命令"

mkdir -p "$BIN_DIR"
cp "$APP_DIR/scripts/mimoapi" "$BIN_DIR/$APP_NAME"
chmod +x "$BIN_DIR/$APP_NAME"
ok "命令已安装: $BIN_DIR/$APP_NAME"

# 配置 PATH（.bashrc + .profile 双写，幂等）
MARK_B="# >>> mimoapi PATH >>>"
MARK_E="# <<< mimoapi PATH <<<"
PATH_BLOCK="$MARK_B
case \":\$PATH:\" in
  *\":\$HOME/.local/bin:\"*) ;;
  *) export PATH=\"\$HOME/.local/bin:\$PATH\" ;;
esac
$MARK_E"

for f in "$HOME/.bashrc" "$HOME/.profile"; do
  touch "$f"
  grep -qF "$MARK_B" "$f" 2>/dev/null && sed -i "\|$MARK_B|,\|$MARK_E|d" "$f"
  printf '\n%s\n' "$PATH_BLOCK" >> "$f"
done
ok "PATH 已配置（.bashrc + .profile）"

# ==================== 完成 ====================
echo ""
echo "  ╔══════════════════════════════════════════════════╗"
echo "  ║                 安装完成 ✅                        ║"
echo "  ╚══════════════════════════════════════════════════╝"
echo ""
echo "  下一步："
echo ""
echo "    1. 让命令生效（当前终端）："
echo "         source ~/.bashrc"
echo "       （或直接重开一个终端）"
echo ""
echo "    2. 启动服务："
echo "         mimoapi"
echo ""
echo "    3. 打开管理面板："
echo "         http://localhost:8788/admin"
echo ""
echo "  其他命令："
echo "    mimoapi start    后台启动"
echo "    mimoapi status   查看状态"
echo "    mimoapi help     全部命令"
echo ""
