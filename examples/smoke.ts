/**
 * 真实功能冒烟测试(端口 9001)。
 *
 * 拓扑:client → mihomo:9001(本库编排)→ 本地上游 HTTP 代理:18080 → 本地目标:18081
 *
 * 验证:start→ready / controller.version / 经 9001 真实转发 / 健康探测延迟 /
 *       reload 热更新 / stop 清理。
 *
 * 运行:pnpm tsx examples/smoke.ts
 */
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ClashBalancer } from '../src/index';

const PROXY_PORT = 9001;        // 客户端连接的固定端口(本次要求)
const CONTROLLER_PORT = 19090;  // external-controller
const UPSTREAM_PORT = 18080;    // 本地上游 HTTP 代理
const TARGET_PORT = 18081;      // 本地目标服务器
const TARGET_URL = `http://127.0.0.1:${TARGET_PORT}/`;

const BIN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../bin/mihomo-windows-amd64-compatible.exe',
);

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass += 1; console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

/** 本地目标 HTTP 服务器:对任何请求回 "hello-from-target"。 */
function startTarget(): Promise<http.Server> {
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('hello-from-target');
  });
  return new Promise((resolve) => srv.listen(TARGET_PORT, '127.0.0.1', () => resolve(srv)));
}

/**
 * 本地上游 HTTP 正向代理:同时支持普通 HTTP(absolute-form)与 CONNECT 隧道,
 * 记录命中次数。mihomo 的 http 出站对所有 TCP 流量走 CONNECT,故隧道是关键。
 */
function startUpstream(): { server: http.Server; hits: () => number } {
  let hits = 0;
  const srv = http.createServer((clientReq, clientRes) => {
    hits += 1;
    const u = new URL(clientReq.url!); // 代理请求是绝对 URL
    const proxyReq = http.request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method: clientReq.method, headers: clientReq.headers },
      (proxyRes) => {
        clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(clientRes);
      },
    );
    proxyReq.on('error', () => { clientRes.writeHead(502); clientRes.end('upstream error'); });
    clientReq.pipe(proxyReq);
  });
  // CONNECT 隧道:把客户端与目标 host:port 之间的 TCP 直接对接。
  srv.on('connect', (req, clientSocket, head) => {
    hits += 1;
    const [host, portStr] = (req.url ?? '').split(':');
    const serverSocket = net.connect(Number(portStr) || 80, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });
    serverSocket.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => serverSocket.destroy());
  });
  srv.listen(UPSTREAM_PORT, '127.0.0.1');
  return { server: srv, hits: () => hits };
}

/** 经 HTTP 代理(mihomo:9001)发起对 targetUrl 的 GET。 */
function getViaProxy(proxyPort: number, targetUrl: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const t = new URL(targetUrl);
    const req = http.request(
      { host: '127.0.0.1', port: proxyPort, method: 'GET', path: targetUrl, headers: { Host: t.host } },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('proxied request timeout')));
    req.end();
  });
}

/** 探测某端口是否在监听。 */
function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.setTimeout(1500, () => { sock.destroy(); resolve(false); });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log(`mihomo: ${BIN}`);
  const target = await startTarget();
  const upstream = startUpstream();
  console.log(`本地目标:${TARGET_URL}   本地上游代理:127.0.0.1:${UPSTREAM_PORT}\n`);

  const lb = new ClashBalancer({
    binPath: BIN,
    port: PROXY_PORT,
    controllerPort: CONTROLLER_PORT,
    strategy: 'round-robin',
    proxies: [
      { name: 'up-1', type: 'http', server: '127.0.0.1', port: UPSTREAM_PORT },
    ],
    // 健康检查的测试 URL 指向本地目标(经节点可达),全程离线即可跑通
    healthCheck: { enabled: true, url: TARGET_URL, interval: 2000, timeout: 3000, failuresToDrop: 3 },
    readyTimeoutMs: 12000,
  });

  let ready = false;
  lb.on('ready', () => { ready = true; });
  lb.on('error', (e) => console.log('  ⚠️  lb error:', (e as Error).message));
  lb.on('clash:fatal', (e) => console.log('  ⚠️  clash fatal:', (e as Error).message));

  try {
    console.log('▶ 1. 启动 + 就绪');
    await lb.start();
    lb.supervisor.on('stderr', (s: string) => {
      const line = s.trim();
      if (line) console.log('    [mihomo]', line);
    });
    check('start() resolve 且 emit ready', ready);

    console.log('▶ 2. external-controller');
    const v = await lb.controller.version();
    check('controller.version() 返回版本', !!v.version, v.version);

    console.log(`▶ 3. 代理端口 ${PROXY_PORT} 监听 + 真实转发`);
    check(`端口 ${PROXY_PORT} 正在监听`, await portListening(PROXY_PORT));
    const hitsBefore = upstream.hits();
    const r1 = await getViaProxy(PROXY_PORT, TARGET_URL);
    check('经 9001 代理的 GET 返回 200', r1.status === 200, `status=${r1.status}`);
    check('响应体来自目标服务器', r1.body === 'hello-from-target', JSON.stringify(r1.body));
    check('流量确实经过上游代理', upstream.hits() > hitsBefore, `upstream hits +${upstream.hits() - hitsBefore}`);

    console.log('▶ 4. 健康探测(经 mihomo 测节点延迟)');
    await sleep(2500); // 等一轮主动健康检查
    const s1 = await lb.stats();
    const up1 = s1.proxies.find((p) => p.name === 'up-1');
    check('stats 含节点 up-1 且存活', !!up1 && up1.alive, JSON.stringify(up1));
    check('延迟为数值(节点可达)', typeof up1?.delay === 'number', `delay=${up1?.delay}ms`);

    console.log('▶ 5. reload 热更新节点');
    await lb.reload({
      proxies: [
        { name: 'up-2', type: 'http', server: '127.0.0.1', port: UPSTREAM_PORT },
        { name: 'up-3', type: 'http', server: '127.0.0.1', port: UPSTREAM_PORT },
      ],
    });
    const s2 = await lb.stats();
    check('reload 后节点变为 up-2/up-3', JSON.stringify(s2.proxies.map((p) => p.name)) === JSON.stringify(['up-2', 'up-3']), s2.proxies.map((p) => p.name).join(','));
    const r2 = await getViaProxy(PROXY_PORT, TARGET_URL);
    check('reload 后转发仍正常', r2.status === 200 && r2.body === 'hello-from-target', `status=${r2.status}`);

    console.log('▶ 6. stop + 清理');
    await lb.stop();
    await sleep(500);
    check(`stop 后端口 ${PROXY_PORT} 不再监听`, !(await portListening(PROXY_PORT)));
  } finally {
    target.close();
    upstream.server.close();
    try { await lb.stop(); } catch { /* already stopped */ }
  }

  console.log(`\n结果:${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('冒烟测试异常:', err);
  process.exit(1);
});
