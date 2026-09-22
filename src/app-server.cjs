'use strict';
// Makes the app under test available, depending on `app` in qa.config.json:
//   { "serve": "./game", "port": 8124 }         serve a folder with a tiny dependency-free HTTP server
//   { "command": "npm run dev", "url": "..." }   run a command and wait until the URL responds
//   { "url": "https://staging.example.com/" }    just use an app that is already running
// If the URL already responds, nothing is started.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm',
};

async function reachable(url) {
  try { return (await fetch(url)).ok; } catch (_) { return false; }
}

async function waitFor(url, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await reachable(url)) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

function serveStatic(root, port) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.normalize(path.join(root, urlPath));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function startApp(app) {
  const url = app.url;
  if (await reachable(url)) return { url, stop() {} };

  if (app.serve) {
    const port = Number(new URL(url).port || 80);
    const server = await serveStatic(path.resolve(app.serve), port);
    return { url, stop() { server.close(); } };
  }

  if (app.command) {
    const child = spawn(app.command, { cwd: app.cwd || process.cwd(), shell: true, stdio: 'ignore', detached: true });
    const ok = await waitFor(url, app.startTimeoutMs || 60000);
    const stop = () => { try { process.kill(-child.pid); } catch (_) {} };
    if (!ok) { stop(); throw new Error(`app did not become reachable: ${url} (command: ${app.command})`); }
    return { url, stop };
  }

  if (!(await waitFor(url, app.startTimeoutMs || 10000))) throw new Error(`app is not reachable: ${url}`);
  return { url, stop() {} };
}

module.exports = { startApp };
