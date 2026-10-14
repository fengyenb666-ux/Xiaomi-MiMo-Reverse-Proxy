# 贡献与开发说明

## 开发环境

| 依赖 | 版本要求 | 说明 |
|---|---|---|
| Node.js | **≥ 22**（推荐 24） | 需要内置 `node:sqlite`，22.5+ 才有 |
| npm | ≥ 10 | 随 Node 附带 |
| Chrome / Edge | 任意近期版本 | 仅「一键自动抓取」需要 |
| Git | 任意 | 可选 |

> **为什么必须 Node 22+？**
> 本项目用 Node 内置的 `node:sqlite` 做持久化，避免 `better-sqlite3`
> 在 Windows 上的原生编译问题。该模块从 Node 22.5 开始提供。

## 本地开发

```bash
# 1. 克隆
git clone https://github.com/fengyenb666-ux/Xiaomi-MiMo-Reverse-Proxy.git
cd Xiaomi-MiMo-Reverse-Proxy

# 2. 安装依赖
npm install

# 3. 开发模式（改动源码后需重新编译）
npm run build
npm start
```

免构建直接跑 TypeScript（Node 22+ 支持类型剥离）：

```bash
node --experimental-strip-types src/index.ts
```

## 项目结构

```
src/
├── index.ts        # HTTP 服务、OpenAI 兼容路由、管理 API
├── db.ts           # SQLite 建表与列迁移
├── accounts.ts     # 账号 CRUD、负载均衡、健康状态、cURL 解析
├── health.ts       # 账号健康检查轮询
├── capture.ts      # Playwright 浏览器自动抓取凭证
├── logger.ts       # 请求日志与聚合统计
└── mimo/
    ├── client.ts   # 上游客户端（模型抓取 + SSE 流解析）
    ├── serialize.ts# 消息序列化 + 思考链状态机
    └── session.ts  # 会话保持（消息指纹匹配）
```

## 测试

```bash
# 思考链解析（22 项）
node --experimental-strip-types test/think-parser.test.ts

# 凭证解析（16 项）
node --experimental-strip-types test/parse-credential.test.ts

# 响应式渲染验证（需服务运行中）
node scripts/verify-responsive-render.mjs
```

## 开发注意事项

### 1. 编码务必用 UTF-8（无 BOM）

本项目含大量中文注释与界面文案。**PowerShell 的
`Set-Content -Encoding UTF8` 会加 BOM 并可能破坏编码**，
请改用 Node 或明确指定无 BOM：

```bash
# ✅ 推荐
node -e "require('fs').writeFileSync('f.txt', content, 'utf8')"

# ❌ 避免
Set-Content -Encoding UTF8 f.txt
```

### 2. 上游协议可能变化

MiMo 网页版不是公开稳定 API，字段名随时可能调整。已知的脆弱点：

- `data.modelConfigListNg`（曾从 `modelConfigList` 改名）
- SSE 事件类型：`message` / `usage` / `dialogId` / `finish`
- 思考链用内联 `<think>` 标签，而非独立字段

改动相关逻辑前请先看 [docs/协议逆向报告.md](docs/协议逆向报告.md)。

### 3. SSE 流必须做分片处理

思考链标签 `<think>` / `</think>` **几乎必然被 SSE 切碎**，
`serialize.ts` 里的 `ThinkParser` 用状态机 + pending 缓冲处理。
不要退化成简单正则替换，否则思考链会失效。

### 4. 数据库列迁移

新增字段请加到 `db.ts` 的 `migrateColumns()` 数组里，
它用 `PRAGMA table_info` 检测后 `ALTER TABLE ADD COLUMN`，
对已有数据库是安全的。

## 提交规范

```
<类型>: <简短描述>

类型：
  feat     新功能
  fix      修 bug
  docs     文档
  style    格式（不影响逻辑）
  refactor 重构
  test     测试
```

示例：

```
feat: 账号健康检查轮询与自动停用
fix: set -e 导致 mimoapi start 静默退出
docs: 补充 WSL 部署指南
```

## 免责声明

本项目仅供学习研究，与小米公司无任何关联。请遵守
[MiMo 服务条款](https://aistudio.xiaomimimo.com)。
