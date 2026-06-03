/**
 * 验证 book-spider 集成所依赖的机制:子进程设 NODE_USE_ENV_PROXY + HTTP(S)_PROXY 后,
 * 内置 fetch / http.get / https.get 是否都经 mihomo 出网。
 * 用一个本地可用上游代理(转发到真实互联网)排除机场抖动。
 *
 * 运行:pnpm tsx examples/envproxy-local.ts
 */
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { ClashBalancer } from '../src/index';

const PROXY_PORT = 9111;
const CONTROLLER_PORT = 19191;
const UPSTREAM_PORT = 19188;
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/mihomo-windows-amd64-compatible.exe');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startUpstream(port: number): http.Server {
  const srv = http.createServer((clientReq, clientRes) => {
    const u = new URL(clientReq.url!);
    const proxyReq = http.request(
      { host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: clientReq.method, headers: clientReq.headers },
      (proxyRes) => { clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers); proxyRes.pipe(clientRes); },
    );
    proxyReq.on('error', () => { clientRes.writeHead(502); clientRes.end('e'); });
    clientReq.pipe(proxyReq);
  });
  srv.on('connect', (req, clientSocket, head) => {
    const [host, portStr] = (req.url ?? '').split(':');
    const serverSocket = net.connect(Number(portStr) || 443, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) serverSocket.write(head);
      serverSocket.pipe(clientSocket); clientSocket.pipe(serverSocket);
    });
    serverSocket.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => serverSocket.destroy());
  });
  srv.listen(port, '127.0.0.1');
  return srv;
}

function probe(mode: 'fetch' | 'http' | 'https'): Promise<string> {
  const url = mode === 'https' ? 'https://ipinfo.io/ip' : 'http://ipinfo.io/ip';
  const code =
    mode === 'fetch'
      ? `fetch(${JSON.stringify(url)}).then(r=>r.text()).then(t=>process.stdout.write('OK:'+t.trim())).catch(e=>process.stdout.write('ERR:'+(e.cause?.message||e.message)))`
      : `require(${JSON.stringify(mode === 'https' ? 'https' : 'http')}).get(${JSON.stringify(url)},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>process.stdout.write('OK:'+d.trim()))}).on('error',e=>process.stdout.write('ERR:'+e.message))`;
  return new Promise((resolve) => {
    const env = { ...process.env, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: `http://127.0.0.1:${PROXY_PORT}`, HTTPS_PROXY: `http://127.0.0.1:${PROXY_PORT}` };
    const c = spawn(process.execPath, ['-e', code], { env });
    let out = ''; c.stdout.on('data', (x) => (out += x));
    c.on('exit', () => resolve(out.trim()));
    setTimeout(() => { c.kill(); resolve('TIMEOUT'); }, 15000);
  });
}

async function main(): Promise<void> {
  const upstream = startUpstream(UPSTREAM_PORT);
  const lb = new ClashBalancer({
    binPath: BIN, port: PROXY_PORT, controllerPort: CONTROLLER_PORT, strategy: 'round-robin',
    proxies: [{ name: 'up-0', type: 'http', server: '127.0.0.1', port: UPSTREAM_PORT }],
    healthCheck: { enabled: true, url: 'http://www.gstatic.com/generate_204', interval: 3000, timeout: 4000 },
    readyTimeoutMs: 12000,
  });
  lb.on('clash:fatal', (e) => console.log('fatal', (e as Error).message));
  await lb.start();
  await sleep(2000);
  console.log('fetch     :', await probe('fetch'));
  console.log('http.get  :', await probe('http'));
  console.log('https.get :', await probe('https'));
  await lb.stop();
  upstream.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
