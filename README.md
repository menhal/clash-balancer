# clash-balancer

通过编排 [mihomo / Clash.Meta](https://github.com/MetaCubeX/mihomo) 实现**代理负载均衡**的 Node.js 库
(TypeScript 编写,打包后同时提供 CommonJS / ESM 与类型声明)。

```
客户端 ──► http://127.0.0.1:<port> ──► mihomo ──► { 节点A, 节点B, 节点C … } 轮询/分发
                                         ▲
                          本库:生成配置 · 拉起并监督进程 · 健康检查 · 自动热重载
```

本库**不自己实现负载均衡算法**(交给 mihomo 的 `load-balance` proxy-group),而是负责把
「一组上游代理 / 订阅」编排成「一个或多个本地端口」,并管理 mihomo 进程的生命周期。

提供两种调用方式:

| 类 | 暴露 | 适用 |
|---|---|---|
| **`ClashBalancer`** | 一个固定本地端口,流量按策略(round-robin / url-test…)分发到多个节点 | 通用代理池:一个端口,多节点自动负载均衡 |
| **`PinnedBalancer`** | 每个存活节点一个**专属端口** + 一个 round-robin 主端口 | 高并发抓取:让**每个出口 IP 同一时刻最多 1 个在途请求**,最大化规避按 IP/子网 的 429 限流 |

---

## 前置条件

- **Node.js ≥ 18**(需内置 `fetch`)。
- **一个 mihomo / Clash.Meta 可执行文件**。两种提供方式:
  - 放到本包的 `bin/` 目录下(如 `bin/mihomo-windows-amd64-compatible.exe`),库会**自动发现**,调用时无需传 `binPath`;
  - 或调用时通过 `binPath` 显式指定路径。
  > `bin/` 默认不随仓库/npm 分发,请自行下载对应平台的二进制放入,或用 `binPath`。

## 安装

```bash
pnpm install   # 或 npm install / yarn
```

```ts
// ESM / TypeScript
import { ClashBalancer, PinnedBalancer } from 'clash-balancer';
// CommonJS
const { ClashBalancer, PinnedBalancer } = require('clash-balancer');
```

---

## 快速开始

最简用法:**不必提供 binPath**(用 `bin/` 下的二进制),订阅**直接给 URL 字符串**。

```ts
const lb = new ClashBalancer({ subscription: 'https://example.com/sub' });

await lb.start();
console.log(`就绪,把代理指向 http://127.0.0.1:${lb.port}`);  // 默认 7890

// 客户端示例(任何支持 HTTP 代理的工具都可):
//   curl -x http://127.0.0.1:7890 https://ipinfo.io/ip

await lb.stop();
```

---

## ClashBalancer

把一组节点/订阅聚合成**一个**本地端口,按策略分发。

### 构造选项

```ts
new ClashBalancer({
  binPath,            // string?  mihomo 路径。省略则用 bin/ 下自带的二进制
  port,               // number?  客户端连接的混合端口(HTTP+SOCKS),默认 7890
  controllerPort,     // number?  external-controller 端口,默认 9090
  strategy,           // 'round-robin'(默认) | 'consistent-hashing' | 'sticky-sessions' | 'url-test'
  proxies,            // ProxyNode[]?  静态节点(Clash 原生格式)
  subscription,       // string?       单订阅 URL 简写
  subscriptions,      // (string | Subscription)[]?  订阅列表(字符串/对象混用)
  excludeFilter,      // string?  剔除名称匹配该正则的节点(机场信息节点)
  maxFailedTimes,     // number?  节点连续失败多少次判不可用,默认 3
  healthCheck: {      // 主动健康检查(JS 层,周期性测各静态节点延迟)
    enabled,          // boolean?  默认 true
    url,              // string?   默认 http://www.gstatic.com/generate_204
    interval,         // number?   ms,默认 60000
    timeout,          // number?   ms,默认 5000
    failuresToDrop,   // number?   连续失败几次永久剔除,默认 3
  },
  restart: { maxRetries, backoffMs },  // 进程崩溃重启:默认 5 次、退避 1000ms 起
  secret,             // string?  external-controller 鉴权,默认随机
  readyTimeoutMs,     // number?  就绪超时,默认 10000
  workDir,            // string?  运行时工作目录,默认系统临时目录
});
```

> `binPath`、`subscription`、`subscriptions` 不传时分别回退到:自带二进制、空、空。
> 至少需要一个 `proxies` 或订阅,否则 `start()` 会抛错(mihomo 不接受空组)。

### 方法

```ts
await lb.start();                                   // 生成配置 → 拉起 mihomo → 轮询就绪 → 启动健康循环
await lb.reload({ proxies?, subscriptions? });      // 热更新节点列表(PUT /configs,不重启进程)
const s = await lb.stats();                         // { port, uptime, proxies: [{ name, alive, delay }] }
await lb.stop();                                    // 停健康循环 → 优雅关闭 mihomo → 清理临时配置
```

### 事件(继承 `EventEmitter`)

```ts
lb.on('ready',        () => {});       // 就绪
lb.on('proxy:up',     (name) => {});   // 节点恢复
lb.on('proxy:down',   (name) => {});   // 节点被剔除
lb.on('all:down',     () => {});       // 所有节点失效(保留旧配置继续尝试)
lb.on('clash:restart',(info) => {});   // mihomo 崩溃后退避重启
lb.on('clash:fatal',  (err) => {});    // 超过 maxRetries,放弃
lb.on('error',        (err) => {});
```

### 示例

```ts
// 静态节点 + 订阅,round-robin,剔除机场信息节点
const lb = new ClashBalancer({
  strategy: 'round-robin',
  proxies: [
    { name: 'hk-1', type: 'ss', server: '1.2.3.4', port: 8388, cipher: 'aes-256-gcm', password: '...' },
  ],
  subscriptions: ['https://example.com/sub'],
  excludeFilter: '剩余流量|到期|官网|过期',
  healthCheck: { interval: 30000, failuresToDrop: 3 },
});

lb.on('ready', () => console.log('客户端 → http://127.0.0.1:' + lb.port));
lb.on('proxy:down', (n) => console.warn('下线', n));
await lb.start();

// 运行中热更新节点
await lb.reload({ subscriptions: ['https://example.com/sub2'] });

// 查看各节点延迟
console.log(await lb.stats());
```

---

## PinnedBalancer:每个出口 IP 单线程

当你**高并发抓取**又怕**单个出口 IP 触发限流(HTTP 429)**时:`ClashBalancer` 的 round-robin 是
「按 TCP 连接」轮换的,连接复用 / 节点数有限时,多个并发请求仍可能挤在同一个出口 IP 上。

`PinnedBalancer` 为**每个存活节点**单独开一个本地端口,端口的出站**固定走那个节点**。只要调用方
保证「每个端口最多一个并发请求」(worker-per-port),就能让**每个出口 IP 同一时刻最多一个在途请求**。

它内部两阶段编排:① 以 round-robin 起一遍、等订阅解析 + 健康检查、读出存活节点(按延迟排序);
② 为选中的 N 个节点各建「一个 `select` 组 + 一个 `mixed` 监听端口」,重启 mihomo 后用
external-controller 把每个组**钉定**到对应节点。

### 构造选项

```ts
new PinnedBalancer({
  binPath,            // string?  省略则用 bin/ 下自带的二进制
  subscription,       // string?  单订阅 URL 简写
  subscriptions,      // (string | Subscription)[]?
  proxies,            // ProxyNode[]?  静态节点
  excludeFilter,      // string?  剔除信息节点(强烈建议机场场景设置)
  maxNodes,           // number?  最多钉多少个节点(=并发上限/端口数),默认 24
  healthUrl,          // string?  健康检查 URL,默认 gstatic generate_204
  healthIntervalSec,  // number?  健康检查间隔秒,默认 6
  maxFailedTimes,     // number?  默认 3
  settleMs,           // number?  发现阶段等待健康检查标活的时间,默认 12000
  readyTimeoutMs,     // number?  单阶段就绪超时,默认 20000
  workDir,            // string?
  log,                // (msg: string) => void   进度日志回调
});
```

### 属性与方法

```ts
await pb.start();      // 两阶段编排,完成后填充下列属性
pb.pins;               // { port: number; node: string }[]  —— 每个出口 IP 一个专属端口
pb.mixedPort;          // number  round-robin 主端口(供详情页/封面等少量非关键流量)
pb.controllerPort;     // number  external-controller 端口
pb.pid;                // number? 当前 mihomo 进程 pid(用于调用方异常退出时兜底清理)
pb.controller;         // Controller  可直接调 REST API
await pb.stop();       // 优雅关闭 + 清理(Windows 下含 taskkill 兜底)

pb.on('clash:restart', (info) => {});
pb.on('clash:fatal',   (err) => {});
```

### 消费 pins:worker-per-port

每个 worker 绑定一个 `pin.port`、内部串行处理任务,即可做到「每出口 IP 单线程」。
用 **undici 的 `ProxyAgent`** 把请求定向到某个端口:

```ts
import { ProxyAgent, fetch as undiciFetch } from 'undici';

const pb = new PinnedBalancer({ subscription: 'https://example.com/sub', maxNodes: 16, excludeFilter: '剩余流量|到期|官网' });
await pb.start();

const queue = [...tasks];                 // 待抓取任务
await Promise.all(pb.pins.map(async (pin) => {
  const dispatcher = new ProxyAgent(`http://127.0.0.1:${pin.port}`);  // 钉定到该节点
  for (let t; (t = queue.shift()); ) {     // 该 worker 串行 → 该节点同时仅 1 请求
    const res = await undiciFetch(t.url, { dispatcher });
    // …处理 res…
  }
  await dispatcher.close();
}));

await pb.stop();
```

> ⚠️ **同源坑**:传给 `fetch` 的 `dispatcher` 必须与该 `fetch` 出自**同一个 undici**。
> 用 Node 内置全局 `fetch` 搭配本包安装的 `ProxyAgent` 会报 `invalid onRequestStart method`。
> 解决:统一用 `undici` 包导出的 `fetch`(如上),或统一用 Node 内置的(但内置不导出 `ProxyAgent`)。

---

## 策略(strategy)

| 值 | mihomo 组类型 | 行为 |
|---|---|---|
| `round-robin`(默认) | `load-balance` | 每条新连接轮换下一个**存活**节点 —— 分散到多 IP |
| `consistent-hashing` | `load-balance` | 同一目标域名 → 固定同一节点 |
| `sticky-sessions` | `load-balance` | 同一来源+目标 → 一段时间内固定节点 |
| `url-test` | `url-test` | 始终走**最快**的单一节点(非分发;全挂时会回退直连) |

> 库默认给 load-balance 组设了 `lazy: false` + `max-failed-times`,让 mihomo **主动**健康检查、
> 先把死节点/信息节点剔除,否则首批连接可能轮到尚未探测的不可用节点而失败。

---

## 订阅与节点过滤

- **订阅简写**:`subscription: 'https://…'` 等价于 `subscriptions: [{ name:'sub', url, interval:86400, userAgent:'clash.meta' }]`。
- `subscriptions` 数组可混用 URL 字符串与完整对象;字符串自动补默认值(`userAgent` 默认 `clash.meta`,很多机场据此返回完整节点列表)。
- **`excludeFilter`**:正则,剔除机场常见的非代理"信息节点"(如 `剩余流量 / 套餐到期 / 官网…`)——
  它们无法转发流量,round-robin 轮到或 PinnedBalancer 钉到都会失败。常用:
  ```
  剩余流量|剩余|套餐|到期|过期|重置|官网|网址|订阅|续费|购买|公告|失联|Traffic|Expire
  ```
  注意别误伤正常节点(如 `GB` 会命中英国 🇬🇧)。

```ts
type Subscription = {
  name: string; url: string; interval: number;
  userAgent?: string;                       // 默认 'clash.meta'
  header?: Record<string, string | string[]>;
};
type ProxyNode = { name: string; type: string; server?: string; port?: number; [k: string]: unknown };
```

---

## 让整个 Node 进程的流量都走代理

不想逐个请求传 dispatcher 时,可借助 Node 18+ 的 `NODE_USE_ENV_PROXY`,让进程内**所有** `fetch` /
`http` / `https` 自动走某个端口(配合 `NO_PROXY` 排除数据库等不该走代理的目标):

```ts
const lb = new ClashBalancer({ subscription: 'https://example.com/sub' });
await lb.start();

const proxy = `http://127.0.0.1:${lb.port}`;
const child = spawn(process.execPath, ['your-script.js'], {
  env: { ...process.env, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: '.your-db.com,127.0.0.1' },
  stdio: 'inherit',
});
```

> 注意:`NODE_USE_ENV_PROXY` 在进程**启动时**读取,故需以子进程方式注入(不能在已运行进程里改 `process.env`)。

---

## 辅助函数 / 底层构件

```ts
import { bundledBinPath, normalizeSubscriptions, buildConfig, Controller, Supervisor, HealthChecker } from 'clash-balancer';

bundledBinPath();                 // 解析 bin/ 下自带二进制的绝对路径(找不到返回 undefined)
normalizeSubscriptions(sub, subs);// 把字符串/对象混合的订阅归一化为 Subscription[]
buildConfig(opts);                // 纯函数:生成 mihomo YAML 字符串(支持 pins/excludeFilter…)
```

- **`Controller`** — mihomo external-controller REST 薄封装:`version()` / `proxies()` / `providers()` /
  `delay(name, {url,timeout})` / `select(group, name)` / `reloadConfig(path)`。
- **`Supervisor`** — 进程生命周期:拉起、捕获 stdout/stderr、崩溃指数退避重启、优雅关闭。
- **`HealthChecker`** — 周期性测延迟、标记/剔除死节点、触发重建+热重载、发事件。

`ClashBalancer` / `PinnedBalancer` 即由以上构件组合而成;需要更细控制时可直接使用它们。

---

## Windows / Clash Verge 注意事项

- 若本机常驻 **Clash Verge**(`verge-mihomo.exe`),它默认占用 **7890 / 9090**。请给本库用别的端口
  (`port` / `controllerPort`),或确保不冲突;否则会出现 `mihomo 就绪超时`(且 stderr 为空)。
- Windows 下子进程在父进程异常退出时可能成为**孤儿**继续占端口。`PinnedBalancer.stop()` 已内置
  `taskkill` 兜底;`ClashBalancer` 的调用方建议在进程退出钩子里补杀。清理残留:
  ```bash
  taskkill /F /IM mihomo-windows-amd64-compatible.exe
  ```

---

## 开发

源码为 TypeScript(`src/`),用 [tsup](https://tsup.egoist.dev/) 打包到 `dist/`,
测试与示例用 [tsx](https://github.com/privatenumber/tsx) 直接运行 `.ts`。

```bash
pnpm build         # 产出 dist/index.js(CJS)、index.mjs(ESM)、index.d.ts
pnpm typecheck     # tsc --noEmit 全量类型检查
pnpm test          # node --test(经 tsx 运行 test/**/*.test.ts)
pnpm example       # 运行 examples/basic.ts

# 真实功能冒烟(需 bin/ 下有 mihomo 二进制):
pnpm tsx examples/smoke.ts        # 全程本地(本地上游代理 + 本地目标)
pnpm tsx examples/sub-smoke.ts    # 真实订阅(需自备订阅)
pnpm tsx examples/rr-local.ts     # 确定性验证 round-robin 在多节点间轮换
pnpm tsx examples/envproxy-local.ts  # 验证 NODE_USE_ENV_PROXY 经本库出网
```

## License

MIT
