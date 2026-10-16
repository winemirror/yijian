$ErrorActionPreference = "Stop"

$packs = "C:\Users\su\Documents\Codex\2026-10-08\fe\work\sfx\packs"
$out = "C:\Users\su\Documents\Codex\2026-10-08\fe\outputs\sfx"
New-Item -ItemType Directory -Force -Path $out | Out-Null

# source (relative to packs) -> published preview name
$pairs = @(
    @("casino-audio\Audio\chips-handle-2.ogg",          "pickup-1.mp3"),
    @("impact-sounds\Audio\impactWood_light_000.ogg",   "pickup-2.mp3"),
    @("casino-audio\Audio\chips-stack-1.ogg",           "pickup-3.mp3"),
    @("impact-sounds\Audio\impactWood_medium_000.ogg",  "place-1.mp3"),
    @("impact-sounds\Audio\impactWood_medium_003.ogg",  "place-2.mp3"),
    @("casino-audio\Audio\chip-lay-1.ogg",              "place-3.mp3"),
    @("impact-sounds\Audio\impactPlank_medium_001.ogg", "place-4.mp3"),
    @("impact-sounds\Audio\impactWood_heavy_000.ogg",   "capture-1.mp3"),
    @("impact-sounds\Audio\impactWood_heavy_003.ogg",   "capture-2.mp3"),
    @("casino-audio\Audio\chips-collide-2.ogg",         "capture-3.mp3"),
    # 发言提醒（对手说话 / 催促走棋时的提示音）
    @("interface-sounds\Audio\confirmation_001.ogg",    "notify-1.mp3"),
    @("interface-sounds\Audio\glass_002.ogg",           "notify-2.mp3"),
    @("interface-sounds\Audio\pluck_001.ogg",           "notify-3.mp3"),
    @("interface-sounds\Audio\question_001.ogg",        "notify-4.mp3"),
    @("interface-sounds\Audio\bong_001.ogg",            "notify-5.mp3")
)

foreach ($pair in $pairs) {
    $src = Join-Path $packs $pair[0]
    $dst = Join-Path $out $pair[1]
    if (-not (Test-Path $src)) {
        Write-Host "MISSING $src"
        continue
    }
    & ffmpeg -hide_banner -loglevel error -y -i $src -ac 1 -ar 44100 -b:a 96k $dst
    $size = (Get-Item $dst).Length
    Write-Host ("{0,-14} {1,7} bytes   <- {2}" -f $pair[1], $size, (Split-Path $pair[0] -Leaf))
}
