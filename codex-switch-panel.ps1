param(
  [switch]$NoLaunch
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $env:USERPROFILE ".codex-switch\config.json"
$LegacyConfigPath = Join-Path $env:USERPROFILE ".codexbar-win\config.json"
$UsageUrl = "https://chatgpt.com/codex/settings/usage"
$CodexAppUri = "shell:AppsFolder\OpenAI.Codex_2p2nqsd0c76g0!App"

function Read-Config {
  if (!(Test-Path -LiteralPath $ConfigPath) -and (Test-Path -LiteralPath $LegacyConfigPath)) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ConfigPath) | Out-Null
    Copy-Item -LiteralPath $LegacyConfigPath -Destination $ConfigPath -Force
  }
  if (!(Test-Path -LiteralPath $ConfigPath)) {
    throw "Config not found: $ConfigPath"
  }
  return Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
}

function Get-OAuthProvider($config) {
  return @($config.providers | Where-Object { $_.id -eq "openai-oauth" -or $_.kind -eq "openai-oauth" })[0]
}

function Quote-Arg([string]$Value) {
  if ($null -eq $Value) { return '""' }
  if ($Value -notmatch '[\s"]') { return $Value }
  return '"' + ($Value -replace '\\(?=")', '\\' -replace '"', '\"') + '"'
}

function Invoke-NodeCli([string[]]$ArgsList) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "node"
  $psi.WorkingDirectory = $ProjectDir
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $allArgs = @("codex-switch.js") + $ArgsList
  $psi.Arguments = ($allArgs | ForEach-Object { Quote-Arg $_ }) -join " "
  $p = [System.Diagnostics.Process]::Start($psi)
  $stdout = $p.StandardOutput.ReadToEnd()
  $stderr = $p.StandardError.ReadToEnd()
  $p.WaitForExit()
  if ($p.ExitCode -ne 0) {
    throw (($stderr + "`n" + $stdout).Trim())
  }
  return $stdout.Trim()
}

function Invoke-NodeScript([string]$ScriptName, [string[]]$ArgsList) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "node"
  $psi.WorkingDirectory = $ProjectDir
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $allArgs = @($ScriptName) + $ArgsList
  $psi.Arguments = ($allArgs | ForEach-Object { Quote-Arg $_ }) -join " "
  $p = [System.Diagnostics.Process]::Start($psi)
  $stdout = $p.StandardOutput.ReadToEnd()
  $stderr = $p.StandardError.ReadToEnd()
  $p.WaitForExit()
  if ($p.ExitCode -ne 0) {
    throw (($stderr + "`n" + $stdout).Trim())
  }
  return $stdout.Trim()
}

function Open-Browser([string]$Browser, [string]$Url) {
  $exe = switch ($Browser) {
    "chrome" { "chrome" }
    "edge" { "msedge" }
    "firefox" { "firefox" }
    default { $null }
  }
  if ($exe) {
    Start-Process -FilePath $exe -ArgumentList $Url
  } else {
    Start-Process $Url
  }
}

function Restart-CodexDesktop {
  $codexProcesses = @(Get-Process -Name "Codex" -ErrorAction SilentlyContinue)
  foreach ($process in $codexProcesses) {
    try { Stop-Process -Id $process.Id -Force -ErrorAction Stop } catch {}
  }
  Start-Sleep -Milliseconds 900
  try {
    Start-Process $CodexAppUri
    return
  } catch {}

  $candidate = @(Get-Process -Name "Codex" -ErrorAction SilentlyContinue | Select-Object -First 1)[0]
  if ($candidate -and $candidate.Path) {
    Start-Process -FilePath $candidate.Path
    return
  }

  $windowsApps = Join-Path $env:ProgramFiles "WindowsApps"
  $exe = Get-ChildItem -Path $windowsApps -Filter "Codex.exe" -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "OpenAI\.Codex" } |
    Select-Object -First 1
  if ($exe) {
    Start-Process -FilePath $exe.FullName
    return
  }
  throw "Codex Desktop was closed, but could not be relaunched automatically."
}

