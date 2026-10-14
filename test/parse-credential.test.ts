/**
 * 凭证解析器单元测试
 *
 * 运行：node --experimental-strip-types test/parse-credential.test.ts
 */

import { parseCredential } from '../src/accounts.ts';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log('\n=== 凭证解析测试 ===\n');

// 1. 标准 cURL（单引号 Cookie，ph 在 URL）
const curl1 = `curl 'https://aistudio.xiaomimimo.com/open-apis/bot/chat?xiaomichatbot_ph=PHVALUE123' \\
  -H 'Cookie: serviceToken=STVALUE456; userId=1234567890; xiaomichatbot_ph="PHVALUE123"' \\
  -H 'Content-Type: application/json' \\
  --data-raw '{"query":"hi"}'`;
const r1 = parseCredential(curl1);
check('标准 cURL 解析成功', r1.ok === true, r1.error);
check('  serviceToken 正确', r1.data?.serviceToken === 'STVALUE456', r1.data?.serviceToken);
check('  userId 正确', r1.data?.userId === '1234567890', r1.data?.userId);
check('  phToken 正确', r1.data?.phToken === 'PHVALUE123', r1.data?.phToken);

// 2. 双引号 Cookie
const curl2 = `curl "https://aistudio.xiaomimimo.com/open-apis/bot/chat?xiaomichatbot_ph=PH2" -H "Cookie: serviceToken=ST2; userId=U2"`;
const r2 = parseCredential(curl2);
check('双引号 cURL', r2.ok && r2.data?.serviceToken === 'ST2', r2.error);

// 3. -b 形式
const curl3 = `curl 'https://x/chat' -b 'serviceToken=ST3; userId=U3; xiaomichatbot_ph=PH3'`;
const r3 = parseCredential(curl3);
check('-b Cookie 形式', r3.ok && r3.data?.serviceToken === 'ST3', r3.error);
check('  phToken 来自 Cookie', r3.data?.phToken === 'PH3', r3.data?.phToken);

// 4. 裸 Cookie 字符串
const r4 = parseCredential('serviceToken=ST4; userId=U4; xiaomichatbot_ph=PH4');
check('裸 Cookie 字符串', r4.ok && r4.data?.serviceToken === 'ST4', r4.error);

// 5. ph 仅在 URL（Cookie 里没有）
const curl5 = `curl 'https://aistudio.xiaomimimo.com/open-apis/bot/chat?xiaomichatbot_ph=ONLYURL' -H 'Cookie: serviceToken=ST5; userId=U5'`;
const r5 = parseCredential(curl5);
check('ph 回退到 URL query', r5.ok && r5.data?.phToken === 'ONLYURL', r5.data?.phToken);

// 6. URL 编码的 ph
const curl6 = `curl 'https://x/chat?xiaomichatbot_ph=abc%2Bdef%3D' -H 'Cookie: serviceToken=ST6'`;
const r6 = parseCredential(curl6);
check('URL 解码 ph', r6.ok && r6.data?.phToken === 'abc+def=', r6.data?.phToken);

// 7. 缺少 serviceToken → 报错
const r7 = parseCredential(`curl 'https://x/chat' -H 'Cookie: userId=U7'`);
check('缺 serviceToken 报错', r7.ok === false && !!r7.error, JSON.stringify(r7));

// 8. 空输入
const r8 = parseCredential('');
check('空输入报错', r8.ok === false, JSON.stringify(r8));

// 9. 无 Cookie（模拟 Chrome 130+ 剥离）
const r9 = parseCredential(`curl 'https://aistudio.xiaomimimo.com/open-apis/bot/chat?xiaomichatbot_ph=P' -H 'Content-Type: application/json'`);
check('无 Cookie 给出提示', r9.ok === false && (r9.error?.includes('Cookie') ?? false), r9.error);

// 10. 无 userId 仍可成功（userId 非强校验）
const r10 = parseCredential(`curl 'https://x/chat' -H 'Cookie: serviceToken=ST10'`);
check('缺 userId 仍成功', r10.ok === true, r10.error);
check('  userId 为空串', r10.data?.userId === '', JSON.stringify(r10.data));

// 11. 真实格式（带引号变体）
const curl11 = `curl 'https://aistudio.xiaomimimo.com/open-apis/bot/chat?xiaomichatbot_ph=%22PH11%22' \\
 -H 'Cookie: serviceToken=ST11; xiaomichatbot_serviceToken="ST11"; userId=U11; xiaomichatbot_ph="PH11"; xiaomichatbot_ph=PH11'`;
const r11 = parseCredential(curl11);
check('复杂真实格式', r11.ok && r11.data?.serviceToken === 'ST11', r11.error);

console.log(`\n${'='.repeat(40)}`);
console.log(`结果: ${passed} 通过, ${failed} 失败`);
console.log(`${'='.repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
