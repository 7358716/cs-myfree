<#
  DSH Bridge rebuild - ASCII ONLY (no Chinese chars!)
  Reason: Windows PowerShell 5.1 reads .ps1 as ANSI/GBK unless BOM;
          Chinese chars break quotes and here-strings.

  Usage:
      powershell -ExecutionPolicy Bypass -File rebuild-ascii.ps1
  Remove old auto-start task:
      powershell -ExecutionPolicy Bypass -File rebuild-ascii.ps1 -CleanTask

  NOTE: This script does NOT register any auto-start task.
        After it finishes, start the agent manually with start-agent.ps1
#>
param([switch]$CleanTask, [string]$Cloud = 'ubuntu@150.158.175.241')

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

# --- remove old auto-start task if asked ---
if ($CleanTask) {
  $t = Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
  if ($t) {
    Unregister-ScheduledTask -TaskName $Task -Confirm:$false -ErrorAction SilentlyContinue
    Say 'auto-start task removed.'
  } else {
    Say 'no auto-start task found.'
  }
  exit 0
}

Say '=================================================='
Say ' DSH Bridge setup (manual start mode)'
Say '=================================================='

# --- 1) Node.js ---
Say '[1/5] Check Node.js...'
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
  Say 'ERROR: node.exe not found. Install Node.js 22+ from https://nodejs.org/'
  exit 1
}
Say ('  node ' + (& node --version) + ' at ' + $node.Source)

# --- 2) SSH key ---
Say '[2/5] Check SSH key...'
$sshDir = Join-Path $env:USERPROFILE '.ssh'
if (-not (Test-Path $sshDir)) { New-Item -ItemType Directory -Path $sshDir -Force | Out-Null }
$key = Join-Path $sshDir 'id_ed25519'
if (-not (Test-Path $key)) {
  Say '  key missing. Pulling from cloud.'
  Say '  >>> enter the CLOUD PASSWORD ONCE when asked <<<'
  $srcDir = '/home/ubuntu/output2026/butlers/dev/WIN-HANDOVER/ssh-backup'
  $tmpDir = Join-Path $env:TEMP 'ssh-pull'
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
  try { & icacls $key /inheritance:r /grant:r "$($env:USERNAME):(R)" 2>&1 | Out-Null; Say '  ACL fixed.' } catch {}
} else {
  Say 'ERROR: no key available.'
  exit 1
}

# --- 3) dirs ---
Say '[3/5] Create dirs...'
foreach ($d in @($Bridge, $Scripts)) {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}
Say ('  ' + $Bridge)
Say ('  ' + $Scripts)

# --- 4) fetch agent ---
Say '[4/5] Fetch agent.mjs...'
$agentDst = Join-Path $Scripts 'agent.mjs'
if (Test-Path $agentDst) { Remove-Item $agentDst -Force -ErrorAction SilentlyContinue }
& scp -o BatchMode=yes -o StrictHostKeyChecking=no ($Cloud + ':' + $Remote + '/agent.mjs') $agentDst 2>&1 | Out-Null
if (-not (Test-Path $agentDst)) {
  Say '  retry with full path...'
  & scp -o BatchMode=yes -o StrictHostKeyChecking=no ($Cloud + ':/home/ubuntu/output2026/butlers/dev/WIN-HANDOVER/rebuild/agent.mjs') $agentDst 2>&1 | Out-Null
}
if (-not (Test-Path $agentDst)) {
  Say 'ERROR: cannot fetch agent.mjs'
  exit 1
}
Say ('  agent.mjs OK (' + (Get-Item $agentDst).Length + ' bytes)')

# --- 5) start script (manual only, NO auto-start) ---
Say '[5/5] Write manual start script...'
$startPs1 = Join-Path $Scripts 'start-agent.ps1'
$lines = @()
$lines += '# Start DSH bridge agent in this window. Close window / Ctrl+C to stop.'
$lines += '$ErrorActionPreference = "Continue"'
$lines += ('$agent = "' + $agentDst + '"')
$lines += 'if (-not (Test-Path $agent)) { Write-Host "agent.mjs not found"; exit 1 }'
$lines += 'Write-Host "Starting DSH bridge agent... (Ctrl+C to stop)"'
$lines += '& node $agent'
Set-Content -Path $startPs1 -Value $lines -Encoding ASCII
Say ('  ' + $startPs1)

# remove any old auto-start task
$existing = Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
if ($existing) {
  Unregister-ScheduledTask -TaskName $Task -Confirm:$false -ErrorAction SilentlyContinue
  Say '  removed old auto-start task.'
}
Say '  auto-start: DISABLED'

Say ''
Say '=================================================='
Say ' DONE'
Say '=================================================='
Say ('  start manually: powershell -ExecutionPolicy Bypass -File "' + $startPs1 + '"')
Say ('  data dir      : ' + $Bridge)
Say ('  log           : ' + $Log)
Say '=================================================='
