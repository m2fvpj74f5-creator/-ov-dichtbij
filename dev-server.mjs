// Local preview server: serves the static files and mimics Vercel's /api/departures function.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { GET } from "./api/departures.js";

const root = process.cwd();
const port = Number(process.env.PORT) || 3000;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/api/departures") {
      const response = await GET(new Request(url));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
      return;
    }
    const path = normalize(join(root, url.pathname === "/" ? "index.html" : url.pathname));
    if (!path.startsWith(root) || /node_modules|\.env|\/api\/|\/lib\//.test(path)) throw new Error("forbidden");
    const body = await readFile(path);
    res.writeHead(200, { "Content-Type": types[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}).listen(port, () => console.log(`OV Dichtbij dev server op http://localhost:${port}`));
