# 在线棋库数据

在线棋库使用 Wukong Xiangqi 的 40,711 局 UCI/ICCS 大师棋谱：

- 来源：https://github.com/maksimKorzh/wukong-xiangqi
- 原始文件：`xqdb/xqdb/xqdb_masters_40711_UCI_games.pgn.zip`
- SHA-256：`E3EB0BF1BB7242AEBBAD49461469FD5FA3F869EDD083E1E56D0B36F7553A3186`
- 仓库声明：MIT
- 上游数据署名：WXF，https://wxf.ca/

压缩包和生成的运行数据不进入 Git。重新生成：

```powershell
Invoke-WebRequest `
  -Uri "https://raw.githubusercontent.com/maksimKorzh/wukong-xiangqi/main/xqdb/xqdb/xqdb_masters_40711_UCI_games.pgn.zip" `
  -OutFile "work/server/data/wukong_masters_uci.pgn.zip"

Expand-Archive `
  -LiteralPath "work/server/data/wukong_masters_uci.pgn.zip" `
  -DestinationPath "work/server/data/extracted"

node work/server/build-game-library.mjs
```

生成物：

- `game-library/catalog.json`：棋谱号、棋手、赛事、年份、着法数和文件偏移。
- `game-library/games.ndjson`：按偏移读取的完整棋谱。
- `game-library/manifest.json`：来源、许可证、数量、哈希和数据版本。

棋谱号格式为两位大写字母加五位数字，例如 `WK00223`。输入时可省略前导零，
服务端会统一规范化。
