# 脚本说明

## 安装部署

| 脚本 | 用途 |
|---|---|
| `../install.sh` | **一键安装**（推荐）：装 Node → 拉源码 → 构建 → 装 Chromium → 配命令 |
| `install-node-wsl.sh` | 仅安装 Linux 版 Node 到 `~/.local`（无需 sudo） |
| `install-chromium.sh` | 下载免安装版 Chromium 到 `~/.local/chromium` |
| `fix-chromium-deps.sh` | **免 sudo** 补齐 Chromium 系统依赖（从 Ubuntu 源解压 .deb） |
| `install-cjk-font.sh` | 安装中文字体（截图/无头渲染需要） |
| `setup-autostart.sh` | 配置 WSL 终端启动时自动拉起服务 |

## 日常运维

| 脚本 | 用途 |
|---|---|
| `mimoapi` | **主命令**：启动/停止/重启/状态/日志 |
| `deploy-to-wsl.sh` | 把项目从 Windows 目录复制到 WSL `~/mimoapi` |
| `force-sync-build.sh` | 强制全量同步源码并重建（含产物校验） |
| `diagnose.sh` | 诊断 `mimoapi` 命令为何找不到 |

## 网络（WSL2 localhost 失效时）

| 脚本 | 用途 |
|---|---|
| `wsl-forward.mjs` | 用户态 TCP 转发，无需管理员权限 |
| `setup-portproxy.ps1` | 配置 `netsh portproxy`（需管理员） |
| `setup-mirrored-network.ps1` | 切换到 WSL 镜像网络模式（一劳永逸，需管理员） |

## 测试验证

| 脚本 | 用途 |
|---|---|
| `final-acceptance.sh` | 完整验收：环境 / 接口 / 数据库 / UI / 单元测试 |
| `test-health-e2e.sh` | 健康检查端到端测试 |
| `test-autodisable.sh` | 连续失败自动停用测试 |
| `test-failover.sh` | 主备切换测试（优先级排序、失败转移） |
| `verify-health.sh` | 校验数据库表结构与列迁移 |
| `verify-redesign.mjs` | 视觉验证：多视口截图 + 设计令牌核对 |
| `verify-responsive-render.mjs` | 多视口渲染验证（检测横向溢出并截图） |
| `verify-windows-deploy.mjs` | 从 Windows 侧验证 WSL 服务 |
| `check-sse-format.mjs` | **SSE 格式检查**：逐帧分析流式输出是否合规 |
| `check-stream-health.mjs` | **流式健康检查**：对比流式与非流式，定位挂起 |
| `rebuild-verify.sh` | 清理重建并校验产物含最新修复 |
| `start-and-check.sh` | 启动服务并检查数据库状态 |
| `run-render-check.sh` | 响应式检查的 WSL 包装（修正 PATH） |
| `run-redesign-check.sh` | 视觉验证的 WSL 包装 |

---

## 常见用法

```bash
# WSL 中安装
bash install.sh --source /mnt/f/code/反代MIMO

# 启动服务
mimoapi start

# 完整验收
bash scripts/final-acceptance.sh

# 检查响应式布局
bash scripts/run-render-check.sh

# 排查流式输出问题
node scripts/check-stream-health.mjs   # 先定位是否挂起
node scripts/check-sse-format.mjs      # 再检查帧格式

# WSL localhost 访问不了时
node scripts/wsl-forward.mjs
```
