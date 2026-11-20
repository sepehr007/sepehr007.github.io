$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root "deploy"
New-Item -ItemType Directory -Force -Path $out | Out-Null

function New-Zip([string]$source, [string]$zipPath) {
  Remove-Item -Force $zipPath -ErrorAction SilentlyContinue
  $zip = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
  try {
    $prefix = $source.TrimEnd('\') + '\'
    Get-ChildItem -Path $source -Recurse -File -Force | ForEach-Object {
      $entryName = $_.FullName.Substring($prefix.Length) -replace '\\', '/'
      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $entryName, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  } finally { $zip.Dispose() }
}

$siteStage = Join-Path $out "site-staging"
if (Test-Path $siteStage) { Remove-Item -Recurse -Force $siteStage }
New-Item -ItemType Directory -Force -Path $siteStage | Out-Null
foreach ($name in @("index.html","auth.html","profile.html","room.html","rooms.html","social.html","owner.html","offline.html","page.html","manifest.webmanifest","sw.js")) {
  $src = Join-Path $root $name
  if (-not (Test-Path $src)) { throw "Missing site file: $src" }
  Copy-Item $src $siteStage
}
foreach ($dir in @("assets","admin-access","god","owner")) {
  $src = Join-Path $root $dir
  if (-not (Test-Path $src)) { throw "Missing site folder: $src" }
  Copy-Item -Recurse $src (Join-Path $siteStage $dir)
}
$siteZip = Join-Path $out "site.zip"
New-Zip $siteStage $siteZip
Remove-Item -Recurse -Force $siteStage

$apiStage = Join-Path $out "api-staging"
if (Test-Path $apiStage) { Remove-Item -Recurse -Force $apiStage }
New-Item -ItemType Directory -Force -Path $apiStage | Out-Null
$excludeDirs = @("node_modules","data","data-test","data-test2","tests",".tmp")
$excludeFiles = @(".env")
robocopy (Join-Path $root "server") $apiStage /E /XD $excludeDirs /XF $excludeFiles /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with code $LASTEXITCODE" }
$apiZip = Join-Path $out "api.zip"
New-Zip $apiStage $apiZip
Remove-Item -Recurse -Force $apiStage

foreach ($zip in @($siteZip, $apiZip)) {
  $mb = [math]::Round((Get-Item $zip).Length / 1MB, 2)
  Write-Host ("{0}  ({1} MB)" -f $zip, $mb)
}
Write-Host "Upload site.zip to public_html and api.zip to the Node app root."
