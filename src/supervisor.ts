import { EventEmitter } from 'node:events';
import { spawn as defaultSpawn } from 'node:child_process';

import type { ChildLike, ResolvedRestart, SpawnLike } from './types';

export interface SupervisorOptions {
  binPath: string;
  args: string[];
  restart: ResolvedRestart;
  spawnImpl?: SpawnLike;
}

/**
 * mihomo 进程生命周期管理:拉起、捕获 stdout/stderr、崩溃指数退避重启、
 * 超过 maxRetries 触发 fatal、优雅关闭。spawn 可注入以便测试。
 *
 * 事件:'stdout'(str) / 'stderr'(str) / 'restart'(info) / 'fatal'(err) / 'exit'(code,signal)
 */
export class Supervisor extends EventEmitter {
  readonly binPath: string;
  readonly args: string[];
  readonly restart: ResolvedRestart;
  readonly spawn: SpawnLike;
  child: ChildLike | null;
  private _stderr: string;
  private _retries: number;
  private _stopping: boolean;
  private _restartTimer: NodeJS.Timeout | null;

  constructor({ binPath, args, restart, spawnImpl }: SupervisorOptions) {
    super();
    this.binPath = binPath;
    this.args = args;
    this.restart = restart;
    this.spawn = spawnImpl ?? (defaultSpawn as unknown as SpawnLike);
    this.child = null;
    this._stderr = '';
    this._retries = 0;
    this._stopping = false;
    this._restartTimer = null;
  }

  /** mihomo stderr 的末尾内容(用于就绪超时等场景的报错诊断)。 */
  lastStderr(): string {
    return this._stderr;
  }

  start(): ChildLike {
    const child = this.spawn(this.binPath, this.args);
    this.child = child;

    child.stdout.on('data', (chunk) => this.emit('stdout', chunk.toString()));
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      this._stderr = (this._stderr + text).slice(-4000);
      this.emit('stderr', text);
    });
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => this._onExit(code, signal));

    return child;
  }

  /** 优雅关闭:不再重启,SIGTERM 结束进程;resolve 于进程退出。 */
  stop(): Promise<void> {
    this._stopping = true;
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    const child = this.child;
    if (!child || child.killed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
    });
  }

  private _onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit('exit', code, signal);
    if (this._stopping) return; // 主动停止,不重启

    this._retries += 1;
    if (this._retries > this.restart.maxRetries) {
      this.emit('fatal', new Error(
        `mihomo 连续崩溃超过 maxRetries=${this.restart.maxRetries},放弃重启。最后退出 code=${code} signal=${signal}`,
      ));
      return;
    }

    const delayMs = this.restart.backoffMs * (2 ** (this._retries - 1));
    this.emit('restart', { attempt: this._retries, delayMs, code, signal });
    this._restartTimer = setTimeout(() => this.start(), delayMs);
  }
}
