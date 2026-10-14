#!/usr/bin/env bash
# 最终诊断：确认为什么命令行输入 mimoapi 找不到
echo "═══════════════════════════════════════════"
echo "  诊断报告"
echo "═══════════════════════════════════════════"

echo ""
echo "[1] 命令文件是否存在"
if [ -f "$HOME/.local/bin/mimoapi" ]; then
  echo "    ✅ $HOME/.local/bin/mimoapi"
  ls -la "$HOME/.local/bin/mimoapi"
else
  echo "    ❌ 文件不存在"
fi

echo ""
echo "[2] 新开一个「登录交互式」shell 时是否可用"
echo "    （这模拟你重新打开终端的情况）"
if bash -lic 'command -v mimoapi' >/dev/null 2>&1; then
  echo "    ✅ 可用: $(bash -lic 'command -v mimoapi' 2>/dev/null)"
else
  echo "    ❌ 不可用"
fi

echo ""
echo "[3] 当前这个非交互 shell 是否可用"
if command -v mimoapi >/dev/null 2>&1; then
  echo "    ✅ 可用"
else
  echo "    ❌ 不可用（非交互 shell 不读 .bashrc，属正常现象）"
fi

echo ""
echo "[4] ~/.local/bin 是否在当前 PATH 中"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) echo "    ✅ 已包含" ;;
  *) echo "    ❌ 未包含" ;;
esac

echo ""
echo "[5] 结论"
if bash -lic 'command -v mimoapi' >/dev/null 2>&1; then
  echo "    ✅ 配置正确！你只需重新打开终端，"
  echo "       或在当前终端执行:  source ~/.bashrc"
else
  echo "    ❌ 配置有问题，需要检查 .bashrc"
fi
echo ""
