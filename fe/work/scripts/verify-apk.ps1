param(
    [Parameter(Mandatory = $true)]
    [string]$Apk,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedCertificate,
    [Parameter(Mandatory = $true)]
    [string]$ApkSigner,
    [Parameter(Mandatory = $true)]
    [string]$Aapt2,
    [string]$ExpectedPackage = $env:YIJIAN_APPLICATION_ID
)

$ErrorActionPreference = "Stop"
$legacyCertificate = "33C29CFDC5EB48421C8A27E235B304050EB3575A0A4522157B1B90314334A581"

foreach ($path in @($Apk, $ApkSigner, $Aapt2)) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Required file does not exist: $path"
    }
}

$signerOutput = & $ApkSigner verify --print-certs $Apk 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "apksigner failed with exit code $LASTEXITCODE"
}
$certMatch = [regex]::Match(
    ($signerOutput -join "`n"),
    "certificate SHA-256 digest:\s*([0-9a-f]+)",
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
)
if (-not $certMatch.Success) {
    throw "Could not read the APK signing certificate"
}

$actualCertificate = ($certMatch.Groups[1].Value -replace "[^0-9A-Fa-f]", "").ToUpperInvariant()
$expectedNormalized = ($ExpectedCertificate -replace "[^0-9A-Fa-f]", "").ToUpperInvariant()
if ($actualCertificate -eq $legacyCertificate) {
    throw "APK is still signed with the exposed legacy debug certificate"
}
if ($actualCertificate -ne $expectedNormalized) {
    throw "APK certificate mismatch: $actualCertificate"
}

$badging = & $Aapt2 dump badging $Apk 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "aapt2 failed with exit code $LASTEXITCODE"
}
$badgingText = $badging -join "`n"
if ($badgingText -match "application-debuggable") {
    throw "Release artifact is debuggable"
}

$packageMatch = [regex]::Match(
    $badgingText,
    "package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'"
)
if (-not $packageMatch.Success) {
    throw "Could not parse APK package metadata"
}

$workRoot = Split-Path -Parent $PSScriptRoot
$packageJson = Get-Content -LiteralPath (Join-Path $workRoot "package.json") -Raw | ConvertFrom-Json
$capacitorConfig = Get-Content -LiteralPath (Join-Path $workRoot "capacitor.config.json") -Raw | ConvertFrom-Json
$gradle = Get-Content -LiteralPath (Join-Path $workRoot "android\app\build.gradle") -Raw
$versionName = [regex]::Match($gradle, 'versionName\s+"([^"]+)"').Groups[1].Value
$versionCode = [int][regex]::Match($gradle, 'versionCode\s+(\d+)').Groups[1].Value
if (-not $ExpectedPackage) {
    $ExpectedPackage = $capacitorConfig.appId
}

if ($packageMatch.Groups[1].Value -ne $ExpectedPackage) {
    throw "APK package does not match $ExpectedPackage"
}
if ([int]$packageMatch.Groups[2].Value -ne $versionCode) {
    throw "APK versionCode does not match Gradle"
}
if ($packageMatch.Groups[3].Value -ne $versionName) {
    throw "APK versionName does not match Gradle"
}

$hash = (Get-FileHash -LiteralPath $Apk -Algorithm SHA256).Hash
[pscustomobject]@{
    Package = $packageMatch.Groups[1].Value
    VersionCode = $versionCode
    VersionName = $versionName
    CertificateSha256 = $actualCertificate
    Sha256 = $hash
}
