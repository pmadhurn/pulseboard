#!/usr/bin/env node
/*
 * PulseBoard — lightweight on-demand server health dashboard.
 * Zero dependencies. Idle cost: ~0 (samples only when /api/stats is hit).
 * Network rates are computed from two /proc/net/dev samples 1s apart.
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

/* ---------------- /proc readers ---------------- */

function readProc(path) {
  try { return fs.readFileSync(path, 'utf8'); } catch { return ''; }
}

function parseKV(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^(\S+):\s+(.+)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function cpuTimes() {
  // returns { idle, total } summed over all cores
  let idle = 0, total = 0;
  for (const line of readProc('/proc/stat').split('\n')) {
    if (!line.startsWith('cpu')) break;
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    if (!parts.length) continue;
    idle += parts[3] + (parts[4] || 0); // idle + iowait
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
  const used = total - avail;
  return {
    total, used, free, available: avail, buff_cache: buffCache,
    usage_pct: total ? +(100 * used / total).toFixed(1) : 0,
    swap: {
      total: swapTotal, used: swapTotal - swapFree, free: swapFree,
      usage_pct: swapTotal ? +(100 * (swapTotal - swapFree) / swapTotal).toFixed(1) : 0,
    },
  };
}

function netCounters() {
  // name -> { rx, tx } bytes
  const out = {};
  for (const line of readProc('/proc/net/dev').split('\n').slice(2)) {
    const m = line.match(/^\s*(\S+):\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
    if (m) out[m[1]] = { rx: parseInt(m[2], 10), tx: parseInt(m[3], 10) };
  }
  return out;
}

function linkSpeeds() {
  const out = {};
  try {
    for (const name of fs.readdirSync('/sys/class/net')) {
      try {
        const s = fs.readFileSync(`/sys/class/net/${name}/speed`, 'utf8').trim();
        const v = parseInt(s, 10);
        if (v > 0) out[name] = v; // Mb/s
      } catch { /* no speed file (veth/lo) */ }
    }
  } catch { /* ignore */ }
  return out;
}

function diskUsage() {
  return new Promise((resolve) => {
    exec('df', ['-Pk', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'overlay', '-x', 'squashfs', '-x', 'efivarfs']).then((out) => {
      const rows = [];
      for (const line of out.split('\n').slice(1)) {
        const p = line.trim().split(/\s+/);
        if (p.length < 6) continue;
        rows.push({
          fs: p[0], size: +p[1] * 1024, used: +p[2] * 1024, avail: +p[3] * 1024,
          use_pct: parseFloat(p[4]), mount: p.slice(5).join(' '),
        });
      }
      resolve(rows);
    });
  });
}

function diskIo(prev) {
  // prev: dev -> {r, w} sectors; returns rates + totals
  const now = {};
  for (const line of readProc('/proc/diskstats').split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length < 14) continue;
    const dev = p[2];
    const reads = +p[5], writes = +p[9]; // sectors
    now[dev] = { r: reads, w: writes };
  }
  const rows = [];
  for (const dev of Object.keys(now)) {
    if (!/^(sd|nvme|vd|mmc|xvd)/.test(dev)) continue;
    const p = prev && prev[dev];
    const rKbps = p ? ((now[dev].r - p.r) * 512) / 1024 : 0; // over 1s window => KB/s
    const wKbps = p ? ((now[dev].w - p.w) * 512) / 1024 : 0;
    rows.push({
      dev,
      r_kbps: Math.max(0, rKbps), w_kbps: Math.max(0, wKbps),
      r_total_gb: +((now[dev].r * 512) / 1024 ** 3).toFixed(2),
      w_total_gb: +((now[dev].w * 512) / 1024 ** 3).toFixed(2),
    });
  }
  return { now, rows };
}

function topProcs() {
  return new Promise((resolve) => {
    exec('ps', ['-eo', 'pid,comm,%cpu,%mem,args', '--sort=-%cpu']).then((out) => {
      const rows = [];
      for (const line of out.split('\n').slice(1, 9)) {
        const m = line.match(/^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(.*)$/);
        if (!m) continue;
        if (m[2] === 'ps' && m[1] === String(process.pid)) continue; // hide sampler
        rows.push({ pid: +m[1], name: m[2], cpu: +m[3], mem: +m[4], cmd: m[5].slice(0, 90) });
      }
      resolve(rows);
    });
  });
}

/* ---------------- services (docker ps, cached 30s) ---------------- */

let servicesCache = { at: 0, data: null };
async function services() {
  const now = Date.now();
  if (servicesCache.data && now - servicesCache.at < 30000) return servicesCache.data;
  const out = await exec('docker', ['ps', '--format', '{{json .}}']);
  const rows = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    try {
      const c = JSON.parse(line);
      rows.push({
        name: c.Names, image: c.Image, status: c.Status,
        ports: (c.Ports || '').split(', ').filter(Boolean).slice(0, 4).join(', '),
      });
    } catch { /* skip */ }
  }
  servicesCache = { at: now, data: rows };
  return rows;
}

/* ---------------- the stats snapshot ---------------- */

async function collectStats() {
  const cpu0 = cpuTimes();
  const net0 = netCounters();
  const disk0 = diskIo(null);
  await sleep(1000);
  const cpu1 = cpuTimes();
  const net1 = netCounters();

  const cpuDelta = cpu1.total - cpu0.total;
  const cpuPct = cpuDelta > 0 ? +(100 * (cpuDelta - (cpu1.idle - cpu0.idle)) / cpuDelta).toFixed(1) : 0;

  const ifaces = [];
  let totRx = 0, totTx = 0;
  const speeds = linkSpeeds();
  const isVirtual = (n) => /^(veth|br-|docker|lxcbr|virbr|vlan|bond\d)/.test(n);
  for (const name of Object.keys(net1)) {
    if (name === 'lo') continue;
    const a = net0[name] || { rx: 0, tx: 0 };
    const b = net1[name];
    const rxBps = Math.max(0, b.rx - a.rx); // bytes/sec over 1s
    const txBps = Math.max(0, b.tx - a.tx);
    // Show physical links always; virtual links only while they have traffic.
    if (isVirtual(name) && rxBps === 0 && txBps === 0) continue;
    totRx += rxBps; totTx += txBps;
    ifaces.push({
      name,
      rx_bps: rxBps, tx_bps: txBps,
      rx_total_gb: +(b.rx / 1024 ** 3).toFixed(2),
      tx_total_gb: +(b.tx / 1024 ** 3).toFixed(2),
      link_mbps: speeds[name] || null,
    });
  }
  ifaces.sort((a, b) => b.rx_bps + b.tx_bps - (a.rx_bps + a.tx_bps));

  const diskIoResult = diskIo(disk0.now);
  const [disk, procs, docker] = await Promise.all([diskUsage(), topProcs(), services()]);

  const mem = memStats();
  const load = os.loadavg();

  return {
    ts: new Date().toISOString(),
    hostname: os.hostname(),
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    uptime_s: Math.floor(os.uptime()),
    loadavg: load.map((n) => +n.toFixed(2)),
    cores: os.cpus().length,
    cpu_usage_pct: cpuPct,
    mem,
    disk,
    diskio: diskIoResult.rows,
    net: { interfaces: ifaces, total: { rx_bps: totRx, tx_bps: totTx } },
    procs,
    docker,
  };
}

/* ---------------- http server ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

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

    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    const full = path.normalize(path.join(PUBLIC_DIR, file));
    if (!full.startsWith(PUBLIC_DIR)) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    const body = await fs.promises.readFile(full);
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(body);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404); res.end('not found');
    } else {
      res.writeHead(500); res.end('error: ' + err.message);
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`PulseBoard listening on http://${HOST}:${PORT}`);
});
