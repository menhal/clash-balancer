#!/usr/bin/env node
'use strict';

/**
 * postinstall:按当前平台从 GitHub Releases 下载 mihomo 二进制到 bin/。
 *
 * 设计为「尽力而为」:任何失败都只警告、退出码 0,绝不阻断 `npm install`。
 * 库运行时若仍找不到二进制,会提示调用方手动传 `binPath`(见 README)。
 *
 * 可用环境变量:
 *   CLASH_BALANCER_SKIP_DOWNLOAD=1   跳过下载(等价 MIHOMO_SKIP_DOWNLOAD)
 *   MIHOMO_VERSION=v1.18.10          指定 mihomo 版本(默认取 latest release)
 *   MIHOMO_DOWNLOAD_URL=https://…    直接指定二进制资源 URL(优先级最高,跳过 GitHub API)
 *   MIHOMO_MIRROR=https://ghproxy…/  GitHub 下载镜像前缀(国内加速,拼在 github.com 链接前)
 *   MIHOMO_FORCE=1                   即使 bin/ 已有二进制也重新下载
 *   GITHUB_TOKEN=…                   提高 GitHub API 速率限制(可选)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const REPO = 'MetaCubeX/mihomo';
const BIN_DIR = path.join(__dirname, '..', 'bin');
const UA = 'clash-balancer-postinstall';

const log = (m) => console.log(`[clash-balancer] ${m}`);
const warn = (m) => console.warn(`[clash-balancer] ${m}`);
const truthy = (v) => !!v && v !== '0' && String(v).toLowerCase() !== 'false';
const normVer = (v) => (/^v/i.test(v) ? v : `v${v}`);

/** 把下载链接套上可选镜像前缀(只作用于 github.com 资源,不动 api.github.com)。 */
function mirror(url) {
  const m = process.env.MIHOMO_MIRROR;
  if (!m) return url;
  return m.replace(/\/+$/, '') + '/' + url;
}

/** 当前平台 → mihomo 资源命名片段;不支持的平台返回 null。 */
function resolveTarget() {
  const archToken = { x64: 'amd64', arm64: 'arm64', ia32: '386' }[process.arch];
  if (!archToken) return null;
  switch (process.platform) {
    case 'win32':
      return { plat: 'windows', arch: archToken, compatible: archToken === 'amd64', ext: '.zip', finalName: 'mihomo.exe' };
    case 'darwin':
      // darwin 无 -compatible 变体
      return { plat: 'darwin', arch: archToken, compatible: false, ext: '.gz', finalName: 'mihomo' };
    case 'linux':
      return { plat: 'linux', arch: archToken, compatible: archToken === 'amd64', ext: '.gz', finalName: 'mihomo' };
    default:
      return null;
  }
}

/** 候选资源文件名,按优先级(优先 -compatible)。 */
function candidateNames(t, tag) {
  const base = `mihomo-${t.plat}-${t.arch}`;
  const names = [];
  if (t.compatible) names.push(`${base}-compatible-${tag}${t.ext}`);
  names.push(`${base}-${tag}${t.ext}`);
  return names;
}

/** bin/ 里是否已有 mihomo 可执行文件(排除残留的压缩包)。 */
function hasExistingBinary() {
  try {
    return fs.readdirSync(BIN_DIR).some((f) => /mihomo/i.test(f) && !/\.(zip|gz)$/i.test(f));
  } catch {
    return false;
  }
}

async function fetchJson(url) {
  const headers = { 'User-Agent': UA, Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function urlOk(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA }, redirect: 'follow' });
    return res.ok;
  } catch {
    return false;
  }
}

