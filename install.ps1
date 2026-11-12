# VibeGuide 一键安装 / 更新：Windows + DeepSeek Harness 桌面版。
# 不需要 Node 或 git：下载预先构建好的包，用 Harness 自带的运行环境执行安装器。
# 只检查、不安装：先运行  $env:VIBEGUIDE_CHECK = '1'  再运行同一条安装命令。
# VIBEGUIDE_PACKAGE（包地址或本地文件）、VIBEGUIDE_APP、VIBEGUIDE_HOME 只供测试覆盖。
# 兼容 Windows 自带的 PowerShell 5.1：不使用 ??、?:、&& 这些新语法。

function Install-VibeGuide {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  $repo = 'wwyking123/VibeGuide'
  $check = ($env:VIBEGUIDE_CHECK -eq '1')
  Remove-Item Env:\VIBEGUIDE_CHECK -ErrorAction SilentlyContinue
  $sources = @(
    "https://raw.githubusercontent.com/$repo/release",
    "https://cdn.jsdelivr.net/gh/${repo}@release",
    "https://fastly.jsdelivr.net/gh/${repo}@release"
  )

  function Fail($message) {
    Write-Host ''
    Write-Host "[没有完成] $message" -ForegroundColor Red
  }

  function Find-Harness {
    if ($env:VIBEGUIDE_APP) { return $env:VIBEGUIDE_APP }
    $candidates = @()
    $keys = @(
      'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
      'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
      'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($entry in @(Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue)) {
      if ("$($entry.DisplayName)" -notmatch 'DeepSeek Harness|dsh-desktop') { continue }
      if ($entry.InstallLocation) { $candidates += "$($entry.InstallLocation)".Trim('"') }
      if ($entry.DisplayIcon) {
        $icon = ("$($entry.DisplayIcon)" -replace ',-?\d+$', '').Trim('"')
        if ($icon) { $candidates += (Split-Path -Parent $icon) }
      }
    }
    if ($env:LOCALAPPDATA) {
      $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness')
      $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\dsh-desktop')
    }
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'DeepSeek Harness') }
    foreach ($directory in $candidates) {
      if ($directory -and (Test-Path -LiteralPath (Join-Path $directory 'resources\app.asar'))) { return $directory }
    }
    return $null
  }

  # 用 Harness 自带的运行环境执行一个脚本；输出写进日志文件，返回退出码。
  function Invoke-Harness($executable, $arguments, $log) {
    $env:ELECTRON_RUN_AS_NODE = '1'
    try {
      $process = Start-Process -FilePath $executable -ArgumentList $arguments -Wait -PassThru -NoNewWindow -RedirectStandardOutput $log -RedirectStandardError "$log.err"
      return $process.ExitCode
    } finally {
      Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    }
  }

  function Read-Log($log) {
    $text = ''
    foreach ($file in @($log, "$log.err")) {
      if (Test-Path -LiteralPath $file) { $text += (Get-Content -LiteralPath $file -Raw -Encoding UTF8) + "`n" }
    }
    return $text
  }

  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

  # ── 找到 Harness 和它的设置 ──
  $app = Find-Harness
  $exe = $null
  if ($app -and (Test-Path -LiteralPath $app)) {
    $exe = Get-ChildItem -LiteralPath $app -Filter '*.exe' -File |
      Where-Object { $_.Name -notmatch '^(Uninstall|unins|Update|elevate)' } |
      Sort-Object Length -Descending | Select-Object -First 1
  }
  $dsh = Join-Path $HOME '.dsh'
  if ($env:DSH_HOME -and $env:DSH_HOME.Trim()) { $dsh = $env:DSH_HOME }
  if ($env:VIBEGUIDE_HOME) { $dsh = $env:VIBEGUIDE_HOME }
  $profileReady = Test-Path -LiteralPath (Join-Path $dsh 'profiles\desktop\package.json')
  $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
  $running = $false
  if ($exe) { $running = (@(Get-Process -Name $exe.BaseName -ErrorAction SilentlyContinue).Count -gt 0) }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('vibeguide-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    # ── 只检查，不安装 ──
    if ($check) {
      Write-Host '===== VibeGuide 环境检查（只读，不会改动任何东西）====='
      Write-Host "系统：$([Environment]::OSVersion.VersionString)，64 位：$([Environment]::Is64BitOperatingSystem)"
      Write-Host "PowerShell：$($PSVersionTable.PSVersion)"
      Write-Host "Harness 安装位置：$(if ($app) { $app } else { '没有找到' })"
      Write-Host "Harness 主程序：$(if ($exe) { $exe.Name } else { '没有找到' })"
      Write-Host "Harness 正在运行：${running}"
      Write-Host "Harness 设置目录：${dsh}（已经打开过 Harness：${profileReady}）"
      Write-Host "DSH_HOME 环境变量：$(if ($env:DSH_HOME) { $env:DSH_HOME } else { '未设置' })"
      Write-Host "解压工具 tar：$(if ($tar) { '有' } else { '没有' })"
      if ($exe) {
        $probe = Join-Path $tmp 'probe.js'
        Set-Content -LiteralPath $probe -Encoding ASCII -Value "console.log('node ' + process.version + ' electron ' + process.versions.electron); try { require('node:sqlite'); console.log('sqlite ok'); } catch (e) { console.log('sqlite ' + e.message); } try { console.log('asar ' + require('fs').existsSync(require('path').join(process.argv[2], 'resources', 'app.asar', 'dsh', 'package.json'))); } catch (e) { console.log('asar ' + e.message); }"
        $log = Join-Path $tmp 'probe.log'
        try {
          $code = Invoke-Harness $exe.FullName @(('"{0}"' -f $probe), ('"{0}"' -f $app)) $log
          Write-Host "Harness 自带运行环境：退出码 ${code}"
          Write-Host (Read-Log $log).Trim()
        } catch {
          Write-Host "Harness 自带运行环境：无法启动（$($_.Exception.Message)）"
        }
      }
      foreach ($source in $sources) {
        try {
          $served = "$((Invoke-WebRequest -UseBasicParsing -Uri "$source/VERSION" -TimeoutSec 15).Content)".Trim()
          Write-Host "下载地址可用：${source}（版本 ${served}）"
        } catch {
          Write-Host "下载地址连不上：${source}"
        }
      }
      Write-Host '===== 检查结束：请把上面这些内容复制给作者 ====='
      return
    }

    # ── 安装前的条件 ──
    if (-not $app -or -not $exe) { Fail '没有找到 DeepSeek Harness 桌面版。请先安装它，再运行这条命令。'; return }
    if (-not $profileReady) { Fail '请先打开一次 DeepSeek Harness，再运行这条命令。'; return }
    if ($running) { Fail '请先完全退出 DeepSeek Harness（右下角托盘图标也要退出），再运行这条命令。'; return }
    if (-not $tar) { Fail '这台电脑缺少解压工具 tar（Windows 10 1803 及以上自带）。请先更新系统。'; return }

    # ── 下载并解压 ──
    Write-Host '正在下载 VibeGuide…'
    $tgz = Join-Path $tmp 'vibeguide.tgz'
    $installer = Join-Path $tmp 'vibeguide\scripts\install-desktop.mjs'
    $packages = @()
    if ($env:VIBEGUIDE_PACKAGE) { $packages += $env:VIBEGUIDE_PACKAGE }
    foreach ($source in $sources) { $packages += "$source/vibeguide.tgz" }
    $downloaded = $false
    foreach ($package in $packages) {
      try {
        if (Test-Path -LiteralPath $package) { Copy-Item -LiteralPath $package -Destination $tgz -Force }
        else { Invoke-WebRequest -UseBasicParsing -Uri $package -OutFile $tgz -TimeoutSec 120 }
        $extracted = Join-Path $tmp 'vibeguide'
        if (Test-Path -LiteralPath $extracted) { Remove-Item -LiteralPath $extracted -Recurse -Force }
        & $tar.Path -xzf $tgz -C $tmp
        if (($LASTEXITCODE -eq 0) -and (Test-Path -LiteralPath $installer)) { $downloaded = $true; break }
      } catch { }
    }
    if (-not $downloaded) { Fail '下载失败。请检查网络后再试一次。'; return }

    # ── 安装（安装器会先在本机自检，通过后才改动 Harness 设置）──
    Write-Host '正在安装…'
    $log = Join-Path $tmp 'install.log'
    $arguments = @('--expose-internals', ('"{0}"' -f $installer), '--app', ('"{0}"' -f $app), '--home', ('"{0}"' -f $dsh), '--upgrade')
    $code = Invoke-Harness $exe.FullName $arguments $log
    $output = Read-Log $log
    if ($output -notmatch '"installed":\s*true') {
      $reason = ''
      $found = [regex]::Match($output, '(?m)^[A-Za-z]*Error[^:\r\n]*: (.+)$')
      if ($found.Success) { $reason = "原因：$($found.Groups[1].Value.Trim())" }
      Fail "安装没有完成，你的 Harness 设置没有被改动。${reason}"
      return
    }

    $version = (Get-Content -LiteralPath (Join-Path $tmp 'vibeguide\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
    Write-Host ''
    Write-Host "[完成] VibeGuide ${version} 安装好了。" -ForegroundColor Green
    Write-Host ''
    Write-Host '接下来：'
    Write-Host '  1. 打开 DeepSeek Harness'
    Write-Host '  2. 新建会话，在输入框上方的模式菜单选 VibeGuide'
    Write-Host '  3. 从右侧打开 VibeGuide 侧栏'
    Write-Host ''
    Write-Host '以后更新，再运行一次同一条命令就行。'
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Install-VibeGuide
