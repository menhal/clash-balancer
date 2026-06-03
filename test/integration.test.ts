import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ClashBalancer } from '../src/balancer';

const CLASH_BIN = process.env.CLASH_BIN;
const skip: boolean | string = CLASH_BIN ? false : '需要环境变量 CLASH_BIN 指向真实 mihomo/clash 二进制';

// 真实拉起 mihomo 的端到端冒烟:start → ready → version → stats → stop。
// 用不可达的占位节点即可让 mihomo 正常启动(关闭主动健康检查,避免等待失败节点)。
test('集成冒烟:真实 mihomo start → ready → stats → stop', { skip }, async () => {
  const lb = new ClashBalancer({
    binPath: CLASH_BIN!,
    port: 17890,
    controllerPort: 19090,
    proxies: [
      { name: 'dummy', type: 'ss', server: '127.0.0.1', port: 18388, cipher: 'aes-256-gcm', password: 'x' },
    ],
    healthCheck: { enabled: false },
    readyTimeoutMs: 8000,
  });

  let ready = false;
  lb.on('ready', () => { ready = true; });

  try {
    await lb.start();
    assert.ok(ready, '应当 emit ready');

    const v = await lb.controller.version();
    assert.ok(v.version, 'controller 应返回版本号');

    const s = await lb.stats();
    assert.equal(s.port, 17890);
    assert.equal(s.proxies.length, 1);
  } finally {
    await lb.stop();
  }
});
