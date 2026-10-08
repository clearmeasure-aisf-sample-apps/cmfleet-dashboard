// Serves a built site for the tests, with the fleet's data taken from a directory instead of from where the fleet
// publishes it: the page is then tested against data the test chose.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
};

export async function serve({ site, data }) {
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    try {
      if (path === '/config.json') {
        response.writeHead(200, { 'content-type': TYPES['.json'] }).end(JSON.stringify({ dataUrl: '/data/' }));
        return;
      }
      const [root, rest] = path.startsWith('/data/') ? [data, path.slice('/data/'.length)] : [site, path === '/' ? 'index.html' : path.slice(1)];
      const file = normalize(join(root, rest));
      if (!file.startsWith(normalize(root) + sep)) throw new Error('outside the site');
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' }).end(body);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((resolve) => { server.close(resolve); }) };
}
