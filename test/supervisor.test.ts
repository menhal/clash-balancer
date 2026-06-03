import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { Supervisor } from '../src/supervisor';
import type { ResolvedRestart, SpawnLike } from '../src/types';

interface FakeChild extends EventEmitter {
  spawnBin: string;
  spawnArgs: readonly string[];
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
  killSignal: NodeJS.Signals | number | null;
  kill(signal?: NodeJS.Signals | number): void;
}

/** 造一个可控的 fake child_process.spawn。 */
function fakeSpawn() {
  const children: FakeChild[] = [];
  const spawnImpl: SpawnLike = (bin, args) => {
    const child = new EventEmitter() as unknown as FakeChild;
    child.spawnBin = bin;
    child.spawnArgs = args;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.killSignal = null;
    child.kill = (sig) => { child.killed = true; child.killSignal = sig ?? null; };
    children.push(child);
    return child;
  };
  return { spawnImpl, children };
}

const RESTART: ResolvedRestart = { maxRetries: 3, backoffMs: 100 };

function make(spawnImpl: SpawnLike, restart: ResolvedRestart = RESTART): Supervisor {
  return new Supervisor({
    binPath: 'C:/bin/mihomo.exe',
    args: ['-d', 'C:/work', '-f', 'C:/work/config.yaml'],
    restart,
    spawnImpl,
  });
}

test('start() 用 binPath + args 调 spawn', () => {
  const { spawnImpl, children } = fakeSpawn();
  const sup = make(spawnImpl);

  sup.start();

  assert.equal(children.length, 1);
  assert.equal(children[0]!.spawnBin, 'C:/bin/mihomo.exe');
  assert.deepEqual(children[0]!.spawnArgs, ['-d', 'C:/work', '-f', 'C:/work/config.yaml']);
});

test('捕获 stderr:emit stderr 事件,lastStderr() 可取末尾内容', () => {
  const { spawnImpl, children } = fakeSpawn();
  const sup = make(spawnImpl);
  const lines: string[] = [];
  sup.on('stderr', (s) => lines.push(s));

  sup.start();
  children[0]!.stderr.emit('data', Buffer.from('FATA failed to start\n'));

  assert.deepEqual(lines, ['FATA failed to start\n']);
  assert.match(sup.lastStderr(), /FATA failed to start/);
});

test('意外退出后指数退避重启', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { spawnImpl, children } = fakeSpawn();
    const sup = make(spawnImpl);
    const restarts: Array<{ attempt: number; delayMs: number }> = [];
    sup.on('restart', (info) => restarts.push(info));

    sup.start();
    children[0]!.emit('exit', 1, null); // 崩溃

    // 退避期间还没拉新进程
    assert.equal(children.length, 1);
    assert.equal(restarts.length, 1);
    assert.equal(restarts[0]!.attempt, 1);
    assert.equal(restarts[0]!.delayMs, 100); // backoffMs * 2^0

    mock.timers.tick(100);
    assert.equal(children.length, 2); // 退避到时,拉起新进程

    // 第二次崩溃,退避翻倍
    children[1]!.emit('exit', 1, null);
    assert.equal(restarts[1]!.attempt, 2);
    assert.equal(restarts[1]!.delayMs, 200); // backoffMs * 2^1
    mock.timers.tick(200);
    assert.equal(children.length, 3);
  } finally {
    mock.timers.reset();
  }
});

test('超过 maxRetries 触发 fatal,不再重启', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { spawnImpl, children } = fakeSpawn();
    const sup = make(spawnImpl, { maxRetries: 2, backoffMs: 10 });
    const fatals: Error[] = [];
    sup.on('fatal', (err) => fatals.push(err));

    sup.start();                                  // child 0
    children[0]!.emit('exit', 1); mock.timers.tick(10);  // retry 1 → child 1
    children[1]!.emit('exit', 1); mock.timers.tick(20);  // retry 2 → child 2
    children[2]!.emit('exit', 1);                        // retry 3 > maxRetries → fatal

    assert.equal(fatals.length, 1);
    assert.ok(fatals[0] instanceof Error);
    mock.timers.tick(10000);
    assert.equal(children.length, 3); // 不再拉新进程
  } finally {
    mock.timers.reset();
  }
});

test('stop() 优雅 kill(SIGTERM)且退出后不重启', async () => {
  const { spawnImpl, children } = fakeSpawn();
  const sup = make(spawnImpl);
  let restarts = 0;
  sup.on('restart', () => { restarts += 1; });

  sup.start();
  const p = sup.stop();
  assert.equal(children[0]!.killed, true);
  assert.equal(children[0]!.killSignal, 'SIGTERM');

  children[0]!.emit('exit', 0, 'SIGTERM'); // kill 导致退出
  await p; // stop() 等到进程退出才 resolve

  assert.equal(restarts, 0);
  assert.equal(children.length, 1);
});

test('stop() 取消待执行的退避重启', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { spawnImpl, children } = fakeSpawn();
    const sup = make(spawnImpl);

    sup.start();
    children[0]!.emit('exit', 1); // 安排退避重启
    sup.stop();                  // 取消
    mock.timers.tick(10000);

    assert.equal(children.length, 1);
  } finally {
    mock.timers.reset();
  }
});
