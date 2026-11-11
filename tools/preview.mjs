import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { projectRoot } from './build.mjs';

const root = await realpath(resolve(projectRoot, 'dist'));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
createServer(async (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const filename = await realpath(resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname)));
    if (!filename.startsWith(root + sep) || !(await stat(filename)).isFile()) { res.writeHead(404).end(); return; }
    const data = await readFile(filename);
    res.writeHead(200, { 'Content-Type': types[extname(filename)] ?? 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (error) {
    res.writeHead(['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 400).end('文件不可用');
  }
}).listen(4173, '127.0.0.1', () => console.log('本地预览：http://127.0.0.1:4173'));
