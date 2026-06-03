import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

import { ClashBalancer } from '../src/balancer';
import * as pkg from '../src/index';
import type { ClashBalancerOptions, FetchLike, MinimalResponse, ProxyNode, SpawnLike } from '../src/types';

/** 真实存在的「假二进制」路径(用 node 可执行文件充当存在的文件)。 */
const REAL_FILE = process.execPath;

interface FakeChild extends EventEmitter {
  spawnBin: string;
  spawnArgs: readonly string[];
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
  kill(signal?: NodeJS.Signals | number): void;
}

/** 可控 fake spawn。 */
function fakeSpawn() {
  const children: FakeChild[] = [];
  const spawnImpl: SpawnLike = (bin, args) => {
    const child = new EventEmitter() as unknown as FakeChild;
    child.spawnBin = bin;
    child.spawnArgs = args;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', 0, 'SIGTERM')); };
    children.push(child);
    return child;
  };
  return { spawnImpl, children };
}

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/** fake fetch:version 成功;reload 记录调用。 */
function fakeFetch({ versionOk = true }: { versionOk?: boolean } = {}) {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, init = {}) => {
    calls.push({ url, init });
    const u = new URL(url);
    if (u.pathname === '/version') {
      return makeRes(versionOk, versionOk ? { version: '1.18.0' } : 'not ready');
    }
    if (u.pathname === '/configs') return makeRes(true, '');
    return makeRes(true, {});
  };
  return { fetchImpl, calls };
}

function makeRes(ok: boolean, body: unknown): MinimalResponse {
  return {
    ok,
    status: ok ? 200 : 503,
    async json() { return body; },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}

function tmpWorkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-'));
}

function baseOpts(overrides: Partial<ClashBalancerOptions> = {}): ClashBalancerOptions {
  return {
    binPath: REAL_FILE,
    port: 7890,
    controllerPort: 9090,
    proxies: [{ name: 'a', type: 'ss', server: '1.1.1.1', port: 1, cipher: 'aes-256-gcm', password: 'p' }],
    healthCheck: { enabled: false },
    readyPollMs: 5,
    readyTimeoutMs: 200,
    ...overrides,
  };
}

test('包入口 index.ts re-export ClashBalancer', () => {
  assert.equal(pkg.ClashBalancer, ClashBalancer);
});

test('binPath 不存在时 start() 抛清晰错误且不 spawn', async () => {
  const { spawnImpl, children } = fakeSpawn();
  const { fetchImpl } = fakeFetch();
  const lb = new ClashBalancer(baseOpts({ binPath: 'C:/definitely/not/here.exe', spawnImpl, fetchImpl }));

  await assert.rejects(() => lb.start(), /binPath|不存在|not found/i);
  assert.equal(children.length, 0);
});

test('start() 写配置、spawn、轮询就绪后 emit ready', async () => {
  const { spawnImpl, children } = fakeSpawn();
  const { fetchImpl } = fakeFetch();
  const workDir = tmpWorkDir();
  const lb = new ClashBalancer(baseOpts({ spawnImpl, fetchImpl, workDir }));
  let ready = 0;
  lb.on('ready', () => { ready += 1; });

  await lb.start();

  // 配置已落盘且含我们的节点
  const cfg = yaml.load(fs.readFileSync(path.join(workDir, 'config.yaml'), 'utf8')) as any;
  assert.equal(cfg['mixed-port'], 7890);
  assert.deepEqual(cfg.proxies.map((p: ProxyNode) => p.name), ['a']);

  // spawn 用了 -d workDir -f config.yaml
  assert.equal(children.length, 1);
  assert.deepEqual(children[0]!.spawnArgs, ['-d', workDir, '-f', path.join(workDir, 'config.yaml')]);

  assert.equal(ready, 1);

  await lb.stop();
});

test('就绪超时 → start() 拒绝并附带 mihomo stderr 末尾', async () => {
  const { spawnImpl, children } = fakeSpawn();
  const { fetchImpl } = fakeFetch({ versionOk: false });
  const workDir = tmpWorkDir();
  const lb = new ClashBalancer(baseOpts({ spawnImpl, fetchImpl, workDir }));

  const p = lb.start();
  // 进程已 spawn,模拟 mihomo 端口占用报错写到 stderr
  children[0]!.stderr.emit('data', Buffer.from('FATA listen tcp :7890: bind: address already in use'));

  let caught: Error | undefined;
  try { await p; } catch (e) { caught = e as Error; }
  assert.ok(caught, '应当拒绝');
  assert.match(caught!.message, /就绪超时/);
  assert.match(caught!.message, /address already in use/);

  await lb.stop();
});

