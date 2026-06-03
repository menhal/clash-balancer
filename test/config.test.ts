import { test } from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';

import { buildConfig, type BuildConfigOptions } from '../src/config';

const baseOpts: BuildConfigOptions = {
  port: 7890,
  controllerPort: 9090,
  secret: 'test-secret',
  strategy: 'round-robin',
  proxies: [
    { name: 'hk-1', type: 'ss', server: '1.2.3.4', port: 8388, cipher: 'aes-256-gcm', password: 'p' },
  ],
  subscriptions: [],
  testUrl: 'http://www.gstatic.com/generate_204',
  testInterval: 300,
};

test('buildConfig 写入 mixed-port / external-controller / secret', () => {
  const cfg = yaml.load(buildConfig(baseOpts)) as any;

  assert.equal(cfg['mixed-port'], 7890);
  assert.equal(cfg['external-controller'], '127.0.0.1:9090');
  assert.equal(cfg.secret, 'test-secret');
});

test('buildConfig 把 proxies 放入 proxies 并建 load-balance 组,所有流量 MATCH 进组', () => {
  const cfg = yaml.load(buildConfig({
    ...baseOpts,
    proxies: [
      { name: 'hk-1', type: 'ss', server: '1.2.3.4', port: 8388, cipher: 'aes-256-gcm', password: 'p' },
      { name: 'jp-1', type: 'trojan', server: '5.6.7.8', port: 443, password: 'q' },
    ],
  })) as any;

  // 原始代理对象原样写入
  assert.equal(cfg.proxies.length, 2);
  assert.deepEqual(cfg.proxies[0], {
    name: 'hk-1', type: 'ss', server: '1.2.3.4', port: 8388, cipher: 'aes-256-gcm', password: 'p',
  });

  // 一个 load-balance 组,strategy=round-robin,含两个节点
  assert.equal(cfg['proxy-groups'].length, 1);
  const group = cfg['proxy-groups'][0];
  assert.equal(group.type, 'load-balance');
  assert.equal(group.strategy, 'round-robin');
  assert.deepEqual(group.proxies, ['hk-1', 'jp-1']);

  // 所有流量进该组
  assert.deepEqual(cfg.rules, [`MATCH,${group.name}`]);
});

test('load-balance 组带 url + interval(mihomo 自身 health-check 兜底)', () => {
  const cfg = yaml.load(buildConfig({
    ...baseOpts,
    testUrl: 'http://example.com/generate_204',
    testInterval: 120,
  })) as any;

  const group = cfg['proxy-groups'][0];
  assert.equal(group.url, 'http://example.com/generate_204');
  assert.equal(group.interval, 120);
});

test('subscriptions 生成 proxy-providers,组用 use: 引用', () => {
  const cfg = yaml.load(buildConfig({
    ...baseOpts,
    proxies: [],
    subscriptions: [
      { name: 'sub-a', url: 'https://example.com/sub', interval: 3600 },
    ],
  })) as any;

  const provider = cfg['proxy-providers']['sub-a'];
  assert.equal(provider.type, 'http');
  assert.equal(provider.url, 'https://example.com/sub');
  assert.equal(provider.interval, 3600);
  assert.ok(provider.path, 'provider 需要 path 落盘');
  assert.equal(provider['health-check'].enable, true);
  assert.equal(provider['health-check'].url, baseOpts.testUrl);

  // 组通过 use 引用 provider
  const group = cfg['proxy-groups'][0];
  assert.deepEqual(group.use, ['sub-a']);
});

test('subscription 的 userAgent / header 写入 proxy-provider 的 header(值为数组)', () => {
  const cfg = yaml.load(buildConfig({
    ...baseOpts,
    proxies: [],
    subscriptions: [
      { name: 'sub-a', url: 'https://example.com/sub', interval: 3600, userAgent: 'clash.meta', header: { 'X-Token': 'abc' } },
    ],
  })) as any;

  const provider = cfg['proxy-providers']['sub-a'];
  assert.deepEqual(provider.header['User-Agent'], ['clash.meta']);
  assert.deepEqual(provider.header['X-Token'], ['abc']);
});

test('不指定 userAgent / header 时 proxy-provider 不带 header 字段', () => {
  const cfg = yaml.load(buildConfig({
    ...baseOpts,
    proxies: [],
    subscriptions: [{ name: 'sub-a', url: 'https://example.com/sub', interval: 3600 }],
  })) as any;

  assert.equal(cfg['proxy-providers']['sub-a'].header, undefined);
});

test('load-balance 组带 lazy:false + max-failed-times(主动剔除死节点,round-robin 才可用)', () => {
  const cfg = yaml.load(buildConfig({ ...baseOpts, maxFailedTimes: 2 })) as any;
  const group = cfg['proxy-groups'][0];
  assert.equal(group.lazy, false);
  assert.equal(group['max-failed-times'], 2);
});

test('excludeFilter 写入组的 exclude-filter,不传则不带该字段', () => {
  const withFilter = yaml.load(buildConfig({ ...baseOpts, excludeFilter: '流量|到期' })) as any;
  assert.equal(withFilter['proxy-groups'][0]['exclude-filter'], '流量|到期');

  const without = yaml.load(buildConfig(baseOpts)) as any;
  assert.equal(without['proxy-groups'][0]['exclude-filter'], undefined);
});

test('pins 为每个端口生成 select 组(pin-i)+ mixed 监听,候选与 balance 同源', () => {
  const cfg = yaml.load(buildConfig({
    ...baseOpts,
    proxies: [],
    subscriptions: [{ name: 'sub', url: 'https://e.com/s', interval: 3600 }],
    pins: [{ port: 20001 }, { port: 20002 }],
  })) as any;

  const groups = cfg['proxy-groups'];
  const pin0 = groups.find((g: any) => g.name === 'pin-0');
  const pin1 = groups.find((g: any) => g.name === 'pin-1');
  assert.equal(pin0.type, 'select');
  assert.deepEqual(pin0.use, ['sub']); // 与 balance 同一候选源
  assert.equal(pin1.type, 'select');

  assert.equal(cfg.listeners.length, 2);
  assert.deepEqual(cfg.listeners[0], { name: 'lst-0', type: 'mixed', port: 20001, listen: '127.0.0.1', proxy: 'pin-0' });
  assert.equal(cfg.listeners[1].port, 20002);
  assert.equal(cfg.listeners[1].proxy, 'pin-1');
});

test('不传 pins 时不产生 listeners / pin 组', () => {
  const cfg = yaml.load(buildConfig(baseOpts)) as any;
  assert.equal(cfg.listeners, undefined);
  assert.equal(cfg['proxy-groups'].length, 1);
});

test('consistent-hashing 仍是 load-balance 组', () => {
  const cfg = yaml.load(buildConfig({ ...baseOpts, strategy: 'consistent-hashing' })) as any;
  const group = cfg['proxy-groups'][0];
  assert.equal(group.type, 'load-balance');
  assert.equal(group.strategy, 'consistent-hashing');
});

test('url-test 映射为 type: url-test,不带 strategy', () => {
  const cfg = yaml.load(buildConfig({ ...baseOpts, strategy: 'url-test' })) as any;
  const group = cfg['proxy-groups'][0];
  assert.equal(group.type, 'url-test');
  assert.equal(group.strategy, undefined);
});

test('proxies 与 subscriptions 同时为空时抛错(空组会让 mihomo 崩溃)', () => {
  assert.throws(
    () => buildConfig({ ...baseOpts, proxies: [], subscriptions: [] }),
    /至少|empty|node|节点/i,
  );
});
