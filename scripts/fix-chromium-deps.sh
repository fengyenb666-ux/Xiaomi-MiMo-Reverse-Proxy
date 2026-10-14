#!/usr/bin/env bash
#
# 无需 sudo 补齐 Chromium 依赖
#
# 思路：从 Ubuntu 源下载所需 .deb 包，解压到用户目录，
# 通过 LD_LIBRARY_PATH 让 Chromium 找到这些库。
#
set -euo pipefail

LIBDIR="$HOME/.local/chromium-libs"
EXTRACT="$LIBDIR/extract"
CHROME_BIN="$HOME/.local/chromium/chrome-linux/chrome"

echo "==> 补齐 Chromium 依赖（无需 sudo）"

# 自动识别系统代号
. /etc/os-release 2>/dev/null || true
SUITE="${UBUNTU_CODENAME:-${VERSION_CODENAME:-noble}}"
MIRROR="http://archive.ubuntu.com/ubuntu"

echo "    系统: ${PRETTY_NAME:-未知} (代号 $SUITE)"
echo "    库目录: $LIBDIR"

if [ ! -f "$CHROME_BIN" ]; then
  echo "❌ 未找到 Chromium: $CHROME_BIN"
  echo "   请先运行 install-chromium.sh"
  exit 1
fi

mkdir -p "$EXTRACT"

# ---------- 1. 找出缺失的库 ----------
MISSING_LIBS=$(ldd "$CHROME_BIN" 2>/dev/null | grep "not found" | awk '{print $1}' | sort -u || true)

if [ -z "$MISSING_LIBS" ]; then
  echo "    ✅ 没有缺失的库"
  exit 0
fi

echo ""
echo "==> 缺失的库:"
echo "$MISSING_LIBS" | sed 's/^/      - /'

# ---------- 2. 库名 → 包名 ----------
map_lib_to_pkg() {
  case "$1" in
    libasound.so.2)             echo "libasound2t64" ;;
    libnspr4.so)                echo "libnspr4" ;;
    libnss3.so|libnssutil3.so|libsmime3.so|libssl3.so|libsoftokn3.so|libpkcs11.so)
                                echo "libnss3" ;;
    libatk-1.0.so.0)            echo "libatk1.0-0t64" ;;
    libatk-bridge-2.0.so.0)     echo "libatk-bridge2.0-0t64" ;;
    libcups.so.2)               echo "libcups2t64" ;;
    libdrm.so.2)                echo "libdrm2" ;;
    libxkbcommon.so.0)          echo "libxkbcommon0" ;;
    libXcomposite.so.1)         echo "libxcomposite1" ;;
    libXdamage.so.1)            echo "libXdamage1" ;;
    libXfixes.so.3)             echo "libxfixes3" ;;
    libXrandr.so.2)             echo "libxrandr2" ;;
    libgbm.so.1)                echo "libgbm1" ;;
    libpango-1.0.so.0)          echo "libpango-1.0-0" ;;
    libpangocairo-1.0.so.0)     echo "libpango-1.0-0" ;;
    libcairo.so.2)              echo "libcairo2" ;;
    libatspi.so.0)              echo "libatspi2.0-0t64" ;;
    libX11.so.6)                echo "libx11-6" ;;
    libxcb.so.1)                echo "libxcb1" ;;
    libXext.so.6)               echo "libxext6" ;;
    libXrender.so.1)            echo "libxrender1" ;;
    libexpat.so.1)              echo "libexpat1" ;;
    libdbus-1.so.3)             echo "libdbus-1-3" ;;
    libglib-2.0.so.0)           echo "libglib2.0-0t64" ;;
    libpcre2-8.so.0)            echo "libpcre2-8-0" ;;
    *)                          echo "" ;;
  esac
}

PKGS=""
for lib in $MISSING_LIBS; do
  pkg=$(map_lib_to_pkg "$lib")
  if [ -n "$pkg" ]; then
    PKGS="$PKGS $pkg"
  else
    echo "      ⚠️  未知库: $lib"
  fi
done
PKGS=$(echo "$PKGS" | tr ' ' '\n' | sort -u | grep -v '^$' || true)

[ -z "$PKGS" ] && { echo "❌ 无法确定需要的包"; exit 1; }

