'use strict';
// ============================================================
// 5G Testbed Management API
// Bridges the UI to Docker socket for container status/control
// Routes: /status, /containers, /nf/:id, /trace/*, /config/:nf
//         /iperf3/status, /iperf3/run, /iperf3/history
//         /auth/*, /users/*  (JWT authentication)
// ============================================================
const express = require('express');
const cors    = require('cors');
const Docker  = require('dockerode');
const fs      = require('fs');
const path    = require('path');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');

const app    = express();
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });
const PORT   = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// ── Auth / User Store ─────────────────────────────────────
const USER_STORE_PATH = process.env.USER_STORE || '/data/users.json';
const JWT_SECRET      = process.env.JWT_SECRET  || 'dev-secret-change-in-prod';
const JWT_EXPIRES     = '24h';
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD || 'admin123';

function loadUserStore() {
  try {
    if (fs.existsSync(USER_STORE_PATH)) return JSON.parse(fs.readFileSync(USER_STORE_PATH, 'utf8'));
  } catch (e) { console.error('[AUTH] user store read error:', e.message); }
  return [];
}

function saveUserStore(users) {
  try {
    const dir = path.dirname(USER_STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(USER_STORE_PATH, JSON.stringify(users, null, 2));
  } catch (e) { console.error('[AUTH] user store write error:', e.message); }
}

function findUserByUsername(username) {
  return loadUserStore().find(u => u.username === username);
}

function findUserById(id) {
  return loadUserStore().find(u => u.id === id);
}

function safeUserId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Sync user to Open5GS WebUI accounts collection (non-fatal)
async function syncOpen5gsAccount(username, passwordHash, role, action = 'upsert') {
  try {
    const container = docker.getContainer('open5gs-mongodb');
    let script;
    if (action === 'delete') {
      script = `db.getSiblingDB('open5gs').accounts.deleteOne({ username: '${username}' })`;
    } else {
      const o5gsRole = (role === 'admin') ? 0 : 1;
      script = `
        const db2 = db.getSiblingDB('open5gs');
        const existing = db2.accounts.findOne({ username: '${username}' });
        if (existing) {
          db2.accounts.updateOne({ username: '${username}' }, { $set: { password_hash: '${passwordHash}', roles: [${o5gsRole}] } });
        } else {
          db2.accounts.insertOne({ username: '${username}', password_hash: '${passwordHash}', roles: [${o5gsRole}], __v: 0 });
        }
      `;
    }
    await runExec(container, ['mongosh', '--quiet', '--eval', script]);
    console.log(`[AUTH] Open5GS account sync: ${action} ${username}`);
  } catch (e) {
    console.warn('[AUTH] Open5GS sync non-fatal error:', e.message);
  }
}

// Seed admin user on first boot
async function seedAdminUser() {
  const users = loadUserStore();
  if (users.length === 0) {
    const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    const admin = {
      id:           safeUserId(),
      username:     'admin',
      passwordHash: hash,
      role:         'admin',
      createdAt:    new Date().toISOString(),
    };
    saveUserStore([admin]);
    console.log('[AUTH] Seeded admin user (username: admin)');
    await syncOpen5gsAccount('admin', hash, 'admin');
  }
}

// ── Auth Middleware ────────────────────────────────────────
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// Check UE ownership: admins see all; researchers see their own
function ownsUe(req, ue) {
  if (req.user?.role === 'admin') return true;
  return ue.owner === req.user?.id;
}

// ── Public Routes (no auth required) ──────────────────────

// POST /auth/login — returns JWT + user info
app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const user = findUserByUsername(username);
  if (!user || !bcrypt.compareSync(password, user.passwordHash))
    return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

// GET /health — stays public
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ── Apply auth to all routes below this line ───────────────
app.use(authenticateToken);

// ── Auth self-service routes ───────────────────────────────

// GET /auth/me — return current user info
app.get('/auth/me', (req, res) => {
  const user = findUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, username: user.username, role: user.role, createdAt: user.createdAt });
});

// PUT /auth/password — change own password (requires current password)
app.put('/auth/password', async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: 'currentPassword and newPassword required' });
  if (newPassword.length < 8)
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  const users = loadUserStore();
  const idx = users.findIndex(u => u.id === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  if (!bcrypt.compareSync(currentPassword, users[idx].passwordHash))
    return res.status(401).json({ error: 'Current password incorrect' });
  users[idx].passwordHash = bcrypt.hashSync(newPassword, 10);
  saveUserStore(users);
  await syncOpen5gsAccount(users[idx].username, users[idx].passwordHash, users[idx].role);
  res.json({ ok: true });
});

// ── User Management (admin only) ──────────────────────────

// GET /users — list all users (admin only)
app.get('/users', requireAdmin, (req, res) => {
  const users = loadUserStore().map(u => ({
    id: u.id, username: u.username, role: u.role, createdAt: u.createdAt,
  }));
  res.json(users);
});

// POST /users — create a new user (admin only)
app.post('/users', requireAdmin, async (req, res) => {
  const { username, password, role = 'researcher' } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!['admin', 'researcher'].includes(role)) return res.status(400).json({ error: 'role must be admin or researcher' });
  if (!/^[a-z0-9_.-]{2,32}$/.test(username))
    return res.status(400).json({ error: 'username: 2-32 lowercase alphanumeric/_/./- characters' });
  const users = loadUserStore();
  if (users.find(u => u.username === username)) return res.status(409).json({ error: 'Username already exists' });
  const hash = bcrypt.hashSync(password, 10);
  const user = { id: safeUserId(), username, passwordHash: hash, role, createdAt: new Date().toISOString() };
  users.push(user);
  saveUserStore(users);
  await syncOpen5gsAccount(username, hash, role);
  res.status(201).json({ id: user.id, username: user.username, role: user.role, createdAt: user.createdAt });
});

