import { EventEmitter } from 'node:events';

import type { DelayResponse, HealthCheckRuntime, ProxyNode, ProxyStatus } from './types';

/** HealthChecker 依赖的最小 controller 能力。 */
export interface DelayProbe {
  delay(name: string, opts: { url: string; timeout: number }): Promise<DelayResponse>;
}

export interface HealthCheckerOptions {
  controller: DelayProbe;
  proxies: ProxyNode[];
  healthCheck: HealthCheckRuntime;
}

interface NodeState {
  proxy: ProxyNode;
  alive: boolean;
  failures: number;
  delay: number | null;
}

/**
 * 主动健康检查:定时对每个静态节点测延迟,连续失败达阈值则永久剔除,
 * 恢复则重新纳入。存活集合变化时 emit('change', aliveProxies) 让上层重建+热重载。
 *
 * 事件:'up'(name) / 'down'(name) / 'change'(aliveProxies[]) / 'all:down' / 'error'(err)
 */
export class HealthChecker extends EventEmitter {
  readonly controller: DelayProbe;
  readonly healthCheck: HealthCheckRuntime;
  readonly nodes: Map<string, NodeState>;
  private _timer: NodeJS.Timeout | null;

  constructor({ controller, proxies, healthCheck }: HealthCheckerOptions) {
    super();
    this.controller = controller;
    this.healthCheck = healthCheck;
    this.nodes = new Map();
    for (const p of proxies) {
      this.nodes.set(p.name, { proxy: p, alive: true, failures: 0, delay: null });
    }
    this._timer = null;
  }

  /** 启动周期性健康检查。 */
  start(): void {
    if (this._timer) return;
    this._timer = setInterval(() => {
      this.tick().catch((err) => this.emit('error', err));
    }, this.healthCheck.interval);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  /** 停止健康检查。 */
  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /** 当前各节点状态(供 stats 使用)。 */
  status(): ProxyStatus[] {
    return [...this.nodes.values()].map((n) => ({
      name: n.proxy.name,
      alive: n.alive,
      delay: n.delay,
    }));
  }

  aliveProxies(): ProxyNode[] {
    return [...this.nodes.values()].filter((n) => n.alive).map((n) => n.proxy);
  }

  /** 执行一轮健康检查。 */
  async tick(): Promise<void> {
    const { url, timeout, failuresToDrop } = this.healthCheck;
    let changed = false;

    for (const node of this.nodes.values()) {
      try {
        const { delay } = await this.controller.delay(node.proxy.name, { url, timeout });
        node.delay = delay;
        node.failures = 0;
        if (!node.alive) {
          node.alive = true;
          changed = true;
          this.emit('up', node.proxy.name);
        }
      } catch {
        node.delay = null;
        node.failures += 1;
        if (node.alive && node.failures >= failuresToDrop) {
          node.alive = false;
          changed = true;
          this.emit('down', node.proxy.name);
        }
      }
    }

    if (changed) {
      const alive = this.aliveProxies();
      if (alive.length === 0) {
        this.emit('all:down');
      } else {
        this.emit('change', alive);
      }
    }
  }
}
