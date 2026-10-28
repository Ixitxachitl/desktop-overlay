// A small web server on this computer only, so the stats page works as a desktop overlay and as an
// OBS browser source alike:
//   /         the stats panel (see page/index.html for its settings)
//   /events   the stats as server-sent events, one JSON message a second
const http = require("http");
const fs = require("fs");
const path = require("path");

const PAGE_DIR = path.join(__dirname, "page");
const FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/fonts/press-start-2p.woff2": ["fonts/press-start-2p.woff2", "font/woff2"],
};

function startServer(hub, port, onError) {
  const server = http.createServer((req, res) => {
    // Only this computer's own addresses, so other websites can't reach it by renaming their own.
    const host = (req.headers.host || "").replace(/:\d+$/, "");
    if (!["127.0.0.1", "localhost"].includes(host)) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url, "http://127.0.0.1");

    if (url.pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      res.write("retry: 2000\n\n");
      const unsubscribe = hub.subscribe((s) => res.write(`data: ${JSON.stringify(s)}\n\n`));
      req.on("close", unsubscribe);
      return;
    }

    const file = FILES[url.pathname];
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    fs.readFile(path.join(PAGE_DIR, file[0]), (err, data) => {
      if (err) res.writeHead(500).end();
      else res.writeHead(200, { "Content-Type": file[1], "Cache-Control": "no-store" }).end(data);
    });
  });
  server.on("error", onError);
  server.listen(port, "127.0.0.1");
  return server;
}

module.exports = { startServer };
