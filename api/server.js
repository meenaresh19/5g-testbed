'use strict';
// ============================================================
// 5G Testbed Management API
// Bridges the UI to Docker socket for container status/control
// Routes: /status, /containers, /nf/:id, /trace/*, /config/:nf
//         /iperf3/status, /iperf3/run, /iperf3/history
// ============================================================
const express = require('express');
const cors    = require('cors');
const Docker  = require('dockerode');
const fs      = require('fs');
const path    = require('path');

const app    = express();
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });
const PORT   = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// ── Maps ──────────────────────────────────────────────────
const LABEL = 'com.5g-testbed.nf';

const NAME_TO_NF = {
  'open5gs-mongodb': 'mongodb',
  'open5gs-nrf':     'nrf',
  'open5gs-scp':     'scp',
  'open5gs-amf':     'amf',
  'open5gs-smf':     'smf',
  'open5gs-upf':     'upf',
  'open5gs-ausf':    'ausf',
  'open5gs-udm':     'udm',
  'open5gs-udr':     'udr',
  'open5gs-pcf':     'pcf',
  'open5gs-bsf':     'bsf',
  'open5gs-nssf':    'nssf',
  // UERANSIM (default RAN)
  'ueransim-gnb':    'gnb',
  'ueransim-ue1':    'ue1',
  'ueransim-ue2':    'ue2',
  // iPerf3 test server
  'iperf3-server':   'iperf3',
  // OAI RAN (legacy, --profile oai)
  'oai-gnb':         'gnb-oai',
  'oai-nrue':        'nrue-oai',
  // IDS engines
  '5g-zeek-ids':  'zeek-ids',
  '5g-scapy-ids': 'scapy-ids',
  // Management
  '5g-testbed-ui':   'ui',
  '5g-testbed-api':  'api',
};

const NF_TO_CONTAINER = Object.fromEntries(
  Object.entries(NAME_TO_NF).map(([k, v]) => [v, k])
);

// Interface → capture target: which container + BPF filter
// AMF is privileged-like (Debian, has NET_ADMIN via kernel params)
// UPF is fully privileged (best for data-plane captures)
const IFACE_TARGETS = {
  n2:  { container: 'open5gs-amf', filter: 'sctp port 38412',   label: 'N2-NGAP'   },
  n3:  { container: 'open5gs-upf', filter: 'udp port 2152',     label: 'N3-GTP-U'  },
  n4:  { container: 'open5gs-upf', filter: 'udp port 8805',     label: 'N4-PFCP'   },
  sbi: { container: 'open5gs-amf', filter: 'tcp port 7777',     label: 'SBI-HTTP2' },
  all: { container: 'open5gs-upf', filter: 'not port 27017',    label: 'ALL'       },
};

const TRACES_DIR = '/traces';

// In-memory session store (survives container restarts only if files exist)
const activeSessions = new Map();

// ── Helpers ───────────────────────────────────────────────
function containerState(s) {
  if (s === 'running')  return 'running';
  if (s === 'created' || s === 'restarting') return 'starting';
  return 'stopped';
}

function safeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Demux Docker's multiplexed log stream (8-byte header per frame)
function demuxLogs(buffer) {
  const raw = typeof buffer === 'string' ? buffer : buffer.toString('binary');
  const lines = [];
  let i = 0;
  while (i < raw.length) {
    if (i + 8 > raw.length) break;
    const size = (raw.charCodeAt(i+4) << 24) | (raw.charCodeAt(i+5) << 16) |
                 (raw.charCodeAt(i+6) <<  8) |  raw.charCodeAt(i+7);
    if (size === 0) { i += 8; continue; }
    lines.push(raw.substring(i + 8, i + 8 + size));
    i += 8 + size;
  }
  return lines.join('')
    .replace(/\x1B\[[0-9;]*[mGKHF]/g, '')
    .replace(/\r/g, '');
}

// Run a short-lived exec inside a container; wait for it to finish
async function runExec(container, cmd, timeoutMs = 30000) {
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  await new Promise((resolve) => {
    stream.on('end',   resolve);
    stream.on('error', resolve);
    stream.socket?.on('end',   resolve);
    stream.socket?.on('error', resolve);
    setTimeout(resolve, timeoutMs);
  });
}

// Run exec and capture stdout+stderr output as a string
async function runExecOutput(container, cmd, timeoutMs = 30000) {
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true, stdin: false });
  const bufs = [];
  await new Promise((resolve) => {
    stream.on('data',  d => bufs.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    stream.on('end',   resolve);
    stream.on('error', resolve);
    stream.socket?.on('end',   resolve);
    stream.socket?.on('error', resolve);
    setTimeout(resolve, timeoutMs);
  });
  return demuxLogs(Buffer.concat(bufs));
}

