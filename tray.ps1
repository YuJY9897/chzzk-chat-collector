# CHZZK Clip Scout 트레이 아이콘
# 서버(node src/server.js)와 함께 실행되어 트레이에서 열기/종료를 제공한다.
# 서버가 꺼지면(포트가 닫히면) 스스로 종료된다.

param([int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 3000 }))

# 중복 실행 방지
$script:mutex = New-Object System.Threading.Mutex($false, "ChzzkClipScoutTray_$Port")
if (-not $script:mutex.WaitOne(0, $false)) { exit }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:openUrl = "http://localhost:$Port"

# 브랜드 컬러 초록 점 아이콘 생성
$bmp = New-Object System.Drawing.Bitmap 16, 16
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(0, 217, 165))
$g.FillEllipse($brush, 1, 1, 14, 14)
$g.Dispose()

$script:notify = New-Object System.Windows.Forms.NotifyIcon
$script:notify.Icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
$script:notify.Text = "CHZZK Clip Scout 실행 중"
$script:notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add("열기")
[void]$menu.Items.Add("-")
$quitItem = $menu.Items.Add("앱 종료")
$script:notify.ContextMenuStrip = $menu

$openItem.add_Click({ Start-Process $script:openUrl })
$script:notify.add_DoubleClick({ Start-Process $script:openUrl })

$quitItem.add_Click({
  try { Invoke-RestMethod -Method Post -Uri "$($script:openUrl)/api/app/quit" -TimeoutSec 3 | Out-Null } catch {}
  $script:notify.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})

# 서버가 꺼지면 트레이도 자동 종료
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.add_Tick({
  $listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if (-not $listening) {
    $script:notify.Visible = $false
    [System.Windows.Forms.Application]::Exit()
  }
})
$timer.Start()

$script:notify.ShowBalloonTip(3000, "CHZZK Clip Scout", "백그라운드에서 실행 중입니다. 이 아이콘을 더블클릭하면 화면이 열립니다.", [System.Windows.Forms.ToolTipIcon]::Info)

[System.Windows.Forms.Application]::Run()
