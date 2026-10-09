// Downloads Kenney asset packs (CC0) and reports the archive location.
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const outDir = path.join(here, "packs");
fs.mkdirSync(outDir, { recursive: true });

for (const slug of process.argv.slice(2)) {
  const page = `https://kenney.nl/assets/${slug}`;
  try {
    const html = await (await fetch(page)).text();
    const match = html.match(
      new RegExp(`https://kenney\\.nl/media/pages/assets/${slug}/[^"'\\s]+\\.zip`)
    );
    if (!match) {
      console.log(`${slug}: no zip link found`);
      continue;
    }
    const response = await fetch(match[0]);
    if (!response.ok) {
      console.log(`${slug}: download failed ${response.status}`);
      continue;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const target = path.join(outDir, `${slug}.zip`);
    fs.writeFileSync(target, bytes);
    console.log(`${slug}: ${bytes.length} bytes -> ${target}`);
  } catch (error) {
    console.log(`${slug}: ERR ${error.message}`);
  }
}