// Ensure tcpdump is installed in the container (installs via apt if needed)
async function ensureTcpdump(container) {
  await runExec(container, [
    'sh', '-c',
    'which tcpdump >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq tcpdump)',
  ], 45000);
}

// Ensure iperf3 is installed in the container (installs via apt if needed)
async function ensureIperf3(container) {
  await runExec(container, [
    'sh', '-c',
    'which iperf3 >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq iperf3)',
  ], 60000);
}

// Get the PDU session tunnel IP from the UE container
// UERANSIM creates uesimtun0; OAI creates oaitun_ue1
async function getUeTunIp(container) {
  const out = await runExecOutput(container, [
    'sh', '-c',
    "ip addr show | grep -E '(uesimtun|oaitun)' | grep -o 'inet [0-9.]*' | awk '{print $2}' | head -1",
  ], 6000);
  return out.trim();
}

// ── Health check ──────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ── NF Status ─────────────────────────────────────────────
app.get('/status', async (req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });
    const status = {};
    for (const c of containers) {
      const name = (c.Names[0] || '').replace(/^\//, '');
      const nfId = (c.Labels && c.Labels[LABEL]) || NAME_TO_NF[name];
      if (nfId) status[nfId] = containerState(c.State);
    }
    res.json(status);
  } catch (err) {
    res.status(503).json({ error: 'Docker socket unavailable', detail: err.message });
  }
});

// ── Container list ────────────────────────────────────────
app.get('/containers', async (req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });
    res.json(containers
      .filter(c => {
        const name = (c.Names[0] || '').replace(/^\//, '');
        return (c.Labels && c.Labels[LABEL]) || NAME_TO_NF[name];
      })
      .map(c => {
        const name = (c.Names[0] || '').replace(/^\//, '');
        return {
          id:     c.Id.substring(0, 12),
          name,
          nf:     (c.Labels && c.Labels[LABEL]) || NAME_TO_NF[name],
          type:   c.Labels && c.Labels['com.5g-testbed.type'],
          image:  c.Image,
          state:  containerState(c.State),
          status: c.Status,
        };
      })
    );
  } catch (err) {
    res.status(503).json({ error: 'Docker socket unavailable', detail: err.message });
  }
});

// ── Start / Stop NF ───────────────────────────────────────
app.post('/nf/:id/start', async (req, res) => {
  const name = NF_TO_CONTAINER[req.params.id];
  if (!name) return res.status(404).json({ error: `Unknown NF: ${req.params.id}` });
  try {
    await docker.getContainer(name).start();
    res.json({ status: 'started', nf: req.params.id });
  } catch (err) {
    if (err.statusCode === 304) return res.json({ status: 'already_running' });
    res.status(500).json({ error: err.message });
  }
});

app.post('/nf/:id/stop', async (req, res) => {
  const name = NF_TO_CONTAINER[req.params.id];
  if (!name) return res.status(404).json({ error: `Unknown NF: ${req.params.id}` });
  try {
    await docker.getContainer(name).stop({ t: 10 });
    res.json({ status: 'stopped', nf: req.params.id });
  } catch (err) {
    if (err.statusCode === 304) return res.json({ status: 'already_stopped' });
    res.status(500).json({ error: err.message });
  }
});

