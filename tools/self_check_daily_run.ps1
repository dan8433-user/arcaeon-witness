# self_check_daily_run.ps1 - what the arcaeon-witness-self-check task runs.
# Two steps, in order, both appending to one log:
#   1. WRITE:   node tools/self_check_daily.js --write   (records into -OutDir)
#   2. PUBLISH: node tools/publish_self_checks.js --publish --days 7
#               (today's and the six days before, so a day whose publish
#               failed is picked up by the next run; already-published
#               records are skipped by blob sha, so the retry costs GETs only)
# The publish step FAILS SOFT: a non-zero exit is logged in one line and does
# not change the task's result, which stays the write step's exit code. The
# records stay in -OutDir either way; nothing is deleted.
# Publish runs even if the write step exited non-zero (one SKIPPED namespace
# exits 2 but the other records were written); the publisher re-validates
# every record on its own and refuses the whole day on any defect.
#
# Registered by tools/install_self_check_task.ps1. The key file and the .env
# file are passed as PATHS only; nothing here reads or prints their contents.
param(
    [Parameter(Mandatory = $true)][string]$WitnessDir,
    [Parameter(Mandatory = $true)][string]$OperatorKeys,
    [Parameter(Mandatory = $true)][string]$KeyFile,
    [Parameter(Mandatory = $true)][string]$VerifyPy,
    [Parameter(Mandatory = $true)][string]$OutDir,
    [Parameter(Mandatory = $true)][string]$LogFile,
    [Parameter(Mandatory = $true)][string]$EnvFile,
    [string]$NodePath = "C:\Program Files\nodejs\node.exe",
    [int]$PublishDays = 7
)
# Set-Location alone moves only PowerShell's location; a child cmd.exe starts
# in the PROCESS directory. Set both, and name the tools by absolute path.
Set-Location -LiteralPath $WitnessDir
[Environment]::CurrentDirectory = $WitnessDir
$writer = Join-Path (Join-Path $WitnessDir "tools") "self_check_daily.js"
$publisher = Join-Path (Join-Path $WitnessDir "tools") "publish_self_checks.js"

function Write-LogLine([string]$msg) {
    $stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    Add-Content -LiteralPath $LogFile -Value "[$stamp] $msg" -Encoding ascii
}

# cmd /c so each node's stdout+stderr append to the log as plain text (the
# same format the write-only task produced), and $LASTEXITCODE is node's.
Write-LogLine "self-check: write step start"
cmd.exe /c "`"$NodePath`" `"$writer`" --key `"$KeyFile`" --operator-keys `"$OperatorKeys`" --verify-py `"$VerifyPy`" --out `"$OutDir`" --write >> `"$LogFile`" 2>&1"
$writeCode = $LASTEXITCODE
Write-LogLine "self-check: write step exit $writeCode"

Write-LogLine "self-check: publish step start"
try {
    cmd.exe /c "`"$NodePath`" `"$publisher`" --dir `"$OutDir`" --operator-keys `"$OperatorKeys`" --env-file `"$EnvFile`" --days $PublishDays --publish >> `"$LogFile`" 2>&1"
    $pubCode = $LASTEXITCODE
} catch {
    $pubCode = -1
    Write-LogLine "self-check: publish step could not start: $($_.Exception.Message)"
}
if ($pubCode -eq 0) {
    Write-LogLine "self-check: publish step exit 0"
} else {
    Write-LogLine "self-check: PUBLISH FAILED SOFT (exit $pubCode); records stay in $OutDir, the next run retries the last $PublishDays days; the status page keeps its previous state"
}
exit $writeCode
