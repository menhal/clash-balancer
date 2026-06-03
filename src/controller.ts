import type {
  DelayResponse,
  FetchLike,
  MinimalResponse,
  VersionResponse,
} from './types';

export interface ControllerOptions {
  controllerPort: number;
  secret: string;
  fetchImpl?: FetchLike;
}

/**
 * mihomo external-controller REST API 的薄封装。
 * fetch 可注入以便测试。
 */
export class Controller {
  readonly base: string;
  readonly secret: string;
  readonly fetch: FetchLike;

  constructor({ controllerPort, secret, fetchImpl }: ControllerOptions) {
    this.base = `http://127.0.0.1:${controllerPort}`;
    this.secret = secret;
    this.fetch = fetchImpl ?? (fetch as FetchLike);
  }

  private get _headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.secret}` };
  }

  /** 发请求并在非 2xx 时抛出含状态码 + 响应体的错误。 */
  private async _request(path: string, init: RequestInit = {}): Promise<MinimalResponse> {
    const res = await this.fetch(`${this.base}${path}`, {
      ...init,
      headers: { ...this._headers, ...(init.headers as Record<string, string> | undefined) },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`mihomo controller ${path} 返回 ${res.status}: ${detail}`);
    }
    return res;
  }

  async version(): Promise<VersionResponse> {
    return (await this._request('/version')).json() as Promise<VersionResponse>;
  }

  async proxies(): Promise<unknown> {
    return (await this._request('/proxies')).json();
  }

  /** GET /providers/proxies:列出各 proxy-provider(订阅)及其解析出的节点。 */
  async providers(): Promise<unknown> {
    return (await this._request('/providers/proxies')).json();
  }

  async delay(name: string, { url, timeout }: { url: string; timeout: number }): Promise<DelayResponse> {
    const qs = new URLSearchParams({ url, timeout: String(timeout) });
    const path = `/proxies/${encodeURIComponent(name)}/delay?${qs}`;
    return (await this._request(path)).json() as Promise<DelayResponse>;
  }

  /** PUT /proxies/{group}:把一个 selector 组选定到指定节点(用于 pinned 端口钉节点)。 */
  async select(group: string, name: string): Promise<MinimalResponse> {
    return this._request(`/proxies/${encodeURIComponent(group)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  }

  async reloadConfig(path: string): Promise<MinimalResponse> {
    return this._request('/configs?force=true', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
  }
}
