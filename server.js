#!/usr/bin/env node
/*
 * PulseBoard server v3.0 — from on-demand toy to a real monitoring tool.
 *  - Background sampler (30s tick): CPU, mem, swap, load, net, disk IO → 24h ring buffer
 *  - Service health checks every 60s with per-service uptime history
 *  - Docker ps -a + docker stats (cached) with stopped-container detection
 *  - Alert engine (thresholds + sustained conditions + cooldowns) → Telegram via
 *    /usr/local/bin/server-alert, plus an in-dashboard alert feed
 *  - History persisted to data/state.json (survives restarts)
 *  - Auth: PULSEBOARD_TOKEN guards detailed APIs; /api/services stays public
 *    (status-page mode) but hides internal-only services when unauthenticated.
 * Zero npm dependencies.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PORT = parseInt(process.env.PULSEBOARD_PORT || '8123', 10);
const HOST = process.env.PULSEBOARD_HOST || '127.0.0.1';
const TOKEN = (process.env.PULSEBOARD_TOKEN || '').trim();
const TELEGRAM_ENABLED = process.env.PULSEBOARD_TELEGRAM !== '0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const TICK_MS = 30_000;            // sampler tick
const HISTORY_MAX = 2880;          // 24h at 30s
const SVC_HISTORY_MAX = 1440;      // 24h at 60s
const ALERTS_MAX = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exec = (cmd, args, timeout = 8000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
    resolve(err ? '' : stdout.toString());
  });
});
const httpGet = (url, timeoutMs = 4000) => new Promise((resolve) => {
  const start = Date.now();
  let done = false;
  const finish = (r) => { if (!done) { done = true; resolve(r); } };
  const t = setTimeout(() => finish({ ok: false, status: 0, latency: timeoutMs, error: 'timeout' }), timeoutMs);
  const req = http.get(url, { timeout: timeoutMs, family: 4 }, (res) => {
    clearTimeout(t); res.resume();
    // 401/403 mean the service answered — it's up, just auth-gated.
    const ok = res.statusCode < 400 || res.statusCode === 401 || res.statusCode === 403;
    finish({ ok, status: res.statusCode, latency: Date.now() - start });
  });
  req.on('error', (e) => { clearTimeout(t); finish({ ok: false, status: 0, latency: Date.now() - start, error: e.code || 'error' }); });
  req.on('timeout', () => { req.destroy(); });
});

/* Non-HTTP probe: JSON state file written by the service ({pid, gateway_state}).
   Up = state says running AND that pid is alive. Mirrors httpGet's return shape. */
function checkStateFile(file) {
  const start = Date.now();
  try {
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    let alive = false;
    try { process.kill(st.pid, 0); alive = true; } catch { alive = false; }
    const ok = alive && st.gateway_state === 'running';
    return { ok, status: ok ? 200 : 0, latency: Date.now() - start, error: ok ? null : (!alive ? 'pid-dead' : `state=${st.gateway_state}`) };
  } catch (e) {
    return { ok: false, status: 0, latency: Date.now() - start, error: e.code || 'state-file' };
  }
}

/* ---------------- /proc readers ---------------- */

function readProc(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }
function parseKV(text) {
  const out = {};
  for (const line of text.split('\n')) { const m = line.match(/^(\S+):\s+(.+)$/); if (m) out[m[1]] = m[2].trim(); }
  return out;
}

