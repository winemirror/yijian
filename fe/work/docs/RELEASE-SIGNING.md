# Android and Windows Release Signing

## Current state

The Android certificate used through `3.22.1` is the committed debug
certificate `33C29CFD...A581`. It is public and must be considered compromised.
The current APK artifacts remain useful only for historical verification.

Changing an Android signing certificate prevents an in-place update of the
existing `com.yijian.xiangqi` package. The owner must choose and communicate a
migration path before distributing a newly signed build.

## Android key setup

Generate a new RSA 4096 key outside the repository and keep at least two
encrypted backups offline:

```powershell
$env:YIJIAN_KEYSTORE_PATH = "$env:USERPROFILE\keys\yijian-release.p12"
$env:YIJIAN_KEY_ALIAS = "yijian-release"
$env:YIJIAN_KEYSTORE_PASSWORD = Read-Host "Keystore password"
$env:YIJIAN_KEY_PASSWORD = Read-Host "Key password"

New-Item -ItemType Directory -Force (Split-Path $env:YIJIAN_KEYSTORE_PATH)
keytool -genkeypair -v `
  -keystore $env:YIJIAN_KEYSTORE_PATH `
  -storetype PKCS12 `
  -alias $env:YIJIAN_KEY_ALIAS `
  -keyalg RSA -keysize 4096 -validity 10000 `
  -dname "CN=Yijian Release, O=Yijian, C=CN" `
  -storepass:env YIJIAN_KEYSTORE_PASSWORD `
  -keypass:env YIJIAN_KEY_PASSWORD
```

Never place the keystore, passwords, or CI files containing them in Git.

## Migration decision

Choose one path before the first release with the new certificate:

1. **New applicationId (recommended for direct APK distribution).** Build with
   `-PyijianApplicationId=com.yijian.xiangqi.v2`, publish it as a new app, and
   explain how users export/import records.
2. **Store-managed signing.** If the app will move to Google Play, enroll the
   new release key as an upload key with Play App Signing according to the
   store migration process. A direct APK using the old certificate cannot
   silently become a differently signed update.

Do not reuse the old applicationId with a new certificate and describe the
result as an in-place upgrade.

## Build and verification

From `fe/work`:

```powershell
npm ci
$env:JAVA_HOME = "C:\Program Files\Zulu\zulu-21"
$env:ANDROID_HOME = "<Android SDK>"

$env:YIJIAN_KEYSTORE_PATH = "<outside repo>\yijian-release.p12"
$env:YIJIAN_KEYSTORE_PASSWORD = "<secret>"
$env:YIJIAN_KEY_ALIAS = "yijian-release"
$env:YIJIAN_KEY_PASSWORD = "<secret>"

node scripts/build-android.mjs release --offline

$env:APKSIGNER = "$env:ANDROID_HOME\build-tools\36.0.0\apksigner.bat"
$env:AAPT2 = "$env:ANDROID_HOME\build-tools\36.0.0\aapt2.exe"
$env:YIJIAN_RELEASE_CERT_SHA256 = "<new certificate SHA-256>"
powershell -File scripts\verify-apk.ps1 `
  -Apk android\app\build\outputs\apk\release\app-release.apk `
  -ExpectedCertificate $env:YIJIAN_RELEASE_CERT_SHA256 `
  -ApkSigner $env:APKSIGNER -Aapt2 $env:AAPT2
```

The verifier rejects:

- the legacy debug certificate;
- a certificate different from `YIJIAN_RELEASE_CERT_SHA256`;
- a debuggable APK;
- package/version drift;
- tracked keystore/key files.

For hermetic build agents that already provide a trusted Gradle 8.14.3 binary,
set `YIJIAN_GRADLE` to its absolute path. Otherwise the repository wrapper is
used and will download the pinned distribution on first use.

## Repository history

Removing the key from `HEAD` does not remove it from public history. After the
new key and migration path are ready:

1. Stop publishing APKs signed by the old key.
2. Notify users and preserve verification hashes for historical files.
3. Coordinate a full-history rewrite with every clone/fork owner.
4. Force-push rewritten branches/tags and rotate any CI secrets that touched
   the old key.

History rewriting is intentionally not automated here.

## Windows executable

`fe/work/xiangqi-exe/build.ps1 -Sign` can sign the portable executable through
`signtool`. Prefer a certificate installed in the Windows certificate store:

```powershell
$env:YIJIAN_SIGNTOOL = "<Windows Kits>\signtool.exe"
$env:YIJIAN_WINDOWS_CERT_SHA1 = "<certificate thumbprint>"
powershell -File work\xiangqi-exe\build.ps1 -Sign
```

Alternatively set `YIJIAN_WINDOWS_PFX_PATH` and
`YIJIAN_WINDOWS_PFX_PASSWORD`. The script verifies that the resulting
Authenticode status is `Valid` before creating the plain-name alias.
