#!/usr/bin/env node
/*
 * PulseBoard server v2.2 — enhanced with per-core CPU, system info,
 * live service health checks, and docker details.
 * Zero dependencies. Idle cost: ~0 (samples only when /api/stats is hit).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const PORT = parseInt(process.env.PULSEBOARD_PORT || '8123', 10);
const HOST = process.env.PULSEBOARD_HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exec = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 4000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
    resolve(err ? '' : stdout.toString());
  });
});
const httpGet = (url, timeoutMs = 3000) => new Promise((resolve) => {
  const t = setTimeout(() => resolve({ ok: false, status: 0, latency: timeoutMs, error: 'timeout' }), timeoutMs);
  const start = Date.now();
  const req = http.get(url, { timeout: timeoutMs, family: 4 }, (res) => {
    const latency = Date.now() - start;
    clearTimeout(t); res.resume(); // drain
    resolve({ ok: res.statusCode < 400, status: res.statusCode, latency });
  });
  req.on('error', (e) => { clearTimeout(t); resolve({ ok: false, status: 0, latency: Date.now() - start, error: e.code || 'error' }); });
  req.on('timeout', () => { req.destroy(); clearTimeout(t); resolve({ ok: false, status: 0, latency: timeoutMs, error: 'timeout' }); });
});

/* ---------------- /proc readers ---------------- */

function readProc(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }
function parseKV(text) {
  const out = {};
  for (const line of text.split('\n')) { const m = line.match(/^(\S+):\s+(.+)$/); if (m) out[m[1]] = m[2].trim(); }
  return out;
}

// Per-core CPU: [{ core: 0, usage_pct: X }, ...]
function cpuTimesPerCore() {
  const cores = [];
  for (const line of readProc('/proc/stat').split('\n')) {
    const m = line.match(/^cpu(\d+)\s+(.+)/);
    if (!m) continue;
    const parts = m[2].trim().split(/\s+/).map(Number);
    let idle = parts[3] + (parts[4] || 0);
    let total = parts.reduce((a, b) => a + (b || 0), 0);
    cores.push({ core: +m[1], idle, total });
  }
  return cores;
}
function cpuTimesAll() {
  let idle = 0, total = 0;
  for (const line of readProc('/proc/stat').split('\n')) {
    if (!line.startsWith('cpu')) break;
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    if (!parts.length) continue;
    idle += parts[3] + (parts[4] || 0);
    total += parts.reduce((a, b) => a + (b || 0), 0);
  }
  return { idle, total };
}

function memStats() {
  const kv = parseKV(readProc('/proc/meminfo'));
  const kb = (k) => parseInt(kv[k] || '0', 10) * 1024;
  const total = kb('MemTotal'), free = kb('MemFree'), avail = kb('MemAvailable');
  const buffCache = kb('Buffers') + kb('Cached') + kb('SReclaimable');
  const swapTotal = kb('SwapTotal'), swapFree = kb('SwapFree');
  return {
    total, used: total - avail, free, available: avail, buff_cache: buffCache,
    usage_pct: total ? +(100 * (total - avail) / total).toFixed(1) : 0,
    swap: { total: swapTotal, used: swapTotal - swapFree, free: swapFree,
      usage_pct: swapTotal ? +(100 * (swapTotal - swapFree) / swapTotal).toFixed(1) : 0 },
  };
}

function netCounters() {
  const out = {};
  for (const line of readProc('/proc/net/dev').split('\n').slice(2)) {
    const m = line.match(/^\s*(\S+):\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
    if (m) out[m[1]] = { rx: parseInt(m[2], 10), tx: parseInt(m[3], 10) };
  }
  return out;
}
function linkSpeeds() {
  const out = {};
  try { for (const name of fs.readdirSync('/sys/class/net')) {
    try { const s = fs.readFileSync(`/sys/class/net/${name}/speed`, 'utf8').trim(); const v = parseInt(s, 10); if (v > 0) out[name] = v; } catch {}
  }} catch {}
  return out;
}

function diskUsage() {
  return new Promise((resolve) => {
    exec('df', ['-Pk', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'overlay', '-x', 'squashfs', '-x', 'efivarfs']).then((out) => {
      const rows = [];
      for (const line of out.split('\n').slice(1)) {
        const p = line.trim().split(/\s+/);
        if (p.length < 6) continue;
        rows.push({ fs: p[0], size: +p[1] * 1024, used: +p[2] * 1024, avail: +p[3] * 1024,
          use_pct: parseFloat(p[4]), mount: p.slice(5).join(' ') });
      }
      resolve(rows);
    });
  });
}

function diskIo(prev) {
  const now = {};
  for (const line of readProc('/proc/diskstats').split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length < 14) continue;
    now[p[2]] = { r: +p[5], w: +p[9] };
  }
  const rows = [];
  for (const dev of Object.keys(now)) {
    if (!/^(sd|nvme|vd|mmc|xvd)/.test(dev)) continue;
    const p = prev && prev[dev];
    rows.push({ dev, r_kbps: Math.max(0, p ? ((now[dev].r - p.r) * 512) / 1024 : 0),
      w_kbps: Math.max(0, p ? ((now[dev].w - p.w) * 512) / 1024 : 0),
      r_total_gb: +((now[dev].r * 512) / 1024 ** 3).toFixed(2),
      w_total_gb: +((now[dev].w * 512) / 1024 ** 3).toFixed(2) });
  }
  return { now, rows };
}

