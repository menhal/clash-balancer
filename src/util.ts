import fs from 'node:fs';
import path from 'node:path';

import type { Subscription } from './types';

/**
 * 解析库自带的 mihomo 可执行文件路径(打包在 `bin/` 下)。
 * 让调用方无需关心二进制位置:不传 binPath 时默认用这个。
 * 找不到(如未随包分发)则返回 undefined,由调用方报错或显式指定。
 */
export function bundledBinPath(): string | undefined {
  // dist/ 运行时:__dirname = .../dist,二进制在 .../bin
  const binDir = path.join(__dirname, '..', 'bin');
  const candidates =
    process.platform === 'win32'
      ? ['mihomo-windows-amd64-compatible.exe', 'mihomo.exe']
      : process.platform === 'darwin'
        ? ['mihomo-darwin-amd64', 'mihomo']
        : ['mihomo-linux-amd64-compatible', 'mihomo-linux-amd64', 'mihomo'];
  for (const name of candidates) {
    const p = path.join(binDir, name);
    if (fs.existsSync(p)) return p;
  }
  // 兜底:bin/ 下任意 mihomo* 文件
  try {
    const found = fs.readdirSync(binDir).find((f) => /mihomo/i.test(f));
    if (found) return path.join(binDir, found);
  } catch { /* 无 bin 目录 */ }
  return undefined;
}

/**
 * 把订阅入参归一化为 Subscription[]:
 * - `subscription: 'https://...'`(单 URL 简写)
 * - `subscriptions: ['url1', { name, url, ... }]`(URL 字符串与完整对象混用)
 * 字符串项自动补默认值(name 自动编号、interval=86400、userAgent='clash.meta')。
 */
export function normalizeSubscriptions(
  subscription?: string,
  subscriptions?: Array<Subscription | string>,
): Subscription[] {
  const list: Array<Subscription | string> = [];
  if (subscription) list.push(subscription);
  if (subscriptions) list.push(...subscriptions);

  return list.map((s, i) => {
    const name = list.length === 1 ? 'sub' : `sub${i}`;
    if (typeof s === 'string') {
      return { name, url: s, interval: 86400, userAgent: 'clash.meta' };
    }
    // 完整对象:保留其余字段,补默认 interval / userAgent
    return { ...s, interval: s.interval ?? 86400, userAgent: s.userAgent ?? 'clash.meta' };
  });
}
