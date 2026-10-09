// Lists downloadable .zip links on the given asset pages.
const pages = process.argv.slice(2);

for (const page of pages) {
  try {
    const response = await fetch(page);
    const html = await response.text();
    const zips = [...new Set(
      [...html.matchAll(/href="([^"]+\.zip)"/g)].map((match) => match[1])
    )];
    console.log(`${page} -> ${response.status}`);
    for (const zip of zips) console.log(`    ${zip}`);
  } catch (error) {
    console.log(`${page} -> ERR ${error.message}`);
  }
}