test('stats() 返回端口、uptime 和各节点状态', async () => {
  const { spawnImpl } = fakeSpawn();
  const { fetchImpl } = fakeFetch();
  const lb = new ClashBalancer(baseOpts({ spawnImpl, fetchImpl, workDir: tmpWorkDir() }));

  await lb.start();
  const s = await lb.stats();

  assert.equal(s.port, 7890);
  assert.ok(s.uptime >= 0);
  assert.deepEqual(s.proxies, [{ name: 'a', alive: true, delay: null }]);

  await lb.stop();
});

test('reload() 更新节点、重写配置并热重载', async () => {
  const { spawnImpl } = fakeSpawn();
  const { fetchImpl, calls } = fakeFetch();
  const workDir = tmpWorkDir();
  const lb = new ClashBalancer(baseOpts({ spawnImpl, fetchImpl, workDir }));
  await lb.start();

  const newProxies: ProxyNode[] = [
    { name: 'b', type: 'ss', server: '2.2.2.2', port: 2, cipher: 'aes-256-gcm', password: 'q' },
    { name: 'c', type: 'trojan', server: '3.3.3.3', port: 443, password: 'r' },
  ];
  await lb.reload({ proxies: newProxies });

  const cfg = yaml.load(fs.readFileSync(path.join(workDir, 'config.yaml'), 'utf8')) as any;
  assert.deepEqual(cfg.proxies.map((p: ProxyNode) => p.name), ['b', 'c']);

  const reloadCall = calls.find((c) => new URL(c.url).pathname === '/configs');
  assert.ok(reloadCall, '应当调用 PUT /configs');
  assert.equal(reloadCall!.init.method, 'PUT');

  const s = await lb.stats();
  assert.deepEqual(s.proxies.map((p) => p.name), ['b', 'c']);

  await lb.stop();
});

test('转发 supervisor 的 restart/fatal 事件为 clash:restart/clash:fatal', async () => {
  const { spawnImpl } = fakeSpawn();
  const { fetchImpl } = fakeFetch();
  const lb = new ClashBalancer(baseOpts({ spawnImpl, fetchImpl, workDir: tmpWorkDir() }));
  await lb.start();

  const restarts: Array<{ attempt: number; delayMs: number }> = [];
  const fatals: Error[] = [];
  lb.on('clash:restart', (i) => restarts.push(i));
  lb.on('clash:fatal', (e) => fatals.push(e));

  lb.supervisor.emit('restart', { attempt: 2, delayMs: 2000 });
  lb.supervisor.emit('fatal', new Error('dead'));

  assert.deepEqual(restarts, [{ attempt: 2, delayMs: 2000 }]);
  assert.equal(fatals.length, 1);
  assert.match(fatals[0]!.message, /dead/);

  await lb.stop();
});

test('健康层 change 触发重建+热重载,配置仅含存活节点', async () => {
  const { spawnImpl } = fakeSpawn();
  const { fetchImpl, calls } = fakeFetch();
  const workDir = tmpWorkDir();
  const proxies: ProxyNode[] = [
    { name: 'a', type: 'ss', server: '1.1.1.1', port: 1, cipher: 'aes-256-gcm', password: 'p' },
    { name: 'b', type: 'ss', server: '2.2.2.2', port: 2, cipher: 'aes-256-gcm', password: 'q' },
  ];
  const lb = new ClashBalancer(baseOpts({ spawnImpl, fetchImpl, workDir, proxies }));
  await lb.start();

  const before = calls.filter((c) => new URL(c.url).pathname === '/configs').length;
  lb.health!.emit('change', [proxies[1]]); // a 被剔除,只剩 b
  await new Promise((r) => setImmediate(r));

  const cfg = yaml.load(fs.readFileSync(path.join(workDir, 'config.yaml'), 'utf8')) as any;
  assert.deepEqual(cfg.proxies.map((p: ProxyNode) => p.name), ['b']);
  const after = calls.filter((c) => new URL(c.url).pathname === '/configs').length;
  assert.equal(after, before + 1);

  await lb.stop();
});
