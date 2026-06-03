import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { HealthChecker, type DelayProbe } from '../src/health';
import type { DelayResponse, HealthCheckRuntime, ProxyNode } from '../src/types';

const PROXIES: ProxyNode[] = [
  { name: 'a', type: 'ss' },
  { name: 'b', type: 'ss' },
];

const HC: HealthCheckRuntime = { url: 'http://t/204', timeout: 1000, failuresToDrop: 3, interval: 60000 };

type Behavior = number | Error | (() => DelayResponse);

/** controller mock:behavior 决定每个节点 delay() 的行为(返回 {delay} 或抛错)。 */
function mockController(behavior: Record<string, Behavior>): DelayProbe {
  return {
    async delay(name: string): Promise<DelayResponse> {
      const b = behavior[name];
      if (typeof b === 'function') return b();
      if (b instanceof Error) throw b;
      return { delay: b as number };
    },
  };
}

function make(behavior: Record<string, Behavior>, proxies: ProxyNode[] = PROXIES): HealthChecker {
  const controller = mockController(behavior);
  return new HealthChecker({ controller, proxies, healthCheck: HC });
}

test('delay 成功的节点保持存活并记录延迟', async () => {
  const hc = make({ a: 100, b: 200 });

  await hc.tick();

  const status = hc.status();
  assert.deepEqual(status, [
    { name: 'a', alive: true, delay: 100 },
    { name: 'b', alive: true, delay: 200 },
  ]);
});

test('连续失败达 failuresToDrop 才剔除:之前保持存活,达到后 down + change', async () => {
  const hc = make({ a: new Error('timeout'), b: 200 });
  const downs: string[] = [];
  const changes: string[][] = [];
  hc.on('down', (name) => downs.push(name));
  hc.on('change', (alive: ProxyNode[]) => changes.push(alive.map((p) => p.name)));

  // 前两轮(failuresToDrop=3)未达阈值,a 仍存活
  await hc.tick();
  await hc.tick();
  assert.deepEqual(downs, []);
  assert.deepEqual(changes, []);
  assert.equal(hc.status().find((s) => s.name === 'a')!.alive, true);

  // 第三轮达到阈值,a 被剔除
  await hc.tick();
  assert.deepEqual(downs, ['a']);
  assert.deepEqual(changes, [['b']]); // change 携带剩余存活节点
  assert.equal(hc.status().find((s) => s.name === 'a')!.alive, false);
});

test('节点恢复:再次成功则 up + change,失败计数清零', async () => {
  let aCalls = 0;
  const hc = make({
    a: () => { aCalls += 1; if (aCalls <= 3) throw new Error('down'); return { delay: 50 }; },
    b: 200,
  });
  const ups: string[] = [];
  const changes: string[][] = [];
  hc.on('up', (name) => ups.push(name));
  hc.on('change', (alive: ProxyNode[]) => changes.push(alive.map((p) => p.name)));

  await hc.tick(); await hc.tick(); await hc.tick(); // a 被剔除
  await hc.tick(); // a 恢复

  assert.deepEqual(ups, ['a']);
  assert.deepEqual(changes, [['b'], ['a', 'b']]); // 先剔除只剩 b,再恢复回 a、b
  const a = hc.status().find((s) => s.name === 'a')!;
  assert.equal(a.alive, true);
  assert.equal(a.delay, 50);
});

test('全部挂掉:emit all:down 且不 emit change(保留旧配置)', async () => {
  const hc = make({ a: new Error('x'), b: new Error('y') });
  const changes: string[][] = [];
  let allDown = 0;
  hc.on('change', (alive: ProxyNode[]) => changes.push(alive.map((p) => p.name)));
  hc.on('all:down', () => { allDown += 1; });

  await hc.tick(); await hc.tick(); await hc.tick();

  assert.equal(allDown, 1);
  assert.deepEqual(changes, []); // 没有 change —— 不重建空组
});

test('start 周期性 tick,stop 后停止', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const hc = make({ a: 100, b: 200 });
    let ticks = 0;
    hc.tick = async () => { ticks += 1; };

    hc.start();
    mock.timers.tick(HC.interval);
    mock.timers.tick(HC.interval);
    assert.equal(ticks, 2);

    hc.stop();
    mock.timers.tick(HC.interval * 5);
    assert.equal(ticks, 2); // stop 后不再 tick
  } finally {
    mock.timers.reset();
  }
});

test('tick 抛错时 emit error,不中断循环', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const hc = make({ a: 100, b: 200 });
    const errors: Error[] = [];
    hc.on('error', (e) => errors.push(e));
    hc.tick = async () => { throw new Error('boom'); };

    hc.start();
    mock.timers.tick(HC.interval);
    // 让 tick 的 rejection microtask 落地
    return Promise.resolve().then(() => {
      assert.equal(errors.length, 1);
      assert.match(errors[0]!.message, /boom/);
      hc.stop();
    });
  } finally {
    mock.timers.reset();
  }
});