function New-Label([string]$Text, [int]$X, [int]$Y, [int]$W, [int]$H, [int]$Size = 10, [bool]$Bold = $false) {
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $Text
  $label.Location = New-Object System.Drawing.Point($X, $Y)
  $label.Size = New-Object System.Drawing.Size($W, $H)
  $style = if ($Bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
  $label.Font = New-Object System.Drawing.Font("Segoe UI", $Size, $style)
  $label.ForeColor = [System.Drawing.Color]::FromArgb(232, 238, 245)
  $label.BackColor = [System.Drawing.Color]::Transparent
  return $label
}

function Mask-Email([string]$Value) {
  if (!$Value -or $Value -notmatch '@') { return $Value }
  $parts = $Value.Split('@', 2)
  $name = $parts[0]
  $domain = $parts[1]
  if ($name.Length -le 2) { return ('*' * $name.Length) + '@' + $domain }
  return ('*' * [Math]::Max(3, $name.Length - 2)) + $name.Substring($name.Length - 2) + '@' + $domain
}

function New-Button([string]$Text, [int]$X, [int]$Y, [int]$W, [int]$H, [System.Drawing.Color]$Back) {
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $Text
  $button.Location = New-Object System.Drawing.Point($X, $Y)
  $button.Size = New-Object System.Drawing.Size($W, $H)
  $button.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
  $button.FlatAppearance.BorderSize = 0
  $button.BackColor = $Back
  $button.ForeColor = [System.Drawing.Color]::White
  $button.Font = New-Object System.Drawing.Font("Segoe UI", 9.5, [System.Drawing.FontStyle]::Bold)
  return $button
}

$bg = [System.Drawing.Color]::FromArgb(20, 24, 31)
$panelBg = [System.Drawing.Color]::FromArgb(30, 36, 46)
$line = [System.Drawing.Color]::FromArgb(55, 64, 78)
$accent = [System.Drawing.Color]::FromArgb(0, 122, 204)
$muted = [System.Drawing.Color]::FromArgb(150, 161, 176)

$form = New-Object System.Windows.Forms.Form
$form.Text = "codex-switch"
$form.StartPosition = "CenterScreen"
$form.Size = New-Object System.Drawing.Size(760, 420)
$form.MinimumSize = New-Object System.Drawing.Size(720, 380)
$form.Font = New-Object System.Drawing.Font("Segoe UI", 10)
$form.BackColor = $bg

$activePanel = New-Object System.Windows.Forms.Panel
$activePanel.Location = New-Object System.Drawing.Point(22, 20)
$activePanel.Size = New-Object System.Drawing.Size(700, 64)
$activePanel.BackColor = $panelBg
$form.Controls.Add($activePanel)

$activeTitle = New-Label "ACTIVE" 16 10 80 18 8 $true
$activeTitle.ForeColor = $muted
$activeText = New-Label "Loading..." 16 30 315 24 11 $true
$costText = New-Label "Total used 5h -   7d -" 350 30 330 24 9 $true
$costText.TextAlign = [System.Drawing.ContentAlignment]::MiddleRight
$costText.ForeColor = $muted
$activePanel.Controls.Add($activeTitle)
$activePanel.Controls.Add($activeText)
$activePanel.Controls.Add($costText)

$accounts = New-Object System.Windows.Forms.ListView
$accounts.Location = New-Object System.Drawing.Point(22, 104)
$accounts.Size = New-Object System.Drawing.Size(700, 204)
$accounts.View = [System.Windows.Forms.View]::Details
$accounts.FullRowSelect = $true
$accounts.MultiSelect = $false
$accounts.HideSelection = $false
$accounts.BackColor = [System.Drawing.Color]::FromArgb(25, 30, 38)
$accounts.ForeColor = [System.Drawing.Color]::FromArgb(232, 238, 245)
$accounts.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
$accounts.GridLines = $false
$accounts.ShowItemToolTips = $true
[void]$accounts.Columns.Add("Account", 260)
[void]$accounts.Columns.Add("5h", 70)
[void]$accounts.Columns.Add("7d", 70)
[void]$accounts.Columns.Add("5h Used", 76)
[void]$accounts.Columns.Add("7d Used", 76)
[void]$accounts.Columns.Add("Status", 90)
$form.Controls.Add($accounts)

$switchButton = New-Button "Switch" 22 324 126 36 $accent
$refreshButton = New-Button "Refresh" 158 324 126 36 ([System.Drawing.Color]::FromArgb(74, 85, 104))
$closeButton = New-Button "Close" 596 324 126 36 ([System.Drawing.Color]::FromArgb(88, 59, 59))

foreach ($control in @($switchButton, $refreshButton, $closeButton)) {
  $form.Controls.Add($control)
}

$restartCheck = New-Object System.Windows.Forms.CheckBox
$restartCheck.Text = "Restart Codex Desktop after switch"
$restartCheck.Location = New-Object System.Drawing.Point(304, 328)
$restartCheck.Size = New-Object System.Drawing.Size(300, 26)
$restartCheck.Checked = $true
$restartCheck.BackColor = $bg
$restartCheck.ForeColor = [System.Drawing.Color]::FromArgb(232, 238, 245)
$restartCheck.Font = New-Object System.Drawing.Font("Segoe UI", 9.5)
$form.Controls.Add($restartCheck)

$status = New-Object System.Windows.Forms.Label
$status.Location = New-Object System.Drawing.Point(22, 372)
$status.Size = New-Object System.Drawing.Size(700, 22)
$status.ForeColor = $muted
$status.BackColor = $bg
$status.Text = "Ready"
$form.Controls.Add($status)

$script:AccountRows = @()
$script:ProviderId = "openai-oauth"

function Set-Status([string]$Text) {
  $status.Text = $Text
  [void]$form.Refresh()
}

function Refresh-Accounts {
  $config = Read-Config
  $provider = Get-OAuthProvider $config
  if (!$provider) {
    $activeText.Text = "No OpenAI OAuth provider found"
    $accounts.Items.Clear()
    return
  }

  $script:ProviderId = [string]$provider.id
  $activeId = [string]$config.active.accountId
  $script:AccountRows = @($provider.accounts)
  $accounts.Items.Clear()

  $activeIndex = -1
  for ($i = 0; $i -lt $script:AccountRows.Count; $i++) {
    $account = $script:AccountRows[$i]
    $isActive = ([string]$account.id -eq $activeId)
    $item = New-Object System.Windows.Forms.ListViewItem([string](Mask-Email $account.label))
    [void]$item.SubItems.Add("Loading...")
    [void]$item.SubItems.Add("Loading...")
    [void]$item.SubItems.Add("n/a")
    [void]$item.SubItems.Add("n/a")
    [void]$item.SubItems.Add($(if ($isActive) { "Active" } else { "Ready" }))
    $item.Name = [string]$account.id
    $item.Tag = $account
    if ($isActive) {
      $item.BackColor = [System.Drawing.Color]::FromArgb(37, 54, 76)
      $item.ForeColor = [System.Drawing.Color]::White
      $activeIndex = $i
    }
    [void]$accounts.Items.Add($item)
  }

  if ($activeIndex -ge 0) {
    $accounts.Items[$activeIndex].Selected = $true
    $accounts.EnsureVisible($activeIndex)
    $active = $script:AccountRows[$activeIndex]
    $activeText.Text = "$(Mask-Email $active.label)"
    $costText.Text = "Total used 5h -   7d -"
  } else {
    $activeText.Text = "No active account selected"
  }
  Set-Status "Ready"
}

function Format-RefreshTime($Value) {
  if (!$Value) { return "" }
  try {
    $dt = [DateTime]::Parse([string]$Value).ToLocalTime()
    return $dt.ToString("HH:mm:ss")
  } catch {
    return ""
  }
}

function Format-UsageTooltip($Usage) {
  $parts = @()
  if ($Usage.stale) { $parts += "cached" } else { $parts += "live" }
  $time = Format-RefreshTime $Usage.refreshedAt
  if ($time) { $parts += "refreshed $time" }
  if ($Usage.estimateNote) { $parts += [string]$Usage.estimateNote }
  return ($parts -join "; ")
}

function Refresh-Usage([switch]$Fresh) {
  try {
    if ($Fresh) { Set-Status "Force refreshing usage..." } else { Set-Status "Refreshing usage..." }
    $usageArgs = @("--json")
    if ($Fresh) { $usageArgs += "--fresh" }
    $jsonText = Invoke-NodeScript "usage.js" $usageArgs
    $usageRows = ConvertFrom-Json $jsonText
    $usageById = @{}
    foreach ($usage in $usageRows) {
      $usageById[[string]$usage.id] = $usage
    }
    foreach ($item in $accounts.Items) {
      $usage = $usageById[[string]$item.Name]
      if ($usage -and $usage.ok) {
        $item.SubItems[1].Text = "$(if ($usage.primary) { $usage.primary.remainingPercent } else { '-' })%"
        $item.SubItems[2].Text = "$(if ($usage.secondary) { $usage.secondary.remainingPercent } else { '-' })%"
        $item.SubItems[3].Text = "$(if ($usage.todayCost) { $usage.todayCost } else { '-' })"
        $item.SubItems[4].Text = "$(if ($usage.monthCost) { $usage.monthCost } else { '-' })"
        $item.ToolTipText = Format-UsageTooltip $usage
      } elseif ($usage) {
        $item.SubItems[1].Text = "ERR"
        $item.SubItems[2].Text = "ERR"
        $item.SubItems[3].Text = "ERR"
        $item.SubItems[4].Text = "ERR"
        $item.ToolTipText = [string]$usage.error
      } else {
        $item.SubItems[1].Text = "N/A"
        $item.SubItems[2].Text = "N/A"
      }
    }
    Update-TotalCost
    Set-Status "Usage refreshed $(Get-Date -Format HH:mm:ss)"
  } catch {
    $message = $_.Exception.Message
    Set-Status "Usage refresh failed: $message"
    foreach ($item in $accounts.Items) {
      $item.SubItems[1].Text = "ERR"
      $item.SubItems[2].Text = "ERR"
      $item.SubItems[3].Text = "ERR"
      $item.SubItems[4].Text = "ERR"
      $item.ToolTipText = $message
    }
  }
}

function Update-TotalCost {
  $primaryTotal = 0.0
  $secondaryTotal = 0.0
  $hasAny = $false
  foreach ($item in $accounts.Items) {
    $primary = Parse-TokenValue $item.SubItems[3].Text
    $secondary = Parse-TokenValue $item.SubItems[4].Text
    if ($null -ne $primary) {
      $primaryTotal += $primary
      $hasAny = $true
    }
    if ($null -ne $secondary) {
      $secondaryTotal += $secondary
      $hasAny = $true
    }
  }
  if ($hasAny) {
    $costText.Text = "Total used 5h $(Format-Tokens $primaryTotal)   7d $(Format-Tokens $secondaryTotal)"
  } else {
    $costText.Text = "Total used 5h -   7d -"
  }
}

function Parse-TokenValue([string]$Text) {
  if (!$Text) { return $null }
  $clean = $Text.Trim()
  if ($clean -eq '-' -or $clean -eq 'n/a') { return $null }
  $multiplier = 1.0
  if ($clean.EndsWith("M")) {
    $multiplier = 1000000.0
    $clean = $clean.TrimEnd("M")
  } elseif ($clean.EndsWith("K")) {
    $multiplier = 1000.0
    $clean = $clean.TrimEnd("K")
  }
  $parsed = 0.0
  if ([double]::TryParse($clean, [ref]$parsed)) { return ($parsed * $multiplier) }
  return $null
}

function Format-Tokens([double]$Value) {
  if ($Value -ge 1000000) {
    $m = $Value / 1000000
    if ($m -ge 10) { return ($m.ToString('0.0') + 'M') }
    return ($m.ToString('0.00') + 'M')
  }
  if ($Value -ge 1000) {
    return ([Math]::Round($Value / 1000).ToString() + 'K')
  }
  return ([Math]::Round($Value).ToString())
}

function Refresh-SelectedUsage([switch]$Fresh) {
  if ($accounts.SelectedItems.Count -lt 1) { return }
  $item = $accounts.SelectedItems[0]
  try {
    if ($Fresh) { Set-Status "Force refreshing $($item.Text)..." } else { Set-Status "Refreshing $($item.Text)..." }
    $usageArgs = @("--json", "--account", $item.Name)
    if ($Fresh) { $usageArgs += "--fresh" }
    $jsonText = Invoke-NodeScript "usage.js" $usageArgs
    $usageRows = ConvertFrom-Json $jsonText
    $usage = @($usageRows)[0]
    if ($usage -and $usage.ok) {
      $item.SubItems[1].Text = "$(if ($usage.primary) { $usage.primary.remainingPercent } else { '-' })%"
      $item.SubItems[2].Text = "$(if ($usage.secondary) { $usage.secondary.remainingPercent } else { '-' })%"
      $item.SubItems[3].Text = "$(if ($usage.todayCost) { $usage.todayCost } else { '-' })"
      $item.SubItems[4].Text = "$(if ($usage.monthCost) { $usage.monthCost } else { '-' })"
      $item.ToolTipText = Format-UsageTooltip $usage
      Set-Status "Usage refreshed for $($item.Text) $(Get-Date -Format HH:mm:ss)"
    } elseif ($usage) {
      $item.SubItems[1].Text = "ERR"
      $item.SubItems[2].Text = "ERR"
      $item.SubItems[3].Text = "ERR"
      $item.SubItems[4].Text = "ERR"
      $item.ToolTipText = [string]$usage.error
      Set-Status "Usage error: $($usage.error)"
    }
  } catch {
    Set-Status "Usage error: $($_.Exception.Message)"
  }
}

$switchButton.Add_Click({
  try {
    if ($accounts.SelectedItems.Count -lt 1) {
      [System.Windows.Forms.MessageBox]::Show("Select an account first.", "codex-switch") | Out-Null
      return
    }

    $account = $accounts.SelectedItems[0].Tag
    Set-Status "Switching to $(Mask-Email $account.label)..."
    Invoke-NodeCli @("use", "--provider", $script:ProviderId, "--account", $account.id) | Out-Null
    Refresh-Accounts
    Refresh-Usage -Fresh

    if ($restartCheck.Checked) {
      Set-Status "Restarting Codex Desktop..."
      Restart-CodexDesktop
      Set-Status "Switched to $(Mask-Email $account.label). Codex Desktop restarted."
    } else {
      Set-Status "Switched to $(Mask-Email $account.label). Restart is disabled."
    }
  } catch {
    Set-Status "Switch failed"
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "Switch failed") | Out-Null
  }
})

$accounts.Add_DoubleClick({ $switchButton.PerformClick() })
$accounts.Add_KeyDown({
  if ($_.KeyCode -eq [System.Windows.Forms.Keys]::F5) {
    Refresh-SelectedUsage -Fresh
  }
})
$refreshButton.Add_Click({ try { Refresh-Accounts; Refresh-Usage -Fresh } catch { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "Refresh failed") | Out-Null } })
$closeButton.Add_Click({ $form.Close() })

Refresh-Accounts
Refresh-Usage

if (!$NoLaunch) {
  [void]$form.ShowDialog()
}
