$ErrorActionPreference = "Stop"

$workspace = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$webRoot = Join-Path $workspace "outputs\xiangqi-local"
$outputDir = Join-Path $workspace "outputs"
$outputExe = Join-Path $outputDir "YiJian-Xiangqi-Portable.exe"
$aliasExe = Join-Path $outputDir "YiJian-Xiangqi.exe"
$compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"

if (-not (Test-Path $compiler)) {
    throw "找不到 .NET Framework C# 编译器：$compiler"
}

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

& $compiler `
    /nologo `
    /target:winexe `
    /optimize+ `
    /codepage:65001 `
    /out:$outputExe `
    /reference:System.Windows.Forms.dll `
    /reference:System.Web.Extensions.dll `
    /resource:"$(Join-Path $webRoot 'index.html')",YiJian.index.html `
    /resource:"$(Join-Path $webRoot 'styles.css')",YiJian.styles.css `
    /resource:"$(Join-Path $webRoot 'ai-data.js')",YiJian.ai-data.js `
    /resource:"$(Join-Path $webRoot 'app.js')",YiJian.app.js `
    /resource:"$(Join-Path $webRoot 'records.js')",YiJian.records.js `
    /resource:"$(Join-Path $webRoot 'net.js')",YiJian.net.js `
    /resource:"$(Join-Path $webRoot 'pikafish.js')",YiJian.pikafish.js `
    /resource:"$(Join-Path $webRoot 'ai-worker-bootstrap.js')",YiJian.ai-worker-bootstrap.js `
    /resource:"$(Join-Path $webRoot 'xiangqi-kai.woff2')",YiJian.xiangqi-kai.woff2 `
    (Join-Path $PSScriptRoot "Launcher.cs")

# A locked output file (the app is still running) makes csc fail without
# stopping the script, which used to ship a stale exe silently.
if ($LASTEXITCODE -ne 0) {
    throw "C# compile failed with exit code $LASTEXITCODE. If the file is locked, close YiJian first."
}

# Keep the plain name in sync so either shortcut launches the same build.
Copy-Item -LiteralPath $outputExe -Destination $aliasExe -Force

Write-Host $outputExe
Write-Host $aliasExe
