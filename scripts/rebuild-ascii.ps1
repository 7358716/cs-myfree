<#
  DSH Bridge rebuild script (ASCII ONLY - no non-ASCII chars!)
  Reason: Windows PowerShell 5.1 reads .ps1 as ANSI/GBK unless it has a BOM.
           Any Chinese char inside breaks quote pairing and here-strings.

  Usage (normal PowerShell, no admin needed):
      powershell -ExecutionPolicy Bypass -File rebuild-ascii.ps1
  Uninstall:
      powershell -ExecutionPolicy Bypass -File rebuild-ascii.ps1 -Uninstall
#>
param([switch]$Uninstall, [string]$Cloud = 'ubuntu@150.158.175.241')

$ErrorActionPreference = 'Continue'
$Bridge  = Join-Path $env:USERPROFILE '.dsh-bridge'
$Scripts = Join-Path $env:USERPROFILE 'dsh-bridge-scripts'
$Task    = 'dsh-bridge-agent'
$Remote  = '/home/ubuntu/dsh-bridge'
$Log     = Join-Path $env:USERPROFILE 'dsh-bridge-rebuild.log'

function Say($m) {
  $line = '[' + (Get-Date -Format 'HH:mm:ss') + '] ' + $m
  Write-Host $line
  try { Add-Content -Path $Log -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue } catch {}
}

if ($Uninstall) {
  Say 'Uninstalling DSH Bridge...'
  $t = Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
  if ($t) { Unregister-ScheduledTask -TaskName $Task -Confirm:$false; Say 'Scheduled task removed.' }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*dsh-bridge*' } |
    ForEach-Object { Say ('Stopping pid=' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Say ('Data dir kept: ' + $Bridge)
  exit 0
}

Say '=================================================='
Say ' DSH Bridge rebuild'
Say '=================================================='

# ---------- 1) Node.js ----------
Say '[1/6] Check Node.js...'
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
  Say 'ERROR: node.exe not found. Install Node.js 22+ first: https://nodejs.org/'
  exit 1
}
Say ('  node: ' + $node.Source + '  ' + (& node --version))

# ---------- 2) SSH key ----------
Say '[2/6] Check SSH key...'
$sshDir = Join-Path $env:USERPROFILE '.ssh'
if (-not (Test-Path $sshDir)) { New-Item -ItemType Directory -Path $sshDir -Force | Out-Null }
$key = Join-Path $sshDir 'id_ed25519'
if (-not (Test-Path $key)) {
  Say '  key missing. Will pull from cloud.'
  Say '  >>> You will be asked for the CLOUD PASSWORD ONCE. Type it and press Enter.'
  $srcDir = '/home/ubuntu/output2026/butlers/dev/WIN-HANDOVER/ssh-backup'
  $tmpDir = Join-Path $env:TEMP 'ssh-backup-pull'
  if (Test-Path $tmpDir) { Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue }
  & scp -r -o StrictHostKeyChecking=no ($Cloud + ':' + $srcDir) $tmpDir
  if (Test-Path $tmpDir) {
    $inner = Get-ChildItem $tmpDir -Directory | Select-Object -First 1
    $useDir = if ($inner) { $inner.FullName } else { $tmpDir }
    foreach ($n in @('id_ed25519','id_ed25519.pub','known_hosts')) {
      $f = Join-Path $useDir $n
      if (Test-Path $f) { Copy-Item $f (Join-Path $sshDir $n) -Force; Say ('  copied ' + $n) }
    }
  }
}
if (Test-Path $key) {
  Say '  key present.'
  # Fix ACL so ssh.exe accepts the private key (Windows requirement)
  try {
    & icacls $key /inheritance:r /grant:r "$($env:USERNAME):(R)" 2>&1 | Out-Null
    Say '  key ACL fixed.'
  } catch {}
} else {
  Say 'ERROR: still no key. Copy it manually with scp.'
  exit 1
}

# ---------- 3) dirs ----------
Say '[3/6] Create dirs...'
foreach ($d in @($Bridge, $Scripts)) {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}
Say ('  ' + $Bridge)
Say ('  ' + $Scripts)

# ---------- 4) fetch agent ----------
Say '[4/6] Fetch agent.mjs + launcher...'
$agentDst = Join-Path $Scripts 'agent.mjs'
$vbsDst   = Join-Path $Scripts 'launch-hidden.vbs'
& scp -o BatchMode=yes -o StrictHostKeyChecking=no ($Cloud + ':' + $Remote + '/agent.mjs') $agentDst 2>&1 | Out-Null
if (-not (Test-Path $agentDst)) {
  & scp -o BatchMode=yes -o StrictHostKeyChecking=no ($Cloud + ':/home/ubuntu/output2026/butlers/dev/WIN-HANDOVER/rebuild/agent.mjs') $agentDst 2>&1 | Out-Null
}
if (-not (Test-Path $agentDst)) {
  Say 'ERROR: cannot fetch agent.mjs'
  exit 1
}
Say ('  agent.mjs OK (' + (Get-Item $agentDst).Length + ' bytes)')

# launcher: write ASCII-only VBS locally (no here-string from remote)
$vbsLines = @(
  'Set sh = CreateObject("WScript.Shell")',
  'sh.Run "node.exe """ & WScript.Arguments(0) & """", 0, False'
)
Set-Content -Path $vbsDst -Value $vbsLines -Encoding ASCII
Say '  launch-hidden.vbs OK'

# ---------- 5) config ----------
Say '[5/6] Write bridge config...'
$cfgPath = Join-Path $Bridge 'config.json'
$cfg = [ordered]@{
  cloud      = $Cloud
  remote     = $Remote
  agentPath  = $agentDst
  pollMs     = 15000
  idleOnly   = $true
  idleMinutes = 3
  dshCli     = ''
}
$cfg | ConvertTo-Json | Set-Content -Path $cfgPath -Encoding UTF8
Say ('  ' + $cfgPath)

# ---------- 6) scheduled task ----------
Say '[6/6] Register scheduled task...'
$existing = Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
if ($existing) { Unregister-ScheduledTask -TaskName $Task -Confirm:$false -ErrorAction SilentlyContinue }
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbsDst + '" "' + $agentDst + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
try {
  Register-ScheduledTask -TaskName $Task -Action $action -Trigger $trigger -Settings $settings -Description 'DSH Bridge Agent' -Force | Out-Null
  Say '  task registered.'
} catch {
  Say ('  ERROR registering task: ' + $_.Exception.Message)
}

Start-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

# ---------- self test ----------
Say '--- self test ---'
$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*agent.mjs*' }
if ($running) {
  Say ('OK: agent running, pid=' + ($running | Select-Object -First 1).ProcessId)
} else {
  Say 'WARN: agent not running yet. Check task scheduler.'
}

Say ''
Say '=================================================='
Say ' Done. Channel should be up in ~30s.'
Say (' data : ' + $Bridge)
Say (' logs : ' + $Log)
Say '=================================================='
