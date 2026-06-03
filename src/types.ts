/**
 * 全局共享类型定义。
 */

/** 负载均衡策略。mihomo 的 `load-balance` 组支持 round-robin / consistent-hashing 等;
 *  `url-test` 为独立组类型(始终走最快)。允许任意字符串以兼容未来策略。 */
export type Strategy =
  | 'round-robin'
  | 'consistent-hashing'
  | 'sticky-sessions'
  | 'url-test'
  | (string & {});

/**
 * 一个上游代理节点。除约定字段外,其余字段(cipher、password、sni……)
 * 原样写入 mihomo 配置,因此用索引签名兜底。
 */
export interface ProxyNode {
  name: string;
  type: string;
  server?: string;
  port?: number;
  [key: string]: unknown;
}

/** 订阅(mihomo proxy-provider)。 */
export interface Subscription {
  name: string;
  url: string;
  interval: number;
  /**
   * 拉取订阅时使用的 User-Agent。很多机场会按 UA 返回不同内容
   * (例如 "clash.meta" 返回完整 Clash 节点列表,默认 UA 可能只回退到单节点),
   * 需要时显式指定。等价于在 proxy-provider 上设置 header['User-Agent']。
   */
  userAgent?: string;
  /** 拉取订阅时附带的自定义请求头(会与 userAgent 合并)。 */
  header?: Record<string, string | string[]>;
}

/** 主动健康检查选项(用户可传部分字段)。 */
export interface HealthCheckOptions {
  enabled?: boolean;
  url?: string;
  interval?: number;
  timeout?: number;
  failuresToDrop?: number;
}

/** 合并默认值后的健康检查配置。 */
export interface ResolvedHealthCheck {
  enabled: boolean;
  url: string;
  interval: number;
  timeout: number;
  failuresToDrop: number;
}

/** HealthChecker 真正用到的运行期字段子集。 */
export interface HealthCheckRuntime {
  url: string;
  interval: number;
  timeout: number;
  failuresToDrop: number;
}

/** 进程崩溃重启选项。 */
export interface RestartOptions {
  maxRetries?: number;
  backoffMs?: number;
}

/** 合并默认值后的重启配置。 */
export interface ResolvedRestart {
  maxRetries: number;
  backoffMs: number;
}

/**
 * 最小化的 fetch 抽象:真实 `fetch` 与测试 mock 都满足该签名。
 */
export interface MinimalResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<MinimalResponse>;

/** 子进程的可读流(只关心 'data' 事件)。 */
export interface DataStream {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
}

/**
 * 最小化的子进程抽象:真实 `child_process.spawn` 的返回值与测试 fake 都满足。
 */
export interface ChildLike {
  stdout: DataStream;
  stderr: DataStream;
  killed: boolean;
  kill(signal?: NodeJS.Signals | number): boolean | void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  emit(event: string, ...args: any[]): boolean;
}

export type SpawnLike = (command: string, args: readonly string[]) => ChildLike;

/** controller `/version` 响应。 */
export interface VersionResponse {
  version: string;
  meta?: boolean;
  [key: string]: unknown;
}

/** controller `/proxies/{name}/delay` 响应。 */
export interface DelayResponse {
  delay: number;
}

/** ClashBalancer 构造选项。 */
export interface ClashBalancerOptions {
  /** mihomo / clash 可执行文件路径。不传则用库自带的 `bin/` 二进制。 */
  binPath?: string;
  /** 客户端连接的固定混合端口,默认 7890。 */
  port?: number;
  /** external-controller 端口,默认 9090。 */
  controllerPort?: number;
  /** 负载均衡策略,默认 'round-robin'。 */
  strategy?: Strategy;
  /** 静态节点列表。 */
  proxies?: ProxyNode[];
  /** 单订阅 URL 简写(等价于 subscriptions: [该 URL])。 */
  subscription?: string;
  /** 订阅列表。可混用 URL 字符串与完整对象;字符串自动补默认值。 */
  subscriptions?: Array<Subscription | string>;
  /** 健康检查配置。 */
  healthCheck?: HealthCheckOptions;
  /**
   * 节点连续失败多少次后被 load-balance 组判为不可用(默认 3)。
   * 配合内部的 lazy:false 主动探测,让 round-robin 只在存活节点间轮询。
   */
  maxFailedTimes?: number;
  /**
   * 过滤掉名称匹配该正则的节点,用于剔除机场常见的"剩余流量/到期/官网"等
   * 非代理信息节点 —— 它们无法转发流量,会让 round-robin 轮到时连接失败。
   */
  excludeFilter?: string;
  /** 崩溃重启配置。 */
  restart?: RestartOptions;
  /** external-controller 鉴权 secret,默认随机生成。 */
  secret?: string;
  /** 就绪轮询间隔(ms),默认 200。 */
  readyPollMs?: number;
  /** 就绪超时(ms),默认 10000。 */
  readyTimeoutMs?: number;
  /** 运行时工作目录,默认在系统临时目录创建。 */
  workDir?: string;
  /** 注入的 spawn 实现(测试用)。 */
  spawnImpl?: SpawnLike;
  /** 注入的 fetch 实现(测试用)。 */
  fetchImpl?: FetchLike;
}

/** stats() 返回结构。 */
export interface BalancerStats {
  port: number;
  uptime: number;
  proxies: ProxyStatus[];
}

/** 单个节点状态。 */
export interface ProxyStatus {
  name: string;
  alive: boolean;
  delay: number | null;
}