echo ""
echo "==> 需要下载: $(echo "$PKGS" | tr '\n' ' ')"

# ---------- 3. 下载并解压 ----------
echo ""
echo "==> 下载并解压 .deb"
cd "$EXTRACT"

# 缓存 Package 索引，避免重复下载
fetch_index() {
  local comp="$1"
  local cache="$EXTRACT/.Packages-$comp"
  if [ ! -f "$cache" ]; then
    curl -sS -m 60 "$MIRROR/dists/$SUITE/$comp/binary-amd64/Packages.gz" 2>/dev/null \
      | gunzip 2>/dev/null > "$cache" || return 1
  fi
  echo "$cache"
}

for pkg in $PKGS; do
  echo "    → $pkg"

  FOUND=""
  for comp in main universe; do
    IDX=$(fetch_index "$comp" 2>/dev/null || echo "")
    [ -z "$IDX" ] && continue
    URL=$(awk -v p="$pkg" '
      /^Package: /{pk=$2}
      /^Filename: /{if(pk==p){print $2; exit}}
    ' "$IDX")
    if [ -n "$URL" ]; then
      FOUND="$MIRROR/$URL"
      break
    fi
  done

  if [ -z "$FOUND" ]; then
    echo "      ⚠️  索引中未找到，跳过"
    continue
  fi

  DEB="$EXTRACT/$(basename "$FOUND")"
  if ! curl -fsSL -m 180 -o "$DEB" "$FOUND" 2>/dev/null; then
    echo "      ⚠️  下载失败"
    continue
  fi

  # 优先用 dpkg-deb（能处理 zst 等新格式）
  if command -v dpkg-deb >/dev/null 2>&1; then
    dpkg-deb -x "$DEB" "$EXTRACT/root" 2>/dev/null && echo "      ✅ 解压成功 (dpkg-deb)"
  elif command -v ar >/dev/null 2>&1; then
    ( cd "$EXTRACT" && ar x "$DEB" 2>/dev/null )
    for f in "$EXTRACT"/data.tar.*; do
      [ -f "$f" ] || continue
      mkdir -p "$EXTRACT/root"
      tar -xf "$f" -C "$EXTRACT/root" 2>/dev/null && echo "      ✅ 解压成功 (ar+tar)"
      rm -f "$f"
    done
    rm -f "$EXTRACT"/control.tar.* "$EXTRACT"/debian-binary
  else
    echo "      ⚠️  缺少解压工具"
  fi
  rm -f "$DEB"
done

# ---------- 4. 汇总 ----------
echo ""
echo "==> 汇总库文件"
mkdir -p "$LIBDIR/lib"
if [ -d "$EXTRACT/root" ]; then
  find "$EXTRACT/root" \( -name "*.so*" -o -name "*.bin" \) 2>/dev/null \
    -exec cp -a {} "$LIBDIR/lib/" \; 2>/dev/null || true
fi

COUNT=$(find "$LIBDIR/lib" -name "*.so*" 2>/dev/null | wc -l)
echo "    收集到 $COUNT 个库文件"
[ "$COUNT" -eq 0 ] && { echo "❌ 未收集到库文件"; exit 1; }

# ---------- 5. 生成包装脚本 ----------
WRAPPER="$HOME/.local/bin/chromium"
mkdir -p "$HOME/.local/bin"
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
export LD_LIBRARY_PATH="$LIBDIR/lib:\${LD_LIBRARY_PATH:-}"
exec "$CHROME_BIN" "\$@"
EOF
chmod +x "$WRAPPER"

# ---------- 6. 验证 ----------
echo ""
echo "==> 验证"
export LD_LIBRARY_PATH="$LIBDIR/lib:${LD_LIBRARY_PATH:-}"
REMAIN=$(ldd "$CHROME_BIN" 2>/dev/null | grep "not found" | awk '{print $1}' | sort -u || true)
if [ -z "$REMAIN" ]; then
  echo "    ✅ 依赖已全部满足"
  "$CHROME_BIN" --version 2>/dev/null || true
else
  echo "    ⚠️  仍缺失:"
  echo "$REMAIN" | sed 's/^/      - /'
fi

# 清理索引缓存
rm -f "$EXTRACT"/.Packages-* 2>/dev/null || true

echo ""
echo "==> 完成"
echo "    包装命令: $WRAPPER"
