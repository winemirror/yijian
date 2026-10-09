// Shared helpers for inspecting font files.
import fs from "node:fs";
import wawoff2 from "wawoff2";

export async function readSfnt(file) {
  const raw = fs.readFileSync(file);
  return raw.toString("ascii", 0, 4) === "wOF2"
    ? Buffer.from(await wawoff2.decompress(raw))
    : raw;
}

export function readCodepoints(sfnt) {
  const numTables = sfnt.readUInt16BE(4);
  let cmap = 0;
  for (let i = 0; i < numTables; i += 1) {
    const rec = 12 + i * 16;
    if (sfnt.toString("ascii", rec, rec + 4) === "cmap") {
      cmap = sfnt.readUInt32BE(rec + 8);
    }
  }
  if (!cmap) throw new Error("no cmap table");

  const codepoints = new Set();
  const numSubtables = sfnt.readUInt16BE(cmap + 2);
  for (let i = 0; i < numSubtables; i += 1) {
    const off = cmap + 4 + i * 8;
    const sub = cmap + sfnt.readUInt32BE(off + 4);
    const format = sfnt.readUInt16BE(sub);
    if (format === 4) {
      const segCountX2 = sfnt.readUInt16BE(sub + 6);
      const segCount = segCountX2 / 2;
      const endO = sub + 14;
      const startO = endO + segCountX2 + 2;
      const deltaO = startO + segCountX2;
      const rangeO = deltaO + segCountX2;
      for (let s = 0; s < segCount; s += 1) {
        const end = sfnt.readUInt16BE(endO + s * 2);
        const start = sfnt.readUInt16BE(startO + s * 2);
        const delta = sfnt.readInt16BE(deltaO + s * 2);
        const rangeOffset = sfnt.readUInt16BE(rangeO + s * 2);
        if (start === 0xffff) continue;
        for (let cp = start; cp <= end; cp += 1) {
          let gid;
          if (rangeOffset === 0) {
            gid = (cp + delta) & 0xffff;
          } else {
            const addr = rangeO + s * 2 + rangeOffset + (cp - start) * 2;
            if (addr + 1 >= sfnt.length) continue;
            gid = sfnt.readUInt16BE(addr);
            if (gid !== 0) gid = (gid + delta) & 0xffff;
          }
          if (gid !== 0) codepoints.add(cp);
        }
      }
    } else if (format === 12) {
      const nGroups = sfnt.readUInt32BE(sub + 12);
      for (let g = 0; g < nGroups; g += 1) {
        const o = sub + 16 + g * 12;
        const start = sfnt.readUInt32BE(o);
        const end = sfnt.readUInt32BE(o + 4);
        for (let cp = start; cp <= end; cp += 1) codepoints.add(cp);
      }
    }
  }
  return codepoints;
}
