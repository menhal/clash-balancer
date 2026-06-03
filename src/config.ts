import yaml from 'js-yaml';

import type { ProxyNode, Strategy, Subscription } from './types';

/**
 * buildConfig 的入参。
 */
export interface BuildConfigOptions {
  /** 客户端连接的混合端口。 */
  port: number;
  /** external-controller 端口。 */
  controllerPort: number;
  /** external-controller 鉴权 secret。 */
  secret: string;
  /** 负载均衡策略。 */
  strategy: Strategy;
  /** 静态节点列表。 */
  proxies?: ProxyNode[];
  /** 订阅列表。 */
  subscriptions?: Subscription[];
  /** mihomo 自身 health-check 的测试 URL。 */
  testUrl: string;
  /** mihomo 自身 health-check 的间隔(秒)。 */
  testInterval: number;
  /** 节点连续失败多少次后被 load-balance 组判为不可用(默认 3)。 */
  maxFailedTimes?: number;
  /** 过滤掉名称匹配该正则的节点(用于剔除机场的"剩余流量/官网/到期"等信息节点)。 */
  excludeFilter?: string;
  /**
   * Pinned 监听端口:为每个 pin 额外生成「一个 select 组 + 一个 mixed 监听端口」,
   * 端口的出站固定指向该 select 组。配合运行时把 select 组 PUT-选定到具体节点,
   * 即可让「每个端口钉死走一个固定节点」(每出口 IP 单线程的基础)。
   * 组名为 `pin-{i}`,故 PinnedBalancer 启动后按序 PUT-select。
   */
  pins?: PinSpec[];
}

/** 一个 pinned 监听:暴露一个本地端口,固定走名为 `pin-{index}` 的 select 组。 */
export interface PinSpec {
  /** 监听端口。 */
  port: number;
}

interface ProxyGroup {
  name: string;
  type: 'load-balance' | 'url-test' | 'select';
  strategy?: string;
  url?: string;
  interval?: number;
  lazy?: boolean;
  'max-failed-times'?: number;
  'exclude-filter'?: string;
  proxies?: string[];
  use?: string[];
}

interface ProxyProvider {
  type: 'http';
  url: string;
  interval: number;
  path: string;
  header?: Record<string, string[]>;
  'health-check': {
    enable: boolean;
    url: string;
    interval: number;
  };
}

interface Listener {
  name: string;
  type: 'mixed';
  port: number;
  listen: string;
  proxy: string;
}

interface ClashConfig {
  'mixed-port': number;
  'external-controller': string;
  secret: string;
  'proxy-groups': ProxyGroup[];
  rules: string[];
  proxies?: ProxyNode[];
  'proxy-providers'?: Record<string, ProxyProvider>;
  listeners?: Listener[];
}

const GROUP_NAME = 'balance';

/** 把 userAgent + 自定义 header 合并成 mihomo proxy-provider 的 header 结构(值为字符串数组)。 */
function buildProviderHeader(
  userAgent?: string,
  header?: Record<string, string | string[]>,
): Record<string, string[]> | undefined {
  const out: Record<string, string[]> = {};
  if (header) {
    for (const [k, v] of Object.entries(header)) {
      out[k] = Array.isArray(v) ? v : [v];
    }
  }
  if (userAgent) {
    out['User-Agent'] = [userAgent];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 生成 mihomo / Clash.Meta 的 YAML 配置字符串(纯函数)。
 */
export function buildConfig(opts: BuildConfigOptions): string {
  const proxies = opts.proxies ?? [];
  const subscriptions = opts.subscriptions ?? [];

  if (proxies.length === 0 && subscriptions.length === 0) {
    throw new Error('buildConfig: 至少需要一个 proxy 或 subscription(空组会让 mihomo 崩溃)');
  }

  // url-test 是独立 group 类型(始终走最快);其余按 load-balance + strategy 处理。
  const group: ProxyGroup = opts.strategy === 'url-test'
    ? { name: GROUP_NAME, type: 'url-test' }
    : { name: GROUP_NAME, type: 'load-balance', strategy: opts.strategy };
  group.url = opts.testUrl;
  group.interval = opts.testInterval;
  // 主动健康检查(不等流量):load-balance 的 round-robin 只在存活节点间轮询,
  // lazy:false 让 mihomo 启动后立即逐一探测,把死节点/机场信息节点先标记掉,
  // 否则首批连接会轮询到尚未探测的不可用节点而失败。
  group.lazy = false;
  group['max-failed-times'] = opts.maxFailedTimes ?? 3;
  if (opts.excludeFilter) group['exclude-filter'] = opts.excludeFilter;
  if (proxies.length > 0) {
    group.proxies = proxies.map((p) => p.name);
  }
  if (subscriptions.length > 0) {
    group.use = subscriptions.map((s) => s.name);
  }

  const config: ClashConfig = {
    'mixed-port': opts.port,
    'external-controller': `127.0.0.1:${opts.controllerPort}`,
    secret: opts.secret,
    'proxy-groups': [group],
    rules: [`MATCH,${GROUP_NAME}`],
  };

  if (proxies.length > 0) {
    config.proxies = proxies;
  }

  if (subscriptions.length > 0) {
    const providers: Record<string, ProxyProvider> = {};
    for (const sub of subscriptions) {
      const provider: ProxyProvider = {
        type: 'http',
        url: sub.url,
        interval: sub.interval,
        path: `./providers/${sub.name}.yaml`,
        'health-check': {
          enable: true,
          url: opts.testUrl,
          interval: opts.testInterval,
        },
      };
      const header = buildProviderHeader(sub.userAgent, sub.header);
      if (header) provider.header = header;
      providers[sub.name] = provider;
    }
    config['proxy-providers'] = providers;
  }

  // Pinned 监听:每个 pin 一个 select 组(`pin-{i}`,候选与 balance 组相同)+ 一个 mixed 端口。
  // 运行时把每个 pin-{i} PUT-选定到一个具体节点,该端口即钉死走那个节点。
  if (opts.pins && opts.pins.length > 0) {
    const listeners: Listener[] = [];
    opts.pins.forEach((pin, i) => {
      const pinGroup: ProxyGroup = { name: `pin-${i}`, type: 'select' };
      if (proxies.length > 0) pinGroup.proxies = proxies.map((p) => p.name);
      if (subscriptions.length > 0) pinGroup.use = subscriptions.map((s) => s.name);
      config['proxy-groups'].push(pinGroup);
      listeners.push({ name: `lst-${i}`, type: 'mixed', port: pin.port, listen: '127.0.0.1', proxy: `pin-${i}` });
    });
    config.listeners = listeners;
  }

  return yaml.dump(config);
}
