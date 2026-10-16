// Embeds the chosen sound effects into the app data file as data URIs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve against this script so the tool keeps working after the workspace
// moves drives or folders.
const here = path.dirname(fileURLToPath(import.meta.url));
const sfxDir = path.join(here, "..", "..", "outputs", "sfx");
const target = path.join(here, "..", "www", "ai-data.js");

const chosen = {
  pickup: "pickup-2.mp3",
  place: "place-2.mp3",
  capture: "capture-3.mp3",
  // 发言提醒：对手发消息或催你走棋时
  notify: "notify-2.mp3",
};

const lines = Object.entries(chosen).map(([key, file]) => {
  const bytes = fs.readFileSync(path.join(sfxDir, file));
  const uri = `data:audio/mpeg;base64,${bytes.toString("base64")}`;
  console.log(`${key.padEnd(8)} <- ${file} (${bytes.length} bytes, ${uri.length} chars)`);
  return `    ${key}: "${uri}",`;
});

const source = fs.readFileSync(target, "utf8");

const block = `\n  // Bundled sound effects (Kenney, CC0 1.0). Inlined so playback is\n`
  + `  // instant and works offline.\n  sounds: {\n${lines.join("\n")}\n  },\n`;

// 已经有 sounds 块就整体替换（脚本要能反复跑），否则插在 version 行之后。
const existing = /\n  \/\/ Bundled sound effects[\s\S]*?\n  sounds: \{[\s\S]*?\n  \},\n/;
let updated;
if (existing.test(source)) {
  updated = source.replace(existing, block);
} else {
  const anchor = /(\n  version: "[^"]*",\n)/;
  if (!anchor.test(source)) throw new Error("could not find the version line in ai-data.js");
  updated = source.replace(anchor, `$1${block}`);
}

fs.writeFileSync(target, updated);
console.log(`updated ${target}`);