function topProcs(sortBy = 'cpu') {
  return new Promise((resolve) => {
    const flag = sortBy === 'mem' ? '-o,%mem' : '-o,%cpu';
    exec('ps', ['-eo', 'pid,comm,%cpu,%mem,args', flag]).then((out) => {
      const rows = [];
      for (const line of out.split('\n').slice(1, 10)) {
        const m = line.match(/^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(.*)$/);
        if (!m) continue;
        if (m[2] === 'ps' && m[1] === String(process.pid)) continue;
        rows.push({ pid: +m[1], name: m[2], cpu: +m[3], mem: +m[4], cmd: m[5].slice(0, 100) });
      }
      resolve(rows);
    });
  });
}

/* ---------------- system info ---------------- */

function getSystemInfo() {
  // IP
  let ip = '';
  try { const n = os.networkInterfaces(); for (const [k, v] of Object.entries(n)) {
    if (k === 'lo' || k.startsWith('docker') || k.startsWith('br-') || k.startsWith('veth') || k.startsWith('lxcbr')) continue;
    for (const i of v) { if (i.family === 'IPv4' && !i.internal) { ip = i.address; break; } }
    if (ip) break;
  }} catch {}
  // cpu model
  let cpuModel = '';
  try { const raw = readProc('/proc/cpuinfo');
    let m = raw.match(/model name\s*:\s*(.+)/i); if (!m) m = raw.match(/Processor\s*:\s*(.+)/i);
    if (m) cpuModel = m[1].trim(); } catch {}
  // process count
  let processCount = 0;
  try { processCount = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d)).length; } catch {}
  return { ip, cpu_model: cpuModel, process_count: processCount };
}

/* ---------------- services health check ---------------- */

const SERVICE_CHECKS = [
  { name: 'Portfolio', url: 'http://127.0.0.1:8090/', public: 'madhur.dev' },
  { name: 'Aravalli Ayurveda', url: 'http://127.0.0.1:3000/', public: 'aa.madhur.dev' },
  { name: 'Open WebUI', url: 'http://127.0.0.1:8080/', public: 'ai.madhur.dev' },
  { name: 'SpeakInsights', url: 'http://127.0.0.1:3010/', public: 'meetings.madhur.dev' },
  { name: 'NavDashboard', url: 'http://127.0.0.1:8085/', public: 'nav.madhur.dev' },
  { name: 'n8n', url: 'http://127.0.0.1:5678/', public: 'n8n.madhur.dev' },
  { name: 'Ollama', url: 'http://127.0.0.1:11434/api/tags', public: 'ollama.madhur.dev' },
  { name: 'Portainer', url: 'http://127.0.0.1:9000/', public: 'docker.madhur.dev' },
  { name: 'VS Code', url: 'http://127.0.0.1:8082/', public: 'code.madhur.dev' },
  { name: 'OmniRoute', url: 'http://127.0.0.1:20128/v1/models', public: null },
  { name: 'Supabase', url: 'http://127.0.0.1:8000/', public: null },
  { name: 'Hermes', url: 'http://127.0.0.1:33435/', public: null }, // ACP check
];

let svcCache = { at: 0, data: null };
async function getServices() {
  const now = Date.now();
  if (svcCache.data && now - svcCache.at < 12000) return svcCache.data;
  const results = await Promise.all(SERVICE_CHECKS.map(async (svc) => {
    const r = await httpGet(svc.url, 4000);
    return { ...svc, status: r.ok ? 'up' : r.status === 0 ? 'down' : 'error',
      http_status: r.status, latency_ms: r.latency, error: r.error || null };
  }));
  svcCache = { at: now, data: results };
  return results;
}

