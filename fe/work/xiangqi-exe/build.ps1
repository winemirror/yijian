param(
    [switch]$Sign,
    [string]$TimestampUrl = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"

$workspace = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$webRoot = Join-Path $workspace "outputs\xiangqi-local"
$outputDir = Join-Path $workspace "outputs"
$outputExe = Join-Path $outputDir "YiJian-Xiangqi-Portable.exe"
$aliasExe = Join-Path $outputDir "YiJian-Xiangqi.exe"
$compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"

function Find-SignTool {
    if ($env:YIJIAN_SIGNTOOL) {
        if (-not (Test-Path -LiteralPath $env:YIJIAN_SIGNTOOL)) {
            throw "YIJIAN_SIGNTOOL does not exist: $($env:YIJIAN_SIGNTOOL)"
        }
        return $env:YIJIAN_SIGNTOOL
    }

    $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $kitsRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
    if (Test-Path -LiteralPath $kitsRoot) {
        $candidate = Get-ChildItem -LiteralPath $kitsRoot -Directory |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName "x64\signtool.exe" } |
            Where-Object { Test-Path -LiteralPath $_ } |
            Select-Object -First 1
        if ($candidate) {
            return $candidate
        }
    }

    throw "signtool.exe was not found. Set YIJIAN_SIGNTOOL."
}

if (-not (Test-Path $compiler)) {
    throw "找不到 .NET Framework C# 编译器：$compiler"
}

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

$compilerArgs = @(
    "/nologo",
    "/target:winexe",
    "/optimize+",
    "/codepage:65001",
    "/out:$outputExe",
    "/reference:System.Windows.Forms.dll",
    "/reference:System.Web.Extensions.dll"
)
$resources = @(
    @("index.html", "YiJian.index.html"),
    @("styles.css", "YiJian.styles.css"),
    @("ai-data.js", "YiJian.ai-data.js"),
    @("app.js", "YiJian.app.js"),
    @("records.js", "YiJian.records.js"),
    @("net.js", "YiJian.net.js"),
    @("pikafish.js", "YiJian.pikafish.js"),
    @("ai-worker-bootstrap.js", "YiJian.ai-worker-bootstrap.js"),
    @("xiangqi-kai.woff2", "YiJian.xiangqi-kai.woff2")
)
foreach ($resource in $resources) {
    $resourcePath = Join-Path $webRoot $resource[0]
    $compilerArgs += "/resource:$resourcePath,$($resource[1])"
}
$compilerArgs += (Join-Path $PSScriptRoot "Launcher.cs")

& $compiler @compilerArgs

# A locked output file (the app is still running) makes csc fail without
# stopping the script, which used to ship a stale exe silently.
if ($LASTEXITCODE -ne 0) {
    throw "C# compile failed with exit code $LASTEXITCODE. If the file is locked, close YiJian first."
}

if ($Sign) {
    $signTool = Find-SignTool
    $signArgs = @(
        "sign",
        "/fd", "SHA256",
        "/td", "SHA256",
        "/tr", $TimestampUrl
    )

    if ($env:YIJIAN_WINDOWS_CERT_SHA1) {
        $signArgs += @("/sha1", $env:YIJIAN_WINDOWS_CERT_SHA1)
    }
    elseif ($env:YIJIAN_WINDOWS_PFX_PATH) {
        if (-not (Test-Path -LiteralPath $env:YIJIAN_WINDOWS_PFX_PATH)) {
            throw "YIJIAN_WINDOWS_PFX_PATH does not exist"
        }
        if (-not $env:YIJIAN_WINDOWS_PFX_PASSWORD) {
            throw "YIJIAN_WINDOWS_PFX_PASSWORD is required with a PFX file"
        }
        $signArgs += @(
            "/f", $env:YIJIAN_WINDOWS_PFX_PATH,
            "/p", $env:YIJIAN_WINDOWS_PFX_PASSWORD
        )
    }
    else {
        throw "Set YIJIAN_WINDOWS_CERT_SHA1 or YIJIAN_WINDOWS_PFX_PATH when using -Sign."
    }

    $signArgs += $outputExe
    & $signTool @signArgs
    if ($LASTEXITCODE -ne 0) {
        throw "signtool failed with exit code $LASTEXITCODE"
    }

    $signature = Get-AuthenticodeSignature -LiteralPath $outputExe
    if ($signature.Status -ne "Valid") {
        throw "Authenticode verification failed: $($signature.Status) $($signature.StatusMessage)"
    }
}
else {
    Write-Warning "Unsigned development build. Use -Sign before public distribution."
}

# Keep the plain name in sync so either shortcut launches the same build.
Copy-Item -LiteralPath $outputExe -Destination $aliasExe -Force

Write-Host $outputExe
Write-Host $aliasExe
