/**
 * 新 UI 视觉验证：多视口截图 + 设计令牌核对
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = path.join(os.homedir(), '.local/chromium/chrome-linux/chrome');
process.env.LD_LIBRARY_PATH =
  `${path.join(os.homedir(), '.local/chromium-libs/lib')}:${process.env.LD_LIBRARY_PATH || ''}`;

const URL = 'http://127.0.0.1:8788/admin';
const OUT = path.join(os.homedir(), 'mimoapi/data/shots2');
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: 'mobile-390', width: 390, height: 844 },
  { name: 'tablet-834', width: 834, height: 1112 },
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'wide-1920', width: 1920, height: 1080 },
];

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  env: { ...process.env },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

console.log('═══════════════════════════════════════════');
console.log(' 新 UI 验证');
console.log('═══════════════════════════════════════════');

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
  });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);

  const m = await page.evaluate(() => {
    const de = document.documentElement;
    const cs = getComputedStyle(document.documentElement);

    // 圆角检查：找出所有非零圆角
    const nonZero = [];
    document.querySelectorAll('*').forEach((el) => {
      const r = getComputedStyle(el).borderRadius;
      if (r && !/^0(px)?(\s+0(px)?)*$/.test(r)) {
        nonZero.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 30), r });
      }
    });

    // 按钮样式
    const btn = document.querySelector('.btn');
    const card = document.querySelector('.card');
    const stat = document.querySelector('.stat');

    return {
      scrollWidth: de.scrollWidth,
      clientWidth: de.clientWidth,
      primary: cs.getPropertyValue('--primary').trim(),
      foreground: cs.getPropertyValue('--foreground').trim(),
      radius: cs.getPropertyValue('--radius').trim(),
      fontFamily: getComputedStyle(document.body).fontFamily.split(',')[0],
      btnRadius: btn ? getComputedStyle(btn).borderRadius : null,
      btnBg: btn ? getComputedStyle(btn).backgroundColor : null,
      cardBorder: card ? getComputedStyle(card).border : null,
      cardRadius: card ? getComputedStyle(card).borderRadius : null,
      statBorderRight: stat ? getComputedStyle(stat).borderRight : null,
      nonZeroCount: nonZero.length,
      nonZeroSamples: nonZero.slice(0, 5),
      headerHeight: document.querySelector('.header')?.offsetHeight,
    };
  });

  const overflow = m.scrollWidth > m.clientWidth + 2;
  console.log(`\n[${vp.name}] ${vp.width}×${vp.height}`);
  console.log(`  横向溢出: ${overflow ? '❌ ' + (m.scrollWidth - m.clientWidth) + 'px' : '✅ 无'}`);
  console.log(`  顶栏高度: ${m.headerHeight}px`);
  console.log(`  按钮圆角: ${m.btnRadius} | 卡片圆角: ${m.cardRadius}`);
  console.log(`  非零圆角元素: ${m.nonZeroCount} 个` + (m.nonZeroCount ? ' ⚠️' : ' ✅'));
  if (m.nonZeroCount) m.nonZeroSamples.forEach(s => console.log(`      <${s.tag} class="${s.cls}"> ${s.r}`));

  await page.screenshot({ path: path.join(OUT, `${vp.name}.png`), fullPage: false });
  await ctx.close();
}

// 设计令牌核对（只做一次）
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

const tokens = await page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  const keys = ['--primary','--primary-foreground','--foreground','--background','--card',
                '--muted','--muted-foreground','--border','--success','--destructive',
                '--brand','--radius','--header-height'];
  const o = {};
  keys.forEach(k => o[k] = cs.getPropertyValue(k).trim());
  return o;
});

console.log('\n═══════════════════════════════════════════');
console.log(' 设计令牌实际值');
console.log('═══════════════════════════════════════════');
Object.entries(tokens).forEach(([k, v]) => console.log(`  ${k.padEnd(24)} ${v}`));

console.log('\n 对照目标设计:');
const expect = {
  '--primary': '#18181b',
  '--foreground': '#09090b',
  '--muted-foreground': '#71717a',
  '--border': '#e4e4e7',
  '--radius': '0px',
  '--header-height': '3.5rem',
};
let ok = 0;
Object.entries(expect).forEach(([k, want]) => {
  const got = tokens[k];
  const match = got === want;
  if (match) ok++;
  console.log(`  ${match ? '✅' : '❌'} ${k}: ${got} ${match ? '' : '(期望 ' + want + ')'}`);
});
console.log(`\n  匹配度: ${ok}/${Object.keys(expect).length}`);

await browser.close();
console.log(`\n  截图: ${OUT}`);
console.log('═══════════════════════════════════════════');
