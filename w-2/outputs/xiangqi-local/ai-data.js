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