// PUT /users/:id — update role (admin only)
app.put('/users/:id', requireAdmin, async (req, res) => {
  const users = loadUserStore();
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  if (users[idx].username === 'admin' && req.body.role && req.body.role !== 'admin')
    return res.status(400).json({ error: 'Cannot demote the built-in admin account' });
  const { role } = req.body;
  if (role && !['admin', 'researcher'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (role) users[idx].role = role;
  saveUserStore(users);
  await syncOpen5gsAccount(users[idx].username, users[idx].passwordHash, users[idx].role);
  res.json({ id: users[idx].id, username: users[idx].username, role: users[idx].role });
});

// PUT /users/:id/password — admin resets another user's password
app.put('/users/:id/password', requireAdmin, async (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8)
    return res.status(400).json({ error: 'newPassword must be at least 8 characters' });
  const users = loadUserStore();
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  users[idx].passwordHash = bcrypt.hashSync(newPassword, 10);
  saveUserStore(users);
  await syncOpen5gsAccount(users[idx].username, users[idx].passwordHash, users[idx].role);
  res.json({ ok: true });
});

// DELETE /users/:id — delete a user (admin only)
app.delete('/users/:id', requireAdmin, async (req, res) => {
  const users = loadUserStore();
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  if (users[idx].username === 'admin') return res.status(400).json({ error: 'Cannot delete the built-in admin account' });
  if (users[idx].id === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });
  const [removed] = users.splice(idx, 1);
  saveUserStore(users);
  await syncOpen5gsAccount(removed.username, '', removed.role, 'delete');
  res.json({ ok: true });
});

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
  // NEF (Free5GC)
  '5g-nef':       'nef',
  // CAMARA API Server
  '5g-camara-api': 'camara-api',
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
  // Check exit code — log non-zero results so silent failures are visible
  try {
    const info = await exec.inspect();
    if (info.ExitCode !== 0) {
      console.warn(`[runExec] non-zero exit ${info.ExitCode} for cmd: ${cmd.join(' ')}`);
    }
  } catch { /* inspect may fail for short-lived execs — ignore */ }
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
  // Check exit code — log non-zero so silent failures surface in API logs
  try {
    const info = await exec.inspect();
    if (info.ExitCode !== 0) {
      console.warn(`[runExecOutput] non-zero exit ${info.ExitCode} for cmd: ${cmd.join(' ')}`);
    }
  } catch { /* inspect may fail for short-lived execs — ignore */ }
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
  const owner     = req.user.id;
  const ownerName = req.user.username;

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
    const filename = `${ownerName}_${sessionId}_${target.label}.pcap`;
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

  const session = { label, startTime, captures, errors, status: captures.length > 0 ? 'running' : 'failed', owner, ownerName };
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

// GET /trace/sessions — list active sessions (admin sees all; researcher sees own)
app.get('/trace/sessions', (req, res) => {
  const list = [];
  for (const [id, s] of activeSessions) {
    if (req.user.role !== 'admin' && s.owner !== req.user.id) continue;
    list.push({ sessionId: id, label: s.label, startTime: s.startTime, status: s.status, ownerName: s.ownerName,
                captures: s.captures.map(c => ({ filename: c.filename, iface: c.iface, label: c.label })) });
  }
  res.json(list);
});

// GET /trace/download/:filename — serve a PCAP file (admin any; researcher own prefix)
app.get('/trace/download/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!/\.pcap$/.test(filename)) return res.status(400).json({ error: 'Only .pcap files allowed' });
  if (req.user.role !== 'admin' && !filename.startsWith(`${req.user.username}_`))
    return res.status(403).json({ error: 'Access denied' });
  const filepath = path.join(TRACES_DIR, filename);
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'File not found. Capture may still be running — stop it first.' });
  }
  res.download(filepath, filename);
});

