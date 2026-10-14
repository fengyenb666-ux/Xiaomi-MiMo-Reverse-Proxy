#!/usr/bin/env bash
# 最终完整验收
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.local/bin"
BASE="http://127.0.0.1:8788"
PASS=0; FAIL=0
ok(){ echo "  ✅ $1"; PASS=$((PASS+1)); }
bad(){ echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo "═══════════════════════════════════════════"
echo " MiMo 反代 · 最终验收"
echo "═══════════════════════════════════════════"

echo ""
echo "[1] 命令与环境"
command -v mimoapi >/dev/null && ok "mimoapi 命令: $(command -v mimoapi)" || bad "mimoapi 缺失"
[ -x "$HOME/.local/chromium/chrome-linux/chrome" ] && ok "Chromium 已安装" || bad "Chromium 缺失"
node -e "require('node:sqlite')" 2>/dev/null && ok "node:sqlite 可用" || bad "node:sqlite 不可用"

echo ""
echo "[2] 服务接口"
for ep in /health /admin /admin/accounts /admin/health /admin/api-info /admin/logs /admin/config; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -m 10 "$BASE$ep")
  [ "$code" = "200" ] && ok "$ep" || bad "$ep (HTTP $code)"
done

echo ""
echo "[3] 数据库结构"
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.env.HOME+'/mimoapi/data/mimo.db');
const t=db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map(r=>r.name);
const need=['accounts','logs','settings','health_checks'];
const miss=need.filter(x=>!t.includes(x));
console.log(miss.length? '  ❌ 缺表: '+miss.join(','): '  ✅ 四张表齐全');
const cols=db.prepare('PRAGMA table_info(accounts)').all().map(c=>c.name);
const needCols=['health_status','last_checked_at','consecutive_failures','check_count','source'];
const missCols=needCols.filter(x=>!cols.includes(x));
console.log(missCols.length? '  ❌ 缺列: '+missCols.join(','): '  ✅ 健康字段齐全');
db.close();
" 2>/dev/null

echo ""
echo "[4] 健康检查功能"
curl -s -m 10 "$BASE/admin/health" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{
    const j=JSON.parse(s);
    const c=j.config;
    console.log('  ✅ 配置: 启用='+c.enabled+' 间隔='+c.intervalSec+'s 阈值='+c.autoDisableAfter);
    console.log('  ✅ 汇总: 在线='+j.summary.online+' 离线='+j.summary.offline+' 过期='+j.summary.expired);
  }catch(e){console.log('  ❌ 解析失败');}
});"

echo ""
echo "[5] 面板 UI"
P=$(curl -s -m 15 "$BASE/admin")
for k in "账号健康检查" "立即检测全部" "healthBadge" "openModal"; do
  echo "$P" | grep -q "$k" && ok "面板含 $k" || bad "面板缺 $k"
done

echo ""
echo "[6] 单元测试"
cd "$HOME/mimoapi"
R1=$(node --experimental-strip-types test/think-parser.test.ts 2>&1 | grep -oP '\d+(?= 通过)' || echo 0)
R2=$(node --experimental-strip-types test/parse-credential.test.ts 2>&1 | grep -oP '\d+(?= 通过)' || echo 0)
[ "$R1" = "22" ] && ok "思考链测试 22/22" || bad "思考链测试 $R1/22"
[ "$R2" = "16" ] && ok "凭证解析测试 16/16" || bad "凭证解析测试 $R2/16"

echo ""
echo "═══════════════════════════════════════════"
echo " 结果: $PASS 通过, $FAIL 失败"
echo "═══════════════════════════════════════════"
exit $FAIL
