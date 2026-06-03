/**
 * 确定性本地测试:round-robin 是否真的把并发连接轮换到多个上游节点。
 * 不依赖任何机场:起 N 个本地 HTTP 正向代理(各自计数),mihomo 用 round-robin
 * 在这 N 个节点间分发,统计每个节点命中数。
 *
 * 拓扑:client → mihomo:9101(round-robin)→ {up-0..up-N 本地代理}→ 本地目标:19181
 *
 * 运行:pnpm tsx examples/rr-local.ts
 */
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ClashBalancer } from '../src/index';

const PROXY_PORT = 9101;
const CONTROLLER_PORT = 19190;
const TARGET_PORT = 19181;
const N_UPSTREAMS = 4;
const UPSTREAM_BASE = 19182; // up-i 监听 19182+i
const TARGET_URL = `http://127.0.0.1:${TARGET_PORT}/`;

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/mihomo-windows-amd64-compatible.exe');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startTarget(): http.Server {
  const srv = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  srv.listen(TARGET_PORT, '127.0.0.1');
  return srv;
}

/** 一个本地 HTTP 正向代理(支持普通 HTTP + CONNECT),记录命中数。 */
function startUpstream(port: number): { server: http.Server; hits: () => number } {
  let hits = 0;
  const srv = http.createServer((clientReq, clientRes) => {
    hits += 1;
    const u = new URL(clientReq.url!);
    const proxyReq = http.request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method: clientReq.method, headers: clientReq.headers },
      (proxyRes) => { clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers); proxyRes.pipe(clientRes); },
    );
    proxyReq.on('error', () => { clientRes.writeHead(502); clientRes.end('e'); });
    clientReq.pipe(proxyReq);
  });
  srv.on('connect', (req, clientSocket, head) => {
    hits += 1;
    const [host, portStr] = (req.url ?? '').split(':');
    const serverSocket = net.connect(Number(portStr) || 80, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) serverSocket.write(head);
      serverSocket.pipe(clientSocket); clientSocket.pipe(serverSocket);
    });
    serverSocket.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => serverSocket.destroy());
  });
  srv.listen(port, '127.0.0.1');
  return { server: srv, hits: () => hits };
}

/** 经 mihomo:PROXY_PORT 对 http 目标发 GET(每次新连接,Connection: close)。 */
function getViaProxy(): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PROXY_PORT, method: 'GET', path: TARGET_URL, headers: { Host: `127.0.0.1:${TARGET_PORT}`, Connection: 'close' } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function main(): Promise<void> {
  const target = startTarget();
  const upstreams = Array.from({ length: N_UPSTREAMS }, (_, i) => startUpstream(UPSTREAM_BASE + i));
  const proxies = Array.from({ length: N_UPSTREAMS }, (_, i) => ({
    name: `up-${i}`, type: 'http', server: '127.0.0.1', port: UPSTREAM_BASE + i,
  }));

  const lb = new ClashBalancer({
    binPath: BIN, port: PROXY_PORT, controllerPort: CONTROLLER_PORT, strategy: 'round-robin',
    proxies,
    healthCheck: { enabled: true, url: TARGET_URL, interval: 2000, timeout: 3000 },
    readyTimeoutMs: 12000,
  });
  lb.on('clash:fatal', (e) => console.log('fatal', (e as Error).message));
  await lb.start();
  console.log(`balancer ready, ${N_UPSTREAMS} 本地上游, round-robin`);

  // 等一轮健康检查(lazy:false 会主动探测)
  await sleep(3000);
  const px = (await lb.controller.proxies()) as { proxies: Record<string, { all?: string[]; now?: string }> };
  console.log('balance.all =', px.proxies['balance']?.all);

  const N = 40;
  console.log(`\n并发 ${N} 个请求…`);
  const results = await Promise.allSettled(Array.from({ length: N }, () => getViaProxy()));
  const ok = results.filter((r) => r.status === 'fulfilled' && (r as PromiseFulfilledResult<number>).value === 200).length;
  const fail = N - ok;
  console.log(`成功 ${ok} / 失败 ${fail}`);
  const dist = upstreams.map((u, i) => `up-${i}:${u.hits()}`);
  console.log('各节点命中:', dist.join('  '));
  const used = upstreams.filter((u) => u.hits() > 0).length;
  console.log(`实际被使用的节点数: ${used} / ${N_UPSTREAMS}  → ${used > 1 ? '✅ round-robin 轮换生效' : '❌ 未轮换'}`);

  await lb.stop();
  target.close();
  upstreams.forEach((u) => u.server.close());
  process.exit(used > 1 && ok > 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
