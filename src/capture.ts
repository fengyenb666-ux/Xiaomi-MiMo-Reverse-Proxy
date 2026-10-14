/**
 * 浏览器自动抓取凭证
 *
 * 思路：不逆向 ph_token 的生成算法（易失效），而是**启动真实浏览器让用户登录**，
 * 然后拦截页面自己发出的 /open-apis/bot/chat 请求，从中直接提取真实凭证。
 *
 * 关键接口（实测确认）：
 *   GET  /open-apis/user/mi/get      检查登录状态
 *   GET  /open-apis/bot/config       模型配置
 *   POST /open-apis/bot/chat?...     对话（含 xiaomichatbot_ph）
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = 'https://aistudio.xiaomimimo.com';
const CHAT_PATH = '/open-apis/bot/chat';

/** 常见 Chrome / Edge 安装位置（Windows） */
const WINDOWS_BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

/** 常见 Linux 浏览器位置（含免安装版） */
function linuxBrowsers(): string[] {
  const home = process.env.HOME ?? '';
  return [
    // 本项目 install-chromium.sh 安装的免安装版（优先）
    path.join(home, '.local', 'chromium', 'chrome-linux', 'chrome'),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium',
  ];
}

/** 查找可用的浏览器可执行文件 */
export function findBrowser(): string | null {
  // 1. 环境变量优先
  const fromEnv = process.env.MIMO_BROWSER_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  // 2. 按平台查找
  const isWin = process.platform === 'win32';
  const candidates = isWin ? WINDOWS_BROWSERS : linuxBrowsers();
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }

  // 3. Playwright 自带浏览器
  const pwDir = path.join(
    process.env.LOCALAPPDATA ?? process.env.HOME ?? '',
    isWin ? 'ms-playwright' : '.cache/ms-playwright',
  );
  if (fs.existsSync(pwDir)) {
    for (const d of fs.readdirSync(pwDir)) {
      if (!d.startsWith('chromium')) continue;
      const subdirs = isWin
        ? ['chrome-win', 'chrome-win64']
        : ['chrome-linux', 'chrome-linux64'];
      const exe = isWin ? 'chrome.exe' : 'chrome';
      for (const sd of subdirs) {
        const c = path.join(pwDir, d, sd, exe);
        if (fs.existsSync(c)) return c;
      }
    }
  }

  return null;
}

/**
 * 计算运行浏览器所需的环境变量。
 *
 * 免安装版 Chromium（install-chromium.sh 装的）依赖一些系统库，
 * 这些库被解压到 ~/.local/chromium-libs/lib。这里自动把它注入
 * LD_LIBRARY_PATH，避免用户手动配置。
 */
function browserEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const home = process.env.HOME ?? '';

  if (process.platform !== 'win32' && home) {
    const libDir = path.join(home, '.local', 'chromium-libs', 'lib');
    if (fs.existsSync(libDir)) {
      const cur = env.LD_LIBRARY_PATH ?? '';
      if (!cur.split(':').includes(libDir)) {
        env.LD_LIBRARY_PATH = cur ? `${libDir}:${cur}` : libDir;
      }
    }
  }

  return env;
}

/**
 * 检查浏览器是否真正可执行（能输出版本号）。
 *
 * 免安装版 Chromium 可能缺少系统库，需要 LD_LIBRARY_PATH，
 * 因此这里做一次真实调用验证，而不只是检查文件存在。
 */
export function browserDiagnostics(): {
  path: string | null;
  runnable: boolean;
  version?: string;
  error?: string;
} {
  const bin = findBrowser();
  if (!bin) {
    return {
      path: null,
      runnable: false,
      error:
        '未检测到浏览器。Linux 下可运行: bash scripts/install-chromium.sh',
    };
  }

  try {
    const out = execFileSync(bin, ['--version'], {
      timeout: 20000,
      encoding: 'utf8',
      env: browserEnv(),
    }).trim();
    return { path: bin, runnable: true, version: out };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 给出更可操作的提示
    let hint = msg;
    if (msg.includes('shared libraries') || msg.includes('error while loading')) {
      hint +=
        '\n缺少系统库。在 Linux/WSL 下运行: bash scripts/fix-chromium-deps.sh';
    }
    return { path: bin, runnable: false, error: hint };
  }
}

export interface CapturedCredential {
  serviceToken: string;
  userId: string;
  phToken: string;
  userAgent: string;
}

export interface CaptureSession {
  id: string;
  status: 'starting' | 'awaiting_login' | 'captured' | 'error' | 'closed';
  message: string;
  loginDetected: boolean;
  credential?: CapturedCredential;
  startedAt: number;
  error?: string;
}

/** 抓取会话表（内存） */
const sessions = new Map<string, CaptureSession>();

/** 运行中的浏览器资源 */
interface LiveCapture {
  session: CaptureSession;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  timer?: NodeJS.Timeout;
}

const live = new Map<string, LiveCapture>();

export function getCaptureSession(id: string): CaptureSession | undefined {
  return sessions.get(id);
}

