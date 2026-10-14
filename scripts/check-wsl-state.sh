#!/usr/bin/env bash
# 检查 WSL 部署完整状态
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.local/bin"

echo "=== 1. 命令文件 ==="
if [ -f "$HOME/.local/bin/mimoapi" ]; then
  echo "  ✅ $HOME/.local/bin/mimoapi ($(stat -c%s "$HOME/.local/bin/mimoapi") bytes)"
  echo "  修改时间: $(stat -c%y "$HOME/.local/bin/mimoapi")"
else
  echo "  ❌ 不存在"
fi

echo ""
echo "=== 2. PATH 是否含 ~/.local/bin ==="
case ":$PATH:" in
  *":$HOME/.local/bin:"*) echo "  ✅ 已包含" ;;
  *) echo "  ❌ 未包含（当前 PATH 前段: $(echo $PATH | cut -c1-60)...）" ;;
esac

echo ""
echo "=== 3. shell 配置中的 PATH 设置 ==="
grep -c "mimoapi PATH" "$HOME/.bashrc" 2>/dev/null && echo "  .bashrc 已配置" || echo "  .bashrc 未配置"
grep -c "mimoapi PATH" "$HOME/.profile" 2>/dev/null && echo "  .profile 已配置" || echo "  .profile 未配置"

echo ""
echo "=== 4. 服务进程 ==="
if pgrep -f "dist/index.js" >/dev/null 2>&1; then
  echo "  运行中:"
  ps aux | grep "dist/index" | grep -v grep | head -2
else
  echo "  ⚠️  未运行"
fi

echo ""
echo "=== 5. 端口 ==="
ss -lntp 2>/dev/null | grep 8788 || echo "  8788 未监听"

echo ""
echo "=== 6. 源码同步状态（对比 Windows 侧）==="
for f in src/index.ts src/db.ts src/health.ts src/accounts.ts src/capture.ts public/index.html README.md; do
  if [ -f "$HOME/mimoapi/$f" ] && [ -f "/mnt/f/code/反代MIMO/$f" ]; then
    w=$(stat -c%s "/mnt/f/code/反代MIMO/$f" 2>/dev/null)
    l=$(stat -c%s "$HOME/mimoapi/$f" 2>/dev/null)
    if [ "$w" = "$l" ]; then
      echo "  ✅ $f"
    else
      echo "  ⚠️  $f   Windows=$w  WSL=$l"
    fi
  fi
done

echo ""
echo "=== 7. 构建产物 ==="
ls -la "$HOME/mimoapi/dist/"*.js 2>/dev/null | head -8

echo ""
echo "=== 8. 数据库 ==="
ls -la "$HOME/mimoapi/data/mimo.db" 2>/dev/null || echo "  数据库不存在"
