# 配置 WSL2 端口转发：让 Windows 通过 localhost 访问 WSL 服务
#
# WSL2 的 localhost 自动转发有时会失效（网络变化、休眠唤醒后），
# 这里显式添加端口代理规则作为兜底。
#
# 用法（需管理员 PowerShell）：
#   .\setup-portproxy.ps1

param(
  [int]$Port = 8788
)

$ErrorActionPreference = 'Stop'

Write-Host "=== 配置 WSL 端口转发 (端口 $Port) ===" -ForegroundColor Cyan

# 检查管理员权限
$isAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  Write-Host "❌ 需要管理员权限" -ForegroundColor Red
  Write-Host "   请右键 PowerShell → 以管理员身份运行，然后重新执行本脚本" -ForegroundColor Yellow
  exit 1
}

# 获取 WSL IP
Write-Host "`n[1/4] 获取 WSL IP..." -ForegroundColor Cyan
$wslIp = (wsl.exe -e bash -c "hostname -I" 2>$null).Trim().Split()[0]
if (-not $wslIp) {
  Write-Host "❌ 无法获取 WSL IP，请确认 WSL 正在运行" -ForegroundColor Red
  exit 1
}
Write-Host "    WSL IP: $wslIp" -ForegroundColor Green

# 移除旧规则
Write-Host "`n[2/4] 清理旧规则..." -ForegroundColor Cyan
$existing = netsh interface portproxy show v4tov4 | Select-String ":$Port\s"
if ($existing) {
  netsh interface portproxy delete v4tov4 listenport=$Port listenaddress=0.0.0.0 2>$null | Out-Null
  Write-Host "    已清理旧规则" -ForegroundColor Gray
} else {
  Write-Host "    无旧规则" -ForegroundColor Gray
}

# 添加新规则
Write-Host "`n[3/4] 添加转发规则..." -ForegroundColor Cyan
netsh interface portproxy add v4tov4 `
  listenport=$Port `
  listenaddress=0.0.0.0 `
  connectport=$Port `
  connectaddress=$wslIp | Out-Null
Write-Host "    ✅ 0.0.0.0:$Port → ${wslIp}:$Port" -ForegroundColor Green

# 防火墙放行
Write-Host "`n[4/4] 配置防火墙..." -ForegroundColor Cyan
$ruleName = "WSL MiMo Proxy $Port"
$fw = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if (-not $fw) {
  New-NetFirewallRule `
    -DisplayName $ruleName `
    -Direction Inbound `
    -LocalPort $Port `
    -Protocol TCP `
    -Action Allow `
    -Profile Any | Out-Null
  Write-Host "    ✅ 已放行入站 TCP $Port" -ForegroundColor Green
} else {
  Write-Host "    规则已存在" -ForegroundColor Gray
}

# 验证
Write-Host "`n=== 验证 ===" -ForegroundColor Cyan
Start-Sleep -Seconds 1
$ok = $false
try {
  $r = Invoke-WebRequest "http://localhost:$Port/health" -UseBasicParsing -TimeoutSec 8
  if ($r.StatusCode -eq 200) {
    Write-Host "✅ localhost:$Port 可访问" -ForegroundColor Green
    Write-Host "   $($r.Content)" -ForegroundColor Gray
    $ok = $true
  }
} catch {
  Write-Host "⚠️  localhost:$Port 仍不可访问: $($_.Exception.Message)" -ForegroundColor Yellow
}

try {
  $r2 = Invoke-WebRequest "http://${wslIp}:$Port/health" -UseBasicParsing -TimeoutSec 8
  if ($r2.StatusCode -eq 200) {
    Write-Host "✅ ${wslIp}:$Port 可访问" -ForegroundColor Green
  }
} catch {
  Write-Host "⚠️  ${wslIp}:$Port 不可访问" -ForegroundColor Yellow
}

Write-Host ""
if ($ok) {
  Write-Host "完成！浏览器打开: http://localhost:$Port/admin" -ForegroundColor Green
} else {
  Write-Host "转发规则已添加。若仍无法访问，请确认 WSL 内服务已启动 (mimoapi start)" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "提示：WSL 重启后 IP 会变化，需重新运行本脚本" -ForegroundColor Gray
Write-Host "     或使用 http://${wslIp}:$Port/admin 直接访问" -ForegroundColor Gray
