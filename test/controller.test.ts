import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Controller } from '../src/controller';
import type { FetchLike, MinimalResponse } from '../src/types';

interface MockResult {
  ok?: boolean;
  status?: number;
  body?: unknown;
}

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/**
 * 造一个记录调用的 mock fetch。
 * @param handler 返回 { ok, status, body }
 */
function mockFetch(handler: (url: string, init: RequestInit) => MockResult | void) {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, init = {}) => {
    calls.push({ url, init });
    const res = handler(url, init) ?? {};
    const { ok = true, status = 200, body = {} } = res;
    const response: MinimalResponse = {
      ok,
      status,
      async json() { return body; },
      async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
    };
    return response;
  };
  return { fetchImpl, calls };
}

function makeController(fetchImpl: FetchLike): Controller {
  return new Controller({ controllerPort: 9090, secret: 's3cr3t', fetchImpl });
}

test('version() GET /version,带 Bearer 鉴权,返回 JSON', async () => {
  const { fetchImpl, calls } = mockFetch(() => ({ body: { version: '1.18.0' } }));
  const ctrl = makeController(fetchImpl);

  const out = await ctrl.version();

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'http://127.0.0.1:9090/version');
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, 'Bearer s3cr3t');
  assert.deepEqual(out, { version: '1.18.0' });
});

test('proxies() GET /proxies,返回 proxies map', async () => {
  const body = { proxies: { 'hk-1': { name: 'hk-1', type: 'Shadowsocks' } } };
  const { fetchImpl, calls } = mockFetch(() => ({ body }));
  const ctrl = makeController(fetchImpl);

  const out = await ctrl.proxies();

  assert.equal(calls[0]!.url, 'http://127.0.0.1:9090/proxies');
  assert.deepEqual(out, body);
});

test('providers() GET /providers/proxies,返回 providers map', async () => {
  const body = { providers: { boost: { name: 'boost', vehicleType: 'HTTP', proxies: [] } } };
  const { fetchImpl, calls } = mockFetch(() => ({ body }));
  const ctrl = makeController(fetchImpl);

  const out = await ctrl.providers();

  assert.equal(calls[0]!.url, 'http://127.0.0.1:9090/providers/proxies');
  assert.deepEqual(out, body);
});

test('delay() GET /proxies/{name}/delay?url=&timeout=,参数做 URL 编码', async () => {
  const { fetchImpl, calls } = mockFetch(() => ({ body: { delay: 123 } }));
  const ctrl = makeController(fetchImpl);

  const out = await ctrl.delay('香港 1', { url: 'http://a.com/generate_204', timeout: 5000 });

  const u = new URL(calls[0]!.url);
  assert.equal(u.pathname, `/proxies/${encodeURIComponent('香港 1')}/delay`);
  assert.equal(u.searchParams.get('url'), 'http://a.com/generate_204');
  assert.equal(u.searchParams.get('timeout'), '5000');
  assert.deepEqual(out, { delay: 123 });
});

test('reloadConfig() PUT /configs?force=true,body 带 path', async () => {
  const { fetchImpl, calls } = mockFetch(() => ({ status: 204 }));
  const ctrl = makeController(fetchImpl);

  await ctrl.reloadConfig('C:/tmp/clash/config.yaml');

  const { url, init } = calls[0]!;
  const u = new URL(url);
  const headers = init.headers as Record<string, string>;
  assert.equal(u.pathname, '/configs');
  assert.equal(u.searchParams.get('force'), 'true');
  assert.equal(init.method, 'PUT');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers.Authorization, 'Bearer s3cr3t');
  assert.deepEqual(JSON.parse(init.body as string), { path: 'C:/tmp/clash/config.yaml' });
});

test('响应非 2xx 时抛错,错误含状态码与响应体', async () => {
  const { fetchImpl } = mockFetch(() => ({ ok: false, status: 401, body: 'unauthorized' }));
  const ctrl = makeController(fetchImpl);

  await assert.rejects(() => ctrl.version(), /401/);
});

test('reloadConfig 非 2xx 时抛错(供上层捕获回滚)', async () => {
  const { fetchImpl } = mockFetch(() => ({ ok: false, status: 400, body: 'bad config' }));
  const ctrl = makeController(fetchImpl);

  await assert.rejects(() => ctrl.reloadConfig('/x.yaml'), /400/);
});
