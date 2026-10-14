#!/usr/bin/env bash
# 端到端测试健康检查功能
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.local/bin"
BASE="http://127.0.0.1:8788"

echo "═══════════════════════════════════════════"
echo " 健康检查功能测试"
echo "═══════════════════════════════════════════"

echo ""
echo "[1] 健康检查配置接口"
curl -s -m 10 "$BASE/admin/health" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{
    const j=JSON.parse(s);
    console.log('  启用:', j.config.enabled);
    console.log('  间隔:', j.config.intervalSec, '秒');
    console.log('  连续失败停用阈值:', j.config.autoDisableAfter);
    console.log('  超时:', j.config.timeoutMs, 'ms');
    console.log('  汇总:', JSON.stringify(j.summary));
  }catch(e){console.log('  解析失败:', s.slice(0,200));}
});"

echo ""
echo "[2] 添加测试账号（假凭证，预期健康检查判为 expired）"
RESP=$(curl -s -m 30 -X POST "$BASE/admin/accounts" \
  -H 'Content-Type: application/json' \
  -d '{"serviceToken":"health_test_token","userId":"999","phToken":"health_ph","alias":"健康检查测试"}')
echo "$RESP" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{
    const j=JSON.parse(s);
    console.log('  创建:', j.created ? '新建' : '更新');
    console.log('  API Key:', j.apiKey);
    if (j.health) {
      console.log('  健康检查:', j.health.ok ? '✅ 在线' : '❌ ' + j.health.status);
      console.log('  延迟:', j.health.latencyMs + 'ms');
      if (j.health.error) console.log('  错误:', j.health.error.slice(0,80));
    } else {
      console.log('  ⚠️ 未返回健康检查结果');
    }
  }catch(e){console.log('  解析失败:', s.slice(0,300));}
});"

echo ""
echo "[3] 账号列表中的健康状态"
curl -s -m 10 "$BASE/admin/accounts" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{
    const j=JSON.parse(s);
    (j.accounts||[]).forEach(a=>{
      console.log('  ' + (a.alias||'未命名') + ':');
      console.log('    健康状态:', a.healthStatus);
      console.log('    连续失败:', a.consecutiveFailures);
      console.log('    检查次数:', a.checkCount);
      console.log('    最近延迟:', a.lastLatencyMs, 'ms');
      console.log('    来源:', a.source);
    });
    console.log('  汇总:', JSON.stringify(j.stats.health));
  }catch(e){console.log('  解析失败');}
});"

echo ""
echo "[4] 账号健康历史"
AID=$(curl -s -m 10 "$BASE/admin/accounts" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{const j=JSON.parse(s);console.log(j.accounts?.[0]?.id||'');}catch(e){console.log('');}
});")
if [ -n "$AID" ]; then
  curl -s -m 10 "$BASE/admin/health/$AID" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{
    const j=JSON.parse(s);
    console.log('  账号:', j.account.alias);
    console.log('  状态:', j.account.healthStatus);
    console.log('  历史记录数:', (j.history||[]).length);
    (j.history||[]).slice(0,3).forEach(h=>{
      console.log('    ' + h.time.slice(11,19) + ' ' + (h.ok?'✅':'❌') + ' ' + h.latencyMs + 'ms ' + (h.error||'').slice(0,50));
    });
  }catch(e){console.log('  解析失败');}
});"
fi

echo ""
echo "[5] 手动触发全量检查"
curl -s -m 60 -X POST "$BASE/admin/health/check" \
  -H 'Content-Type: application/json' -d '{}' | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{
    const j=JSON.parse(s);
    const r=j.result||{};
    console.log('  检查:', r.checked, '| 在线:', r.ok, '| 异常:', r.failed, '| 自动停用:', r.disabled);
    (r.details||[]).forEach(d=>console.log('    ' + (d.alias||d.id.slice(0,8)) + ': ' + (d.ok?'✅':'❌') + ' ' + d.status + ' ' + d.latencyMs + 'ms'));
  }catch(e){console.log('  解析失败:', s.slice(0,200));}
});"

echo ""
echo "[6] 修改轮询配置"
curl -s -m 10 -X PATCH "$BASE/admin/health/config" \
  -H 'Content-Type: application/json' \
  -d '{"intervalSec":120,"autoDisableAfter":5}' | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{const j=JSON.parse(s);console.log('  新间隔:', j.config.intervalSec, '秒 | 停用阈值:', j.config.autoDisableAfter);}
  catch(e){console.log('  解析失败');}
});"

echo ""
echo "[7] 清理测试账号"
if [ -n "$AID" ]; then
  curl -s -m 10 -X DELETE "$BASE/admin/accounts/$AID" >/dev/null
  echo "  已删除测试账号"
fi

echo ""
echo "═══════════════════════════════════════════"