// GET /trace/files — list PCAP files (admin sees all; researcher sees own)
app.get('/trace/files', (req, res) => {
  try {
    if (!fs.existsSync(TRACES_DIR)) return res.json([]);
    const prefix = `${req.user.username}_`;
    const files = fs.readdirSync(TRACES_DIR)
      .filter(f => f.endsWith('.pcap') && (req.user.role === 'admin' || f.startsWith(prefix)))
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

// DELETE /trace/files/:filename — delete a PCAP file (admin any; researcher own prefix)
app.delete('/trace/files/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!/\.pcap$/.test(filename)) return res.status(400).json({ error: 'Only .pcap files allowed' });
  if (req.user.role !== 'admin' && !filename.startsWith(`${req.user.username}_`))
    return res.status(403).json({ error: 'Access denied' });
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
  const nfs   = ['nrf','scp','amf','smf','upf','ausf','udm','udr','pcf','bsf','nssf','nef','gnb','ue1','ue2'];

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

// POST /ids/start — start IDS engine(s); optional body { engine: 'zeek-ids' | 'scapy-ids' }
app.post('/ids/start', async (req, res) => {
  const { engine } = req.body || {};
  const targets = engine ? IDS_ENGINES.filter(e => e.id === engine) : IDS_ENGINES;
  const results = [];
  for (const { id, container } of targets) {
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

// POST /ids/stop — stop IDS engine(s); optional body { engine: 'zeek-ids' | 'scapy-ids' }
app.post('/ids/stop', async (req, res) => {
  const { engine } = req.body || {};
  const targets = engine ? IDS_ENGINES.filter(e => e.id === engine) : IDS_ENGINES;
  const results = [];
  for (const { id, container } of targets) {
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

// ═══════════════════════════════════════════════════════════
// DDoS ATTACK SIMULATION — control-plane (NGAP) + data-plane (GTP-U)
// Runs Python/Scapy attack scripts inside the 5g-scapy-attacker container
// ═══════════════════════════════════════════════════════════

const ATTACKER_CONTAINER  = '5g-scapy-attacker';
const ATTACKER_RAN_IP     = '192.168.70.91';   // ran-net IP (UE-side source)
const ATTACKER_INTERNET_IP = '1.2.3.4';         // spoofed internet source IP

// Control-plane attack: NGAP SYN flood toward AMF N2 (port 38412)
const ATTACK_CP_SCRIPT = [
  'import sys,time,os',
  'from scapy.all import IP,TCP,send,conf',
  'conf.verb=0',
  'burst=int(sys.argv[1]);dur=float(sys.argv[2])*60;wait=float(sys.argv[3]);tgt=sys.argv[4]',
  "open('/tmp/atk.pid','w').write(str(os.getpid()))",
  'n=0;end=time.time()+dur',
  'try:',
  '    while time.time()<end:',
  '        n+=1;send([IP(dst=tgt)/TCP(dport=38412,flags="S") for _ in range(burst)])',
  "        print('burst '+str(n)+': '+str(burst)+' NGAP SYN -> '+tgt+':38412',flush=True)",
  '        time.sleep(wait)',
  "except Exception as e:print('err: '+str(e),flush=True)",
  'finally:',
  "    try:os.unlink('/tmp/atk.pid')",
  '    except:pass',
  "print('DONE',flush=True)",
].join('\n');

// Data-plane attack: GTP-U flood toward UPF N3 (port 2152)
const ATTACK_DP_SCRIPT = [
  'import sys,time,os,random',
  'from scapy.all import IP,UDP,Raw,send,conf',
  'conf.verb=0',
  'burst=int(sys.argv[1]);dur=float(sys.argv[2])*60;wait=float(sys.argv[3]);tgt=sys.argv[4];src=sys.argv[5]',
  `src_ip='${ATTACKER_RAN_IP}' if src=='ue' else '${ATTACKER_INTERNET_IP}'`,
  "open('/tmp/atk.pid','w').write(str(os.getpid()))",
  'n=0;end=time.time()+dur',
  'try:',
  '    while time.time()<end:',
  '        n+=1;pkts=[]',
  '        for _ in range(burst):',
  '            teid=random.randint(1,0xffffffff)',
  '            gtp=bytes([0x30,0xff,0x00,0x08])+teid.to_bytes(4,"big")+bytes([0,0,0,0])',
  '            pkts.append(IP(src=src_ip,dst=tgt)/UDP(sport=random.randint(1024,65535),dport=2152)/Raw(gtp))',
  '        send(pkts)',
  "        print('burst '+str(n)+': '+str(burst)+' GTP-U -> '+tgt+':2152 src:'+src_ip,flush=True)",
  '        time.sleep(wait)',
  "except Exception as e:print('err: '+str(e),flush=True)",
  'finally:',
  "    try:os.unlink('/tmp/atk.pid')",
  '    except:pass',
  "print('DONE',flush=True)",
].join('\n');

// In-memory attack tracking
let activeAttack = null;

// Helper: get primary IP of a container on a given network (or first network)
async function getContainerIp(containerName, preferNetwork = null) {
  try {
    const info = await docker.getContainer(containerName).inspect();
    const nets = info.NetworkSettings.Networks || {};
    if (preferNetwork && nets[preferNetwork]) return nets[preferNetwork].IPAddress;
    const first = Object.values(nets).find(n => n.IPAddress);
    return first ? first.IPAddress : null;
  } catch { return null; }
}

// GET /ddos/upfs — list UPF containers with their IPs (for data-plane target selection)
app.get('/ddos/upfs', async (req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });
    const upfContainers = containers.filter(c =>
      c.Labels?.['com.5g-testbed.type'] === '5gc-up' ||
      (c.Names || []).some(n => /upf/i.test(n))
    );
    const upfs = await Promise.all(upfContainers.map(async c => {
      const name = c.Names[0].replace('/', '');
      const ips = {};
      try {
        const info = await docker.getContainer(name).inspect();
        const nets = info.NetworkSettings.Networks || {};
        for (const [netName, netInfo] of Object.entries(nets)) {
          if (netInfo.IPAddress) ips[netName] = netInfo.IPAddress;
        }
      } catch {}
      return {
        containerName: name,
        label: c.Labels?.['com.5g-testbed.nf'] || name,
        running: c.State === 'running',
        ips,
        primaryIp: Object.values(ips)[0] || null,
      };
    }));
    res.json(upfs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /ddos/status — current attack state
app.get('/ddos/status', async (req, res) => {
  // Auto-expire if duration elapsed
  if (activeAttack && Date.now() > activeAttack.endTime) activeAttack = null;

  // Also check attacker container readiness
  let attackerReady = false;
  try {
    const info = await docker.getContainer(ATTACKER_CONTAINER).inspect();
    attackerReady = info.State.Running;
  } catch {}

  res.json({
    running:      !!activeAttack,
    attackerReady,
    attack:       activeAttack || null,
  });
});

// POST /ddos/start — launch a DDoS attack burst in the attacker container
// Body: { plane, burstSize, duration, waitSecs, targetContainer, source }
app.post('/ddos/start', async (req, res) => {
  if (activeAttack && Date.now() < activeAttack.endTime)
    return res.status(409).json({ error: 'Attack already running — stop it first' });

  const {
    plane         = 'control',
    burstSize     = 4,
    duration      = 1,
    waitSecs      = 5,
    targetContainer,   // data plane only: UPF container name
    source        = 'ue',
  } = req.body || {};

  if (!['control', 'data'].includes(plane))
    return res.status(400).json({ error: 'plane must be "control" or "data"' });
  if (plane === 'data' && !targetContainer)
    return res.status(400).json({ error: 'targetContainer required for data plane attack' });

  // Verify attacker container is running
  let attacker;
  try {
    attacker = docker.getContainer(ATTACKER_CONTAINER);
    const info = await attacker.inspect();
    if (!info.State.Running)
      return res.status(503).json({ error: 'Attacker container is not running. Start IDS stack first (make ids-up).' });
  } catch {
    return res.status(503).json({ error: 'Attacker container not found. Run: make ids-up' });
  }

  // Determine target IP
  let targetIp;
  if (plane === 'control') {
    // Attack AMF N2 NGAP port
    targetIp = await getContainerIp('open5gs-amf');
    if (!targetIp) return res.status(503).json({ error: 'Cannot resolve AMF IP' });
  } else {
    // Attack selected UPF GTP-U port
    targetIp = await getContainerIp(targetContainer);
    if (!targetIp) return res.status(503).json({ error: `Cannot resolve IP for ${targetContainer}` });
  }

  const script = plane === 'control' ? ATTACK_CP_SCRIPT : ATTACK_DP_SCRIPT;
  const scriptB64 = Buffer.from(script).toString('base64');

  try {
    // Write attack script into container
    await runExec(attacker, ['sh', '-c', `printf '%s' '${scriptB64}' | base64 -d > /tmp/atk.py`], 5000);

    // Launch attack in background (detached exec)
    const args = [burstSize, duration, waitSecs, targetIp];
    if (plane === 'data') args.push(source);
    const exec = await attacker.exec({
      Cmd: ['python3', '/tmp/atk.py', ...args.map(String)],
      AttachStdout: false,
      AttachStderr: false,
    });
    await exec.start({ Detach: true });

    activeAttack = {
      plane,
      burstSize:  Number(burstSize),
      duration:   Number(duration),
      waitSecs:   Number(waitSecs),
      targetIp,
      targetContainer: plane === 'data' ? targetContainer : 'open5gs-amf',
      source:     plane === 'data' ? source : null,
      startedAt:  new Date().toISOString(),
      endTime:    Date.now() + Number(duration) * 60 * 1000,
    };

    res.json({ ok: true, attack: activeAttack });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /ddos/stop — kill the running attack script in the attacker container
app.post('/ddos/stop', async (req, res) => {
  activeAttack = null;
  try {
    const attacker = docker.getContainer(ATTACKER_CONTAINER);
    await runExec(attacker, [
      'sh', '-c',
      'kill -9 $(cat /tmp/atk.pid 2>/dev/null) 2>/dev/null; rm -f /tmp/atk.pid /tmp/atk.py',
    ], 5000);
    res.json({ ok: true });
  } catch (e) {
    // Container may not exist or not be running — that's ok, attack is stopped
    res.json({ ok: true, warning: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// METRICS — Prometheus HTTP API proxy
// Allows the UI to query Prometheus without CORS issues
// ═══════════════════════════════════════════════════════════
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || 'http://prometheus:9090';

// GET /metrics/query?query=<promql> — instant query
app.get('/metrics/query', async (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: 'query param required' });
  try {
    const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    res.json(await r.json());
  } catch (e) {
    res.status(503).json({ status: 'error', error: `Prometheus unreachable: ${e.message}` });
  }
});

// GET /metrics/query_range?query=<promql>&minutes=30&step=30 — range query
app.get('/metrics/query_range', async (req, res) => {
  const { query, minutes = 30, step = 30 } = req.query;
  if (!query) return res.status(400).json({ error: 'query param required' });
  const end   = Math.floor(Date.now() / 1000);
  const start = end - Number(minutes) * 60;
  try {
    const url = `${PROMETHEUS_URL}/api/v1/query_range?query=${encodeURIComponent(query)}&start=${start}&end=${end}&step=${step}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    res.json(await r.json());
  } catch (e) {
    res.status(503).json({ status: 'error', error: `Prometheus unreachable: ${e.message}` });
  }
});

// ═══════════════════════════════════════════════════════════
// NEF — Network Exposure Function (Free5GC) Northbound API
// ═══════════════════════════════════════════════════════════
const NEF_BASE = process.env.NEF_URL || 'http://10.45.0.25:8000';

// GET /nef/status — NEF container state + NRF registration probe
app.get('/nef/status', async (req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });
    const nef        = containers.find(c => c.Names.some(n => n.includes('5g-nef')));
    const running    = nef?.State === 'running';

    // Probe NEF SBI to check if it's actually responding (registered with NRF)
    let reachable = false;
    if (running) {
      try {
        const r = await fetch(`${NEF_BASE}/nnef-pfdmanagement/v1/`, {
          signal: AbortSignal.timeout(2000),
        });
        reachable = r.status < 500;
      } catch { /* not yet up */ }
    }

    res.json({
      running,
      reachable,
      container : nef ? containerState(nef) : 'stopped',
      image     : nef?.Image || 'free5gc/nef:v3.4.3',
      ip        : '10.45.0.25',
      port      : 8000,
      nrfUri    : 'http://10.45.0.10:7777',
      services  : ['nnef-pfdmanagement', 'nnef-eventexposure', 'nnef-trafficinfluence'],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ALL /nef-api/* — Northbound API proxy → Free5GC NEF SBI
// Allows the UI (and external AFs) to call NEF APIs through the management API.
app.all('/nef-api/*', async (req, res) => {
  const nefPath = req.url.slice('/nef-api'.length) || '/';
  const opts    = {
    method : req.method,
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    signal : AbortSignal.timeout(10000),
  };
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body && Object.keys(req.body).length) {
    opts.body = JSON.stringify(req.body);
  }
  try {
    const upstream = await fetch(`${NEF_BASE}${nefPath}`, opts);
    const ct       = upstream.headers.get('content-type') || '';
    let body;
    try {
      body = ct.includes('json') ? await upstream.json() : await upstream.text();
    } catch {
      body = {};
    }
    res.status(upstream.status).json(body);
  } catch (err) {
    res.status(503).json({ error: 'NEF unreachable', detail: err.message, nefUrl: `${NEF_BASE}${nefPath}` });
  }
});

// ═══════════════════════════════════════════════════════════
// CAMARA API proxy  →  CAMARA API Server (5g-camara-api:8080)
// All /camara-api/* requests are forwarded transparently.
// ═══════════════════════════════════════════════════════════
const CAMARA_BASE = process.env.CAMARA_URL || 'http://5g-camara-api:8080';

app.all('/camara-api/*', async (req, res) => {
  const camaraPath = req.url.slice('/camara-api'.length) || '/';
  const opts = {
    method:  req.method,
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    signal:  AbortSignal.timeout(12000),
  };
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body && Object.keys(req.body).length) {
    opts.body = JSON.stringify(req.body);
  }
  try {
    const upstream = await fetch(`${CAMARA_BASE}${camaraPath}`, opts);
    const ct   = upstream.headers.get('content-type') || '';
    let body;
    try { body = ct.includes('json') ? await upstream.json() : await upstream.text(); }
    catch { body = {}; }
    res.status(upstream.status).json(body);
  } catch (err) {
    res.status(503).json({
      error:    'CAMARA API server unreachable',
      detail:   err.message,
      camaraUrl: `${CAMARA_BASE}${camaraPath}`,
      hint:     'Run: make camara-up',
    });
  }
});

// ═══════════════════════════════════════════════════════════
// SUBSCRIBERS — live CRUD against Open5GS MongoDB
// ═══════════════════════════════════════════════════════════

// Shared helper: build the full Open5GS subscriber document
// Input: { imsi, key, opc, dnn, sst, sd, ambrDl, ambrUl }
function buildSubDoc(s) {
  const dl = s.ambrDl || 1024, ul = s.ambrUl || 1024;
  const sd = (s.sd || '000000').replace(/^0x/i, '');
  return `{
    imsi: '${s.imsi}', msisdn: [], imeisv: '4301816488979312',
    mme_host: [], mme_realm: [], purge_flag: [],
    security: { k: '${s.key}', op: null, opc: '${s.opc}', amf: '8000', sqn: NumberLong(64) },
    ambr: { downlink: { value: ${dl}, unit: 3 }, uplink: { value: ${ul}, unit: 3 } },
    slice: [{ sst: ${Number(s.sst) || 1}, sd: '0x${sd}', default_indicator: true,
      session: [{ name: '${s.dnn || 'internet'}', type: 3, pcc_rule: [],
        ambr: { downlink: { value: ${dl}, unit: 3 }, uplink: { value: ${ul}, unit: 3 } },
        qos: { index: 9, arp: { priority_level: 8, pre_emption_capability: 1, pre_emption_vulnerability: 1 } },
        ue: { addr: '0.0.0.0' }
      }]
    }],
    access_restriction_data: 32, subscriber_status: 0,
    network_access_mode: 0, subscribed_rau_tau_timer: 12, __v: 0
  }`;
}

// Normalize a raw MongoDB subscriber doc into a flat UI object
function normalizeSub(d) {
  const slice   = (d.slice || [])[0] || {};
  const session = (slice.session || [])[0] || {};
  const rawSd   = (slice.sd || '000000').replace(/^0x/i, '');
  return {
    imsi:   d.imsi || '',
    key:    (d.security || {}).k   || '',
    opc:    (d.security || {}).opc || '',
    dnn:    session.name  || 'internet',
    sst:    slice.sst     || 1,
    sd:     rawSd,
    ambrDl: ((d.ambr || {}).downlink || {}).value || 1024,
    ambrUl: ((d.ambr || {}).uplink   || {}).value || 1024,
  };
}

// GET /subscribers — list all from MongoDB
app.get('/subscribers', async (req, res) => {
  try {
    const mongo  = docker.getContainer('open5gs-mongodb');
    const script = `
      var docs = db.getSiblingDB('open5gs').subscribers.find({}).toArray();
      var out  = docs.map(function(d) {
        var sl = (d.slice||[])[0]||{}, se = (sl.session||[])[0]||{};
        return { imsi: d.imsi,
          key:  (d.security||{}).k   || '',
          opc:  (d.security||{}).opc || '',
          dnn:  se.name  || 'internet',
          sst:  sl.sst   || 1,
          sd:   ((sl.sd||'000000').replace(/^0x/i,'')),
          ambrDl: ((d.ambr||{}).downlink||{}).value || 1024,
          ambrUl: ((d.ambr||{}).uplink  ||{}).value || 1024 };
      });
      print(JSON.stringify(out));
    `;
    const raw = await runExecOutput(mongo, ['mongosh', '--quiet', '--eval', script], 10000);
    // Extract JSON from output (ignore any mongosh preamble lines)
    const jsonLine = raw.split('\n').find(l => l.trim().startsWith('['));
    res.json(jsonLine ? JSON.parse(jsonLine) : []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /subscribers — create subscriber in MongoDB
app.post('/subscribers', async (req, res) => {
  const { imsi } = req.body;
  if (!imsi || !/^\d{15}$/.test(imsi))
    return res.status(400).json({ error: 'imsi must be 15 digits' });
  try {
    const mongo  = docker.getContainer('open5gs-mongodb');
    // Check for duplicate
    const chk = await runExecOutput(mongo,
      ['mongosh','--quiet','--eval',
       `db.getSiblingDB('open5gs').subscribers.countDocuments({imsi:'${imsi}'})`], 5000);
    if (/^\s*[1-9]/.test(chk.trim()))
      return res.status(409).json({ error: 'IMSI already exists in MongoDB' });
    const script = `
      db.getSiblingDB('open5gs').subscribers.insertOne(${buildSubDoc(req.body)});
      print('ok');
    `;
    await runExecOutput(mongo, ['mongosh','--quiet','--eval', script], 15000);
    res.json({ ok: true, imsi });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /subscribers/:imsi — update subscriber (replace document)
app.put('/subscribers/:imsi', async (req, res) => {
  const { imsi } = req.params;
  try {
    const mongo  = docker.getContainer('open5gs-mongodb');
    const script = `
      db.getSiblingDB('open5gs').subscribers.deleteOne({ imsi: '${imsi}' });
      db.getSiblingDB('open5gs').subscribers.insertOne(${buildSubDoc({ ...req.body, imsi })});
      print('ok');
    `;
    await runExecOutput(mongo, ['mongosh','--quiet','--eval', script], 15000);
    res.json({ ok: true, imsi });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /subscribers/:imsi — remove subscriber from MongoDB
app.delete('/subscribers/:imsi', async (req, res) => {
  try {
    const mongo  = docker.getContainer('open5gs-mongodb');
    const script = `
      var r = db.getSiblingDB('open5gs').subscribers.deleteOne({ imsi: '${req.params.imsi}' });
      print(r.deletedCount === 1 ? 'ok' : 'notfound');
    `;
    const out = await runExecOutput(mongo, ['mongosh','--quiet','--eval', script], 10000);
    if (out.includes('notfound')) return res.status(404).json({ error: 'IMSI not found in MongoDB' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// UE MANAGER — simulated UE config + Open5GS subscriber reg
// ═══════════════════════════════════════════════════════════

const UE_STORE_PATH = process.env.UE_STORE || '/data/ues.json';

function loadUeStore() {
  try {
    if (fs.existsSync(UE_STORE_PATH)) return JSON.parse(fs.readFileSync(UE_STORE_PATH, 'utf8'));
  } catch (e) { console.error('[UE] store read error:', e.message); }
  return [];
}

function saveUeStore(ues) {
  try {
    const dir = path.dirname(UE_STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(UE_STORE_PATH, JSON.stringify(ues, null, 2));
  } catch (e) { console.error('[UE] store write error:', e.message); }
}

function ueDefaults(imsi) {
  return {
    imsi,
    key:    'fec86ba6eb707ed08905757b1bb44b8f',
    opc:    'C42449363BBAD02B66D16BC975D77CC1',
    dnn:    'internet',
    sst:    1,
    sd:     '000000',
    ambrDl: 1024,
    ambrUl: 1024,
    registered:  false,
    createdAt:   new Date().toISOString(),
  };
}

// IMSI → UERANSIM container: static fallback + dynamic Docker-label lookup
const IMSI_STATIC = {
  '001010000000001': 'ueransim-ue1',
  '001010000000002': 'ueransim-ue2',
};

async function resolveImsiToContainer(imsi) {
  if (IMSI_STATIC[imsi]) {
    try { await docker.getContainer(IMSI_STATIC[imsi]).inspect(); return IMSI_STATIC[imsi]; } catch {}
  }
  const containers = await docker.listContainers({ all: true });
  const match = containers.find(c => c.Labels?.['com.5g-testbed.imsi'] === imsi);
  return match ? match.Names[0].replace('/', '') : null;
}

// Generate UERANSIM nr-ue YAML config for an arbitrary IMSI
function generateUeYaml({ imsi, key, opc, dnn = 'internet', sst = 1, sd = '000000', mcc = '001', mnc = '01' }) {
  const sdHex = sd && sd !== '000000' ? sd : null;
  return [
    `supi: 'imsi-${imsi}'`,
    `mcc: '${mcc}'`,
    `mnc: '${mnc}'`,
    `key: '${key}'`,
    `op:  '${opc}'`,
    `opType: 'OPC'`,
    `amf: '8000'`,
    `imei:   '35693803564${String(Date.now() % 10000).padStart(4, '0')}'`,
    `imeiSv: '4370816125816151'`,
    ``,
    `gnbSearchList:`,
    `  - 192.168.70.20`,
    ``,
    `uacAic: {mps: false, mcs: false}`,
    `uacAcc: {normalClass: 0, class11: false, class12: false, class13: false, class14: false, class15: false}`,
    ``,
    `sessions:`,
    `  - type: 'IPv4'`,
    `    apn: '${dnn}'`,
    `    slice: {sst: ${sst}${sdHex ? `, sd: 0x${sdHex}` : ''}}`,
    ``,
    `configured-nssai:`,
    `  - sst: ${sst}${sdHex ? `\n    sd: 0x${sdHex}` : ''}`,
    ``,
    `default-nssai:`,
    `  - sst: ${sst}`,
    `    sd: 1`,
    ``,
    `integrity: {IA1: true, IA2: true, IA3: true}`,
    `ciphering: {EA1: true, EA2: true, EA3: true}`,
    `integrityMaxRate: {uplink: 'full', downlink: 'full'}`,
  ].join('\n');
}

// Find next available UE label (ue3, ue4, …)
async function nextUeLabel() {
  const containers = await docker.listContainers({ all: true });
  const taken = new Set(containers.map(c => c.Labels?.['com.5g-testbed.nf']).filter(Boolean));
  taken.add('ue1'); taken.add('ue2');
  let n = 3;
  while (taken.has(`ue${n}`)) n++;
  return `ue${n}`;
}

// Build mongosh script to upsert a subscriber document
function buildMongoInsert(ue) {
  return `
    var db = db.getSiblingDB('open5gs');
    db.subscribers.deleteOne({ imsi: '${ue.imsi}' });
    var r = db.subscribers.insertOne({
      imsi: '${ue.imsi}',
      msisdn: [], imeisv: '4301816488979312',
      mme_host: [], mme_realm: [], purge_flag: [],
      security: { k: '${ue.key}', op: null, opc: '${ue.opc}', amf: '8000', sqn: NumberLong(64) },
      ambr: {
        downlink: { value: ${ue.ambrDl || 1024}, unit: 3 },
        uplink:   { value: ${ue.ambrUl || 1024}, unit: 3 }
      },
      slice: [{
        sst: ${ue.sst}, sd: '0x${ue.sd || '000000'}', default_indicator: true,
        session: [{
          name: '${ue.dnn}', type: 3, pcc_rule: [],
          ambr: {
            downlink: { value: ${ue.ambrDl || 1024}, unit: 3 },
            uplink:   { value: ${ue.ambrUl || 1024}, unit: 3 }
          },
          qos: { index: 9, arp: { priority_level: 8, pre_emption_capability: 1, pre_emption_vulnerability: 1 } },
          ue: { addr: '0.0.0.0' }
        }]
      }],
      access_restriction_data: 32, subscriber_status: 0,
      network_access_mode: 0, subscribed_rau_tau_timer: 12, __v: 0
    });
    print(r.insertedId ? 'ok' : 'fail');
  `;
}

// GET /ue — list configured UEs (admin sees all; researcher sees own)
app.get('/ue', (req, res) => {
  const ues = loadUeStore();
  res.json(req.user.role === 'admin' ? ues : ues.filter(u => u.owner === req.user.id));
});

// POST /ue — create UE (IMSI required, rest auto-filled); owner = current user
app.post('/ue', (req, res) => {
  const ues = loadUeStore();
  const { imsi } = req.body;
  if (!imsi || !/^\d{15}$/.test(imsi))
    return res.status(400).json({ error: 'imsi must be exactly 15 digits' });
  if (ues.find(u => u.imsi === imsi))
    return res.status(409).json({ error: 'IMSI already exists' });
  const ue = { ...ueDefaults(imsi), ...req.body, imsi, registered: false, owner: req.user.id };
  ues.push(ue);
  saveUeStore(ues);
  res.json(ue);
});

// PUT /ue/:imsi — update editable UE fields (owner or admin)
app.put('/ue/:imsi', (req, res) => {
  const ues = loadUeStore();
  const idx = ues.findIndex(u => u.imsi === req.params.imsi);
  if (idx === -1) return res.status(404).json({ error: 'UE not found' });
  if (!ownsUe(req, ues[idx])) return res.status(403).json({ error: 'Access denied' });
  // Protect identity/lifecycle fields from being overwritten
  const { imsi: _i, registered: _r, createdAt: _c, owner: _o, ...editable } = req.body;
  ues[idx] = { ...ues[idx], ...editable, updatedAt: new Date().toISOString() };
  saveUeStore(ues);
  res.json(ues[idx]);
});

// DELETE /ue/:imsi — remove UE from local store (owner or admin)
app.delete('/ue/:imsi', (req, res) => {
  let ues = loadUeStore();
  const ue = ues.find(u => u.imsi === req.params.imsi);
  if (!ue) return res.status(404).json({ error: 'UE not found' });
  if (!ownsUe(req, ue)) return res.status(403).json({ error: 'Access denied' });
  ues = ues.filter(u => u.imsi !== req.params.imsi);
  saveUeStore(ues);
  res.json({ ok: true });
});

// POST /ue/:imsi/register — insert subscriber into Open5GS MongoDB
app.post('/ue/:imsi/register', async (req, res) => {
  const ues = loadUeStore();
  const ue = ues.find(u => u.imsi === req.params.imsi);
  if (!ue) return res.status(404).json({ error: 'UE not found in store' });
  try {
    const mongo = docker.getContainer('open5gs-mongodb');
    const out = await runExecOutput(mongo,
      ['mongosh', '--quiet', '--eval', buildMongoInsert(ue)], 15000);
    const idx = ues.findIndex(u => u.imsi === ue.imsi);
    ues[idx].registered   = true;
    ues[idx].registeredAt = new Date().toISOString();
    saveUeStore(ues);
    res.json({ ok: true, output: out.trim() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /ue/:imsi/register — remove subscriber from MongoDB (deregister)
app.delete('/ue/:imsi/register', async (req, res) => {
  const ues = loadUeStore();
  const ue = ues.find(u => u.imsi === req.params.imsi);
  if (!ue) return res.status(404).json({ error: 'UE not found' });
  try {
    const mongo = docker.getContainer('open5gs-mongodb');
    const script = `db.getSiblingDB('open5gs').subscribers.deleteOne({ imsi: '${ue.imsi}' }); print('ok');`;
    await runExecOutput(mongo, ['mongosh', '--quiet', '--eval', script], 10000);
    const idx = ues.findIndex(u => u.imsi === ue.imsi);
    ues[idx].registered = false;
    saveUeStore(ues);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /ue/:imsi/status — tunnel IP + container state + MongoDB presence
app.get('/ue/:imsi/status', async (req, res) => {
  const ues = loadUeStore();
  const ue = ues.find(u => u.imsi === req.params.imsi);
  if (!ue) return res.status(404).json({ error: 'UE not found' });

  const containerName = await resolveImsiToContainer(ue.imsi);
  let tunIp = null, cState = 'none', cRunning = false;
  if (containerName) {
    try {
      const info = await docker.getContainer(containerName).inspect();
      cState   = info.State.Status;
      cRunning = info.State.Running;
      if (cRunning) tunIp = await getUeTunIp(docker.getContainer(containerName));
    } catch {}
  }

  // Verify subscriber is in MongoDB
  let inMongo = false;
  try {
    const mongo = docker.getContainer('open5gs-mongodb');
    const out = await runExecOutput(mongo,
      ['mongosh', '--quiet', '--eval',
       `db.getSiblingDB('open5gs').subscribers.countDocuments({ imsi: '${ue.imsi}' })`], 5000);
    inMongo = /^\s*1\s*/.test(out.trim());
  } catch {}

  res.json({
    imsi: ue.imsi, registered: ue.registered, inMongo,
    containerName, containerState: cState, containerRunning: cRunning,
    tunIp: tunIp || null, hasPduSession: !!tunIp,
  });
});

// POST /ue/:imsi/ping — ICMP ping via PDU session tunnel
app.post('/ue/:imsi/ping', async (req, res) => {
  const { target = '8.8.8.8', count = 4 } = req.body || {};
  const containerName = await resolveImsiToContainer(req.params.imsi);
  if (!containerName)
    return res.status(400).json({ error: 'No UERANSIM container mapped for this IMSI' });
  try {
    const c = docker.getContainer(containerName);
    const tunIp = await getUeTunIp(c);
    if (!tunIp)
      return res.status(400).json({ error: 'No PDU session tunnel active (uesimtun0 not found)' });
    const out = await runExecOutput(c,
      ['sh', '-c', `ping -c ${Math.min(Number(count), 10)} -W 2 -I ${tunIp} ${target} 2>&1`], 30000);
    res.json({ ok: true, output: out, tunIp, target });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// UE MANAGER — PDU session control + NAS status (nr-cli)
// ═══════════════════════════════════════════════════════════

// Run an nr-cli command inside a UERANSIM container
// Tries /ueransim/build/nr-cli first, falls back to PATH
async function runNrCli(containerName, imsi, cmd, timeout = 12000) {
  const c   = docker.getContainer(containerName);
  const key = `imsi-${imsi}`;
  // Use sh -c so the fallback chain works without extra exec calls
  const shell = `nr-cli ${key} --exec '${cmd}' 2>&1 || /ueransim/build/nr-cli ${key} --exec '${cmd}' 2>&1`;
  return (await runExecOutput(c, ['sh', '-c', shell], timeout)).trim();
}

// Parse UERANSIM ps-list output into [{psi, state, type, dnn, ip}]
function parsePsList(raw) {
  const sessions = [];
  // Split on "PDU Session[N]" blocks
  const blocks = raw.split(/(?=PDU Session\s*\[?\d+\]?)/i);
  for (const block of blocks) {
    const psiM = block.match(/PDU Session\s*\[?(\d+)\]?/i);
    if (!psiM) continue;
    const get = (keys) => {
      for (const k of keys) {
        const m = block.match(new RegExp(`${k}\\s*[:\\[\\s]\\s*([^\\]\\n]+)`, 'i'));
        if (m) return m[1].replace(/\].*/, '').trim();
      }
      return null;
    };
    sessions.push({
      psi:   parseInt(psiM[1]),
      state: get(['State', 'status']),
      type:  get(['Session Type', 'session-type', 'Type']),
      dnn:   get(['APN/DNN', 'DNN', 'apn']),
      ip:    get(['Address', 'PDU address', 'IP', 'IPv4']),
    });
  }
  return sessions;
}

// Parse UERANSIM UE status output into flat object
function parseNasStatus(raw) {
  const get = (keys) => {
    for (const k of keys) {
      const m = raw.match(new RegExp(`${k}\\s*[:\\[\\s]\\s*([^\\]\\n]+)`, 'i'));
      if (m) return m[1].replace(/\].*/, '').trim();
    }
    return null;
  };
  return {
    cmState:  get(['cm-state', 'CM-STATE']),
    mmState:  get(['mm-state', '5GMM-STATE', '5gmm-state']),
    rmState:  get(['rm-state', 'RM-STATE']),
    sim:      get(['sim-inserted']),
  };
}

// GET /ue/:imsi/sessions — list active PDU sessions via nr-cli ps-list
app.get('/ue/:imsi/sessions', async (req, res) => {
  const { imsi } = req.params;
  const cn = await resolveImsiToContainer(imsi);
  if (!cn) return res.status(400).json({ error: 'No UERANSIM container mapped for this IMSI' });
  try {
    const out  = await runNrCli(cn, imsi, 'ps-list');
    res.json({ ok: true, output: out, sessions: parsePsList(out) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /ue/:imsi/sessions — establish a new PDU session
// body: { type:'IPv4'|'IPv6'|'IPv4v6', dnn, sst, sd }
app.post('/ue/:imsi/sessions', async (req, res) => {
  const { imsi } = req.params;
  const cn = await resolveImsiToContainer(imsi);
  if (!cn) return res.status(400).json({ error: 'No UERANSIM container mapped for this IMSI' });
  const { type = 'IPv4', dnn, sst, sd } = req.body || {};
  // Validate type
  if (!['IPv4','IPv6','IPv4v6'].includes(type))
    return res.status(400).json({ error: 'type must be IPv4, IPv6, or IPv4v6' });
  let cmd = `ps-establish ${type}`;
  if (sst)  cmd += ` --sst ${Number(sst)}`;
  if (sd)   cmd += ` --sd ${sd.replace(/^0x/i, '')}`;
  if (dnn)  cmd += ` --dnn ${dnn}`;
  try {
    const out = await runNrCli(cn, imsi, cmd, 25000);
    res.json({ ok: true, output: out, cmd });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /ue/:imsi/sessions — release all PDU sessions (ps-release-all)
app.delete('/ue/:imsi/sessions', async (req, res) => {
  const { imsi } = req.params;
  const cn = await resolveImsiToContainer(imsi);
  if (!cn) return res.status(400).json({ error: 'No UERANSIM container mapped for this IMSI' });
  try {
    const out = await runNrCli(cn, imsi, 'ps-release-all', 20000);
    res.json({ ok: true, output: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /ue/:imsi/sessions/:psi — release a specific PDU session by PSI
app.delete('/ue/:imsi/sessions/:psi', async (req, res) => {
  const { imsi, psi } = req.params;
  const cn = await resolveImsiToContainer(imsi);
  if (!cn) return res.status(400).json({ error: 'No UERANSIM container mapped for this IMSI' });
  const psiN = parseInt(psi);
  if (isNaN(psiN) || psiN < 1 || psiN > 15)
    return res.status(400).json({ error: 'PSI must be 1–15' });
  try {
    const out = await runNrCli(cn, imsi, `ps-release ${psiN}`, 20000);
    res.json({ ok: true, output: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /ue/:imsi/nas-status — NAS / CM state from nr-cli status
app.get('/ue/:imsi/nas-status', async (req, res) => {
  const { imsi } = req.params;
  const cn = await resolveImsiToContainer(imsi);
  if (!cn) return res.status(400).json({ error: 'No UERANSIM container mapped for this IMSI' });
  try {
    const out = await runNrCli(cn, imsi, 'status', 10000);
    res.json({ ok: true, output: out, parsed: parseNasStatus(out) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /ue/:imsi/nas-deregister — NAS de-registration via nr-cli
// body: { type: 'normal'|'switch-off'|'disable-5g' }
app.post('/ue/:imsi/nas-deregister', async (req, res) => {
  const { imsi } = req.params;
  const cn = await resolveImsiToContainer(imsi);
  if (!cn) return res.status(400).json({ error: 'No UERANSIM container mapped for this IMSI' });
  const type = ['normal', 'switch-off', 'disable-5g'].includes(req.body?.type)
    ? req.body.type : 'normal';
  try {
    const out = await runNrCli(cn, imsi, `deregister ${type}`, 20000);
    res.json({ ok: true, output: out, type });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// UE LIFECYCLE — dynamic provisioning / deprovisioning
// ═══════════════════════════════════════════════════════════

// GET /ue/inventory — merged view: UE store + Docker containers + MongoDB subscribers
app.get('/ue/inventory', async (req, res) => {
  try {
    // 1. All UE-type Docker containers (label or name pattern)
    const allContainers = await docker.listContainers({ all: true });
    const ueContainers  = allContainers.filter(c =>
      c.Labels?.['com.5g-testbed.type'] === 'ue' ||
      c.Names.some(n => /\/ueransim-ue\d+/.test(n))
    );
    const containerByName = {};
    for (const c of ueContainers) containerByName[c.Names[0].replace('/', '')] = c;

    // 2. MongoDB IMSIs
    let mongoImsis = [];
    try {
      const mongo = docker.getContainer('open5gs-mongodb');
      const out = await runExecOutput(mongo, ['mongosh', '--quiet', '--eval',
        `JSON.stringify(Array.from(db.getSiblingDB('open5gs').subscribers.find({},{imsi:1,_id:0})))`], 8000);
      const line = out.split('\n').find(l => l.trim().startsWith('['));
      if (line) mongoImsis = JSON.parse(line).map(s => s.imsi);
    } catch {}

    // 3. UE store (credentials + labels), filtered by owner
    const allUeStore = loadUeStore();
    const ueStore = req.user.role === 'admin'
      ? allUeStore
      : allUeStore.filter(u => u.owner === req.user.id);

    // Helper: build result entry from container + optional store entry
    async function makeEntry(imsi, storEntry, containerName) {
      const c = containerName ? containerByName[containerName] : null;
      let tunIp = null;
      if (c?.State === 'running') {
        try { tunIp = await getUeTunIp(docker.getContainer(containerName)); } catch {}
      }
      return {
        imsi,
        label:           storEntry?.label || (IMSI_STATIC[imsi] ? IMSI_STATIC[imsi].replace('ueransim-', '') : null),
        key:             storEntry?.key  || null,
        opc:             storEntry?.opc  || null,
        dnn:             storEntry?.dnn  || null,
        sst:             storEntry?.sst  || null,
        sd:              storEntry?.sd   || null,
        owner:           storEntry?.owner || null,
        containerName:   containerName   || null,
        containerState:  c?.State        || 'none',
        containerRunning: c?.State === 'running',
        tunIp,
        inMongo:         mongoImsis.includes(imsi),
        provisioned:     !!containerName,
        dynamic:         !IMSI_STATIC[imsi],
      };
    }

    const result = [];
    const seen   = new Set();

    // From UE store
    for (const ue of ueStore) {
      seen.add(ue.imsi);
      const staticCn = IMSI_STATIC[ue.imsi];
      const dynC = ueContainers.find(c => c.Labels?.['com.5g-testbed.imsi'] === ue.imsi);
      const cn = ue.containerName ||
        (staticCn && containerByName[staticCn] ? staticCn : null) ||
        (dynC ? dynC.Names[0].replace('/', '') : null);
      result.push(await makeEntry(ue.imsi, ue, cn));
    }

    // Containers not yet in UE store (e.g. ue1 before user adds it)
    for (const c of ueContainers) {
      const cn        = c.Names[0].replace('/', '');
      const imsiLabel = c.Labels?.['com.5g-testbed.imsi'];
      const staticImsi = Object.entries(IMSI_STATIC).find(([, name]) => name === cn)?.[0];
      const imsi = imsiLabel || staticImsi;
      if (!imsi || seen.has(imsi)) continue;
      seen.add(imsi);
      result.push(await makeEntry(imsi, null, cn));
    }

    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /ue/provision — create and start a UERANSIM container for a UE in the store
app.post('/ue/provision', async (req, res) => {
  const { imsi } = req.body || {};
  if (!imsi) return res.status(400).json({ error: 'imsi required' });

  const ues = loadUeStore();
  const ue  = ues.find(u => u.imsi === imsi);
  if (!ue) return res.status(404).json({ error: 'UE not in store — add it in the Config tab first' });
  if (!ownsUe(req, ue)) return res.status(403).json({ error: 'Access denied' });

  const containers = await docker.listContainers({ all: true });
  const staticCn   = IMSI_STATIC[imsi];

  // Static container (ue1/ue2): just start if it exists but is stopped
  if (staticCn) {
    const existing = containers.find(c => c.Names.some(n => n.includes(staticCn)));
    if (existing) {
      if (existing.State !== 'running') await docker.getContainer(staticCn).start();
      return res.json({ ok: true, containerName: staticCn, label: staticCn.replace('ueransim-', ''), existed: true });
    }
    // Fall through: static container not created yet — create dynamically
  }

  // Check for existing dynamic container
  const dynExisting = containers.find(c => c.Labels?.['com.5g-testbed.imsi'] === imsi);
  if (dynExisting) {
    const cn = dynExisting.Names[0].replace('/', '');
    if (dynExisting.State !== 'running') await docker.getContainer(cn).start();
    return res.json({ ok: true, containerName: cn, label: dynExisting.Labels?.['com.5g-testbed.nf'], existed: true });
  }

  // Create new container with config embedded in the start command
  const label         = staticCn ? staticCn.replace('ueransim-', '') : await nextUeLabel();
  const containerName = staticCn || `ueransim-${label}`;
  const mcc           = process.env.MCC || '001';
  const mnc           = process.env.MNC || '01';
  const yaml          = generateUeYaml({ imsi, key: ue.key, opc: ue.opc, dnn: ue.dnn || 'internet',
    sst: ue.sst || 1, sd: ue.sd || '000000', mcc, mnc });
  const b64           = Buffer.from(yaml).toString('base64');

  // Locate the project ran-net
  const nets   = await docker.listNetworks();
  const ranNet = nets.find(n => n.Name.endsWith('_ran-net') || n.Name === 'ran-net');
  if (!ranNet) return res.status(500).json({ error: 'ran-net not found — is the testbed running?' });

  try {
    const container = await docker.createContainer({
      Image: 'towards5gs/ueransim:v3.2.6',
      name:  containerName,
      Cmd:   ['sh', '-c', `printf '%s' '${b64}' | base64 -d > /tmp/ue.yaml && exec nr-ue -c /tmp/ue.yaml`],
      HostConfig: {
        CapAdd:        ['NET_ADMIN'],
        Devices:       [{ PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' }],
        RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 5 },
        NetworkMode:   ranNet.Name,
      },
      Labels: {
        'com.5g-testbed.nf':      label,
        'com.5g-testbed.type':    'ue',
        'com.5g-testbed.imsi':    imsi,
        'com.5g-testbed.managed': 'dynamic',
      },
    });
    await container.start();

    // Persist label + containerName in UE store
    const idx = ues.findIndex(u => u.imsi === imsi);
    ues[idx].label         = label;
    ues[idx].containerName = containerName;
    saveUeStore(ues);

    res.json({ ok: true, label, containerName, imsi });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /ue/:containerName/deprovision — stop + remove a dynamic UE container
app.delete('/ue/:containerName/deprovision', async (req, res) => {
  const { containerName } = req.params;
  try {
    const c    = docker.getContainer(containerName);
    const info = await c.inspect();
    const isDynamic = info.Config?.Labels?.['com.5g-testbed.managed'] === 'dynamic';

    if (!isDynamic && IMSI_STATIC[Object.keys(IMSI_STATIC).find(k => IMSI_STATIC[k] === containerName)]) {
      return res.status(400).json({ error: `${containerName} is a static UE. Stop it via the Start/Stop button instead.` });
    }

    const imsi = info.Config?.Labels?.['com.5g-testbed.imsi'];
    if (info.State.Running) await c.stop({ t: 5 });
    await c.remove();

    // Clear container ref from UE store (keep credentials)
    if (imsi) {
      const ues = loadUeStore();
      const idx = ues.findIndex(u => u.imsi === imsi);
      if (idx !== -1) { delete ues[idx].containerName; delete ues[idx].label; saveUeStore(ues); }
    }
    res.json({ ok: true, containerName, imsi });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 404 ───────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[5G-API] Testbed API listening on :${PORT}`);
  console.log(`[5G-API] Docker socket : ${process.env.DOCKER_SOCKET || '/var/run/docker.sock'}`);
  console.log(`[5G-API] Traces dir   : ${TRACES_DIR}`);
  await seedAdminUser();
});
