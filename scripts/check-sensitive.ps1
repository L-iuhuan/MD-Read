#requires -Version 5.1
<#
  scripts/check-sensitive.ps1 — 提交前 / 发布前敏感信息门禁

  用法：
    pwsh -File scripts/check-sensitive.ps1              # 扫描全部已跟踪文件
    pwsh -File scripts/check-sensitive.ps1 -Staged      # 只扫描已暂存改动
    pwsh -File scripts/check-sensitive.ps1 -Path docs   # 只扫描指定路径
    pwsh -File scripts/check-sensitive.ps1 -FixList     # 只列命中，不判失败（排查用）

  退出码：0 = 通过；1 = 命中敏感信息（可用于 CI / pre-commit）

  ⚠️ 设计要点（重要）：
    本文件**不得**写入具体的人名、邮箱、公司名、内网标识 ——
    否则脚本自身就成了新的泄露源。具体词条放在
    `scripts/.sensitive-extra.txt`（已 gitignore，不进仓库）。
#>
[CmdletBinding()]
param(
  [switch]$Staged,
  [string]$Path,
  [switch]$FixList
)

$ErrorActionPreference = 'Stop'
$repoRoot = (git rev-parse --show-toplevel).Trim()
Set-Location $repoRoot

# ── 1) 通用模式（内联安全：不含任何具体身份信息）────────────────
$generic = [ordered]@{
  '邮箱'             = '[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Za-z0-9.-]+\.(?!png\b|jpe?g\b|webp\b|gif\b|ico\b|svg\b|bmp\b)[A-Za-z]{2,}'
  '内网/公网 IP'     = '\b(?!127\.0\.0\.1)(?!0\.0\.0\.0)(?!(?:198\.18)\.)(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b'
  'UNC 主机路径'     = '\\\\[A-Za-z0-9._-]+\\'
  'Windows 家目录'   = '[A-Za-z]:\\\\?[Uu]sers\\\\[A-Za-z0-9._-]+'
  'Unix 家目录'      = '/(?:home|Users)/[A-Za-z0-9._-]+'
  '疑似凭据'         = '(?i)(secret|passwd|password|api[_-]?key|access[_-]?key|private[_-]?key)[\s]*[:=][\s]*[A-Za-z0-9/+_=-]{16,}'
  '备案/主体信息'    = 'ICP备|公网安备|有限公司|股份有限公司'
}

# ── 2) 具体词条（从 gitignore 的外部文件读，避免脚本自身泄露）──
$extraFile = Join-Path $repoRoot 'scripts/.sensitive-extra.txt'
$extra = [ordered]@{}
if (Test-Path -LiteralPath $extraFile) {
  $i = 0
  foreach ($line in Get-Content -LiteralPath $extraFile -Encoding UTF8) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    $i++
    $extra["自定义词条#$i"] = [regex]::Escape($t)
  }
} else {
  Write-Warning "未找到 $extraFile —— 只跑通用模式；具体人名/域名等不会被检出。"
}

$patterns = [ordered]@{}
foreach ($k in $generic.Keys) { $patterns[$k] = $generic[$k] }
foreach ($k in $extra.Keys)   { $patterns[$k] = $extra[$k] }

# ── 3) 已知假阳性（测试夹具里的故意假路径，不算泄露）────────────
$allowList = @(
  'D:\\docs\\a.md', 'D:/docs/a.md',
  'E:\\docs\\sub\\a.md', 'E:/docs/sub/a.md'
)

# ── 4) 取文件清单 ────────────────────────────────────────────
if ($Staged) {
  $files = git -c core.quotepath=false diff --cached --name-only --diff-filter=ACMR
} elseif ($Path) {
  $files = git -c core.quotepath=false ls-files -- $Path
} else {
  $files = git -c core.quotepath=false ls-files
}
$files = @($files | Where-Object { $_ -and $_ -notmatch '^"' -and (Test-Path -LiteralPath $_ -ErrorAction SilentlyContinue) })

if ($files.Count -eq 0) { Write-Host "没有需要扫描的文件。" -ForegroundColor Yellow; exit 0 }

$hits = @()
foreach ($f in $files) {
  # 跳过二进制
  if ($f -match '\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf|msi|exe|pdf|zip|bundle)$') { continue }
  $isTestFixture = $f -match '(^|/)tests/'   # 测试夹具含故意假路径
  $lineNo = 0
  foreach ($line in (Get-Content -LiteralPath $f -Encoding UTF8 -ErrorAction SilentlyContinue)) {
    $lineNo++
    foreach ($name in $patterns.Keys) {
      if ($isTestFixture -and $name -match 'UNC|家目录') { continue }
      if ([regex]::IsMatch($line, $patterns[$name])) {
        $isAllowed = $false
        foreach ($a in $allowList) { if ($line -like "*$a*") { $isAllowed = $true; break } }
        if (-not $isAllowed) {
          $hits += [pscustomobject]@{ 类别 = $name; 文件 = $f; 行 = $lineNo; 片段 = $line.Trim() }
        }
      }
    }
  }
}

# ── 5) 报告 ──────────────────────────────────────────────────
if ($hits.Count -eq 0) {
  Write-Host "✅ 敏感信息门禁通过（扫描 $($files.Count) 个文件，模式 $($patterns.Count) 条）" -ForegroundColor Green
  exit 0
}

Write-Host "❌ 命中 $($hits.Count) 处敏感信息（扫描 $($files.Count) 个文件）：" -ForegroundColor Red
$hits | Group-Object 类别 | ForEach-Object {
  Write-Host ""
  Write-Host "  【$($_.Name)】$($_.Count) 处" -ForegroundColor Yellow
  $_.Group | Select-Object -First 10 | ForEach-Object {
    $s = if ($_.片段.Length -gt 110) { $_.片段.Substring(0, 110) + '…' } else { $_.片段 }
    Write-Host ("    {0}:{1}  {2}" -f $_.文件, $_.行, $s)
  }
  if ($_.Count -gt 10) { Write-Host "    …（另有 $($_.Count - 10) 处）" }
}
Write-Host ""
Write-Host "处理建议：改写为占位符（<user@example.com> / <公司> / <user> / 10.0.0.1）或移出公开仓库。" -ForegroundColor Cyan
if ($FixList) { exit 0 }
exit 1