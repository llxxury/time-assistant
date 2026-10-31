# End-to-end regression on the real phone (ASCII only: PS 5.1 reads .ps1 as ANSI).
# Flow: wipe data -> cold start -> inject 10-day-old store -> restart -> assert -> tap week tab -> screenshot
# Usage: powershell -ExecutionPolicy Bypass -File D:\ta-build\e2e.ps1
$ErrorActionPreference = 'Continue'
$ADB = if ($env:ADB) { $env:ADB } else { Join-Path $env:TEMP 'platform-tools\adb.exe' }
$PKG = 'ai.cosmos.timeassistant'
$CDP = if ($env:TA_CDP) { $env:TA_CDP } else { Join-Path (Split-Path $PSScriptRoot -Parent) 'tools\cdp.mjs' }
$SHOT = Join-Path $env:TEMP 'e2e-week.png'

function AppPid {
  for ($i = 0; $i -lt 20; $i++) {
    $p = (& $ADB shell pidof $PKG 2>$null) -replace "`r", '' -replace '\s', ''
    if ($p) { return $p }
    Start-Sleep -Milliseconds 400
  }
  throw 'app did not start'
}

function Fwd {
  $p = AppPid
  & $ADB forward --remove-all 2>$null | Out-Null
  & $ADB forward tcp:9222 localabstract:webview_devtools_remote_$p 2>&1 | Out-Null
  return $p
}

function Cdp([string]$expr) {
  Fwd | Out-Null
  return (node $CDP $expr)
}

# Process up != page ready. Wait until the WebView is actually interactive,
# otherwise the assertions read a half-booted page.
function WaitReady {
  for ($i = 0; $i -lt 40; $i++) {
    try {
      Fwd | Out-Null
      $r = node $CDP "document.readyState + '|' + document.querySelectorAll('.seg-btn').length" 2>$null
      if ($r -match '^complete\|[1-9]') { return }
    } catch {}
    Start-Sleep -Milliseconds 500
  }
  throw 'page never became ready'
}

# MIUI shows its own notification-permission sheet after pm clear; it covers the UI and
# can kill the launch. Tap "always allow" if that sheet is up.
function DismissPermSheet {
  Start-Sleep -Seconds 1
  $focus = (& $ADB shell dumpsys window 2>$null | Select-String 'mCurrentFocus' | Out-String)
  if ($focus -match 'GrantPermissions|permission') {
    & $ADB shell input tap 525 1460
    Start-Sleep -Seconds 2
  }
}

Write-Host '[1/6] wipe data'
& $ADB shell pm clear $PKG | Out-Null
# pm clear also revokes POST_NOTIFICATIONS; the app then shows the system grant dialog
# which covers the UI and makes the test read a half-started page.
# pm grant is ignored on MIUI, appops works.
& $ADB shell appops set $PKG POST_NOTIFICATION allow 2>$null | Out-Null
& $ADB shell pm grant $PKG android.permission.POST_NOTIFICATIONS 2>$null | Out-Null

Write-Host '[2/6] cold start'
& $ADB shell am start -n "$PKG/.MainActivity" 2>&1 | Out-Null
Start-Sleep -Seconds 2
DismissPermSheet
WaitReady
$first = Cdp "(() => { const s = JSON.parse(Cosmos.load()||'null'); return JSON.stringify({startDate:s.startDate, tasks:(s.tasks||[]).length}); })()"
Write-Host "      first run: $first"

Write-Host '[3/6] inject 10-day-old store'
Cdp "@D:\ta-build\inject.js" | Out-Null

Write-Host '[4/6] restart (kill + start, like a user reopening the app)'
# Do NOT use location.reload(): on pagehide the page flushes its in-memory store back
# to disk and would wipe the injected one.
& $ADB shell am force-stop $PKG | Out-Null
Start-Sleep -Milliseconds 600
& $ADB shell am start -n "$PKG/.MainActivity" 2>&1 | Out-Null
Start-Sleep -Seconds 2
DismissPermSheet
WaitReady

