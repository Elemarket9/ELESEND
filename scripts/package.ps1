$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskOutput = Join-Path $taskRoot 'ELESEND_STANDALONE_LOGISTICS_PLATFORM.zip'
if (Test-Path -LiteralPath $taskOutput) { throw 'Archive already exists; move it aside before rebuilding.' }
$taskArchive = [IO.Compression.ZipFile]::Open($taskOutput, [IO.Compression.ZipArchiveMode]::Create)
try {
  $taskFiles = Get-ChildItem -LiteralPath $taskRoot -Recurse -File -Force | Where-Object {
    $taskRelative = [IO.Path]::GetRelativePath($taskRoot, $_.FullName).Replace('\','/')
    $taskRelative -notmatch '(^|/)(node_modules|\.git|\.runtime)(/|$)' -and
    $taskRelative -notmatch '(^|/)\.env$' -and
    $taskRelative -notmatch '\.(zip|log)$' -and
    $taskRelative -ne 'ELESEND_STANDALONE_LOGISTICS_PLATFORM.sha256'
  }
  foreach ($taskFile in $taskFiles) {
    $taskEntry = 'ELESEND/' + [IO.Path]::GetRelativePath($taskRoot, $taskFile.FullName).Replace('\','/')
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($taskArchive, $taskFile.FullName, $taskEntry, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $taskArchive.Dispose() }
$taskHash = (Get-FileHash -LiteralPath $taskOutput -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath (Join-Path $taskRoot 'ELESEND_STANDALONE_LOGISTICS_PLATFORM.sha256') -Value "$taskHash  ELESEND_STANDALONE_LOGISTICS_PLATFORM.zip"
Write-Output "$taskOutput`nSHA-256: $taskHash"