function cpuTimesPerCore() {
  const cores = [];
  for (const line of readProc('/proc/stat').split('\n')) {
    const m = line.match(/^cpu(\d+)\s+(.+)/);
    if (!m) continue;
    const parts = m[2].trim().split(/\s+/).map(Number);
    cores.push({ core: +m[1], idle: parts[3] + (parts[4] || 0), total: parts.reduce((a, b) => a + (b || 0), 0) });
  }
  return cores;
}
function cpuTimesAll() {
  const line = readProc('/proc/stat').split('\n')[0] || '';
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  if (!parts.length) return { idle: 0, total: 0 };
  return { idle: parts[3] + (parts[4] || 0), total: parts.reduce((a, b) => a + (b || 0), 0) };
}
function cpuPctBetween(a, b) {
  const d = b.total - a.total;
  return d > 0 ? +(100 * (d - (b.idle - a.idle)) / d).toFixed(1) : 0;
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
const isVirtualIface = (n) => n === 'lo' || /^(veth|br-|docker|lxcbr|virbr|vlan|bond\d)/.test(n);
function physNetTotals(counters) {
  let rx = 0, tx = 0;
  for (const [name, c] of Object.entries(counters)) {
    if (isVirtualIface(name)) continue;
    rx += c.rx; tx += c.tx;
  }
  return { rx, tx };
}
function linkSpeeds() {
  const out = {};
  try { for (const name of fs.readdirSync('/sys/class/net')) {
    try { const v = parseInt(fs.readFileSync(`/sys/class/net/${name}/speed`, 'utf8').trim(), 10); if (v > 0) out[name] = v; } catch {}
  }} catch {}
  return out;
}

function diskUsage() {
  return exec('df', ['-Pk', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'overlay', '-x', 'squashfs', '-x', 'efivarfs']).then((out) => {
    const rows = [];
    for (const line of out.split('\n').slice(1)) {
      const p = line.trim().split(/\s+/);
      if (p.length < 6) continue;
      rows.push({ fs: p[0], size: +p[1] * 1024, used: +p[2] * 1024, avail: +p[3] * 1024,
        use_pct: parseFloat(p[4]), mount: p.slice(5).join(' ') });
    }
    return rows;
  });
}

function diskIoCounters() {
  const out = {};
  for (const line of readProc('/proc/diskstats').split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length < 14) continue;
    const dev = p[2];
    if (!/^(sd|nvme|vd|mmc|xvd)/.test(dev)) continue;
    // whole devices only — skip partitions (sda1, nvme0n1p1, mmcblk0p1)
    if (/^(sd[a-z]+|vd[a-z]+|xvd[a-z]+)\d+$/.test(dev) || /p\d+$/.test(dev)) continue;
    out[dev] = { r: +p[5], w: +p[9] };
  }
  return out;
}
function diskIoTotals(counters) {
  let r = 0, w = 0;
  for (const c of Object.values(counters)) { r += c.r; w += c.w; }
  return { r, w }; // sectors (512B)
}

function topProcs(sortBy = 'cpu') {
  const flag = sortBy === 'mem' ? '--sort=-%mem' : '--sort=-%cpu';
  return exec('ps', ['-eo', 'pid,comm,%cpu,%mem,args', flag]).then((out) => {
    const rows = [];
    for (const line of out.split('\n').slice(1, 12)) {
      const m = line.match(/^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(.*)$/);
      if (!m) continue;
      if (m[2] === 'ps') continue;
      rows.push({ pid: +m[1], name: m[2], cpu: +m[3], mem: +m[4], cmd: m[5].slice(0, 90) });
    }
    return rows;
  });
}

function getSystemInfo() {
  let ip = '';
  try { const n = os.networkInterfaces(); for (const [k, v] of Object.entries(n)) {
    if (isVirtualIface(k)) continue;
    for (const i of v) { if (i.family === 'IPv4' && !i.internal) { ip = i.address; break; } }
    if (ip) break;
  }} catch {}
  let cpuModel = '';
  try { const raw = readProc('/proc/cpuinfo');
    let m = raw.match(/model name\s*:\s*(.+)/i) || raw.match(/Processor\s*:\s*(.+)/i);
    if (m) cpuModel = m[1].trim(); } catch {}
  let processCount = 0;
  try { processCount = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d)).length; } catch {}
  return { ip, cpu_model: cpuModel, process_count: processCount };
}

/* ---------------- services ---------------- */

