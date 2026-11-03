<#
  cs-myfree / cs-guard 一键更新脚本（Windows / PowerShell）
  用法：右键"使用 PowerShell 运行"，或在 PowerShell 里：
        powershell -ExecutionPolicy Bypass -File update-plugins.ps1
  会自动：探测 profile → 检查网络 → 配置 https→ssh 重写 → 安装 → 验证
#>
$ErrorActionPreference = 'Continue'
$VER = 'v1.3.0'
$OWNER = '7358716'
$PKGS = @('cs-myfree', 'cs-guard')

function Info($m) { Write-Host "[信息] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[成功] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[注意] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "[失败] $m" -ForegroundColor Red }

Info "=== 1/6 检查 dsh 命令 ==="
$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if (-not $dsh) {
  Fail "找不到 dsh 命令。请确认 DeepSeek Harness 已安装，并在新开的 PowerShell 里重试。"
  exit 1
}
Ok "dsh 在 $($dsh.Source)"

Info "=== 2/6 探测 profile 名 ==="
$profilesDir = Join-Path $env:USERPROFILE '.dsh\profiles'
if (-not (Test-Path $profilesDir)) {
  Fail "找不到 $profilesDir —— DSH 可能没初始化过"
  exit 1
}
$names = Get-ChildItem $profilesDir -Directory | Select-Object -ExpandProperty Name
Info "发现 profile：$($names -join ', ')"

# 优先选已装了 cs-myfree 的那个
$profile = $null
foreach ($n in $names) {
  $pj = Join-Path $profilesDir "$n\package.json"
  if (Test-Path $pj) {
    $txt = Get-Content $pj -Raw
    if ($txt -match 'cs-myfree') { $profile = $n; break }
  }
}
if (-not $profile) {
  # 没装过就选 web 或 desktop
  if ($names -contains 'web') { $profile = 'web' }
  elseif ($names -contains 'desktop') { $profile = 'desktop' }
  else { $profile = $names[0] }
}
Ok "使用 profile：$profile"

Info "=== 3/6 检查 git 是否可用 ==="
$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
  Warn "没装 git。github: 方式需要 git。"
  Warn "请先安装：winget install --id Git.Git -e --source winget"
  Warn "装完重开 PowerShell 再跑本脚本，或改用本地目录安装（见文末）。"
  exit 1
}
Ok "git 在 $($git.Source)"

Info "=== 4/6 测试 GitHub 连通性（https 与 ssh）==="
$httpsOk = $false
try {
  $r = Invoke-WebRequest -Uri 'https://github.com' -Method Head -TimeoutSec 8 -UseBasicParsing
  $httpsOk = ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400)
} catch { $httpsOk = $false }

$sshOk = $false
try {
  $out = ssh -T -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 git@github.com 2>&1
  $sshOk = ($out -match 'successfully authenticated')
} catch { $sshOk = $false }

Info "https: $(if($httpsOk){'通'}else{'不通'})   ssh: $(if($sshOk){'已认证'}else{'不可用'})"

if (-not $httpsOk -and $sshOk) {
  Warn "https 不通但 ssh 可用 ⇒ 配置 git 走 ssh（这一步很关键）"
  git config --global url."git@github.com:".insteadOf "https://github.com/"
  Ok "已配置 https→ssh 重写"
} elseif (-not $httpsOk -and -not $sshOk) {
  Fail "https 和 ssh 都不通，无法从 GitHub 安装。"
  Warn "改用本地目录安装：把仓库下载解压后执行："
  Warn "  dsh plugin --profile $profile add D:\path\to\cs-myfree"
  exit 1
}

Info "=== 5/6 安装/更新两个插件 ==="
foreach ($p in $PKGS) {
  Info "处理 ${p} ..."
  # 注意：PowerShell 里 # 必须包在引号内，且用单引号最稳
  $spec = "github:${OWNER}/${p}#${VER}"
  Info "  spec = $spec"
  & dsh plugin --profile $profile add $spec
  if ($LASTEXITCODE -ne 0) {
    Warn "${p} 带版本号失败，改用最新 main 重试"
    & dsh plugin --profile $profile add "github:${OWNER}/${p}"
  }
}
Ok "安装命令执行完毕"

Info "=== 6/6 验证 ==="
$pj = Join-Path $profilesDir "$profile\package.json"
$txt = Get-Content $pj -Raw
foreach ($p in $PKGS) {
  if ($txt -match [regex]::Escape($p)) { Ok "${p} 已写入 dependencies" }
  else { Fail "${p} 没有出现在 dependencies" }
}
$bundles = ($txt | ConvertFrom-Json).dsh.profile.bundles
Info "bundles: $($bundles -join ', ')"

Write-Host ""
Ok "=== 完成 ==="
Write-Host "请重启 DSH（关闭窗口重新打开），然后在 设置 → 左侧应看到 Myfree 和 Guard" -ForegroundColor Cyan
Write-Host ""
Write-Host "如果还是看不到，把下面这条的输出发给我："
Write-Host "  Get-Content '$pj'" -ForegroundColor DarkGray
