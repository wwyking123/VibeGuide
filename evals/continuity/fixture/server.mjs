import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Explicit allowlist: project records and other workspace files are never served.
const publicFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/registration.mjs', ['registration.mjs', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

export function createDemoServer() {
  return createServer(async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    let pathname;
    try { pathname = new URL(request.url, 'http://127.0.0.1').pathname; }
    catch { response.writeHead(400); response.end(); return; }
    const file = publicFiles.get(pathname);
    if (!file) { response.writeHead(404); response.end('Not found'); return; }
    try {
      const content = await readFile(new URL(file[0], import.meta.url));
      response.writeHead(200, {
        'Content-Type': file[1], 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch {
      response.writeHead(500); response.end('Demo file could not be read');
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--port' || !/^\d+$/.test(args[1]))) {
    throw new Error('Usage: node server.mjs [--port 4173]');
  }
  const port = args.length ? Number(args[1]) : 4173;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  const server = createDemoServer();
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => {
    console.log(`本机演示：http://127.0.0.1:${server.address().port}`);
    console.log('没有真实登录、多人共享或上线。按 Ctrl+C 结束。');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
