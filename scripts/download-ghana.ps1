param([string]$DataDirectory = (Join-Path $env:USERPROFILE 'ghana-map-data'))
$ErrorActionPreference='Stop'
$taskDirectory=[IO.Path]::GetFullPath($DataDirectory)
New-Item -ItemType Directory -Force -Path $taskDirectory | Out-Null
$taskSource='https://download.geofabrik.de/africa/ghana-latest.osm.pbf'
$taskTarget=Join-Path $taskDirectory 'ghana-latest.osm.pbf'
$taskChecksum=Join-Path $taskDirectory 'ghana-latest.osm.pbf.md5'
& curl.exe --fail --location --retry 3 --connect-timeout 20 --max-time 90 --output $taskChecksum ($taskSource+'.md5')
if($LASTEXITCODE -ne 0){throw 'Ghana publisher checksum download failed'}
$taskExpected=((Get-Content -LiteralPath $taskChecksum -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
if($taskExpected -notmatch '^[a-f0-9]{32}$'){throw 'Invalid publisher checksum'}
if(Test-Path -LiteralPath $taskTarget){
 if((Get-FileHash -LiteralPath $taskTarget -Algorithm MD5).Hash.ToLowerInvariant() -ne $taskExpected){throw 'Existing Ghana extract differs; preserve it under a dated name before updating'}
}else{
 $taskPartial=$taskTarget+'.partial'
 & curl.exe --fail --location --retry 3 --connect-timeout 20 --max-time 1800 --output $taskPartial $taskSource
 if($LASTEXITCODE -ne 0){throw 'Ghana data download failed; partial file is not usable'}
 if((Get-FileHash -LiteralPath $taskPartial -Algorithm MD5).Hash.ToLowerInvariant() -ne $taskExpected){throw 'Ghana extract publisher checksum mismatch; retry after preserving/removing the partial file'}
 Move-Item -LiteralPath $taskPartial -Destination $taskTarget
}
[ordered]@{source=$taskSource;downloadedAtUtc=[DateTime]::UtcNow.ToString('o');path=$taskTarget;bytes=(Get-Item -LiteralPath $taskTarget).Length;publisherMD5=$taskExpected;sha256=(Get-FileHash -LiteralPath $taskTarget -Algorithm SHA256).Hash.ToLowerInvariant();licence='ODbL 1.0';attribution='OpenStreetMap contributors';licenceUrl='https://www.openstreetmap.org/copyright'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskDirectory 'ghana-source.json')
Get-Content -LiteralPath (Join-Path $taskDirectory 'ghana-source.json')
