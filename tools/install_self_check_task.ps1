# install_self_check_task.ps1 - registers arcaeon-witness-self-check.
# DAILY at 03:30 local, after velouria-logtree-checkpoint (02:45) and
# velouria-ots-anchor (03:15), so the day's self-check reads the head those two
# just covered. The task runs tools/self_check_daily_run.ps1, two steps:
#   1. WRITE: `node tools/self_check_daily.js --write` (design page B8 day 2):
#      verifier two's public-record checks over the live pins repo, one signed
#      SELF-CHECKED record per namespace at HEAD, under the operator's DECLARED
#      check key. Refuses a key that is not in the OPERATOR_KEYS document it is
#      handed (DISAGREEMENTS D17), writes create-only into -OutDir.
#   2. PUBLISH: `node tools/publish_self_checks.js --publish --days 7`: every
#      record of the last seven days is re-verified (shape, signature, path,
#      key declared locally AND in the published checks/OPERATOR_KEYS.json)
#      and PUT create-only into the pins repo's checks/ through the GitHub
#      contents API (GITHUB_TOKEN from -EnvFile, the same auth and per-file
#      commit pattern the genesis checkpoint was published with). Records
#      already there with the same bytes are skipped, so a rerun makes no
#      commit. This step FAILS SOFT: its failure is one log line, and the
#      task's result stays the write step's exit code.
#
# Modelled on velouria/scripts/install_logtree_checkpoint_task.ps1 (same
# Register-ScheduledTask pattern). NOT REGISTERED by the release that ships it.
#
# Function:        once daily, build + write that day's self-check records,
#                  then publish them into checks/ in the public pins repo.
# Intent:          our own look at every namespace, on the record as OURS
#                  (SELF-CHECKED, never CHECKED; design B5).
# Protected outcome: the audit-state column shows a dated look, not BLIND,
#                  and a BROKEN of our own finding shows red (B3).
# Stop condition:  write: exit 2 on any SKIPPED namespace, an undeclared key, a
#                  missing verify.py, or an unreadable OPERATOR_KEYS.json.
#                  publish (soft, logged): exit 2 on any record that fails
#                  validation (then nothing of that run is published), a path
#                  already there with different bytes, a published declaration
#                  that is absent or lacks the key, or a GitHub error. No retry
#                  inside a run; the next run covers the last seven days.
# Cost boundary:   one verify.py run over the public repo plus one raw read
#                  per namespace; publish: 1 + (records in 7 days) GETs and
#                  one PUT (one commit) per new record, about 8 a day;
#                  10-minute execution limit; one instance.
#
# Register this ONLY after checks/OPERATOR_KEYS.json is published to the pins
# repo and read back (the key fence reads the local copy named below; it must
# be the same bytes as the published one, and the publisher refuses while the
# published copy is absent or does not list the key).
#
#   powershell -ExecutionPolicy Bypass -File tools\install_self_check_task.ps1 `
#     [-WitnessDir C:\Users\USER\arcaeon-witness-rc3b] `
#     [-OperatorKeys C:\Users\USER\arcaeon-witness-pins\checks\OPERATOR_KEYS.json] `
#     [-OutDir $env:USERPROFILE\.arcaeon\self_check_out] `
#     [-EnvFile C:\Users\USER\velouria\.env]
param(
    [string]$WitnessDir = (Join-Path $env:USERPROFILE "arcaeon-witness-rc3b"),
    [string]$OperatorKeys = (Join-Path $env:USERPROFILE "arcaeon-witness-pins\checks\OPERATOR_KEYS.json"),
    [string]$KeyFile = (Join-Path $env:USERPROFILE ".arcaeon\witness-selfcheck.pem"),
    [string]$VerifyPy = (Join-Path $env:USERPROFILE "velouria\projects\online_business\verifier_two\verify.py"),
    [string]$OutDir = (Join-Path $env:USERPROFILE ".arcaeon\self_check_out"),
    [string]$LogFile = (Join-Path $env:USERPROFILE ".arcaeon\self_check_log.txt"),
    [string]$EnvFile = (Join-Path $env:USERPROFILE "velouria\.env"),
    [string]$NodePath = "C:\Program Files\nodejs\node.exe"
)
$ErrorActionPreference = "Stop"
$TaskName = "arcaeon-witness-self-check"

# Every input must exist before anything is registered. The key file's and
# the .env file's CONTENTS are never read or printed here; only presence.
$tool = Join-Path $WitnessDir "tools\self_check_daily.js"
$publisher = Join-Path $WitnessDir "tools\publish_self_checks.js"
$runner = Join-Path $WitnessDir "tools\self_check_daily_run.ps1"
foreach ($p in @($NodePath, $tool, $publisher, $runner, $OperatorKeys, $KeyFile, $VerifyPy, $EnvFile)) {
    if (-not (Test-Path $p)) {
        Write-Error "required path not found: $p"
        exit 1
    }
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }

# The runner does write-then-publish and owns the log (see its header).
# Paths only on the command line; no secret is ever an argument.
$runArgs = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runner`"" +
    " -WitnessDir `"$WitnessDir`" -OperatorKeys `"$OperatorKeys`" -KeyFile `"$KeyFile`"" +
    " -VerifyPy `"$VerifyPy`" -OutDir `"$OutDir`" -LogFile `"$LogFile`"" +
    " -EnvFile `"$EnvFile`" -NodePath `"$NodePath`""
$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument $runArgs `
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
    -Description "Daily SELF-CHECKED records for dan8433-user/arcaeon-witness-pins under the operator's declared key: tools/self_check_daily.js --write (create-only, local out dir), then tools/publish_self_checks.js --publish into checks/ (create-only, idempotent, fails soft and logs)." | Out-Null

Write-Host "Registered '$TaskName' (daily 03:30 AM: write, then publish; cwd $WitnessDir, out $OutDir, log $LogFile)."
