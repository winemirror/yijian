/*
 * Compact opening and endgame knowledge for the local Xiangqi engine.
 *
 * Sources consulted:
 * - https://xiangqi.one/zh/articles/xiangqi-openings-guide
 * - https://www.zh.xiangqi.com/opening-central-cannon.html
 * - https://zh.wikipedia.org/zh-hans/%E8%B1%A1%E6%A3%8B%E5%BC%80%E5%B1%80
 * - https://github.com/xqbase/eleeye
 * - https://github.com/nguyenpham/MRXqOpeningBook
 * - https://github.com/nguyenpham/FelicityEgtb
 * - https://www.zh.xiangqi.com/articles/10-xiangqi-endgame-principles.html
 *
 * Move tokens use file letters a-i and ranks 1-10 counted from Red's side.
 * Example: h3-e3 is Red's right cannon moving to the central file.
 */
(typeof window !== "undefined" ? window : self).XiangqiAiData = {
  version: "2026.10.08",

  // Bundled sound effects (Kenney, CC0 1.0). Inlined so playback is
  // instant and works offline.
  sounds: {
    pickup: "data:audio/mpeg;base64,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",
    place: "data:audio/mpeg;base64,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Wvhxeb/Q58eGP6soY///1Lf/+VcAAAgw3BoK3MJWDTDDEAHIwOoDSMCKASzAbwD8wDEAxFQAYiAFAsAAJYNTbjjLohHXXQBAnAEiKNDBWSHhsEATClVHghGg3BAoKBJHB4NmExcKhQEB6GDwlBsRhuPMLxEYZLiUJbDUucIw8I5McKjVhawPzCJpQvQkgTEGvqI4Lv8Hr///G3//PFv/QSf//8qMf/9R8uc/8ANhgOKc90DbGBdgOZ0AABwYF2AUFAB6zFMMSACjAMwB8//7csTbg47BROxPmLHSIDHczfYeOAB0APaapkvZYQAgCJgEYAWLYXRoDWA3JcGwQQ4hRCxDRcYwQt5DfAbqF4iwqQxUiHkPHJAkMACUBi8UYyGQIuO8coh5IDDIeYh74gOFywGCYlhOC4x6J0pkIRY3D0BySCDZEABUBXA3wCwQUmUR0myTERUUyifyTcTuI/HLEfhfcP0FgJU9/JVv4qiGC4A5QV8WMTmUxx///+IBjGDICcDAggnAY8ZMTmd/////ImKXGcGQE4KJwZAZ8ZMTnL44x0f////////4yAnBM0IIOsZMTmYJk+OgZATgZycHWMmqAAAQAYYAAAAAPmZzRx8wkmHjL/URMNAzAgluP+nMDgRQWMf4FoAMKVWfrIYBujeUx1f8GOP0MNyRamU4tv/4mZ3CwGkO//twxO8AEq2O6HXzgBQLRdyDP0AABEmSvMLZ//6mQvmWrTrT0JmltL///hC1whDEoLq2C9hVkff//9UN6jbVXAVbYqIUaD4L2DFhf///9uZIaob2drc3jmwez6FGg+ta1/////7JAcH7gxs8OO8c2CJAmhe1rbg+ta6he3///////fumOPDneO2CI8mfun8d/Gef///+1twc11XULFt43ByKTEFNRTMuMTAwqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqv/7csS0gBpB8xk5t4AIAAA0g4AABKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
    capture: "data:audio/mpeg;base64,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",
    notify: "data:audio/mpeg;base64,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",
  },
  openingLines: [
    {
      name: "中炮对屏风马·直车",
      weight: 20,
      moves: ["h3-e3", "h10-g8", "h1-g3", "i10-h10", "i1-h1", "b10-c8", "b1-c3"]
    },
    {
      name: "中炮对屏风马·挺三兵",
      weight: 14,
      moves: ["h3-e3", "h10-g8", "h1-g3", "i10-h10", "g4-g5", "b10-c8", "i1-h1"]
    },
    {
      name: "中炮对屏风马·左马盘河",
      weight: 10,
      moves: ["h3-e3", "h10-g8", "h1-g3", "i10-h10", "i1-h1", "b10-c8", "b1-c3", "a10-b10"]
    },
    {
      name: "顺炮直车对横车",
      weight: 12,
      moves: ["h3-e3", "h8-e8", "h1-g3", "h10-g8", "i1-h1", "i10-i9"]
    },
    {
      name: "顺炮横车对直车",
      weight: 10,
      moves: ["h3-e3", "h8-e8", "h1-g3", "h10-g8", "i1-i2", "i10-h10", "i2-h2"]
    },
    {
      name: "中炮对列炮",
      weight: 8,
      moves: ["h3-e3", "b8-e8", "h1-g3", "h10-g8", "i1-h1", "i10-h10"]
    },
    {
      name: "中炮对反宫马",
      weight: 9,
      moves: ["h3-e3", "b10-c8", "h1-g3", "h8-f8", "i1-h1", "i10-h10"]
    },
    {
      name: "中炮对单提马",
      weight: 6,
      moves: ["h3-e3", "h10-i8", "h1-g3", "b10-c8", "i1-h1", "i10-h10"]
    },
    {
      name: "飞相局",
      weight: 9,
      moves: ["g1-e3", "h10-g8", "h1-g3", "i10-h10", "i1-h1", "b10-c8"]
    },
    {
      name: "起马局",
      weight: 8,
      moves: ["h1-g3", "h10-g8", "g1-e3", "i10-h10", "i1-h1", "b10-c8"]
    },
    {
      name: "仙人指路·兵七进一",
      weight: 11,
      moves: ["c4-c5", "h10-g8", "h1-g3", "i10-h10", "i1-h1", "b10-c8"]
    },
    {
      name: "仙人指路·兵三进一",
      weight: 11,
      moves: ["g4-g5", "b10-c8", "h1-g3", "h10-g8", "i1-h1", "a10-b10"]
    },
    {
      name: "过宫炮",
      weight: 5,
      moves: ["h3-d3", "h10-g8", "h1-g3", "i10-h10", "i1-h1", "b10-c8"]
    },
    {
      name: "仕角炮",
      weight: 4,
      moves: ["h3-f3", "h10-g8", "h1-g3", "i10-h10", "i1-h1", "b10-c8"]
    },
    {
      name: "边炮局",
      weight: 2,
      moves: ["h3-i3", "h10-g8", "h1-g3", "i10-h10", "i1-h1", "b10-c8"]
    },
    {
      name: "巡河炮",
      weight: 2,
      moves: ["h3-h5", "h10-g8", "h1-g3", "i10-h10", "i1-h1", "b10-c8"]
    }
  ],
  endgamePatterns: [
    {
      name: "单车例和士象全",
      strong: "r",
      weak: "aabb",
      bonus: -180
    },
    {
      name: "单车例和马双象",
      strong: "r",
      weak: "nnbb",
      bonus: -140
    },
    {
      name: "单车例胜马双士",
      strong: "r",
      weak: "nnaa",
      bonus: 170
    },
    {
      name: "车高兵例胜马士象全",
      strong: "rp",
      weak: "nnaabb",
      bonus: 220
    },
    {
      name: "双马例胜士象全",
      strong: "nn",
      weak: "aabb",
      bonus: 180
    },
    {
      name: "炮士例胜双士",
      strong: "ca",
      weak: "aa",
      bonus: 160
    },
    {
      name: "单马例胜单士",
      strong: "n",
      weak: "a",
      bonus: 110
    },
    {
      name: "单马例和单象",
      strong: "n",
      weak: "b",
      bonus: -100
    }
  ]
};
