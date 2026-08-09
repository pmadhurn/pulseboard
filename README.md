# PulseBoard ♡

Zero-idle, on-demand server health dashboard. Press the button, watch the stats — and when you don't, it costs **nothing** (no background sampling, no daemons spinning).

Live at: **https://health.madhur.dev**

## Features
- CPU usage % (1s delta from `/proc/stat`), load average, core count
- Memory + Swap usage with bars
- Storage utilisation per mount (`df`)
- Network: live up/down throughput per interface + lifetime totals, link speed, sparkline chart
- Disk I/O: read/write KB/s + lifetime totals (`/proc/diskstats`)
- Top processes by CPU
- Docker container list (cached 30s server-side)
- Deployed-services directory (from obsidian deployment notes)

## Design: zero idle cost
- The server does **nothing** between requests. There are no samplers, no background intervals.
- Stats are computed **only when the browser polls `/api/stats`** — i.e. only while you hold the dashboard's Monitor button on.
- Network rates and CPU% use two `/proc` samples 1s apart, computed on demand.
- No dependencies — plain Node.js `http` + `/proc` reads.

## Design
Version 2 is a full visual rebuild, not a recolor:

- Mission-control / telemetry-terminal layout with a command bar, status LED, standby prompt, live event log, and module grid.
- Large real-time multi-series telemetry chart for CPU, memory, download, and upload.
- Big live stat strip for CPU, memory, swap, disk, and network throughput.
- Terminal-style modules for processor, memory, swap, network interfaces, disk I/O, top processes, and deployed services.
- Professional dark palette: near-black graphite, warm gold, amber, emerald, violet — no blue hero theme.
- Micro-interactions: monitor press response, live LED pulse, hover lift, chart glow, staggered panel entrance.
- `prefers-reduced-motion` respected. Zero dependencies kept — plain HTML/CSS/JS.
- Redesigned with [emilkowalski/skills](https://github.com/pmadhurn/skills-for-ai) (emil-design-eng, apple-design, animate, pick-ui-library).
- Options panel (gear icon or press `O`): theme presets (gold/emerald/violet/ember/mono), poll rate (1s/2s/5s), chart window (60s/90s/180s), per-series chart toggles. All persisted in localStorage.

## Run
```bash
node server.js            # listens on 127.0.0.1:8123
# or
PULSEBOARD_PORT=8123 PULSEBOARD_HOST=127.0.0.1 node server.js
```

## Systemd (this server)
`/etc/systemd/system/pulseboard.service` → `systemctl start pulseboard`

## Cloudflare Tunnel
Ingress in `/etc/cloudflared/config.yml` (before the `http_status:404` catch-all):
```yaml
- hostname: health.madhur.dev
  service: http://localhost:8123
```
Then `cloudflared tunnel route dns 46dac571-1095-4f5d-b552-ea8b7ca0fddd health.madhur.dev` and restart cloudflared.

## API
- `GET /api/stats` — full snapshot (JSON)
- `GET /api/health` — lightweight liveness

## License
MIT
