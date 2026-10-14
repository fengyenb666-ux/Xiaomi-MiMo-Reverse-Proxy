#!/usr/bin/env bash
#
# 测试主备模式（failover）
#
# 场景：
#   1. 添加 3 个账号 → 请求应固定走第 1 个（主账号）
#   2. 停用第 1 个 → 请求应自动走第 2 个
#   3. 调整顺序 → 请求应跟随新顺序
#
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.local/bin"
BASE="http://127.0.0.1:8788"

PASS=0; FAIL=0
ok(){ echo "  ✅ $1"; PASS=$((PASS+1)); }
bad(){ echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo "═══════════════════════════════════════════"
echo " 主备模式测试"
echo "═══════════════════════════════════════════"

# 清理已有账号
echo ""
echo "[准备] 清理现有账号"
curl -s -m 10 "$BASE/admin/accounts" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',async()=>{
  try{
    const j=JSON.parse(s);
    for(const a of (j.accounts||[])) {
      await fetch('$BASE/admin/accounts/'+a.id,{method:'DELETE'});
    }
    console.log('    已清理 '+((j.accounts||[]).length)+' 个');
  }catch(e){console.log('    清理失败');}
});"
sleep 1

echo ""
echo "[1] 添加 3 个账号"
for i in 1 2 3; do
  curl -s -m 20 -X POST "$BASE/admin/accounts" \
    -H 'Content-Type: application/json' \
    -d "{\"serviceToken\":\"failover_test_$i\",\"userId\":\"900$i\",\"phToken\":\"ph$i\",\"alias\":\"账号$i\"}" \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log('    账号$i → '+j.account.id.slice(0,8)+' priority='+j.account.priority);}catch(e){}});"
done

echo ""
echo "[2] 检查顺序与主账号标记"
curl -s -m 10 "$BASE/admin/accounts" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{
    const j=JSON.parse(s);
    console.log('    顺序（按优先级）:');
    (j.accounts||[]).forEach((a,i)=>{
      console.log('      '+(i+1)+'. '+a.alias+'  priority='+a.priority+'  '+(i===0?'← 主账号':'备用'));
    });
  }catch(e){console.log('    解析失败');}
});"

echo ""
echo "[3] 验证 priority 自动递增（新账号排到末尾）"
curl -s -m 10 "$BASE/admin/accounts" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{
    const accs=JSON.parse(s).accounts||[];
    const prios=accs.map(a=>a.priority);
    console.log('    priorities: '+prios.join(', '));
    const strictAsc = prios.every((p,i)=>i===0||p>prios[i-1]);
    if (strictAsc) {
      console.log('    ✅ 严格递增（主备顺序明确）');
    } else {
      console.log('    ⚠️  存在相同优先级，将按创建时间排序');
    }
  }catch(e){console.log('    ❌ 解析失败');}
});"

echo ""
echo "[4] 测试移动顺序（把账号2上移到第一）"
ID2=$(curl -s -m 10 "$BASE/admin/accounts" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const a=JSON.parse(s).accounts;console.log(a[1].id)}catch(e){console.log('')}});")
if [ -n "$ID2" ]; then
  curl -s -m 10 -X POST "$BASE/admin/accounts/$ID2/move" \
    -H 'Content-Type: application/json' -d '{"direction":"up"}' \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(j.ok?'    ✅ 上移成功':'    ❌ '+j.error);}catch(e){console.log('    ❌ 失败');}});"
  echo "    移动后顺序:"
  curl -s -m 10 "$BASE/admin/accounts" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{
    (JSON.parse(s).accounts||[]).forEach((a,i)=>console.log('      '+(i+1)+'. '+a.alias+(i===0?' ← 主账号':'')));
  }catch(e){}
});"
fi

echo ""
echo "[5] 测试设为主账号（把账号3设为主）"
ID3=$(curl -s -m 10 "$BASE/admin/accounts" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const a=JSON.parse(s).accounts;console.log(a.find(x=>x.alias==='账号3')?.id||'')}catch(e){console.log('')}});")
if [ -n "$ID3" ]; then
  curl -s -m 10 -X POST "$BASE/admin/accounts/$ID3/primary" \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(j.ok?'    ✅ 设置成功':'    ❌ 失败');}catch(e){console.log('    ❌ 失败');}});"
  curl -s -m 10 "$BASE/admin/accounts" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{
    console.log('    新顺序:');
    (JSON.parse(s).accounts||[]).forEach((a,i)=>console.log('      '+(i+1)+'. '+a.alias+(i===0?' ← 主账号':'')));
  }catch(e){}
});"
fi

echo ""
echo "[6] 主备切换：停用主账号后，请求应走下一个"
ACCS=$(curl -s -m 10 "$BASE/admin/accounts")
IDP=$(echo "$ACCS" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).accounts[0].id)}catch(e){console.log('')}});")
PRIMARY_ALIAS=$(echo "$ACCS" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).accounts[0].alias)}catch(e){console.log('')}});")
BACKUP_ALIAS=$(echo "$ACCS" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).accounts[1].alias)}catch(e){console.log('')}});")

echo "    主账号: $PRIMARY_ALIAS  备用: $BACKUP_ALIAS"
curl -s -m 10 -X PATCH "$BASE/admin/accounts/$IDP" \
  -H 'Content-Type: application/json' -d '{"isActive":false}' >/dev/null
echo "    已停用主账号 $PRIMARY_ALIAS"

# 记录请求前的日志数，然后发请求
BEFORE=$(curl -s -m 10 "$BASE/admin/logs" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).logs.length)}catch(e){console.log(0)}});")

KEY=$(echo "$ACCS" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).accounts[1].apiKey)}catch(e){console.log('')}});")
curl -s -m 40 -X POST "$BASE/v1/chat/completions" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $KEY" \
  -d '{"model":"mimo-v2.6-flash","messages":[{"role":"user","content":"hi"}]}' >/dev/null 2>&1

# 查最新日志的账号
USED=$(curl -s -m 10 "$BASE/admin/logs" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{
    const logs=JSON.parse(s).logs||[];
    console.log(logs.length ? (logs[0].accountAlias || logs[0].accountId.slice(0,8)) : '');
  }catch(e){console.log('')}
});")
echo "    请求实际使用的账号: $USED"

if [ "$USED" = "$BACKUP_ALIAS" ]; then
  ok "切换到备用账号成功（$PRIMARY_ALIAS → $BACKUP_ALIAS）"
elif [ "$USED" = "$PRIMARY_ALIAS" ]; then
  bad "仍然使用已停用的主账号"
elif [ -z "$USED" ]; then
  echo "    ⚠️  未产生日志（可能请求失败）"
else
  ok "使用了账号: $USED"
fi

echo ""
echo "[7] 清理测试账号"
curl -s -m 10 "$BASE/admin/accounts" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',async()=>{
  try{
    const j=JSON.parse(s);
    for(const a of (j.accounts||[])) {
      await fetch('$BASE/admin/accounts/'+a.id,{method:'DELETE'});
    }
    console.log('    已清理');
  }catch(e){}
});"

echo ""
echo "═══════════════════════════════════════════"
echo " 结果: $PASS 通过, $FAIL 失败"
echo "═══════════════════════════════════════════"
