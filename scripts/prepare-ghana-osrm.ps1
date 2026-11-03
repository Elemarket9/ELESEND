param([string]$DataDirectory=(Join-Path $env:USERPROFILE 'ghana-map-data'),[string]$Vehicle='all')
$ErrorActionPreference='Stop'
$data=[IO.Path]::GetFullPath($DataDirectory)
$pbf=Join-Path $data 'ghana-latest.osm.pbf'
$metadataPath=Join-Path $data 'ghana-source.json'
if(!(Test-Path -LiteralPath $pbf) -or !(Test-Path -LiteralPath $metadataPath)){throw 'Run scripts/download-ghana.ps1 first'}
$metadata=Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
if((Get-FileHash -LiteralPath $pbf -Algorithm SHA256).Hash.ToLowerInvariant() -ne $metadata.sha256){throw 'Ghana PBF checksum does not match its provenance record'}

$image='ghcr.io/project-osrm/osrm-backend:v26.10.0'
$mount="type=bind,source=$data,target=/data"
& docker.exe image inspect $image *> $null
if($LASTEXITCODE -ne 0){throw "Docker image $image is not available; pull it first"}

function Build-Graph([string]$ProfileLua, [string]$GraphBase) {
  $targetFile=Join-Path $data "$GraphBase.osrm"
  if(Test-Path -LiteralPath $targetFile){
    Write-Output "Graph $targetFile exists. Skipping rebuild."
    return
  }
  Write-Output "Extracting $GraphBase with $ProfileLua..."
  # OSRM names its output after the input, so extract from a copy to keep other graphs intact.
  if($GraphBase -ne 'ghana-latest'){Copy-Item -Path (Join-Path $data 'ghana-latest.osm.pbf') -Destination (Join-Path $data "$GraphBase.osm.pbf") -Force}
  & docker.exe run --rm --network none --mount $mount $image osrm-extract -p $ProfileLua "/data/$GraphBase.osm.pbf"
  if($LASTEXITCODE -ne 0){throw "OSRM extraction for $GraphBase failed"}
  if($GraphBase -ne 'ghana-latest'){Remove-Item -Path (Join-Path $data "$GraphBase.osm.pbf") -Force}
  & docker.exe run --rm --network none --mount $mount $image osrm-partition "/data/$GraphBase.osrm"
  if($LASTEXITCODE -ne 0){throw "OSRM partition for $GraphBase failed"}
  & docker.exe run --rm --network none --mount $mount $image osrm-customize "/data/$GraphBase.osrm"
  if($LASTEXITCODE -ne 0){throw "OSRM customization for $GraphBase failed"}
  Write-Output "Graph $GraphBase successfully generated."
}

if($Vehicle -eq 'all' -or $Vehicle -eq 'car'){
  Build-Graph '/opt/car.lua' 'ghana-latest'
}
if($Vehicle -eq 'all' -or $Vehicle -eq 'motorcycle'){
  # Uses road rules from the car profile: the bicycle profile allows footpaths and uses cycling speeds.
  # Not verified against Ghanaian motorbike access. Changing the profile requires rebuilding this graph.
  Build-Graph '/opt/car.lua' 'ghana-motorcycle'
}
Write-Output 'Private Ghana OSRM routing graphs (car + motorcycle) prepared.'