const SERVICE_CHECKS = [
  { name: 'Portfolio', url: 'http://127.0.0.1:8090/', public: 'madhur.dev' },
  { name: 'Aravalli Ayurveda', url: 'http://127.0.0.1:3000/', public: 'aravalliayurveda.com' },
  { name: 'Open WebUI', url: 'http://127.0.0.1:8080/', public: 'ai.madhur.dev' },
  { name: 'SpeakInsights', url: 'http://127.0.0.1:3010/', public: 'meetings.madhur.dev' },
  { name: 'NavDashboard', url: 'http://127.0.0.1:8085/', public: 'nav.madhur.dev' },
  { name: 'n8n', url: 'http://127.0.0.1:5678/', public: 'n8n.madhur.dev' },
  { name: 'Ollama', url: 'http://127.0.0.1:11434/api/tags', public: 'ollama.madhur.dev' },
  { name: 'Portainer', url: 'http://127.0.0.1:9000/', public: 'docker.madhur.dev' },
  { name: 'VS Code', url: 'http://127.0.0.1:8082/', public: 'code.madhur.dev' },
  { name: 'FileDrop', url: 'http://127.0.0.1:8140/api/health', public: 'link.madhur.dev' },
  { name: 'PulseBoard', url: `http://127.0.0.1:${PORT}/api/health`, public: 'health.madhur.dev', self: true },
  { name: 'OmniRoute', url: 'http://127.0.0.1:20128/v1/models', public: null },
  { name: 'Supabase', url: 'http://127.0.0.1:8000/', public: null },
  // Hermes gateway has no HTTP port (ACP is stdio); probe its state file + pid instead.
  { name: 'Hermes', stateFile: '/home/ubuntu/.hermes/gateway_state.json', public: null },
];

/* ---------------- persistent state ---------------- */

const state = {
  history: [],                 // [{t, cpu, mem, swap, load, rx, tx, dr, dw}]
  svc: {},                     // name -> { samples: [1|0], latency: n, status, http_status, fails, since }
  alerts: [],                  // [{t, level, key, msg}]
};

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (Array.isArray(raw.history)) state.history = raw.history.slice(-HISTORY_MAX);
    if (raw.svc && typeof raw.svc === 'object') state.svc = raw.svc;
    if (Array.isArray(raw.alerts)) state.alerts = raw.alerts.slice(-ALERTS_MAX);
    console.log(`state loaded: ${state.history.length} history points, ${state.alerts.length} alerts`);
  } catch {}
}
let stateDirty = false;
function saveState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
    stateDirty = false;
  } catch (e) { console.error('saveState failed:', e.message); }
}

/* ---------------- alert engine ---------------- */

const cooldowns = new Map(); // key -> last sent ms
function cooldownOk(key, ms) {
  const last = cooldowns.get(key) || 0;
  if (Date.now() - last < ms) return false;
  cooldowns.set(key, Date.now());
  return true;
}

function pushAlert(level, key, msg, cooldownMs = 30 * 60_000) {
  if (!cooldownOk(key, cooldownMs)) return;
  const alert = { t: Date.now(), level, key, msg };
  state.alerts.push(alert);
  if (state.alerts.length > ALERTS_MAX) state.alerts.splice(0, state.alerts.length - ALERTS_MAX);
  stateDirty = true;
  console.log(`[alert:${level}] ${msg}`);
  if (TELEGRAM_ENABLED) {
    const icon = level === 'crit' ? '🔴' : level === 'warn' ? '🟡' : '🟢';
    execFile('sudo', ['-n', '/usr/local/bin/server-alert', `${icon} PulseBoard: ${msg}`],
      { timeout: 15000 }, () => {});
  }
}

// sustained-condition counters (ticks)
const sustain = { cpu: 0, load: 0 };

function evaluateAlerts(point, mem) {
  const cores = os.cpus().length;
  // CPU >= 90% for 5 minutes (10 ticks)
  sustain.cpu = point.cpu >= 90 ? sustain.cpu + 1 : 0;
  if (sustain.cpu === 10) pushAlert('warn', 'cpu-high', `CPU at ${point.cpu}% sustained for 5 min`);
  // load1 >= 3x cores for 5 minutes
  sustain.load = point.load >= 3 * cores ? sustain.load + 1 : 0;
  if (sustain.load === 10) pushAlert('warn', 'load-high', `Load average ${point.load} (${cores} cores) sustained for 5 min`);
  // memory / swap
  if (mem.usage_pct >= 92) pushAlert('crit', 'mem-high', `Memory at ${mem.usage_pct}% (${fmtBytes(mem.available)} available)`);
  if (mem.swap.usage_pct >= 85) pushAlert('warn', 'swap-high', `Swap at ${mem.swap.usage_pct}%`, 2 * 3600_000);
}

