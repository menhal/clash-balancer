import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { buildConfig } from './config';
import { Controller } from './controller';
import { Supervisor } from './supervisor';
import { bundledBinPath, normalizeSubscriptions } from './util';
import type { FetchLike, ProxyNode, SpawnLike, Subscription } from './types';

/**
 * PinnedBalancer:与 ClashBalancer 并列的另一种调用方式 —— 为每个「存活节点」开一个
 * 专属本地端口,端口的出站固定走该节点。配合调用方「每端口最多一个并发请求」,
 * 即可保证 **每个出口 IP 同一时刻最多一个在途请求**(最大化规避按 IP/子网 的限流)。
 *
 * 两阶段编排:
 *  1) 发现:以 round-robin 起一遍 mihomo,等订阅解析 + 健康检查,读出存活节点(按延迟排序)。
 *  2) 钉定:为选中的 N 个节点各生成「一个 select 组 + 一个 mixed 监听端口」,重启 mihomo,
 *     再用 external-controller 把每个 `pin-{i}` 组 PUT-选定到对应节点。
 *
 * 另保留一个 round-robin 主端口(mixedPort),供少量非关键流量使用。
 *
 * @example
 * const pb = new PinnedBalancer({ binPath, subscriptions: [{ name:'sub', url, interval:86400, userAgent:'clash.meta' }] });
 * await pb.start();
 * pb.mixedPort;                 // round-robin 主端口
 * pb.pins;                      // [{ port, node }, ...] 每节点一个专属端口
 * await pb.stop();
 */
export interface PinnedBalancerOptions {
  /** mihomo / clash 可执行文件路径。不传则用库自带的 `bin/` 二进制。 */
  binPath?: string;
  /** 单订阅 URL 简写(等价于 subscriptions: [该 URL])。 */
  subscription?: string;
  /** 订阅列表。可混用 URL 字符串与完整对象;字符串自动补默认值。 */
  subscriptions?: Array<Subscription | string>;
  /** 静态节点列表。 */
  proxies?: ProxyNode[];
  /** 剔除名称匹配该正则的节点(机场"剩余流量/到期/官网"等信息节点)。 */
  excludeFilter?: string;
  /** 最多钉多少个节点(限制端口与资源,默认 24)。 */
  maxNodes?: number;
  /** 健康检查 URL(默认 gstatic generate_204)。 */
  healthUrl?: string;
  /** 健康检查间隔秒(默认 6)。 */
  healthIntervalSec?: number;
  /** 节点连续失败多少次判不可用(默认 3)。 */
  maxFailedTimes?: number;
  /** 发现阶段等待健康检查标活的时间 ms(默认 12000)。 */
  settleMs?: number;
  /** 单阶段就绪超时 ms(默认 20000)。 */
  readyTimeoutMs?: number;
  /** 工作目录(默认系统临时目录下自动创建)。 */
  workDir?: string;
  /** 注入 spawn(测试用)。 */
  spawnImpl?: SpawnLike;
  /** 注入 fetch(测试用)。 */
  fetchImpl?: FetchLike;
  /** 进度日志回调。 */
  log?: (msg: string) => void;
}

/** 一个钉定节点:本地端口 → 固定节点名。 */
export interface Pin {
  port: number;
  node: string;
}

