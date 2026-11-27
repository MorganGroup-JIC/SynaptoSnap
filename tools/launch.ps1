<# SynaptoSnap launcher, started by SynaptoSnap.bat.
   Serves the app's own files to this computer only (http://localhost:47321/) and opens SynaptoSnap in Edge.
   Served like this, rather than opened as a file, Edge can install SynaptoSnap as an app: its own window, a Start-menu
   entry and a sharp taskbar icon (Edge only gives un-installed app windows the 16-pixel tab icon).
   Once installed, SynaptoSnap also starts on its own without this server (sw.js keeps an offline copy); starting it
   through SynaptoSnap.bat refreshes that copy from this folder.
   Only the app's files are served (never the microscopy data in this folder), and only on this computer.
   The server stops by itself after 15 minutes without requests: the app needs it only while it starts.
   If the server cannot start, the app opens as a file, as before. #>
param([int]$Port = 47321, [int]$IdleMinutes = 15, [switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$base = "http://localhost:$Port/"
$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
  Where-Object { Test-Path $_ } | Select-Object -First 1

function Get-WebAppId([string]$manifestId) {
  # Chromium's id for an installed web app: SHA-256 of its manifest id, first 16 bytes, hex digits 0-f written as a-p
  $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($manifestId))
  -join ($hash[0..15] | ForEach-Object { [char](97 + ($_ -shr 4)); [char](97 + ($_ -band 15)) })
}

function Open-App {
  if ($NoOpen) { return }
  # installed? Edge then has a shortcut with --app-id=<id> in the Start menu (or on the desktop)
  $id = Get-WebAppId $base
  $shell = New-Object -ComObject WScript.Shell
  $lnk = @("$env:APPDATA\Microsoft\Windows\Start Menu\Programs", [Environment]::GetFolderPath('Desktop')) |
    ForEach-Object { Get-ChildItem $_ -Filter *.lnk -Recurse -ErrorAction SilentlyContinue } |
    Where-Object { $shell.CreateShortcut($_.FullName).Arguments -like "*--app-id=$id*" } | Select-Object -First 1
  if ($lnk) { Start-Process $lnk.FullName; return }
  # not installed yet: an Edge tab, where the app shows "Install app" (and Edge an install icon in the address bar)
  if ($edge) { Start-Process $edge $base } else { Start-Process $base }
}

function Open-AsFile {
  if ($NoOpen) { return }
  $url = ([Uri](Join-Path $root 'index.html')).AbsoluteUri
  if ($edge) { Start-Process $edge "--app=`"$url`"" } else { Start-Process (Join-Path $root 'index.html') }
}

# already serving (SynaptoSnap.bat started earlier)? then only open the app
try {
  if ((Invoke-WebRequest "$($base)__synaptosnap" -UseBasicParsing -TimeoutSec 2).Content -eq 'SynaptoSnap') { Open-App; exit 0 }
} catch { }

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($base)
try { $listener.Start() } catch { Open-AsFile; exit 2 }   # e.g. the port is used by another program
Open-App

$types = @{ '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.webmanifest' = 'application/manifest+json'
            '.png' = 'image/png'; '.svg' = 'image/svg+xml'; '.ico' = 'image/x-icon' }
$allowed = '^(index\.html|manifest\.webmanifest|sw\.js|icon\.(svg|ico)|js/(vendor/)?[\w.-]+\.js|icons/[\w.-]+\.png|tools/[\w.-]+\.html)$'
$last = Get-Date
while ($listener.IsListening) {
  $next = $listener.GetContextAsync()
  while (-not $next.Wait(1000)) {
    if (((Get-Date) - $last).TotalMinutes -ge $IdleMinutes) { $listener.Stop(); exit 0 }
  }
  $ctx = $next.Result; $last = Get-Date
  $req = $ctx.Request; $res = $ctx.Response
  try {
    $rel = [Uri]::UnescapeDataString($req.Url.AbsolutePath.TrimStart('/'))
    if ($rel -eq '') { $rel = 'index.html' }
    $bytes = $null
    if ($req.HttpMethod -ne 'GET' -and $req.HttpMethod -ne 'HEAD') { $res.StatusCode = 405 }
    elseif ($rel -eq '__synaptosnap') { $bytes = [Text.Encoding]::UTF8.GetBytes('SynaptoSnap'); $res.ContentType = 'text/plain' }
    elseif ($rel -match $allowed -and $rel -notmatch '\.\.') {
      $path = Join-Path $root $rel
      if (Test-Path -LiteralPath $path -PathType Leaf) {
        $bytes = [IO.File]::ReadAllBytes($path)
        $res.ContentType = $types[[IO.Path]::GetExtension($path).ToLower()]
      } else { $res.StatusCode = 404 }
    } else { $res.StatusCode = 404 }
    if ($bytes) {
      $res.Headers['Cache-Control'] = 'no-cache'   # sw.js asks the network first, so a started app is always this folder's version
      $res.ContentLength64 = $bytes.Length
      if ($req.HttpMethod -eq 'GET') { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
    }
  } catch { $res.StatusCode = 500 } finally { $res.Close() }
}
