/**
 * 订阅地址真实功能测试(端口 9001)。
 *
 * client → mihomo:9001(本库编排,proxy-providers 拉取订阅)→ 订阅里的真实节点 → 互联网
 *
 * 运行:pnpm tsx examples/sub-smoke.ts
 */
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ClashBalancer } from '../src/index';

const SUB_URL = 'https://dy.xxx.shop/xxxx';
const PROXY_PORT = 9001;
const CONTROLLER_PORT = 19090;

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.setTimeout(1500, () => { sock.destroy(); resolve(false); });
  });
}

/** 经 HTTP 代理(mihomo:9001)发起对 http 目标的 GET。 */
function getViaProxy(proxyPort: number, targetUrl: string, timeoutMs = 8000): Promise<{ status: number; body: string }> {
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
    req.setTimeout(timeoutMs, () => req.destroy(new Error('proxied request timeout')));
    req.end();
  });
}

interface ProxiesResp {
  proxies: Record<string, { all?: string[]; now?: string; type?: string }>;
}

interface ProvidersResp {
  providers: Record<string, { vehicleType?: string; proxies?: Array<{ name: string }> }>;
}

async function main(): Promise<void> {
  console.log(`mihomo: ${BIN}`);
  console.log(`订阅:  ${SUB_URL}\n`);

  const lb = new ClashBalancer({
    binPath: BIN,
    port: PROXY_PORT,
    controllerPort: CONTROLLER_PORT,
    strategy: 'url-test', // 自动选最快的可用节点
    // userAgent: 'clash.meta' 让机场返回完整 Clash 节点列表(默认 UA 只回退到单节点)
    subscriptions: [{ name: 'boost', url: SUB_URL, interval: 86400, userAgent: 'clash.meta' }],
    healthCheck: { enabled: true, url: 'http://www.gstatic.com/generate_204', interval: 5000, timeout: 5000 },
    readyTimeoutMs: 15000,
  });

  lb.on('error', (e) => console.log('  ⚠️  lb error:', (e as Error).message));
  lb.on('clash:fatal', (e) => console.log('  ⚠️  clash fatal:', (e as Error).message));

  let ready = false;
  lb.on('ready', () => { ready = true; });

  try {
    console.log('▶ 1. 启动 + 就绪');
    await lb.start();
    lb.supervisor.on('stderr', (s: string) => {
      const line = s.trim();
      if (line) console.log('    [mihomo]', line.slice(0, 200));
    });
    check('start() resolve 且 emit ready', ready);

    console.log('▶ 2. external-controller');
    const v = await lb.controller.version();
    check('controller.version() 返回版本', !!v.version, v.version);

    console.log('▶ 3. 订阅 proxy-provider 拉取节点(轮询最多 ~30s)');
    let nodeCount = 0;
    for (let i = 0; i < 30; i += 1) {
      const pr = (await lb.controller.providers()) as ProvidersResp;
      const boost = pr.providers['boost'];
      if (boost?.proxies && boost.proxies.length > 1) {
        nodeCount = boost.proxies.length;
        break;
      }
      await sleep(1000);
    }
    check('订阅节点已加载进 boost provider', nodeCount > 1, `节点数=${nodeCount}`);

    // url-test 经一次连接后选出最快节点
    const p = (await lb.controller.proxies()) as ProxiesResp;
    const selected = p.proxies['balance']?.now ?? '';
    check('balance(url-test)组已绑定 provider 节点', (p.proxies['balance']?.all?.length ?? 0) > 1,
      `组内节点数=${p.proxies['balance']?.all?.length ?? 0}`);

    console.log(`▶ 4. 经 9001 真实转发到互联网(当前 url-test 选中:${selected || '(尚未选出,首次连接后产生)'})`);
    let ok204 = false;
    let lastStatus = 0;
    for (let i = 0; i < 8; i += 1) {
      try {
        const r = await getViaProxy(PROXY_PORT, 'http://www.gstatic.com/generate_204');
        lastStatus = r.status;
        if (r.status === 204 || r.status === 200) { ok204 = true; break; }
      } catch (e) {
        lastStatus = -1;
        console.log(`    重试 ${i + 1}: ${(e as Error).message}`);
      }
      await sleep(2000);
    }
    check('经代理访问 gstatic/generate_204 返回 204', ok204, `status=${lastStatus}`);

    // 出口 IP(信息性,展示流量确实从代理节点出去)
    try {
      const ipRes = await getViaProxy(PROXY_PORT, 'http://ipinfo.io/ip', 8000);
      const egress = ipRes.body.trim();
      console.log(`    出口 IP(经代理):${egress}`);
    } catch (e) {
      console.log(`    出口 IP 获取失败(非致命):${(e as Error).message}`);
    }

    console.log('▶ 5. stats');
    const s = await lb.stats();
    check('stats.port == 9001', s.port === PROXY_PORT, `port=${s.port}`);
    console.log(`    uptime=${s.uptime}ms, 静态节点状态条目=${s.proxies.length}(订阅节点由 mihomo 自管,不在此列)`);

    console.log('▶ 6. stop + 清理');
    await lb.stop();
    await sleep(500);
    check(`stop 后端口 ${PROXY_PORT} 不再监听`, !(await portListening(PROXY_PORT)));
  } finally {
    try { await lb.stop(); } catch { /* already stopped */ }
  }

  console.log(`\n结果:${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('订阅测试异常:', err);
  process.exit(1);
});
