# install_self_check_task.ps1 - registers arcaeon-witness-self-check.
# DAILY at 03:30 local, after velouria-logtree-checkpoint (02:45) and
# velouria-ots-anchor (03:15), so the day's self-check reads the head those two
# just covered. Fires `node tools/self_check_daily.js --write` (design page B8
# day 2): verifier two's public-record checks over the live pins repo, one
# signed SELF-CHECKED record per namespace at HEAD, under the operator's
# DECLARED check key. The tool refuses a key that is not in the OPERATOR_KEYS
# document it is handed (DISAGREEMENTS D17), writes create-only, and never
# commits, pushes or writes to the store.
#
# Modelled on velouria/scripts/install_logtree_checkpoint_task.ps1 (same
# Register-ScheduledTask pattern). NOT REGISTERED by the release that ships it.
#
# Function:        once daily, build + write that day's self-check records.
# Intent:          our own look at every namespace, on the record as OURS
#                  (SELF-CHECKED, never CHECKED; design B5).
# Protected outcome: the audit-state column shows a dated look, not BLIND,
#                  and a BROKEN of our own finding shows red (B3).
# Stop condition:  exit 2 on any SKIPPED namespace, an undeclared key, a
#                  missing verify.py, or an unreadable OPERATOR_KEYS.json;
#                  the log line says which. No retry.
# Cost boundary:   one verify.py run over the public repo plus one raw read
#                  per namespace; 10-minute execution limit; one instance.
#
# THE GAP, stated so nobody reads this as done: the records land in -OutDir
# on this machine. Nothing publishes them into the pins repo's checks/
# directory yet, and until something does, the status page (their only
# reader) cannot see them. Register this only together with a publisher (or
# a by-hand commit of -OutDir's checks/ tree, create-only, read back).
#
# Register this ONLY after checks/OPERATOR_KEYS.json is published to the pins
# repo and read back (the key fence reads the local copy named below; it must
# be the same bytes as the published one).
#
#   powershell -ExecutionPolicy Bypass -File tools\install_self_check_task.ps1 `
#     [-WitnessDir C:\Users\USER\arcaeon-witness-rc3b] `
#     [-OperatorKeys C:\Users\USER\arcaeon-witness-pins\checks\OPERATOR_KEYS.json] `
#     [-OutDir $env:USERPROFILE\.arcaeon\self_check_out]
param(
    [string]$WitnessDir = (Join-Path $env:USERPROFILE "arcaeon-witness-rc3b"),
    [string]$OperatorKeys = (Join-Path $env:USERPROFILE "arcaeon-witness-pins\checks\OPERATOR_KEYS.json"),
    [string]$KeyFile = (Join-Path $env:USERPROFILE ".arcaeon\witness-selfcheck.pem"),
    [string]$VerifyPy = (Join-Path $env:USERPROFILE "velouria\projects\online_business\verifier_two\verify.py"),
    [string]$OutDir = (Join-Path $env:USERPROFILE ".arcaeon\self_check_out"),
    [string]$LogFile = (Join-Path $env:USERPROFILE ".arcaeon\self_check_log.txt"),
    [string]$NodePath = "C:\Program Files\nodejs\node.exe"
)
$ErrorActionPreference = "Stop"
$TaskName = "arcaeon-witness-self-check"

# Every input must exist before anything is registered. The key file's
# CONTENTS are never read or printed here; only its presence is checked.
$tool = Join-Path $WitnessDir "tools\self_check_daily.js"
foreach ($p in @($NodePath, $tool, $OperatorKeys, $KeyFile, $VerifyPy)) {
    if (-not (Test-Path $p)) {
        Write-Error "required path not found: $p"
        exit 1
    }
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }

# cmd /c so stdout+stderr append to one log file (one line per namespace plus
# the summary line); node's exit code is the task's result.
$cmdLine = "`"$NodePath`" tools\self_check_daily.js --key `"$KeyFile`" --operator-keys `"$OperatorKeys`" --verify-py `"$VerifyPy`" --out `"$OutDir`" --write >> `"$LogFile`" 2>&1"
$action = New-ScheduledTaskAction `
    -Execute "cmd.exe" `
    -Argument "/c $cmdLine" `
    -WorkingDirectory $WitnessDir

$trigger = New-ScheduledTaskTrigger -Daily -At "3:30AM"

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -MultipleInstances IgnoreNew `
    -Hidden

$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName `
    -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description "Daily SELF-CHECKED records for dan8433-user/arcaeon-witness-pins under the operator's declared key (tools/self_check_daily.js, create-only, local out dir). Publishing into checks/ is a separate step." | Out-Null

Write-Host "Registered '$TaskName' (daily 03:30 AM, cwd $WitnessDir, out $OutDir, log $LogFile)."
