#requires -Version 5.1
<#
  scripts/check-sensitive.ps1 — 提交前 / 发布前敏感信息门禁

  用法（**2026-09-23 本机实测可跑**）：
    scripts\check-sensitive.cmd                                  # 薄包装：cmd / PowerShell / CI 都能直接用
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\check-sensitive.ps1
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\check-sensitive.ps1 -Staged
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\check-sensitive.ps1 -Path docs
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\check-sensitive.ps1 -FixList

  ⚠️ 为什么必须带 `-ExecutionPolicy Bypass`：本机/公司机的执行策略默认 RemoteSigned，
     仓里的 .ps1 没有签名 → 直接 `.\scripts\check-sensitive.ps1` 会报「禁止运行脚本」
     （2026-09-23 实测：门禁"谁都跑不了"就是这个原因）。
  ⚠️ 为什么用 `powershell.exe` 而不是 `pwsh`：本机只有 Windows PowerShell 5.1
     （`pwsh` 不存在，实测）；本脚本按 5.1 兼容写（`#requires -Version 5.1`）。

  退出码：0 = 通过（含"无自定义词条文件"时只跑通用模式的降级路径）；
          1 = 命中敏感信息（CI / pre-commit 直接判 `$LASTEXITCODE`）。
          其它非零 = 脚本自身跑不起来（缺 git、路径不对等），同样应视为失败。

  ⚠️ 跑任何命令时的通用坑（本项目已踩过）：`cargo test 2>&1 | Select-Object -Last N`
     会因为 PowerShell 把原生命令的 stderr 当成 `NativeCommandError` 而**显示"exit 1"**，
     其实测试是通过的。**判退出码永远显式读 `$LASTEXITCODE`**，不要看管道里的红字。

  ⚠️ 设计要点（重要）：
    本文件**不得**写入具体的人名、邮箱、公司名、内网标识 ——
    否则脚本自身就成了新的泄露源。具体词条放在
    `scripts/.sensitive-extra.txt`（已 gitignore，不进仓库）；该文件缺失时降级为
    "只跑通用模式"并给出警告（CI 里必然缺失，必须能继续跑）。
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
# ⚠ 这里只放**具体字面量**，不要放"整类豁免" —— 整类豁免会连真实泄露一起盖住。
#   造夹具时优先用不撞正则的形状（如 `C:\docs\…`）；撞上了就在此加白，并写明出处。
#   注意「家目录」类正则**对测试夹具同样生效**（故意的）：真实家目录粘进夹具里仍要被抓。
$allowList = @(
  'D:\\docs\\a.md', 'D:/docs/a.md',
  'E:\\docs\\sub\\a.md', 'E:/docs/sub/a.md',
  '/home/u/a.md'                     # modu/tests/recent.spec.ts:95 的 dirName 夹具
)

# ── 4) 取文件清单 ────────────────────────────────────────────
if ($Staged) {
  $files = git -c core.quotepath=false diff --cached --name-only --diff-filter=ACMR
} elseif ($Path) {
  $files = git -c core.quotepath=false ls-files -- $Path
} else {
  $files = git -c core.quotepath=false ls-files
}
# 门禁自身与词条清单不参与扫描（前者含模式字面量如「有限公司」，后者是词条来源，都会自命中）
$selfSkip = @('scripts/check-sensitive.ps1', 'scripts/.sensitive-extra.txt')
$files = @($files | Where-Object { $selfSkip -notcontains $_ } | Where-Object { $_ -and $_ -notmatch '^"' -and (Test-Path -LiteralPath $_ -ErrorAction SilentlyContinue) })

if ($files.Count -eq 0) { Write-Host "没有需要扫描的文件。" -ForegroundColor Yellow; exit 0 }

$hits = @()
foreach ($f in $files) {
  # 跳过二进制
  if ($f -match '\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf|msi|exe|pdf|zip|bundle)$') { continue }
  # 测试夹具含**故意造的假路径**，会让路径类正则咬到转义反斜杠（如 Rust 的 "C:\\docs\\a.md"、
  # TS 的 "D:\\docs\\b.md"）。覆盖三种形态：tests 目录 / src 下的 *_tests.rs / *.spec|test.ts。
  $isTestFixture = ($f -match '(^|/)tests?/') -or ($f -match '_tests?\.rs$') -or ($f -match '\.(spec|test)\.(ts|tsx|js)$')
  $lineNo = 0
  foreach ($line in (Get-Content -LiteralPath $f -Encoding UTF8 -ErrorAction SilentlyContinue)) {
    $lineNo++
    foreach ($name in $patterns.Keys) {
      # 只豁免「UNC 主机路径」一种：测试夹具里的 `\\docs\` 是 Rust/TS 转义字面量，必然假阳性。
      # ⚠ **不豁免「家目录」** —— 真实用户家目录（C:\Users\<真名>）出现在测试里仍然是敏感信息，必须照抓。
      if ($isTestFixture -and $name -eq 'UNC 主机路径') { continue }
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
Write-Host "处理建议：改写为占位符（<user@example.com> / <公司> / <user> / <内网IP>）或移出公开仓库。" -ForegroundColor Cyan
if ($FixList) { exit 0 }
exit 1