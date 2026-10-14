# WebView2 启动自检（只读 + 一次临时进程探测；不改任何用户数据）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\wv2-probe.ps1
$ErrorActionPreference = 'Continue'
$report = Join-Path $PSScriptRoot 'wv2-probe-report.txt'
function Say($t) { Write-Host $t; Add-Content -Path $report -Value $t }
Set-Content -Path $report -Value ("WebView2 自检 " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))

Say "=== 1) 身份 ==="
Say ("whoami: " + (whoami 2>&1))
$id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
Say ("User: " + $id.Name)
$pr = New-Object System.Security.Principal.WindowsPrincipal($id)
Say ("Elevated(管理员): " + $pr.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator))
Say ("IntegrityLevel: " + ($id.Groups | Where-Object { $_.Value -like 'S-1-16-*' } | ForEach-Object { $_.Value }) -join ',')

Say ""
Say "=== 2) 用户态目录可写性 ==="
foreach ($d in @("$env:LOCALAPPDATA\com.modu.reader", "$env:APPDATA\com.modu.reader", $env:TEMP)) {
  if (-not (Test-Path $d)) { Say ("不存在: " + $d); continue }
  $t = Join-Path $d ("_wtest_" + [guid]::NewGuid().ToString('N') + ".tmp")
  try { [IO.File]::WriteAllText($t, "x"); Remove-Item $t -Force; Say ("可写 OK   " + $d) }
  catch { Say ("不可写 FAIL " + $d + " : " + $_.Exception.Message) }
}
$tf = "$env:APPDATA\com.modu.reader\trusted-paths.json"
if (Test-Path $tf) {
  try { $fs = [IO.File]::Open($tf, 'Open', 'ReadWrite', 'None'); $fs.Close(); Say ("可写 OK   " + $tf) }
  catch { Say ("不可写/被占用 FAIL " + $tf + " : " + $_.Exception.Message) }
}

Say ""
Say "=== 3) WebView2 运行时 ==="
$root = "${env:ProgramFiles(x86)}\Microsoft\EdgeWebView\Application"
$vers = @(Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^\d+\.' } | Sort-Object Name -Descending)
Say ("安装的运行时目录: " + ((@($vers | ForEach-Object Name)) -join ' , '))
$exe = Join-Path $vers[0].FullName 'msedgewebview2.exe'
Say ("最新 msedgewebview2.exe 存在: " + (Test-Path $exe))
Say ("UDF 里出现过的运行时快照版本: " + ((@(Get-ChildItem "$env:LOCALAPPDATA\com.modu.reader\EBWebView\Snapshots" -Directory -ErrorAction SilentlyContinue | ForEach-Object Name)) -join ' , '))

Say ""
Say "=== 4) 直接拉起 WebView2 浏览器进程（隔离 UDF，4 秒后清理） ==="
$probeUdf = Join-Path $env:TEMP ("wv2-probe-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $probeUdf | Out-Null
try {
  $p = Start-Process -FilePath $exe -PassThru -ArgumentList @(
    '--embedded-browser-webview=1', '--webview-exe-name=wv2probe.exe', '--webview-exe-version=1.0.0',
    ("--user-data-dir=" + $probeUdf), '--no-first-run', '--no-default-browser-check', 'about:blank'
  )
  Start-Sleep -Seconds 4
  $alive = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($probeUdf) })
  Say ("探测进程 pid=" + $p.Id + " 已退出=" + $p.HasExited)
  Say ("用同一 UDF 存活的 msedgewebview2 进程数: " + $alive.Count)
  if ($alive.Count -gt 0) { Say "结论: WebView2 引擎在你这个会话里【能】启动 -> 问题在 UDF/占用面" }
  else { Say "结论: WebView2 引擎在你这个会话里【起不来】(0 个子进程) -> 策略/EDR 拦截或运行时损坏" }
  foreach ($a in $alive) { Stop-Process -Id $a.ProcessId -Force -ErrorAction SilentlyContinue }
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
} catch { Say ("直接拉起失败: " + $_.Exception.Message) }
Remove-Item $probeUdf -Recurse -Force -ErrorAction SilentlyContinue

Say ""
Say "=== 5) 安全软件 / 策略 ==="
try { (Get-MpComputerStatus | Select-Object AMRunningMode, RealTimeProtectionEnabled, AntivirusEnabled | Format-List | Out-String).Trim() | ForEach-Object { Say $_ } } catch { Say "Get-MpComputerStatus 不可用" }
try { Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction SilentlyContinue | ForEach-Object { Say ("AV: " + $_.displayName) } } catch { }
try {
  $ev = Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = (Get-Date).AddHours(-6) } -MaxEvents 300 -ErrorAction SilentlyContinue |
    Where-Object { $_.Message -match 'msedgewebview2|WebView2|AppLocker|CodeIntegrity|modu' } | Select-Object -First 8
  if ($ev) { foreach ($e in $ev) { Say ("事件 " + $e.TimeCreated + " [" + $e.ProviderName + "] " + (($e.Message -replace '\s+', ' ').Substring(0, [Math]::Min(200, $e.Message.Length)))) } }
  else { Say "近 6 小时 Application 日志里没有 WebView2/AppLocker/modU 相关事件" }
} catch { Say ("事件日志读取失败: " + $_.Exception.Message) }

Say ""
Say ("报告已写到: " + $report)