export function listCaptureSessions(): CaptureSession[] {
  return [...sessions.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * 从 Cookie 与请求信息中提取凭证。
 *
 * serviceToken / userId 来自 Cookie；
 * phToken 优先取 URL query，其次 Cookie，最后从请求头推断。
 */
function extractCredential(
  cookies: Array<{ name: string; value: string }>,
  chatUrl: string,
  userAgent: string,
): CapturedCredential | null {
  const cookieMap = new Map<string, string>();
  for (const c of cookies) cookieMap.set(c.name, c.value);

  // Cookie 中可能存在带引号的值，需要去掉引号
  const unquote = (v?: string) => (v ?? '').replace(/^"|"$/g, '').trim();

  const serviceToken = unquote(
    cookieMap.get('serviceToken') ??
      cookieMap.get('xiaomichatbot_serviceToken'),
  );
  const userId = unquote(cookieMap.get('userId'));

  // ph token：URL query 最可靠
  let phToken = '';
  try {
    const u = new URL(chatUrl);
    phToken =
      u.searchParams.get('xiaomichatbot_ph') ??
      u.searchParams.get('ultraspeed_ph') ??
      u.searchParams.get('michatbot_ph') ??
      '';
  } catch {
    /* ignore */
  }

  if (!phToken) {
    phToken = unquote(
      cookieMap.get('xiaomichatbot_ph') ??
        cookieMap.get('ultraspeed_ph') ??
        cookieMap.get('michatbot_ph'),
    );
  }

  if (!serviceToken) return null;

  return { serviceToken, userId, phToken, userAgent };
}

/**
 * 启动一次自动抓取。
 *
 * 打开有头浏览器 → 用户登录小米账号 → 自动捕获 chat 请求中的凭证。
 * 返回会话 ID，前端轮询状态。
 */
export async function startCapture(opts: {
  /** 超时时间（毫秒），默认 5 分钟 */
  timeoutMs?: number;
  /** 是否无头模式（无头模式下用户无法登录，仅用于测试） */
  headless?: boolean;
}): Promise<CaptureSession> {
  const { timeoutMs = 5 * 60 * 1000, headless = false } = opts;

  const id = `cap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  const session: CaptureSession = {
    id,
    status: 'starting',
    message: '正在启动浏览器...',
    loginDetected: false,
    startedAt: Date.now(),
  };
  sessions.set(id, session);

  const exePath = findBrowser();
  if (!exePath) {
    session.status = 'error';
    session.message = '未找到可用浏览器';
    session.error =
      '未检测到 Chrome 或 Edge。请安装 Chrome，或设置环境变量 MIMO_BROWSER_PATH 指向浏览器可执行文件。';
    return session;
  }

  let browser: Browser;
  try {
    browser = await chromium.launch({
      executablePath: exePath,
      headless,
      env: browserEnv(),
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-blink-features=AutomationControlled',
        // WSL / 容器中缺少这些沙箱依赖，关闭沙箱以确保能启动
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
  } catch (err) {
    session.status = 'error';
    session.message = '浏览器启动失败';
    const msg = err instanceof Error ? err.message : String(err);
    session.error =
      msg +
      (msg.includes('shared libraries')
        ? '\n提示：缺少系统库，请运行 bash scripts/fix-chromium-deps.sh'
        : '');
    return session;
  }

  const context = await browser.newContext({
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1280, height: 860 },
  });

  const page = await context.newPage();

  const entry: LiveCapture = { session, browser, context, page };
  live.set(id, entry);

  session.status = 'awaiting_login';
  session.message = '请在弹出的浏览器中登录小米账号，登录后会自动抓取凭证';

  /** 捕获成功后收尾 */
  const finish = async (cred: CapturedCredential) => {
    session.status = 'captured';
    session.credential = cred;
    session.message = '凭证抓取成功';
    if (entry.timer) clearTimeout(entry.timer);
    // 留出时间让前端拿到结果，再关闭浏览器
    setTimeout(() => {
      void closeCapture(id);
    }, 3000);
  };

  // 关键：拦截页面自己发出的 chat 请求，从中提取真实凭证
  page.on('request', async (req) => {
    if (!req.url().includes(CHAT_PATH)) return;
    if (session.status === 'captured') return;

    try {
      const cookies = await context.cookies();
      const cred = extractCredential(cookies, req.url(), await page.evaluate(() => navigator.userAgent));
      if (cred) {
        console.log(`[抓取] 成功捕获凭证 (userId=${cred.userId || '空'})`);
        await finish(cred);
      }
    } catch (err) {
      console.warn('[抓取] 提取凭证失败:', err);
    }
  });

  // 辅助：监听登录状态接口，用于前端提示
  page.on('response', async (res) => {
    if (!res.url().includes('/open-apis/user/mi/get')) return;
    try {
      const text = await res.text();
      const json = JSON.parse(text) as { code?: number; data?: unknown };
      if (json.code === 0 && json.data) {
        session.loginDetected = true;
        if (session.status === 'awaiting_login') {
          session.message = '已检测到登录，请发送一条消息以触发凭证抓取';
        }
      }
    } catch {
      /* ignore */
    }
  });

  // 超时处理
  entry.timer = setTimeout(() => {
    if (session.status === 'awaiting_login' || session.status === 'starting') {
      session.status = 'error';
      session.error = `等待登录超时（${Math.round(timeoutMs / 1000)} 秒）。请重试。`;
      session.message = '抓取超时';
      void closeCapture(id);
    }
  }, timeoutMs);

  // 打开站点
  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (err) {
    console.warn('[抓取] 页面加载异常:', err);
  }

  return session;
}

/** 关闭抓取会话 */
export async function closeCapture(id: string): Promise<void> {
  const entry = live.get(id);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  live.delete(id);

  try {
    await entry.browser.close();
  } catch {
    /* ignore */
  }

  const s = sessions.get(id);
  if (s && s.status !== 'captured') {
    s.status = 'closed';
    s.message = '已关闭浏览器';
  }
}

/** 关闭全部抓取会话（进程退出时调用） */
export async function closeAllCaptures(): Promise<void> {
  const ids = [...live.keys()];
  await Promise.all(ids.map((id) => closeCapture(id)));
}
