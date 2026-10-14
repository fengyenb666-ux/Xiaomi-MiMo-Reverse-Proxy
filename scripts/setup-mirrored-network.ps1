# 配置 WSL 使用「镜像网络模式」
#
# 镜像模式下，WSL 与 Windows 共享网络栈：
#   - localhost 天然互通（不需要 portproxy）
#   - WSL 的 IP 与 Windows 相同
#   - 不受 WSL 重启后 IP 变化影响
#
# 这是 Windows 11 + WSL 2.0+ 推荐的配置方式。
#
# 用法：.\setup-mirrored-network.ps1

$ErrorActionPreference = 'Continue'

$configPath = "$env:USERPROFILE\.wslconfig"

Write-Host "=== WSL 镜像网络模式配置 ===" -ForegroundColor Cyan
Write-Host ""

# 检查 WSL 版本
Write-Host "[1/4] 检查 WSL 版本..." -ForegroundColor Cyan
$ver = (wsl.exe --version 2>$null) -join "`n"
if ($ver -match 'WSL\s+版本[:：]\s*([\d.]+)') {
  Write-Host "    WSL 版本: $($Matches[1])" -ForegroundColor Green
} else {
  Write-Host "    $($ver.Split("`n")[0])" -ForegroundColor Gray
}

# 检查现有配置
Write-Host "`n[2/4] 检查当前配置..." -ForegroundColor Cyan
if (Test-Path $configPath) {
  Write-Host "    已存在 .wslconfig:" -ForegroundColor Gray
  Get-Content $configPath | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }

  if ((Get-Content $configPath -Raw) -match 'networkingMode\s*=\s*mirrored') {
    Write-Host "`n    ✅ 已配置为镜像模式，无需修改" -ForegroundColor Green
    Write-Host "       若仍无法访问，请执行: wsl --shutdown 然后重开" -ForegroundColor Yellow
    exit 0
  }

  # 备份
  $backup = "$configPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item $configPath $backup
  Write-Host "    已备份到: $backup" -ForegroundColor Gray
} else {
  Write-Host "    无 .wslconfig（使用默认 NAT 模式）" -ForegroundColor Gray
}

# 写入配置
Write-Host "`n[3/4] 写入镜像网络配置..." -ForegroundColor Cyan

$content = @'
# WSL 配置
# 由 MiMo 反代部署脚本生成

[wsl2]
# 镜像网络模式：WSL 与 Windows 共享网络栈
# 好处：localhost 天然互通，WSL 内服务可直接用 http://localhost:端口 访问
networkingMode=mirrored

# 启用 DNS 隧道，解决部分网络下 DNS 解析问题
dnsTunneling=true

# 自动代理：继承 Windows 的代理设置
autoProxy=true

[experimental]
# 防火墙与 Windows 同步
hostAddressLoopback=true
'@

# 若已有 [wsl2] 段则追加，否则新建
if (Test-Path $configPath) {
  $existing = Get-Content $configPath -Raw
  if ($existing -match '\[wsl2\]') {
    # 已有 wsl2 段，在段内插入 networkingMode（若不存在）
    $new = $existing -replace '(\[wsl2\])', "`$1`nnetworkingMode=mirrored"
    Set-Content -Path $configPath -Value $new -Encoding UTF8
    Write-Host "    已在现有 [wsl2] 段添加 networkingMode=mirrored" -ForegroundColor Green
  } else {
    Add-Content -Path $configPath -Value "`n$content" -Encoding UTF8
    Write-Host "    已追加 [wsl2] 配置段" -ForegroundColor Green
  }
} else {
  Set-Content -Path $configPath -Value $content -Encoding UTF8
  Write-Host "    已创建 $configPath" -ForegroundColor Green
}

# 重启 WSL 生效
Write-Host "`n[4/4] 重启 WSL 使配置生效..." -ForegroundColor Cyan
Write-Host "    正在关闭 WSL..." -ForegroundColor Gray
wsl.exe --shutdown 2>$null
Start-Sleep -Seconds 3

Write-Host "    正在启动 WSL..." -ForegroundColor Gray
wsl.exe -e bash -c "echo ready" 2>$null | Out-Null
Start-Sleep -Seconds 2

Write-Host "`n=== 验证 ===" -ForegroundColor Cyan
$ip = (wsl.exe -e bash -c "hostname -I" 2>$null).Trim().Split()[0]
Write-Host "    WSL IP: $ip" -ForegroundColor Gray

Write-Host "`n完成！" -ForegroundColor Green
Write-Host ""
Write-Host "接下来的步骤：" -ForegroundColor Cyan
Write-Host "  1. 在 WSL 终端启动服务:  mimoapi start"
Write-Host "  2. 浏览器打开:           http://localhost:8788/admin"
Write-Host ""
Write-Host "镜像模式下 localhost 直接可用，无需端口转发。" -ForegroundColor Gray
Write-Host "如需还原配置，删除或编辑: $configPath" -ForegroundColor Gray