async function download(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 确定二进制资源的下载 URL;失败返回 null。 */
async function resolveDownloadUrl(t) {
  if (process.env.MIHOMO_DOWNLOAD_URL) return mirror(process.env.MIHOMO_DOWNLOAD_URL);

  // 1) 走 GitHub API 拿到 release 的真实资源列表(版本与命名最可靠)
  try {
    const pinned = process.env.MIHOMO_VERSION ? normVer(process.env.MIHOMO_VERSION) : null;
    const api = pinned
      ? `https://api.github.com/repos/${REPO}/releases/tags/${pinned}`
      : `https://api.github.com/repos/${REPO}/releases/latest`;
    const release = await fetchJson(api);
    const tag = release.tag_name;
    const assets = release.assets || [];

    for (const name of candidateNames(t, tag)) {
      const hit = assets.find((a) => a.name === name);
      if (hit) return mirror(hit.browser_download_url);
    }
    // 正则兜底:平台+架构+扩展名匹配,优先含 compatible、名字最短(最规范)的
    const re = new RegExp(`^mihomo-${t.plat}-${t.arch}(-compatible)?[^/]*\\${t.ext}$`);
    const matches = assets.filter((a) => re.test(a.name)).sort((a, b) => a.name.length - b.name.length);
    if (t.compatible) {
      const c = matches.find((a) => /compatible/.test(a.name));
      if (c) return mirror(c.browser_download_url);
    }
    if (matches[0]) return mirror(matches[0].browser_download_url);
  } catch (e) {
    warn(`GitHub API 获取 release 失败(${e.message});尝试直链…`);
  }

  // 2) 兜底:仅当用户显式指定了版本时,按直链探测(避免猜错版本号)
  if (process.env.MIHOMO_VERSION) {
    const tag = normVer(process.env.MIHOMO_VERSION);
    for (const name of candidateNames(t, tag)) {
      const u = mirror(`https://github.com/${REPO}/releases/download/${tag}/${name}`);
      if (await urlOk(u)) return u;
    }
  }
  return null;
}

/** 递归找第一个匹配正则的文件路径。 */
function findFile(dir, re) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) {
      const f = findFile(p, re);
      if (f) return f;
    } else if (re.test(name)) {
      return p;
    }
  }
  return null;
}

/** 解压 zip(Windows 资源)并把其中的 mihomo 可执行文件落到 finalPath。 */
function extractZip(buf, finalPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-'));
  const zipPath = path.join(tmpDir, 'mihomo.zip');
  fs.writeFileSync(zipPath, buf);
  try {
    if (process.platform === 'win32') {
      execFileSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${tmpDir}' -Force`],
        { stdio: 'ignore' },
      );
    } else {
      // bsdtar(现代 Windows/macOS/多数 Linux 自带)也能解 zip,作非 win32 兜底
      execFileSync('tar', ['-xf', zipPath, '-C', tmpDir], { stdio: 'ignore' });
    }
    const exe = findFile(tmpDir, /mihomo.*\.exe$/i) || findFile(tmpDir, /mihomo/i);
    if (!exe) throw new Error('zip 内未找到 mihomo 可执行文件');
    fs.copyFileSync(exe, finalPath);
    fs.chmodSync(finalPath, 0o755);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  if (truthy(process.env.CLASH_BALANCER_SKIP_DOWNLOAD) || truthy(process.env.MIHOMO_SKIP_DOWNLOAD)) {
    log('已设置跳过下载,略过 mihomo 二进制获取。');
    return;
  }

  const t = resolveTarget();
  if (!t) {
    warn(`暂不支持自动下载平台 ${process.platform}/${process.arch};请手动下载 mihomo 并在代码中传入 binPath。`);
    return;
  }

  if (!truthy(process.env.MIHOMO_FORCE) && hasExistingBinary()) {
    log('bin/ 已存在 mihomo 二进制,跳过下载(设 MIHOMO_FORCE=1 可强制刷新)。');
    return;
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });

  const url = await resolveDownloadUrl(t);
  if (!url) {
    warn('未能确定 mihomo 下载地址;请手动下载并传入 binPath,或设置 MIHOMO_VERSION / MIHOMO_MIRROR 后重试。');
    return;
  }

  log(`下载 mihomo(${process.platform}/${process.arch}): ${url}`);
  const buf = await download(url);

  const finalPath = path.join(BIN_DIR, t.finalName);
  if (t.ext === '.gz') {
    fs.writeFileSync(finalPath, zlib.gunzipSync(buf));
    fs.chmodSync(finalPath, 0o755);
  } else {
    extractZip(buf, finalPath);
  }

  log(`mihomo 已就绪: ${finalPath}`);
}

main().catch((e) => {
  warn(`安装 mihomo 失败:${e && e.message ? e.message : e}`);
  warn('这不影响安装;运行时请通过 binPath 指定 mihomo 路径,或设置 MIHOMO_MIRROR 后重装。');
  // 故意不设非零退出码:postinstall 失败不应让整个依赖安装失败。
});