function evaluateDiskAlerts(disks) {
  for (const d of disks) {
    // 2026-08-23: lowered 85->78 (crit 93->90). Disk grows ~1%/day here, so the old
    // window gave only ~8 days of warning and the 81% creep went unannounced entirely.
    if (d.use_pct >= 78) {
      pushAlert(d.use_pct >= 90 ? 'crit' : 'warn', `disk-${d.mount}`,
        `Disk ${d.mount} at ${d.use_pct}% (${fmtBytes(d.avail)} free)`, 6 * 3600_000);
    }
  }
}

function fmtBytes(b) {
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(1) + ' GiB';
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(0) + ' MiB';
  return Math.round(b / 1024) + ' KiB';
}

/* ---------------- background sampler ---------------- */

let prev = null;              // { t, cpu, net, io }
let dfCache = [];             // refreshed every 10 ticks
let dockerCache = { ps: [], stats: {}, at: 0 };
let tickCount = 0;
let prevRunning = null;       // Set of running container names

async function refreshServices() {
  const results = await Promise.all(SERVICE_CHECKS.map(async (svc) => {
    const r = svc.stateFile ? checkStateFile(svc.stateFile) : await httpGet(svc.url, 4000);
    return { svc, r };
  }));
  for (const { svc, r } of results) {
    let rec = state.svc[svc.name];
    if (!rec) rec = state.svc[svc.name] = { samples: [], fails: 0, since: Date.now() };
    rec.latency = r.latency;
    rec.http_status = r.status;
    rec.error = r.error || null;
    if (r.ok) {
      if (rec.fails >= 2 && !svc.self) pushAlert('info', `svc-up-${svc.name}`, `${svc.name} is back UP`, 60_000);
      rec.fails = 0;
      rec.status = 'up';
    } else {
      rec.fails += 1;
      // only flip to down (and alert) after 2 consecutive failures — avoids flapping
      if (rec.fails >= 2) {
        if (rec.status !== 'down' && !svc.self) {
          pushAlert('crit', `svc-down-${svc.name}`, `${svc.name} is DOWN (${r.error || 'HTTP ' + r.status})`, 30 * 60_000);
        }
        rec.status = 'down';
      }
    }
    rec.samples.push(rec.status === 'down' ? 0 : 1);
    if (rec.samples.length > SVC_HISTORY_MAX) rec.samples.splice(0, rec.samples.length - SVC_HISTORY_MAX);
  }
  stateDirty = true;
}

async function refreshDocker() {
  const out = await exec('docker', ['ps', '-a', '--format', '{{json .}}'], 15000);
  const rows = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    try {
      const c = JSON.parse(line);
      rows.push({ name: c.Names, image: c.Image, status: c.Status, state: c.State,
        ports: (c.Ports || '').split(', ').filter(Boolean).slice(0, 3).join(', ') });
    } catch {}
  }
  if (rows.length) {
    const running = new Set(rows.filter(r => r.state === 'running').map(r => r.name));
    if (prevRunning) {
      for (const name of prevRunning) {
        if (!running.has(name)) pushAlert('warn', `ctr-stop-${name}`, `Container ${name} stopped`, 30 * 60_000);
      }
      for (const name of running) {
        if (!prevRunning.has(name) && cooldowns.has(`ctr-stop-${name}`)) {
          pushAlert('info', `ctr-start-${name}`, `Container ${name} is running again`, 60_000);
        }
      }
    }
    prevRunning = running;
    dockerCache.ps = rows;
    dockerCache.at = Date.now();
  }
}

