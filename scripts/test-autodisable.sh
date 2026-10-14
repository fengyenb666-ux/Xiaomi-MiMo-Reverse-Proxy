#!/usr/bin/env bash
# 测试自动停用机制
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.local/bin"
BASE="http://127.0.0.1:8788"

echo "=== 测试：连续失败自动停用 ==="
echo ""

# 设置为 2 次失败即停用
curl -s -m 10 -X PATCH "$BASE/admin/health/config" \
  -H 'Content-Type: application/json' \
  -d '{"autoDisableAfter":2}' >/dev/null
echo "已将阈值设为 2 次"

# 添加假账号
RESP=$(curl -s -m 30 -X POST "$BASE/admin/accounts" \
  -H 'Content-Type: application/json' \
  -d '{"serviceToken":"autodisable_test","userId":"888","phToken":"ph","alias":"自动停用测试"}')
AID=$(echo "$RESP" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).account.id)}catch(e){console.log('')}})")
echo "账号 ID: $AID"

show_state() {
  curl -s -m 10 "$BASE/admin/accounts" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{
    const a=(JSON.parse(s).accounts||[]).find(x=>x.id==='$AID');
    if(a) console.log('  状态='+a.healthStatus+' 连败='+a.consecutiveFailures+' 启用='+a.isActive);
  }catch(e){}
});"
}

echo ""
echo "第 1 次检查（添加时自动触发）:"
show_state

echo ""
echo "第 2 次检查:"
curl -s -m 60 -X POST "$BASE/admin/health/check" -H 'Content-Type: application/json' -d "{\"ids\":[\"$AID\"]}" >/dev/null
show_state

echo ""
echo "第 3 次检查（应触发自动停用）:"
curl -s -m 60 -X POST "$BASE/admin/health/check" -H 'Content-Type: application/json' -d "{\"ids\":[\"$AID\"]}" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{const r=JSON.parse(s).result;console.log('  本次检查: 检查='+r.checked+' 异常='+r.failed+' 自动停用='+r.disabled);}catch(e){}
});"
show_state

echo ""
echo "=== 恢复配置并清理 ==="
curl -s -m 10 -X PATCH "$BASE/admin/health/config" \
  -H 'Content-Type: application/json' -d '{"autoDisableAfter":3}' >/dev/null
curl -s -m 10 -X DELETE "$BASE/admin/accounts/$AID" >/dev/null
echo "已恢复阈值=3，清理测试账号"
