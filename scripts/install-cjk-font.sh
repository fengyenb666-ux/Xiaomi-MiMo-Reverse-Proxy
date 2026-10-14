#!/usr/bin/env bash
# 安装中文字体（用于截图渲染），无需 sudo
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.local/bin"

FONTDIR="$HOME/.local/share/fonts"
mkdir -p "$FONTDIR"

echo "=== 检查现有中文字体 ==="
if fc-list :lang=zh 2>/dev/null | head -3 | grep -q .; then
  echo "  已有中文字体:"
  fc-list :lang=zh 2>/dev/null | head -3
  exit 0
fi
echo "  无中文字体，尝试安装..."

# 从 Ubuntu 源下载 fonts-noto-cjk（体积较大）或 fonts-wqy-zenhei（较小）
WORK=$(mktemp -d)
cd "$WORK" || exit 1

SUITE="${UBUNTU_CODENAME:-${VERSION_CODENAME:-noble}}"
MIRROR="http://archive.ubuntu.com/ubuntu"

found=""
for pkg in fonts-wqy-zenhei fonts-wqy-microhei fonts-noto-cjk; do
  echo "  查找 $pkg ..."
  for comp in main universe; do
    IDX="$WORK/.idx-$comp"
    [ -f "$IDX" ] || curl -sS -m 60 "$MIRROR/dists/$SUITE/$comp/binary-amd64/Packages.gz" 2>/dev/null | gunzip > "$IDX" 2>/dev/null
    URL=$(awk -v p="$pkg" '/^Package: /{pk=$2} /^Filename: /{if(pk==p){print $2; exit}}' "$IDX" 2>/dev/null)
    if [ -n "$URL" ]; then
      echo "    找到: $URL"
      if curl -fsSL -m 180 -o "$pkg.deb" "$MIRROR/$URL" 2>/dev/null; then
        if dpkg-deb -x "$pkg.deb" "$WORK/root" 2>/dev/null; then
          echo "    ✅ 已解压 $pkg"
          found="$found $pkg"
        fi
      fi
      break
    fi
  done
  [ -n "$found" ] && break
done

if [ -n "$found" ]; then
  # 收集字体文件
  find "$WORK/root" \( -name "*.ttf" -o -name "*.ttc" -o -name "*.otf" \) 2>/dev/null \
    -exec cp {} "$FONTDIR/" \; 2>/dev/null
  COUNT=$(ls -1 "$FONTDIR" 2>/dev/null | wc -l)
  echo "  已安装 $COUNT 个字体文件"
  command -v fc-cache >/dev/null 2>&1 && fc-cache -f "$FONTDIR" >/dev/null 2>&1
  echo "  ✅ 字体缓存已更新"
else
  echo "  ⚠️ 未能安装中文字体（不影响功能，仅影响截图显示）"
fi

rm -rf "$WORK"