interface ProxiesResp {
  proxies: Record<string, { alive?: boolean; history?: Array<{ delay?: number }>; type?: string }>;
}
interface ProvidersResp {
  providers: Record<string, { proxies?: Array<{ name: string }> }>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class PinnedBalancer extends EventEmitter {
  readonly binPath: string;
  readonly subscriptions: Subscription[];
  readonly proxies: ProxyNode[];
  readonly excludeFilter?: string;
  readonly maxNodes: number;
  readonly healthUrl: string;
  readonly healthIntervalSec: number;
  readonly maxFailedTimes: number;
  readonly settleMs: number;
  readonly readyTimeoutMs: number;
  readonly secret: string;
  readonly workDir: string;

  /** round-robin 主端口(非关键流量)。start() 后可用。 */
  mixedPort = 0;
  /** external-controller 端口(钉定阶段)。 */
  controllerPort = 0;
  /** 每个钉定节点:{ port, node }。 */
  pins: Pin[] = [];
  /** 钉定阶段的 controller(start() 后可用)。 */
  controller?: Controller;

  private readonly _spawnImpl: SpawnLike;
  private readonly _fetchImpl: FetchLike;
  private readonly _ownWorkDir: boolean;
  private readonly _log: (msg: string) => void;
  private _supervisor?: Supervisor;
  private _stopped = false;

  constructor(opts: PinnedBalancerOptions) {
    super();
    this.binPath = opts.binPath ?? bundledBinPath() ?? '';
    this.subscriptions = normalizeSubscriptions(opts.subscription, opts.subscriptions);
    this.proxies = opts.proxies ?? [];
    this.excludeFilter = opts.excludeFilter;
    this.maxNodes = opts.maxNodes ?? 24;
    this.healthUrl = opts.healthUrl ?? 'http://www.gstatic.com/generate_204';
    this.healthIntervalSec = opts.healthIntervalSec ?? 6;
    this.maxFailedTimes = opts.maxFailedTimes ?? 3;
    this.settleMs = opts.settleMs ?? 12000;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 20000;
    this.secret = crypto.randomBytes(16).toString('hex');
    this._spawnImpl = opts.spawnImpl ?? (childProcess.spawn as unknown as SpawnLike);
    this._fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);
    this._log = opts.log ?? (() => {});
    this._ownWorkDir = !opts.workDir;
    this.workDir = opts.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'clash-pinned-'));
  }

  /** 两阶段编排:发现存活节点 → 为每个节点钉一个专属端口。填充 mixedPort / pins。 */
  async start(): Promise<void> {
    if (!this.binPath) {
      throw new Error('未提供 binPath,且未找到库自带的 mihomo 二进制;请显式传入 binPath。');
    }
    if (!fs.existsSync(this.binPath)) {
      throw new Error(`binPath 不存在:${this.binPath}`);
    }
    if (this.subscriptions.length === 0 && this.proxies.length === 0) {
      throw new Error('PinnedBalancer: 至少需要一个 subscription 或 proxy');
    }
    fs.mkdirSync(path.join(this.workDir, 'providers'), { recursive: true });

    // ---- 阶段 1:发现存活节点 ----
    const ctrlPort1 = await this._freePort();
    const mixed1 = await this._freePort();
    this._writeConfig('discover.yaml', mixed1, ctrlPort1, []);
    this._log('启动 mihomo(发现节点)…');
    let sup = this._spawn('discover.yaml');
    let controller = new Controller({ controllerPort: ctrlPort1, secret: this.secret, fetchImpl: this._fetchImpl });
    if (!(await this._waitReady(controller))) {
      await this._stopSup(sup);
      this._cleanup();
      throw new Error(`mihomo 就绪超时(发现阶段,${this.readyTimeoutMs}ms)。stderr:\n${sup.lastStderr()}`);
    }

    const chosen = await this._discoverAliveNodes(controller);
    await this._stopSup(sup);
    if (chosen.length === 0) {
      this._cleanup();
      throw new Error('没有可用节点(订阅可能全部失效,或都被 excludeFilter 过滤)');
    }
    this._log(`存活可用节点已选用 ${chosen.length} 个(上限 ${this.maxNodes})。`);

    // ---- 阶段 2:每个节点一个专属端口 ----
    this.controllerPort = await this._freePort();
    this.mixedPort = await this._freePort();
    const pinPorts: number[] = [];
    for (let i = 0; i < chosen.length; i += 1) pinPorts.push(await this._freePort());

    this._writeConfig('pinned.yaml', this.mixedPort, this.controllerPort, pinPorts);
    this._log('启动 mihomo(pinned)…');
    sup = this._spawn('pinned.yaml');
    sup.on('restart', (info) => this.emit('clash:restart', info));
    sup.on('fatal', (err) => this.emit('clash:fatal', err));
    this._supervisor = sup;
    controller = new Controller({ controllerPort: this.controllerPort, secret: this.secret, fetchImpl: this._fetchImpl });
    this.controller = controller;
    if (!(await this._waitReady(controller))) {
      await this._stopSup(sup);
      this._cleanup();
      throw new Error(`mihomo 就绪超时(pinned 阶段,${this.readyTimeoutMs}ms)。stderr:\n${sup.lastStderr()}`);
    }
    await sleep(2500);

    // 把每个 pin-{i} select 组钉到对应节点
    for (let i = 0; i < chosen.length; i += 1) {
      try {
        await controller.select(`pin-${i}`, chosen[i]);
      } catch (err) {
        this._log(`pin-${i} 固定到 ${chosen[i]} 失败:${(err as Error).message}`);
      }
    }
    await sleep(1500);

    this.pins = chosen.map((node, i) => ({ port: pinPorts[i], node }));
    this.emit('ready');
  }

  /** 当前 pinned 阶段 mihomo 的 pid(供调用方在异常退出时兜底 taskkill)。 */
  get pid(): number | undefined {
    return (this._supervisor?.child as { pid?: number } | null)?.pid;
  }

  /** 优雅关闭并清理临时目录。 */
  async stop(): Promise<void> {
    if (this._stopped) return;
    this._stopped = true;
    if (this._supervisor) await this._stopSup(this._supervisor);
    this._cleanup();
  }

  // --- 内部 ---

  /** 停止一个 supervisor;Windows 下 SIGTERM 未必杀死,故补一刀 taskkill 防止 mihomo 残留。 */
  private async _stopSup(sup: Supervisor): Promise<void> {
    const pid = (sup.child as { pid?: number } | null)?.pid;
    try { await sup.stop(); } catch { /* ignore */ }
    if (pid && process.platform === 'win32') {
      try { childProcess.spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); } catch { /* ignore */ }
    }
  }

  private _spawn(cfgFile: string): Supervisor {
    const sup = new Supervisor({
      binPath: this.binPath,
      args: ['-d', this.workDir, '-f', path.join(this.workDir, cfgFile)],
      restart: { maxRetries: 5, backoffMs: 1000 },
      spawnImpl: this._spawnImpl,
    });
    sup.start();
    return sup;
  }

  private _writeConfig(file: string, mixedPort: number, controllerPort: number, pinPorts: number[]): void {
    const yamlStr = buildConfig({
      port: mixedPort,
      controllerPort,
      secret: this.secret,
      strategy: 'round-robin',
      proxies: this.proxies,
      subscriptions: this.subscriptions,
      testUrl: this.healthUrl,
      testInterval: this.healthIntervalSec,
      maxFailedTimes: this.maxFailedTimes,
      excludeFilter: this.excludeFilter,
      pins: pinPorts.map((port) => ({ port })),
    });
    fs.writeFileSync(path.join(this.workDir, file), yamlStr);
  }

  private async _waitReady(controller: Controller): Promise<boolean> {
    const deadline = Date.now() + this.readyTimeoutMs;
    for (;;) {
      try { await controller.version(); return true; }
      catch {
        if (Date.now() >= deadline) return false;
        await sleep(300);
      }
    }
  }

  /** 读出存活、非信息节点,按延迟升序,截取 maxNodes 个。 */
  private async _discoverAliveNodes(controller: Controller): Promise<string[]> {
    const excludeRe = this.excludeFilter ? new RegExp(this.excludeFilter) : null;

    // 收集候选节点名:订阅走 provider,静态走 proxies。
    let names: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      try {
        if (this.subscriptions.length > 0) {
          const pr = (await controller.providers()) as ProvidersResp;
          names = this.subscriptions.flatMap((s) => (pr.providers?.[s.name]?.proxies ?? []).map((p) => p.name));
        } else {
          names = this.proxies.map((p) => p.name);
        }
        if (names.length > (this.subscriptions.length > 0 ? 3 : 0)) break;
      } catch { /* retry */ }
      await sleep(1500);
    }
    await sleep(this.settleMs);

    const px = (await controller.proxies().catch(() => ({ proxies: {} }))) as ProxiesResp;
    const delayOf = (n: string): number => {
      const h = px.proxies?.[n]?.history;
      return Array.isArray(h) && h.length ? (h[h.length - 1].delay ?? 9999) : 9999;
    };
    const alive = names.filter((n) => {
      if (excludeRe && excludeRe.test(n)) return false;
      return px.proxies?.[n]?.alive;
    });
    alive.sort((a, b) => delayOf(a) - delayOf(b));
    return alive.slice(0, this.maxNodes);
  }

  private _freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        srv.close(() => resolve(port));
      });
    });
  }

  private _cleanup(): void {
    try {
      if (this._ownWorkDir) fs.rmSync(this.workDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
}
