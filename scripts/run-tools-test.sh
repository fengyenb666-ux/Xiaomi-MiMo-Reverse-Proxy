#!/usr/bin/env bash
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.local/bin"
cd "$HOME/mimoapi" || exit 1
exec node scripts/test-tools-e2e.mjs
