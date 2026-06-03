// 最简用法示例:拉起 mihomo,把多个上游代理放进一个负载均衡组,
// 客户端只需把代理指向 http://127.0.0.1:7890。
//
// 运行前:设置 CLASH_BIN 指向你的 mihomo/clash 可执行文件。
//   PowerShell:  $env:CLASH_BIN = 'C:/tools/mihomo/mihomo.exe'; pnpm example
//   bash:        CLASH_BIN=/path/to/mihomo pnpm example

import { ClashBalancer } from '../src/index';

async function main(): Promise<void> {
  const binPath = process.env.CLASH_BIN;
  if (!binPath) {
    console.error('请先设置 CLASH_BIN 指向 mihomo/clash 二进制');
    process.exit(1);
  }

  const lb = new ClashBalancer({
    binPath,
    port: 7890,
    strategy: 'round-robin',
    proxies: [
      // 换成你自己的真实节点
      { name: 'hk-1', type: 'ss', server: '1.2.3.4', port: 8388, cipher: 'aes-256-gcm', password: '...' },
      { name: 'jp-1', type: 'trojan', server: '5.6.7.8', port: 443, password: '...' },
    ],
    // 也可以用订阅,交给 mihomo 的 proxy-providers 自行拉取/解析:
    // subscriptions: [{ name: 'sub-a', url: 'https://example.com/sub', interval: 3600 }],
    healthCheck: { enabled: true, interval: 60000, failuresToDrop: 3 },
  });

  lb.on('ready', () => console.log(`就绪:客户端把代理指向 http://127.0.0.1:${lb.port}`));
  lb.on('proxy:up', (name) => console.log('节点上线', name));
  lb.on('proxy:down', (name) => console.log('节点下线', name));
  lb.on('all:down', () => console.warn('所有节点失效!'));
  lb.on('clash:restart', (info) => console.warn('mihomo 重启', info));
  lb.on('clash:fatal', (err) => console.error('mihomo 无法恢复', err));
  lb.on('error', (err) => console.error('错误', err));

  await lb.start();

  // 每 10 秒打印一次各节点延迟
  setInterval(async () => {
    const s = await lb.stats();
    console.log('状态', JSON.stringify(s.proxies));
  }, 10000);

  // 优雅退出
  const shutdown = async (): Promise<void> => {
    console.log('\n正在关闭…');
    await lb.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
