import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildConfig } from './config';
import { Controller } from './controller';
import { HealthChecker } from './health';
import { Supervisor } from './supervisor';
import { bundledBinPath, normalizeSubscriptions } from './util';
import type {
  BalancerStats,
  ClashBalancerOptions,
  FetchLike,
  ProxyNode,
  ResolvedHealthCheck,
  ResolvedRestart,
  SpawnLike,
  Strategy,
  Subscription,
} from './types';

const DEFAULT_HEALTH: ResolvedHealthCheck = {
  enabled: true,
  url: 'http://www.gstatic.com/generate_204',
  interval: 60000,
  timeout: 5000,
  failuresToDrop: 3,
};
const DEFAULT_RESTART: ResolvedRestart = { maxRetries: 5, backoffMs: 1000 };

/**
 * 通过编排 mihomo 实现自动代理负载均衡的主类。
 */
export class ClashBalancer extends EventEmitter {
  readonly binPath: string;
  readonly port: number;
  readonly controllerPort: number;
  readonly strategy: Strategy;
  proxies: ProxyNode[];
  subscriptions: Subscription[];
  readonly healthCheck: ResolvedHealthCheck;
  readonly maxFailedTimes: number;
  readonly excludeFilter?: string;
  readonly restart: ResolvedRestart;
  readonly secret: string;

  readonly readyPollMs: number;
  readonly readyTimeoutMs: number;

  readonly workDir: string;
  readonly configPath: string;

  controller!: Controller;
  supervisor!: Supervisor;
  health?: HealthChecker;

  private readonly _spawnImpl: SpawnLike;
  private readonly _fetchImpl: FetchLike;
  private readonly _ownWorkDir: boolean;
  private _startedAt?: number;

  constructor(opts: ClashBalancerOptions) {
    super();
    this.binPath = opts.binPath ?? bundledBinPath() ?? '';
    this.port = opts.port ?? 7890;
    this.controllerPort = opts.controllerPort ?? 9090;
    this.strategy = opts.strategy ?? 'round-robin';
    this.proxies = opts.proxies ?? [];
    this.subscriptions = normalizeSubscriptions(opts.subscription, opts.subscriptions);
    this.healthCheck = { ...DEFAULT_HEALTH, ...(opts.healthCheck ?? {}) };
    this.maxFailedTimes = opts.maxFailedTimes ?? 3;
    this.excludeFilter = opts.excludeFilter;
    this.restart = { ...DEFAULT_RESTART, ...(opts.restart ?? {}) };
    this.secret = opts.secret ?? crypto.randomBytes(16).toString('hex');

    this.readyPollMs = opts.readyPollMs ?? 200;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 10000;

    this._spawnImpl = opts.spawnImpl ?? (childProcess.spawn as unknown as SpawnLike);
    this._fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);

    this._ownWorkDir = !opts.workDir;
    this.workDir = opts.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'clash-balancer-'));
    this.configPath = path.join(this.workDir, 'config.yaml');
  }

  async start(): Promise<void> {
    if (!this.binPath) {
      throw new Error('未提供 binPath,且未找到库自带的 mihomo 二进制;请显式传入 binPath。');
    }
    if (!fs.existsSync(this.binPath)) {
      throw new Error(`binPath 不存在:${this.binPath}`);
    }

    this._writeConfig(this.proxies);

    this.controller = new Controller({
      controllerPort: this.controllerPort,
      secret: this.secret,
      fetchImpl: this._fetchImpl,
    });

    this.supervisor = new Supervisor({
      binPath: this.binPath,
      args: ['-d', this.workDir, '-f', this.configPath],
      restart: this.restart,
      spawnImpl: this._spawnImpl,
    });
    this.supervisor.on('restart', (info) => this.emit('clash:restart', info));
    this.supervisor.on('fatal', (err) => this.emit('clash:fatal', err));
    this.supervisor.start();

    await this._waitReady();

    this.health = this._makeHealth(this.proxies);
    if (this.healthCheck.enabled) this.health.start();

    this._startedAt = Date.now();
    this.emit('ready');
  }

  async stop(): Promise<void> {
    if (this.health) this.health.stop();
    if (this.supervisor) await this.supervisor.stop();
    this._cleanup();
  }

  /** 热更新代理/订阅列表:重写配置 + PUT /configs,不重启进程。 */
  async reload({ proxies, subscriptions }: { proxies?: ProxyNode[]; subscriptions?: Subscription[] } = {}): Promise<void> {
    if (proxies) this.proxies = proxies;
    if (subscriptions) this.subscriptions = subscriptions;

    this._writeConfig(this.proxies);
    await this.controller.reloadConfig(this.configPath);

    if (this.health) {
      this.health.stop();
      this.health = this._makeHealth(this.proxies);
      if (this.healthCheck.enabled) this.health.start();
    }
  }

  /** 当前运行状态:端口、运行时长、各节点存活与延迟。 */
  async stats(): Promise<BalancerStats> {
    return {
      port: this.port,
      uptime: this._startedAt ? Date.now() - this._startedAt : 0,
      proxies: this.health ? this.health.status() : [],
    };
  }

  private _makeHealth(proxies: ProxyNode[]): HealthChecker {
    const health = new HealthChecker({ controller: this.controller, proxies, healthCheck: this.healthCheck });
    health.on('up', (name) => this.emit('proxy:up', name));
    health.on('down', (name) => this.emit('proxy:down', name));
    health.on('all:down', () => this.emit('all:down'));
    health.on('error', (err) => this.emit('error', err));
    health.on('change', (alive) => this._onAliveChange(alive));
    return health;
  }

  /** 存活集合变化:重建配置(仅含存活节点)并热重载;失败保留旧配置。 */
  private async _onAliveChange(aliveProxies: ProxyNode[]): Promise<void> {
    try {
      this._writeConfig(aliveProxies);
      await this.controller.reloadConfig(this.configPath);
    } catch (err) {
      this.emit('error', err);
    }
  }

  private _writeConfig(proxies: ProxyNode[]): void {
    fs.mkdirSync(this.workDir, { recursive: true });
    if (this.subscriptions.length > 0) {
      fs.mkdirSync(path.join(this.workDir, 'providers'), { recursive: true });
    }
    const yamlStr = buildConfig({
      port: this.port,
      controllerPort: this.controllerPort,
      secret: this.secret,
      strategy: this.strategy,
      proxies,
      subscriptions: this.subscriptions,
      testUrl: this.healthCheck.url,
      testInterval: Math.max(1, Math.round(this.healthCheck.interval / 1000)),
      maxFailedTimes: this.maxFailedTimes,
      excludeFilter: this.excludeFilter,
    });
    fs.writeFileSync(this.configPath, yamlStr);
  }

  private async _waitReady(): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    for (;;) {
      try {
        await this.controller.version();
        return;
      } catch {
        if (Date.now() >= deadline) {
          const tail = this.supervisor.lastStderr();
          throw new Error(`mihomo 就绪超时(${this.readyTimeoutMs}ms)。stderr 末尾:\n${tail}`);
        }
        await new Promise((r) => setTimeout(r, this.readyPollMs));
      }
    }
  }

  private _cleanup(): void {
    try {
      if (this._ownWorkDir) {
        fs.rmSync(this.workDir, { recursive: true, force: true });
      } else {
        fs.rmSync(this.configPath, { force: true });
      }
    } catch {
      /* 清理失败忽略 */
    }
  }
}