/* ---------------- docker details ---------------- */

let dockerCache = { at: 0, data: null };
async function getDocker() {
  const now = Date.now();
  if (dockerCache.data && now - dockerCache.at < 15000) return dockerCache.data;
  const out = await exec('docker', ['ps', '--format', '{{json .}}']);
  const rows = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    try {
      const c = JSON.parse(line);
      rows.push({ name: c.Names, image: c.Image, status: c.Status, state: c.State,
        ports: (c.Ports || '').split(', ').filter(Boolean).slice(0, 3).join(', '),
        size: c.Size || '' });
    } catch {}
  }
  dockerCache = { at: now, data: rows };
  return rows;
}

/* ---------------- the stats snapshot ---------------- */

async function collectStats() {
  const cpu0 = cpuTimesAll(), cpu0c = cpuTimesPerCore();
  const net0 = netCounters(), disk0 = diskIo(null);
  await sleep(1000);
  const cpu1 = cpuTimesAll(), cpu1c = cpuTimesPerCore();
  const net1 = netCounters();

  const cpuDelta = cpu1.total - cpu0.total;
  const cpuPct = cpuDelta > 0 ? +(100 * (cpuDelta - (cpu1.idle - cpu0.idle)) / cpuDelta).toFixed(1) : 0;
  const cores = cpu0c.map((c0, i) => {
    const c1 = cpu1c[i] || { idle: 0, total: 0 };
    const d = c1.total - c0.total;
    return { core: c0.core, usage_pct: d > 0 ? +(100 * (d - (c1.idle - c0.idle)) / d).toFixed(1) : 0 };
  });

  const ifaces = [];
  let totRx = 0, totTx = 0;
  const speeds = linkSpeeds();
  const isVirtual = (n) => /^(veth|br-|docker|lxcbr|virbr|vlan|bond\d)/.test(n);
  for (const name of Object.keys(net1)) {
    if (name === 'lo') continue;
    const a = net0[name] || { rx: 0, tx: 0 }, b = net1[name];
    const rxBps = Math.max(0, b.rx - a.rx), txBps = Math.max(0, b.tx - a.tx);
    if (isVirtual(name) && rxBps === 0 && txBps === 0) continue;
    totRx += rxBps; totTx += txBps;
    ifaces.push({ name, rx_bps: rxBps, tx_bps: txBps,
      rx_total_gb: +(b.rx / 1024 ** 3).toFixed(2), tx_total_gb: +(b.tx / 1024 ** 3).toFixed(2),
      link_mbps: speeds[name] || null });
  }
  ifaces.sort((a, b) => (b.rx_bps + b.tx_bps) - (a.rx_bps + a.tx_bps));

  const diskIoResult = diskIo(disk0.now);
  const [disk, procs, docker, services, sysInfo] = await Promise.all([
    diskUsage(), topProcs('cpu'), getDocker(), getServices(), Promise.resolve(getSystemInfo()),
  ]);

  const mem = memStats();
  return {
    ts: new Date().toISOString(), hostname: os.hostname(),
    os: `${os.type()} ${os.release()}`, arch: os.arch(),
    kernel: os.release(), uptime_s: Math.floor(os.uptime()),
    loadavg: os.loadavg().map((n) => +n.toFixed(2)), cores: os.cpus().length,
    cpu_usage_pct: cpuPct, cpu_cores: cores,
    mem, disk, diskio: diskIoResult.rows,
    net: { interfaces: ifaces, total: { rx_bps: totRx, tx_bps: totTx } },
    procs, docker, services, ...sysInfo,
  };
}

/* ---------------- http server ---------------- */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/api/stats') {
      const stats = await collectStats();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(stats));
      return;
    }
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'pulseboard', ts: new Date().toISOString() }));
      return;
    }
    if (url.pathname === '/api/services') {
      const svc = await getServices();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(svc));
      return;
    }

    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    const full = path.normalize(path.join(PUBLIC_DIR, file));
    if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
    const body = await fs.promises.readFile(full);
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(body);
  } catch (err) {
    if (err.code === 'ENOENT') { res.writeHead(404); res.end('not found'); }
    else { res.writeHead(500); res.end('error: ' + err.message); }
  }
});

server.listen(PORT, HOST, () => { console.log(`PulseBoard listening on http://${HOST}:${PORT}`); });