Write-Host '[5/6] assert'
$raw = Cdp "(() => { const s = JSON.parse(Cosmos.load()||'null'); return JSON.stringify({startDate:s.startDate, logDate:(s.log[0]||{}).date, logDay:(s.log[0]||{}).day, pendDate:s.pending[0] && s.pending[0].date, pendKey:s.pending[0] && s.pending[0].key, days:(s.lastPlan||[]).map(p=>p.day), tasks:(s.tasks||[]).length}); })()"
$s = $raw | ConvertFrom-Json
$today = (Get-Date).ToString('yyyy-MM-dd')
$checks = [ordered]@{
  'startDate rolled to today' = ($s.startDate -eq $today)
  'old log keeps its date'    = ($s.logDate -eq '2026-10-21')
  'old log day recomputed'    = ($s.logDay -eq -10)
  'overdue block -> pending'  = ($s.pendDate -eq '2026-10-26')
  'pending key rewritten'     = ($s.pendKey -eq 't2|-5|1140')
  'blocks landed in 7 days'   = (($s.days | Measure-Object -Minimum).Minimum -ge 0 -and ($s.days | Measure-Object -Maximum).Maximum -lt 7)
  'tasks intact'              = ($s.tasks -eq 3)
}
$fail = 0
foreach ($k in $checks.Keys) {
  if ($checks[$k]) { Write-Host "      PASS  $k" } else { Write-Host "      FAIL  $k"; $fail++ }
}
Write-Host "      raw: $raw"

Write-Host '[6/6] native tap -> week tab, screenshot'
& $ADB shell input tap 190 132
Start-Sleep -Seconds 2
& $ADB shell screencap -p /sdcard/_e2e.png
& $ADB pull /sdcard/_e2e.png $SHOT 2>$null | Out-Null
& $ADB shell rm /sdcard/_e2e.png

Write-Host '[7/9] axis view toggle'
$axis = Cdp "(async()=>{const s=(ms)=>new Promise(r=>setTimeout(r,ms));const m=[...document.querySelectorAll('#plan-mode .seg-btn')].find(b=>b.dataset.m==='axis');if(!m)return 'no-toggle';m.click();await s(700);return document.querySelectorAll('.axis-bar').length>0?'axis-ok':'axis-empty';})()"
if ($axis -match 'axis-ok') { Write-Host '      PASS  axis renders blocks'; $checks['axis view'] = $true }
else { Write-Host "      FAIL  axis ($axis)"; $checks['axis view'] = $false; $fail++ }
Cdp "(async()=>{const s=(ms)=>new Promise(r=>setTimeout(r,ms));const m=[...document.querySelectorAll('#plan-mode .seg-btn')].find(b=>b.dataset.m==='list');if(m){m.click();await s(400);}return 'back';})()" | Out-Null

Write-Host '[8/9] dark skin'
$dark = Cdp "(async()=>{const s=(ms)=>new Promise(r=>setTimeout(r,ms));const t=[...document.querySelectorAll('.seg-btn')].find(b=>b.dataset.tab==='settings');if(!t)return 'no-tab';t.click();await s(600);const c=[...document.querySelectorAll('#skin-chips .chip')].find(x=>x.dataset.s==='dark');if(!c)return 'no-chip';c.click();await s(800);const ok=!!document.getElementById('skin-dark');const bg=getComputedStyle(document.querySelector('.card')||document.body).backgroundColor;return ok+'|'+bg;})()"
if ($dark -match '^True\|rgb\(24, 28, 37\)') { Write-Host '      PASS  dark skin applied'; $checks['dark skin'] = $true }
else { Write-Host "      FAIL  dark skin ($dark)"; $checks['dark skin'] = $false; $fail++ }

Write-Host '[9/9] share image'
& $ADB shell rm -f /sdcard/Pictures/time-assistant-*.png 2>$null | Out-Null
$share = Cdp "(async()=>{const s=(ms)=>new Promise(r=>setTimeout(r,ms));const t=[...document.querySelectorAll('.seg-btn')].find(b=>b.dataset.tab==='week');if(!t)return 'no-tab';t.click();await s(700);const b=document.querySelector('#plan-share');if(!b)return 'no-btn';b.click();await s(2000);return ((document.querySelector('#toast')||{}).textContent||'');})()"
Start-Sleep -Seconds 1
$png = (& $ADB shell ls /sdcard/Pictures 2>$null | Select-String 'time-assistant-.*\.png' | Measure-Object).Count
if ($png -ge 1) { Write-Host '      PASS  share png written'; $checks['share image'] = $true }
else { Write-Host "      FAIL  share png missing ($share)"; $checks['share image'] = $false; $fail++ }

if ($fail -eq 0) { Write-Host "RESULT: PASS ($($checks.Count) checks)  shot=$SHOT"; exit 0 }
else { Write-Host "RESULT: FAIL ($fail/$($checks.Count))  shot=$SHOT"; exit 1 }
