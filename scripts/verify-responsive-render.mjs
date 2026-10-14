/**
 * 响应式布局渲染验证
 *
 * 用 Chromium 在多种视口宽度下打开管理面板，
 * 检查是否出现横向溢出，并截图对比。
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CHROME = path.join(os.homedir(), '.local/chromium/chrome-linux/chrome');
const LIB = path.join(os.homedir(), '.local/chromium-libs/lib');
process.env.LD_LIBRARY_PATH = `${LIB}:${process.env.LD_LIBRARY_PATH || ''}`;

const URL = 'http://127.0.0.1:8788/admin';
const OUT = path.join(os.homedir(), 'mimoapi/data/shots');
fs.mkdirSync(OUT, { recursive: true });

/** 要测试的视口（覆盖手机 → 超宽屏） */
const VIEWPORTS = [
  { name: 'mobile-360',  width: 360,  height: 740 },
  { name: 'mobile-414',  width: 414,  height: 896 },
  { name: 'tablet-768',  width: 768,  height: 1024 },
  { name: 'laptop-1366', width: 1366, height: 768 },
  { name: 'desktop-1920',width: 1920, height: 1080 },
  { name: 'ultrawide-2560', width: 2560, height: 1440 },
];

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  env: { ...process.env },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

console.log('═══════════════════════════════════════════');
console.log(' 响应式布局验证');
console.log('═══════════════════════════════════════════');

let pass = 0;
let fail = 0;

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();

  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1200);

    // 检查横向溢出
    const metrics = await page.evaluate(() => {
      const de = document.documentElement;
      const body = document.body;

      // 找出所有超出视口宽度的元素
      const overflowing = [];
      document.querySelectorAll('*').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > window.innerWidth + 2) {
          overflowing.push({
            tag: el.tagName.toLowerCase(),
            cls: (el.className || '').toString().slice(0, 40),
            right: Math.round(r.right),
            width: Math.round(r.width),
          });
        }
      });

      return {
        scrollWidth: de.scrollWidth,
        clientWidth: de.clientWidth,
        bodyScrollWidth: body.scrollWidth,
        innerWidth: window.innerWidth,
        overflowCount: overflowing.length,
        samples: overflowing.slice(0, 5),
        // 关键元素尺寸
        containerWidth: document.querySelector('.container')?.getBoundingClientRect().width,
        statsCols: getComputedStyle(document.querySelector('.stats')).gridTemplateColumns,
      };
    });

    const hasHScroll = metrics.scrollWidth > metrics.clientWidth + 2;

    console.log('');
    console.log(`[${vp.name}] ${vp.width}×${vp.height}`);
    console.log(`  文档宽度 ${metrics.scrollWidth} / 视口 ${metrics.clientWidth}`);
    console.log(`  容器宽度 ${Math.round(metrics.containerWidth)}px`);
    console.log(`  统计列数 ${metrics.statsCols.split(' ').length}`);

    if (hasHScroll) {
      console.log(`  ❌ 出现横向滚动（溢出 ${metrics.scrollWidth - metrics.clientWidth}px）`);
      fail++;
    } else {
      console.log(`  ✅ 无横向滚动`);
      pass++;
    }

    if (metrics.overflowCount > 0) {
      console.log(`  ⚠️  ${metrics.overflowCount} 个元素超出视口:`);
      metrics.samples.forEach((s) =>
        console.log(`       <${s.tag} class="${s.cls}"> right=${s.right} w=${s.width}`),
      );
    }

    await page.screenshot({
      path: path.join(OUT, `${vp.name}.png`),
      fullPage: false,
    });
  } catch (err) {
    console.log(`[${vp.name}] ❌ 渲染失败: ${err.message}`);
    fail++;
  }

  await ctx.close();
}

await browser.close();

console.log('');
console.log('═══════════════════════════════════════════');
console.log(` 结果: ${pass} 通过, ${fail} 失败`);
console.log(` 截图: ${OUT}`);
console.log('═══════════════════════════════════════════');

process.exit(fail > 0 ? 1 : 0);