async function refreshDockerStats() {
  const out = await exec('docker', ['stats', '--no-stream', '--format', '{{json .}}'], 25000);
  const stats = {};
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    try {
      const s = JSON.parse(line);
      stats[s.Name] = {
        cpu_pct: parseFloat(s.CPUPerc) || 0,
        mem: (s.MemUsage || '').split('/')[0].trim(),
        mem_pct: parseFloat(s.MemPerc) || 0,
      };
    } catch {}
  }
  if (Object.keys(stats).length) dockerCache.stats = stats;
}

async function samplerTick() {
  tickCount += 1;
  const t = Date.now();
  const cpu = cpuTimesAll();
  const net = physNetTotals(netCounters());
  const io = diskIoTotals(diskIoCounters());
  const mem = memStats();
  const load = +os.loadavg()[0].toFixed(2);

  if (prev) {
    const dt = (t - prev.t) / 1000;
    const point = {
      t,
      cpu: cpuPctBetween(prev.cpu, cpu),
      mem: mem.usage_pct,
      swap: mem.swap.usage_pct,
      load,
      rx: Math.max(0, Math.round((net.rx - prev.net.rx) / dt)),
      tx: Math.max(0, Math.round((net.tx - prev.net.tx) / dt)),
      dr: Math.max(0, Math.round(((io.r - prev.io.r) * 512) / dt / 1024)),   // KB/s
      dw: Math.max(0, Math.round(((io.w - prev.io.w) * 512) / dt / 1024)),
    };
    state.history.push(point);
    if (state.history.length > HISTORY_MAX) state.history.splice(0, state.history.length - HISTORY_MAX);
    stateDirty = true;
    evaluateAlerts(point, mem);
  }
  prev = { t, cpu, net, io };

  // staggered slower jobs (all awaited-but-independent; failures are silent)
  if (tickCount === 1 || tickCount % 2 === 0) refreshServices().catch(() => {});
  if (tickCount % 2 === 1) refreshDocker().catch(() => {});
  if (tickCount % 3 === 0) refreshDockerStats().catch(() => {});
  if (tickCount % 10 === 1) diskUsage().then((d) => { dfCache = d; evaluateDiskAlerts(d); }).catch(() => {});
  if (tickCount % 10 === 0 && stateDirty) saveState();
}

/* ---------------- API payload builders ---------------- */

function dockerRows() {
  return dockerCache.ps.map((c) => ({ ...c, ...(dockerCache.stats[c.name] || {}) }));
}

function serviceRows(authed) {
  const rows = [];
  for (const svc of SERVICE_CHECKS) {
    if (!authed && !svc.public) continue;
    const rec = state.svc[svc.name] || {};
    const samples = rec.samples || [];
    const up = samples.filter(Boolean).length;
    rows.push({
      name: svc.name,
      public: svc.public,
      internal: !svc.public,
      status: rec.status || 'unknown',
      latency_ms: rec.latency ?? null,
      http_status: rec.http_status ?? null,
      uptime_24h: samples.length ? +(100 * up / samples.length).toFixed(2) : null,
      strip: samples.slice(-90),
    });
  }
  return rows;
}

