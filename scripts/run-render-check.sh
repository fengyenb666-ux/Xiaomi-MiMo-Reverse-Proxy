#!/usr/bin/env bash
# 运行响应式渲染验证
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.local/bin"
cd "$HOME/mimoapi" || exit 1
exec node scripts/verify-responsive-render.mjs