// ── NF Logs ───────────────────────────────────────────────
// ?tail=N  ?download=1
app.get('/nf/:id/logs', async (req, res) => {
  const name = NF_TO_CONTAINER[req.params.id];
  if (!name) return res.status(404).json({ error: `Unknown NF: ${req.params.id}` });
  const tail = parseInt(req.query.tail) || 500;
  try {
    const buf = await docker.getContainer(name).logs({ stdout: true, stderr: true, tail, timestamps: true });
    const text = demuxLogs(buf);
    if (req.query.download) {
      res.setHeader('Content-Disposition', `attachment; filename="${req.params.id}-logs.txt"`);
    }
    res.type('text/plain').send(text);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Config file reader ────────────────────────────────────
app.get('/config/:nf', (req, res) => {
  const nf   = req.params.nf.replace(/[^a-z0-9]/g, '');
  const file = path.join('/configs/open5gs', `${nf}.yaml`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Config not found' });
  res.type('text/plain').send(fs.readFileSync(file, 'utf8'));
});

// ═══════════════════════════════════════════════════════════
// TRACE / PCAP MANAGEMENT
// ═══════════════════════════════════════════════════════════

// POST /trace/start
// Body: { label, interfaces: ['n2','n3','n4','sbi'] | 'all', filter }
app.post('/trace/start', async (req, res) => {
  const { label = 'trace', interfaces = ['n3'], filter: customFilter = '' } = req.body;

  const sessionId = safeId();
  const startTime = new Date().toISOString();

  // Resolve requested interfaces into unique container+filter targets
  const ifaceList = interfaces === 'all'
    ? Object.keys(IFACE_TARGETS)
    : (Array.isArray(interfaces) ? interfaces : [interfaces]);

  const seen    = new Set();
  const targets = [];
  for (const iface of ifaceList) {
    const t = IFACE_TARGETS[iface];
    if (!t) continue;
    const key = `${t.container}::${customFilter || t.filter}`;
    if (!seen.has(key)) { seen.add(key); targets.push({ iface, ...t }); }
  }

  const captures = [];
  const errors   = [];

  for (const target of targets) {
    const filename = `${sessionId}_${target.label}.pcap`;
    const capPath  = `${TRACES_DIR}/${filename}`;
    const bpf      = customFilter || target.filter;

    try {
      const container = docker.getContainer(target.container);

      // Install tcpdump if missing (may take ~10s on first run)
      await ensureTcpdump(container);

      // Start detached tcpdump — writes PCAP to shared /traces volume
      const captureExec = await container.exec({
        Cmd: ['sh', '-c', `tcpdump -w ${capPath} -i any ${bpf} >/dev/null 2>&1`],
        AttachStdout: false,
        AttachStderr: false,
      });
      await captureExec.start({ Detach: true });

      captures.push({ container: target.container, filename, iface: target.iface, label: target.label });
    } catch (err) {
      errors.push({ iface: target.iface, container: target.container, error: err.message });
    }
  }

  const session = { label, startTime, captures, errors, status: captures.length > 0 ? 'running' : 'failed' };
  activeSessions.set(sessionId, session);

  res.json({ sessionId, label, startTime, captures: captures.map(c => ({ filename: c.filename, iface: c.iface, label: c.label })), errors });
});

// POST /trace/stop/:sessionId
app.post('/trace/stop/:sessionId', async (req, res) => {
  const session = activeSessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found or already stopped' });

  const stopTime = new Date().toISOString();
  const durationSec = Math.round((new Date(stopTime) - new Date(session.startTime)) / 1000);
  const duration = `${String(Math.floor(durationSec / 60)).padStart(2,'0')}:${String(durationSec % 60).padStart(2,'0')}`;

  // Send SIGINT to tcpdump in each affected container (unique containers)
  const uniqueContainers = [...new Set(session.captures.map(c => c.container))];
  for (const name of uniqueContainers) {
    try {
      const container = docker.getContainer(name);
      // SIGINT causes tcpdump to flush and close the PCAP cleanly
      await runExec(container, ['sh', '-c', 'kill -INT $(pgrep tcpdump) 2>/dev/null || true'], 5000);
    } catch (_) { /* container may be stopped */ }
  }

  // Give tcpdump time to flush its write buffer
  await new Promise(r => setTimeout(r, 1500));

  const result = {
    sessionId:  req.params.sessionId,
    label:      session.label,
    startTime:  session.startTime,
    stopTime,
    duration,
    files:      session.captures.map(c => ({ filename: c.filename, iface: c.iface, label: c.label })),
    errors:     session.errors,
  };

  activeSessions.delete(req.params.sessionId);
  res.json(result);
});

// GET /trace/sessions — list active sessions
app.get('/trace/sessions', (req, res) => {
  const list = [];
  for (const [id, s] of activeSessions) {
    list.push({ sessionId: id, label: s.label, startTime: s.startTime, status: s.status,
                captures: s.captures.map(c => ({ filename: c.filename, iface: c.iface, label: c.label })) });
  }
  res.json(list);
});

// GET /trace/download/:filename — serve a PCAP file
app.get('/trace/download/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!/\.pcap$/.test(filename)) return res.status(400).json({ error: 'Only .pcap files allowed' });
  const filepath = path.join(TRACES_DIR, filename);
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'File not found. Capture may still be running — stop it first.' });
  }
  res.download(filepath, filename);
});