async function collectLiveStats() {
  const cpu0 = cpuTimesAll(), cpu0c = cpuTimesPerCore();
  const net0 = netCounters();
  const io0 = diskIoCounters();
  await sleep(1000);
  const cpu1 = cpuTimesAll(), cpu1c = cpuTimesPerCore();
  const net1 = netCounters();
  const io1 = diskIoCounters();

  const cores = cpu0c.map((c0, i) => ({
    core: c0.core,
    usage_pct: cpuPctBetween(c0, cpu1c[i] || c0),
  }));

  const ifaces = [];
  let totRx = 0, totTx = 0;
  const speeds = linkSpeeds();
  for (const name of Object.keys(net1)) {
    if (name === 'lo') continue;
    const a = net0[name] || { rx: 0, tx: 0 }, b = net1[name];
    const rxBps = Math.max(0, b.rx - a.rx), txBps = Math.max(0, b.tx - a.tx);
    if (isVirtualIface(name) && rxBps === 0 && txBps === 0) continue;
    if (!isVirtualIface(name)) { totRx += rxBps; totTx += txBps; }
    ifaces.push({ name, rx_bps: rxBps, tx_bps: txBps,
      rx_total_gb: +(b.rx / 1024 ** 3).toFixed(2), tx_total_gb: +(b.tx / 1024 ** 3).toFixed(2),
      link_mbps: speeds[name] || null });
  }
  ifaces.sort((a, b) => (b.rx_bps + b.tx_bps) - (a.rx_bps + a.tx_bps));

  const diskio = [];
  for (const dev of Object.keys(io1)) {
    const a = io0[dev] || io1[dev];
    diskio.push({ dev,
      r_kbps: Math.max(0, ((io1[dev].r - a.r) * 512) / 1024),
      w_kbps: Math.max(0, ((io1[dev].w - a.w) * 512) / 1024),
      r_total_gb: +((io1[dev].r * 512) / 1024 ** 3).toFixed(2),
      w_total_gb: +((io1[dev].w * 512) / 1024 ** 3).toFixed(2) });
  }

  const [procsCpu, procsMem] = await Promise.all([topProcs('cpu'), topProcs('mem')]);
  const mem = memStats();

  return {
    ts: new Date().toISOString(), hostname: os.hostname(),
    os: `${os.type()} ${os.release()}`, arch: os.arch(),
    uptime_s: Math.floor(os.uptime()),
    loadavg: os.loadavg().map((n) => +n.toFixed(2)), cores: os.cpus().length,
    cpu_usage_pct: cpuPctBetween(cpu0, cpu1), cpu_cores: cores,
    mem, disk: dfCache, diskio,
    net: { interfaces: ifaces, total: { rx_bps: totRx, tx_bps: totTx } },
    procs_cpu: procsCpu, procs_mem: procsMem,
    docker: dockerRows(),
    services: serviceRows(true),
    alerts_recent: state.alerts.slice(-5).reverse(),
    ...getSystemInfo(),
  };
}

/* ---------------- auth ---------------- */

function tokenOk(req, url) {
  if (!TOKEN) return true; // no token configured -> everything open (local/dev)
  const hdr = req.headers['x-pb-token'] || '';
  const bearer = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const q = url.searchParams.get('token') || '';
  for (const cand of [hdr, bearer, q]) {
    if (!cand) continue;
    const a = crypto.createHash('sha256').update(cand).digest();
    const b = crypto.createHash('sha256').update(TOKEN).digest();
    if (crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

/* ---------------- http server ---------------- */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    if (p === '/api/health') return json(res, 200, { ok: true, service: 'pulseboard', v: 3, ts: new Date().toISOString() });

    if (p === '/api/services') return json(res, 200, serviceRows(tokenOk(req, url)));

    if (p === '/api/auth/check') return json(res, tokenOk(req, url) ? 200 : 401, { ok: tokenOk(req, url) });

    if (p === '/api/stats' || p === '/api/history' || p === '/api/alerts' || p === '/api/docker') {
      if (!tokenOk(req, url)) return json(res, 401, { error: 'unauthorized' });
      if (p === '/api/stats') return json(res, 200, await collectLiveStats());
      if (p === '/api/docker') return json(res, 200, dockerRows());
      if (p === '/api/alerts') return json(res, 200, state.alerts.slice().reverse());
      // /api/history?hours=1..24
      const hours = Math.min(24, Math.max(1, parseInt(url.searchParams.get('hours') || '24', 10) || 24));
      const cutoff = Date.now() - hours * 3600_000;
      return json(res, 200, state.history.filter((pt) => pt.t >= cutoff));
    }

    let file = p === '/' ? '/index.html' : p;
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

/* ---------------- start ---------------- */

loadState();
samplerTick().catch(() => {});
const timer = setInterval(() => samplerTick().catch((e) => console.error('tick:', e.message)), TICK_MS);

function shutdown() {
  clearInterval(timer);
  if (stateDirty) saveState();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, HOST, () => {
  console.log(`PulseBoard v3 on http://${HOST}:${PORT} (auth ${TOKEN ? 'ON' : 'OFF'}, telegram ${TELEGRAM_ENABLED ? 'ON' : 'OFF'})`);
});
