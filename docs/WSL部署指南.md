# WSL 部署指南

本项目已部署到 WSL Ubuntu，命令为 `mimoapi`。

---

## 一键安装（新机器）

```bash
# 方式一：从仓库克隆（把 <用户>/<仓库> 换成你的地址）
curl -fsSL https://raw.githubusercontent.com/<用户>/<仓库>/main/install.sh | bash -s -- \
  --repo https://github.com/<用户>/<仓库>.git

# 方式二：从本地目录（已有源码时）
bash install.sh --source /mnt/f/code/反代MIMO
```

脚本会自动完成：安装 Node → 拉取源码 → 装依赖 → 构建 → 装 Chromium → 配置 `mimoapi` 命令。

---

## 日常使用

在 **WSL 终端**输入：

```bash
mimoapi
```

浏览器打开 **http://localhost:8788/admin**

> **Windows 浏览器可直接访问**，无需配置端口转发。

### 命令一览

| 命令 | 作用 |
|---|---|
| `mimoapi` | 前台启动（Ctrl+C 停止） |
| `mimoapi start` | 后台启动（脱离终端，可关窗口） |
| `mimoapi stop` | 停止服务 |
| `mimoapi restart` | 重启 |
| `mimoapi status` | 查看状态和访问地址 |
| `mimoapi logs` | 实时查看日志 |
| `mimoapi build` | 重新构建 |
| `mimoapi update` | 从 Windows 侧同步代码并重建 |
| `mimoapi help` | 帮助 |

自定义端口：

```bash
PORT=9000 mimoapi start
```

---

## 部署结构

| 项目 | 位置 |
|---|---|
| 项目目录 | `~/mimoapi` |
| 命令 | `~/.local/bin/mimoapi` |
| Node | `~/.local/node-v24.22.0-linux-x64` |
| Chromium | `~/.local/chromium/chrome-linux/chrome` |
| Chromium 依赖库 | `~/.local/chromium-libs/lib` |
| 数据库 | `~/mimoapi/data/mimo.db` |
| 日志 | `~/mimoapi/data/mimoapi.log` |

> **为什么放在 `~/mimoapi` 而不是 `/mnt/f/...`？**
> `/mnt/f` 是 Windows 跨盘挂载，I/O 慢 5-10 倍，且 SQLite 跨盘有文件锁风险。

---

## 自动抓取凭证（WSL 环境）

WSL 里没有图形界面，**无法弹出可见的浏览器窗口**。因此自动抓取采用
**无头（headless）模式**运行：

1. 面板点「打开浏览器并抓取」→ 后台启动无头 Chromium 访问 MiMo 站点
2. 由于无头浏览器没有登录态，**需要你把 Windows 侧的 Cookie 导入**

### 推荐流程：手动粘贴（最可靠）

1. 在 **Windows 的 Chrome** 里登录 <https://aistudio.xiaomimimo.com>
2. `F12` → **Network** → 发一条消息 → 找到 `chat` 请求
3. 右键 → **Copy as cURL**
4. 粘贴到面板「手动添加」框 → 点「添加账号」

> Chrome 130+ 需先在 DevTools → 设置(⚙️) → Preferences 勾选
> 「Allow to generate HAR with sensitive data」，否则 Cookie 会被剥离。

---

## 数据存储

使用 **SQLite**（Node 24 内置 `node:sqlite`），文件在 `~/mimoapi/data/mimo.db`。

| 表 | 用途 |
|---|---|
| `accounts` | 账号、API Key、统计 |
| `logs` | 请求日志 |
| `settings` | 键值配置 |

```bash
# 直接查询
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.env.HOME+'/mimoapi/data/mimo.db');
console.log(db.prepare('SELECT alias,api_key,request_count FROM accounts').all());
db.close();
"

# 备份
cp ~/mimoapi/data/mimo.db ~/mimoapi/data/backup-$(date +%F).db

# 重置
mimoapi stop && rm -f ~/mimoapi/data/mimo.db*
```

---

## 常见问题

### Q: 输入 `mimoapi` 提示 command not found？

配置刚写入，当前终端还没加载：

```bash
source ~/.bashrc
```

或关掉终端重新打开。

### Q: Windows 浏览器打不开 localhost:8788？

先确认 WSL 内服务在跑：

```bash
mimoapi status
curl -s http://127.0.0.1:8788/health
```

若 WSL 内正常但 Windows 访问不了，是 WSL2 的 localhost 转发失效。
用 WSL 的 IP 访问：

```bash
hostname -I | awk '{print $1}'
# 例如输出 172.20.163.67，则访问 http://172.20.163.67:8788/admin
```

或用用户态转发（无需管理员）：

```bash
# 在 Windows PowerShell 中
node /mnt/f/code/反代MIMO/scripts/wsl-forward.mjs
```

彻底解决（需管理员，让 localhost 永久互通）：

```powershell
# 管理员 PowerShell
.\scripts\setup-mirrored-network.ps1
```

### Q: 服务启动后过一会儿就没了？

已修复。WSL 会在最后一个会话退出时回收后台进程，
`mimoapi start` 现在用 `setsid` 让进程完全脱离终端，可长期常驻。

### Q: 关闭 WSL 终端后服务还在吗？

在。`mimoapi start` 启动的进程独立于终端。
但 **Windows 重启或 `wsl --shutdown` 后会停止**，需重新执行 `mimoapi start`。

想开机自启：

```bash
bash ~/mimoapi/scripts/setup-autostart.sh on
```

### Q: 浏览器报缺少 so 库？

```bash
bash ~/mimoapi/scripts/fix-chromium-deps.sh
```

此脚本从 Ubuntu 源下载所需 .deb 并解压到用户目录，**不需要 sudo**。

### Q: 端口被占用？

```bash
mimoapi stop
PORT=9000 mimoapi start
```

### Q: 怎么更新代码？

```bash
mimoapi update    # 从 Windows 侧同步 + 重建
mimoapi restart   # 重启生效
```

---

## 卸载

```bash
mimoapi stop
rm -rf ~/mimoapi
rm -f ~/.local/bin/mimoapi
rm -rf ~/.local/chromium ~/.local/chromium-libs
sed -i '/# >>> mimoapi/,/# <<< mimoapi/d' ~/.bashrc ~/.profile
```