// GET /trace/files — list all PCAP files in the traces directory
app.get('/trace/files', (req, res) => {
  try {
    if (!fs.existsSync(TRACES_DIR)) return res.json([]);
    const files = fs.readdirSync(TRACES_DIR)
      .filter(f => f.endsWith('.pcap'))
      .map(f => {
        const stat = fs.statSync(path.join(TRACES_DIR, f));
        return { filename: f, size: stat.size, mtime: stat.mtime };
      })
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /trace/files/:filename — delete a PCAP file
app.delete('/trace/files/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!/\.pcap$/.test(filename)) return res.status(400).json({ error: 'Only .pcap files allowed' });
  const filepath = path.join(TRACES_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
  fs.unlinkSync(filepath);
  res.json({ deleted: filename });
});

// GET /trace/logs/:sessionId — download bundled NF logs as plain text
// Use sessionId = 'now' for an ad-hoc bundle
app.get('/trace/logs/:sessionId', async (req, res) => {
  const ts    = new Date().toISOString();
  const label = req.params.sessionId;
  const nfs   = ['nrf','scp','amf','smf','upf','ausf','udm','udr','pcf','bsf','nssf','gnb','ue1','ue2'];

  let bundle = `5G Testbed — Log Bundle\n`;
  bundle    += `Session : ${label}\n`;
  bundle    += `Time    : ${ts}\n`;
  bundle    += `${'═'.repeat(70)}\n\n`;

  for (const nf of nfs) {
    const name = NF_TO_CONTAINER[nf];
    bundle += `${'─'.repeat(70)}\n[${nf.toUpperCase()}]  ${name}\n${'─'.repeat(70)}\n`;
    try {
      const buf  = await docker.getContainer(name).logs({ stdout: true, stderr: true, tail: 500, timestamps: true });
      bundle += demuxLogs(buf);
    } catch (err) {
      bundle += `(unavailable: ${err.message})\n`;
    }
    bundle += '\n\n';
  }

  const outFile = `5g-logs-${label}-${Date.now()}.txt`;
  res.setHeader('Content-Disposition', `attachment; filename="${outFile}"`);
  res.type('text/plain').send(bundle);
});

// ═══════════════════════════════════════════════════════════
// iPERF3 THROUGHPUT TESTING
// ═══════════════════════════════════════════════════════════

// In-memory iPerf3 test history (last 50 runs)
const testHistory = [];

// GET /iperf3/status — check UE containers and tunnel IPs
app.get('/iperf3/status', async (req, res) => {
  const ues = [
    { id: 'ue1', name: 'ueransim-ue1' },
    { id: 'ue2', name: 'ueransim-ue2' },
  ];
  const results = {};
  for (const { id, name } of ues) {
    try {
      const info = await docker.getContainer(name).inspect();
      if (info.State.Running) {
        const tunIp = await getUeTunIp(docker.getContainer(name));
        results[id] = { container: name, running: true, tunIp: tunIp || null, ready: !!tunIp };
      } else {
        results[id] = { container: name, running: false, tunIp: null, ready: false };
      }
    } catch {
      results[id] = { container: name, running: false, tunIp: null, ready: false };
    }
  }
  res.json(results);
});

// POST /iperf3/run
// Body: { ue, target, duration, parallel, direction }
//   direction: 'dl' (server→UE), 'ul' (UE→server), 'bidir'
app.post('/iperf3/run', async (req, res) => {
  const {
    ue        = 'ue1',
    target    = '10.45.0.200',
    duration  = 10,
    parallel  = 1,
    direction = 'dl',
  } = req.body;

  const containerName = ue === 'ue2' ? 'ueransim-ue2' : 'ueransim-ue1';
  try {
    const container = docker.getContainer(containerName);
    const info = await container.inspect();
    if (!info.State.Running) {
      return res.status(400).json({ error: `${containerName} is not running` });
    }

    // Check tunnel IP (PDU session must be established)
    const tunIp = await getUeTunIp(container);
    if (!tunIp) {
      return res.status(400).json({
        error: 'No PDU session tunnel IP found (uesimtun0 missing). Is the UE registered and PDU session established?',
      });
    }

    // Install iperf3 if not present (~10s on first run)
    await ensureIperf3(container);

    // Build command
    // DL = server sends data to UE → -R (reverse mode)
    // UL = UE sends data to server → default
    // bidir = simultaneous both ways
    let cmd = `iperf3 -c ${target} -p 5201 -t ${duration} -P ${parallel} -J -B ${tunIp}`;
    if (direction === 'dl')    cmd += ' -R';
    if (direction === 'bidir') cmd += ' --bidir';

    const startTime = new Date().toISOString();
    const raw = await runExecOutput(container, ['sh', '-c', cmd], (duration + 45) * 1000);

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.status(500).json({ error: 'iperf3 did not return valid JSON', raw: raw.slice(0, 500) });
    }

    // Extract summary (handles dl, ul, bidir layouts)
    const end = parsed.end || {};
    const summary = {
      dl_bps:      end.sum_received?.bits_per_second  || end.sum?.bits_per_second  || 0,
      ul_bps:      end.sum_sent?.bits_per_second      || 0,
      dl_mbps:     Math.round((end.sum_received?.bits_per_second  || end.sum?.bits_per_second  || 0) / 1e6 * 10) / 10,
      ul_mbps:     Math.round((end.sum_sent?.bits_per_second      || 0) / 1e6 * 10) / 10,
      retransmits: end.sum_sent?.retransmits           || 0,
      cpu_host:    Math.round(end.cpu_utilization_percent?.host_total   || 0),
      cpu_remote:  Math.round(end.cpu_utilization_percent?.remote_total || 0),
    };

    const record = { id: safeId(), ue, tunIp, target, direction, duration, parallel, startTime, summary };
    testHistory.push(record);
    if (testHistory.length > 50) testHistory.shift();

    res.json({ ok: true, ...record, result: parsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /iperf3/history — last 50 runs (newest first)
app.get('/iperf3/history', (req, res) => {
  res.json([...testHistory].reverse());
});

// ═══════════════════════════════════════════════════════════
// IDS — ZEEK + SCAPY INTRUSION DETECTION
// ═══════════════════════════════════════════════════════════

const IDS_DIR         = '/ids';
const ZEEK_NOTICE_LOG = '/ids/zeek/notice.log';
const SCAPY_ALERTS    = '/ids/scapy_alerts.jsonl';
const IDS_MAX_ALERTS  = 200;

const IDS_ENGINES = [
  { id: 'zeek-ids',  container: '5g-zeek-ids',  label: 'Zeek (Control Plane)'  },
  { id: 'scapy-ids', container: '5g-scapy-ids', label: 'Scapy (Data Plane)'    },
];

// Tail last N non-empty lines from a file; returns [] if missing
function tailFile(filepath, maxLines = IDS_MAX_ALERTS) {
  if (!fs.existsSync(filepath)) return [];
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    const lines   = content.split('\n').filter(l => l.trim().length > 0);
    return maxLines > 0 ? lines.slice(-maxLines) : lines;
  } catch { return []; }
}

// Parse a Zeek JSON notice.log line into a unified alert object
function parseZeekLine(line) {
  try {
    const obj = JSON.parse(line);
    // Zeek JSON keys: ts (Unix float), note, msg, sub, id.orig_h
    const ts = obj.ts
      ? new Date(obj.ts * 1000).toISOString().slice(0, 19) + 'Z'
      : new Date().toISOString().slice(0, 19) + 'Z';
    const severity = obj.sub || 'INFO';
    return {
      id:        ts + Math.random().toString(36).slice(2, 6),
      timestamp: ts,
      engine:    'zeek',
      severity:  severity.toUpperCase(),
      type:      (obj.note  || '').replace(/^FiveG::/, ''),
      source:    obj['id.orig_h'] || obj.src || 'unknown',
      message:   obj.msg || '',
      details:   { uid: obj.uid, peer: obj.peer },
    };
  } catch { return null; }
}

// Parse a Scapy JSON alert line into a unified alert object
function parseScapyLine(line) {
  try {
    const obj = JSON.parse(line);
    return {
      id:        (obj.timestamp || '') + Math.random().toString(36).slice(2, 6),
      timestamp: obj.timestamp || new Date().toISOString().slice(0, 19) + 'Z',
      engine:    'scapy',
      severity:  (obj.severity || 'INFO').toUpperCase(),
      type:      obj.type    || 'UNKNOWN',
      source:    obj.source  || 'unknown',
      message:   obj.message || '',
      details:   obj.details || {},
    };
  } catch { return null; }
}

// Load + merge alerts from both engines, sorted newest-first
function loadAlerts(limit = IDS_MAX_ALERTS, severityFilter = null) {
  const zeekLines  = tailFile(ZEEK_NOTICE_LOG, limit);
  const scapyLines = tailFile(SCAPY_ALERTS, limit);

  let alerts = [
    ...zeekLines.map(parseZeekLine).filter(Boolean),
    ...scapyLines.map(parseScapyLine).filter(Boolean),
  ]
  .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
  .slice(0, limit);

  if (severityFilter) {
    const sf = severityFilter.toUpperCase();
    alerts = alerts.filter(a => a.severity === sf);
  }
  return alerts;
}

// Count lines in a file (number of alerts)
function countLines(filepath) {
  if (!fs.existsSync(filepath)) return 0;
  try {
    return fs.readFileSync(filepath, 'utf8')
      .split('\n').filter(l => l.trim().length > 0).length;
  } catch { return 0; }
}

// GET /ids/status — engine container states + total alert counts
app.get('/ids/status', async (req, res) => {
  const engines = {};
  for (const { id, container, label } of IDS_ENGINES) {
    try {
      const info = await docker.getContainer(container).inspect();
      engines[id] = {
        label,
        running:  info.State.Running,
        status:   info.State.Status,
        startedAt: info.State.StartedAt,
      };
    } catch {
      engines[id] = { label, running: false, status: 'not_found', startedAt: null };
    }
  }
  const zeekCount  = countLines(ZEEK_NOTICE_LOG);
  const scapyCount = countLines(SCAPY_ALERTS);
  res.json({ engines, zeekAlerts: zeekCount, scapyAlerts: scapyCount, totalAlerts: zeekCount + scapyCount });
});

// GET /ids/alerts?severity=HIGH&limit=100
app.get('/ids/alerts', (req, res) => {
  const limit    = Math.min(parseInt(req.query.limit) || 100, IDS_MAX_ALERTS);
  const severity = req.query.severity || null;
  res.json(loadAlerts(limit, severity));
});

// GET /ids/stats — summary counts by severity and type
app.get('/ids/stats', (req, res) => {
  const alerts = loadAlerts(IDS_MAX_ALERTS);
  const bySev  = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  const byType = {};
  for (const a of alerts) {
    bySev[a.severity] = (bySev[a.severity] || 0) + 1;
    byType[a.type]    = (byType[a.type]    || 0) + 1;
  }
  res.json({ total: alerts.length, bySeverity: bySev, byType });
});

// POST /ids/start — start both IDS engines
app.post('/ids/start', async (req, res) => {
  const results = [];
  for (const { id, container } of IDS_ENGINES) {
    try {
      await docker.getContainer(container).start();
      results.push({ id, status: 'started' });
    } catch (err) {
      if (err.statusCode === 304) results.push({ id, status: 'already_running' });
      else results.push({ id, status: 'error', error: err.message });
    }
  }
  res.json({ results });
});

// POST /ids/stop — stop both IDS engines
app.post('/ids/stop', async (req, res) => {
  const results = [];
  for (const { id, container } of IDS_ENGINES) {
    try {
      await docker.getContainer(container).stop({ t: 5 });
      results.push({ id, status: 'stopped' });
    } catch (err) {
      if (err.statusCode === 304) results.push({ id, status: 'already_stopped' });
      else results.push({ id, status: 'error', error: err.message });
    }
  }
  res.json({ results });
});

// DELETE /ids/alerts — clear alert files (truncate to empty)
app.delete('/ids/alerts', (req, res) => {
  try {
    if (fs.existsSync(ZEEK_NOTICE_LOG)) fs.writeFileSync(ZEEK_NOTICE_LOG, '');
    if (fs.existsSync(SCAPY_ALERTS))    fs.writeFileSync(SCAPY_ALERTS, '');
    res.json({ cleared: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 404 ───────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[5G-API] Testbed API listening on :${PORT}`);
  console.log(`[5G-API] Docker socket : ${process.env.DOCKER_SOCKET || '/var/run/docker.sock'}`);
  console.log(`[5G-API] Traces dir   : ${TRACES_DIR}`);
});
