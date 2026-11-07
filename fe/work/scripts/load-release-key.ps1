param(
    [string]$SecretsDir = "D:\Codex\yijian-secrets\android-release"
)

$ErrorActionPreference = "Stop"
$keystore = Join-Path $SecretsDir "yijian-release.p12"
$encryptedPasswordFile = Join-Path $SecretsDir "password.dpapi.txt"
$metadataFile = Join-Path $SecretsDir "metadata.json"

foreach ($path in @($keystore, $encryptedPasswordFile, $metadataFile)) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Release key material is missing: $path"
    }
}

$ciphertext = [System.IO.File]::ReadAllText($encryptedPasswordFile).Trim()
$securePassword = ConvertTo-SecureString -String $ciphertext
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
    $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
}
finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

$metadata = Get-Content -LiteralPath $metadataFile -Raw | ConvertFrom-Json
$env:YIJIAN_KEYSTORE_PATH = $keystore
$env:YIJIAN_KEYSTORE_PASSWORD = $password
$env:YIJIAN_KEY_ALIAS = $metadata.alias
$env:YIJIAN_KEY_PASSWORD = $password

Write-Host "Release signing environment loaded."
Write-Host "Alias: $($metadata.alias)"
Write-Host "Certificate SHA-256: $($metadata.certificateSha256)"
