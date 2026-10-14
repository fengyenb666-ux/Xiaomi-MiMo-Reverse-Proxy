/**
 * WSL 端口转发（用户态，无需管理员权限）
 *
 * 背景：WSL2 的 localhost 自动转发在部分环境（Windows 11 24H2+、
 * Hyper-V 防火墙启用时）会失效，导致 Windows 无法通过 localhost
 * 访问 WSL 内的服务。管理员方案是 netsh portproxy，但需要提权。
 *
 * 本脚本用纯 Node.js 在用户态做 TCP 转发：
 *   Windows:8788  →  WSL_IP:8788
 *
 * 用法:
 *   node wsl-forward.mjs            # 默认 8788 端口
 *   node wsl-forward.mjs 9000       # 指定端口
 *
 * 停止: Ctrl+C
 */

import net from 'node:net';
import { execSync } from 'node:child_process';

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8788);

/** 获取 WSL 的 IP */
function getWslIp() {
  try {
    const out = execSync('wsl.exe -e bash -c "hostname -I"', {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    const ip = out.trim().split(/\s+/)[0];
    return ip || null;
  } catch {
    return null;
  }
}

let WSL_IP = getWslIp();

if (!WSL_IP) {
  console.error('❌ 无法获取 WSL IP，请确认 WSL 正在运行');
  process.exit(1);
}

console.log('');
console.log('  ╔══════════════════════════════════════════════╗');
console.log('  ║        WSL 端口转发（用户态）                 ║');
console.log('  ╚══════════════════════════════════════════════╝');
console.log('');
console.log(`  Windows  http://localhost:${PORT}/admin`);
console.log(`     ↓ 转发`);
console.log(`  WSL      http://${WSL_IP}:${PORT}/admin`);
console.log('');
console.log('  按 Ctrl+C 停止');
console.log('');

let connCount = 0;

const server = net.createServer((client) => {
  connCount++;
  const id = connCount;

  const upstream = net.connect(PORT, WSL_IP);

  // 双向管道
  client.pipe(upstream);
  upstream.pipe(client);

  const cleanup = () => {
    client.destroy();
    upstream.destroy();
  };

  client.on('error', cleanup);
  upstream.on('error', (err) => {
    if (err.code === 'ECONNREFUSED') {
      console.error(`  [${id}] WSL 服务未响应（${WSL_IP}:${PORT} 拒绝连接）`);
      console.error(`       请确认 WSL 内已启动: mimoapi start`);
    }
    cleanup();
  });

  client.on('close', cleanup);
  upstream.on('close', cleanup);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ 端口 ${PORT} 已被占用`);
    console.error(`   可能服务已在运行，或换端口: node wsl-forward.mjs 9000`);
  } else {
    console.error('❌ 转发服务错误:', err.message);
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`  ✅ 转发已启动: localhost:${PORT} → ${WSL_IP}:${PORT}`);
  console.log('');
});

// 定期刷新 WSL IP（WSL 重启后 IP 会变）
setInterval(() => {
  const ip = getWslIp();
  if (ip && ip !== WSL_IP) {
    console.log(`  ℹ️  WSL IP 变化: ${WSL_IP} → ${ip}`);
    WSL_IP = ip;
  }
}, 30000);

process.on('SIGINT', () => {
  console.log('\n正在关闭转发...');
  server.close(() => process.exit(0));
});
