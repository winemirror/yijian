const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "outputs", "xiangqi-local");
const port = Number(process.env.PORT || 4173);
// HOST=0.0.0.0 exposes the page on the local network, which is the quickest way
// to open it from a phone. Defaults to loopback only.
const host = process.env.HOST || "127.0.0.1";
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

http.createServer((request, response) => {
  const pathname = request.url.split("?")[0];
  const requestPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(root, `.${requestPath}`);
  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": mime[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    response.end(content);
  });
}).listen(port, host, () => {
  const urls = host === "0.0.0.0" || host === "::"
    ? Object.values(os.networkInterfaces())
        .flat()
        .filter((entry) => entry && entry.family === "IPv4" && !entry.internal)
        .map((entry) => `http://${entry.address}:${port}`)
    : [`http://${host}:${port}`];
  console.log(urls.length ? urls.join("\n") : `http://127.0.0.1:${port}`);
});
