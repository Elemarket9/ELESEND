param([string]$DataDirectory=(Join-Path $env:USERPROFILE 'ghana-map-data'))
$ErrorActionPreference='Stop'
$taskDirectory=[IO.Path]::GetFullPath($DataDirectory)
$taskJar=Join-Path $taskDirectory 'tools/planetiler.jar'
$taskChecksum=Join-Path $taskDirectory 'tools/planetiler.jar.sha256'
New-Item -ItemType Directory -Force -Path (Join-Path $taskDirectory 'tools') | Out-Null
if(!(Test-Path -LiteralPath $taskJar)){
 & curl.exe -fL --retry 2 --max-time 900 --output $taskJar 'https://github.com/onthegomap/planetiler/releases/download/v0.10.2/planetiler.jar'
 if($LASTEXITCODE -ne 0){throw 'Planetiler download failed'}
}
if(!(Test-Path -LiteralPath $taskChecksum)){
 & curl.exe -fL --retry 2 --max-time 90 --output $taskChecksum 'https://github.com/onthegomap/planetiler/releases/download/v0.10.2/planetiler.jar.sha256'
 if($LASTEXITCODE -ne 0){throw 'Planetiler checksum download failed'}
}
$taskExpected=((Get-Content -LiteralPath $taskChecksum -Raw).Trim() -split '\s+')[0]
if((Get-FileHash -LiteralPath $taskJar -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskExpected.ToLowerInvariant()){throw 'Planetiler checksum mismatch'}
$taskSource=Join-Path $taskDirectory 'ghana-latest.osm.pbf'
if(!(Test-Path -LiteralPath $taskSource)){throw 'Download Ghana data with scripts/download-ghana.ps1 first'}
$taskMetadata=Get-Content -LiteralPath (Join-Path $taskDirectory 'ghana-source.json') -Raw | ConvertFrom-Json
if((Get-FileHash -LiteralPath $taskSource -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskMetadata.sha256){throw 'Ghana source hash mismatch'}
$taskOutput=Join-Path $taskDirectory 'ghana.mbtiles'
if(Test-Path -LiteralPath $taskOutput){throw 'Preserve the existing tiles under a dated filename before rebuilding'}
$taskSchema=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../deploy/maps/ghana-schema.yml'))
& java -Xmx3g -jar $taskJar generate-custom "--schema=$taskSchema" "--osm-local-path=$taskSource" "--output=$taskOutput" "--tmpdir=$(Join-Path $taskDirectory 'tile-temp')" --threads=2 --nodemap-storage=ram --bounds=-3.4,4.5,1.4,11.4
if($LASTEXITCODE -ne 0){throw 'Ghana vector tile generation failed'}
Get-FileHash -LiteralPath $taskOutput -Algorithm SHA256
