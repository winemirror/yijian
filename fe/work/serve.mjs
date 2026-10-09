// Tiny static server for previewing the built web app.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(
  process.env.ROOT || "C:/Users/su/Documents/Codex/2026-10-08/fe/outputs/xiangqi-local"
);
const port = Number(process.env.PORT || 4290);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
};

http
  .createServer((request, response) => {
    const pathname = (request.url || "/").split("?")[0];
    const requestPath = pathname === "/" ? "/index.html" : pathname;
    const filePath = path.resolve(root, `.${requestPath}`);
    if (!filePath.startsWith(root)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    fs.readFile(filePath, (error, content) => {
      if (error) {
        response.writeHead(404).end("Not found");
        return;
      }
      response.writeHead(200, {
        "Content-Type": mime[path.extname(filePath)] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      response.end(content);
    });
  })
  .listen(port, "127.0.0.1", () => {
    console.log(`http://127.0.0.1:${port}`);
  });
