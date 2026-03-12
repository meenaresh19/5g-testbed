'use strict';
// ============================================================
// CAMARA API Server — 5G Testbed
// Exposes CAMARA-Project standardised REST APIs on top of
// Open5GS + Free5GC NEF.  All 3GPP-specific calls are routed
// through the management API server which acts as a gateway.
//
// CAMARA APIs implemented (https://camaraproject.org):
//   device-status/v0.6          — UE connectivity & roaming
//   location-verification/v0.2  — UE location verification
//   qod/v0.10                   — Quality on Demand sessions
//   device-reachability/v0      — UE reachability subscriptions
//   simple-edge-discovery/v1    — MEC platform discovery
//
// Architecture:
//   CAMARA API  ──►  Management API ──► Docker / NEF / Open5GS
// ============================================================

const express = require('express');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT        = process.env.PORT         || 8080;
const MGMT_URL    = process.env.MGMT_API_URL || 'http://5g-testbed-api:5000';
const MCC         = process.env.MCC          || '001';
const MNC         = process.env.MNC          || '01';

// ── In-memory stores ──────────────────────────────────────
const qodSessions       = new Map();   // sessionId → session object
const reachSubs         = new Map();   // subscriptionId → sub object
const notifications     = [];          // last 50 CAMARA callbacks

const MAX_NOTIFICATIONS = 50;

// ── Helpers ───────────────────────────────────────────────

/** GET <MGMT_URL>/status and return the parsed JSON (or null). */
async function getMgmtStatus() {
  try {
    const r = await fetch(`${MGMT_URL}/status`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/** Call <MGMT_URL>/nef-api<path> with optional opts. */
async function callNef(nefPath, opts = {}) {
  const url = `${MGMT_URL}/nef-api${nefPath}`;
  const defaults = {
    method:  'GET',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    signal:  AbortSignal.timeout(8000),
  };
  try {
    const r = await fetch(url, { ...defaults, ...opts });
    const ct = r.headers.get('content-type') || '';
    const body = ct.includes('json') ? await r.json() : await r.text();
    return { ok: r.ok, status: r.status, body };
  } catch (err) {
    return { ok: false, status: 503, body: { error: err.message } };
  }
}

/**
 * Map a ueId string to a connectivity status.
 * ueId can be: "ue1" | "ue2" | IMSI (15-digit) | short-IMSI (last digits)
 */
async function resolveConnectivity(ueId) {
  const status = await getMgmtStatus();
  if (!status) return 'NOT_CONNECTED';

  const id = (ueId || '').trim().toLowerCase();

  // Direct match: "ue1", "ue2"
  if (status[id] !== undefined) {
    return status[id] === 'running' ? 'CONNECTED_DATA' : 'NOT_CONNECTED';
  }

  // IMSI mapping: 001010000000001 → ue1, 001010000000002 → ue2
  const imsiMap = {
    [`${MCC}${MNC}0000000001`]: 'ue1',
    [`${MCC}${MNC}0000000002`]: 'ue2',
  };
  const mapped = imsiMap[id.replace(/^imsi-/, '')];
  if (mapped && status[mapped] !== undefined) {
    return status[mapped] === 'running' ? 'CONNECTED_DATA' : 'NOT_CONNECTED';
  }

  // GNB running means at least SMS/signalling possible
  if (status.gnb === 'running') return 'CONNECTED_SMS';

  return 'NOT_CONNECTED';
}

/** Generate a unique ID. */
const uid = (prefix = 'id') =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/** Push to notifications ring buffer. */
function addNotification(type, data) {
  notifications.unshift({ receivedAt: new Date().toISOString(), type, data });
  if (notifications.length > MAX_NOTIFICATIONS) notifications.length = MAX_NOTIFICATIONS;
}

// ── CAMARA error helper ────────────────────────────────────
const camaraErr = (res, httpStatus, code, msg) =>
  res.status(httpStatus).json({ status: httpStatus, code, message: msg });

// ============================================================
// 1. DEVICE STATUS API  (CAMARA device-status v0.6)
//    Spec: https://github.com/camaraproject/DeviceStatus
// ============================================================

// GET /device-status/v0/connectivity?ueId=<ue1|ue2|IMSI>
app.get('/device-status/v0/connectivity', async (req, res) => {
  const { ueId } = req.query;
  if (!ueId) return camaraErr(res, 400, 'MISSING_IDENTIFIER', 'ueId query param is required');
  const connectivityStatus = await resolveConnectivity(ueId);
  res.json({ connectivityStatus, lastStatusTime: new Date().toISOString() });
});

// GET /device-status/v0/roaming?ueId=<>
app.get('/device-status/v0/roaming', async (req, res) => {
  const { ueId } = req.query;
  if (!ueId) return camaraErr(res, 400, 'MISSING_IDENTIFIER', 'ueId query param is required');
  // Testbed is always the home network — no roaming
  res.json({
    roaming:     false,
    countryCode: parseInt(MCC, 10),
    countryName: 'Testbed Home Network',
    lastStatusTime: new Date().toISOString(),
  });
});

// ============================================================
// 2. LOCATION VERIFICATION API  (CAMARA location-verification v0.2)
//    Spec: https://github.com/camaraproject/DeviceLocation
// ============================================================

// POST /location-verification/v0/verify
app.post('/location-verification/v0/verify', async (req, res) => {
  const { device, area, maxAge } = req.body;
  if (!device) return camaraErr(res, 400, 'MISSING_IDENTIFIER', 'device object is required');
  if (!area)   return camaraErr(res, 400, 'MISSING_AREA', 'area object is required');

  // In an RF-simulator testbed there is no real location.
  // Return UNKNOWN with the "testbed campus" as the last known position.
  res.json({
    verificationResult: 'UNKNOWN',
    lastLocationTime:   new Date().toISOString(),
    matchRate:          0,
    device,
    area,
  });
});

// ============================================================
// 3. QUALITY ON DEMAND API  (CAMARA qod v0.10)
//    Spec: https://github.com/camaraproject/QualityOnDemand
//    Implementation: creates Free5GC NEF Traffic Influence subs
// ============================================================

// QoS profile → human label
const QOS_PROFILES = {
  QOS_E: { label: 'Best Effort',          minBandwidth: null },
  QOS_S: { label: 'Small  (≥ 2 Mbps)',    minBandwidth: 2    },
  QOS_M: { label: 'Medium (≥ 10 Mbps)',   minBandwidth: 10   },
  QOS_L: { label: 'Large  (≥ 20 Mbps)',   minBandwidth: 20   },
  QOS_REAL_TIME_CONVERSATIONAL: { label: 'Real-time / Conversational', minBandwidth: 4 },
};

// POST /qod/v0/sessions
app.post('/qod/v0/sessions', async (req, res) => {
  const { device, applicationServer, qosProfile, webhook, duration } = req.body;
  if (!device)     return camaraErr(res, 400, 'MISSING_IDENTIFIER', 'device is required');
  if (!qosProfile) return camaraErr(res, 400, 'MISSING_PROFILE',    'qosProfile is required');
  if (!QOS_PROFILES[qosProfile]) {
    return camaraErr(res, 400, 'INVALID_PROFILE',
      `Unknown qosProfile. Valid: ${Object.keys(QOS_PROFILES).join(', ')}`);
  }

  const sessionId  = uid('qod');
  const expiresAt  = new Date(Date.now() + (duration || 3600) * 1000).toISOString();
  const deviceId   = device.ipv4Address || device.phoneNumber || device.networkAccessIdentifier || 'unknown';

  const session = {
    sessionId,
    device,
    applicationServer: applicationServer || null,
    qosProfile,
    qosStatus:         'REQUESTED',
    startedAt:         new Date().toISOString(),
    expiresAt,
    webhook:           webhook || null,
    nefSubscriptionId: null,
  };

  // Attempt to back the session with a NEF Traffic Influence subscription
  const nefBody = {
    afServiceId: sessionId,
    supi: device.phoneNumber
      ? `imsi-${MCC}${MNC}${device.phoneNumber}`
      : undefined,
    dnn: 'internet',
    snssai: { sst: 1 },
    notificationDestination: webhook?.notificationUrl
      || `http://5g-camara-api:${PORT}/camara/callback`,
    trafficFilters: [{ flowId: 1, flowDescriptions: ['permit out ip from any to assigned'] }],
  };

  const nefRes = await callNef('/nnef-trafficinfluence/v1/subscriptions', {
    method: 'POST',
    body:   JSON.stringify(nefBody),
  });

  if (nefRes.ok) {
    session.nefSubscriptionId = nefRes.body.afTransId || nefRes.body.subscriptionId || null;
    session.qosStatus = 'AVAILABLE';
  } else {
    // NEF may not be running — keep session active for demo/simulation
    session.qosStatus = 'AVAILABLE';
    session.nefNote   = 'NEF not reachable — session tracked locally';
  }

  qodSessions.set(sessionId, session);
  res.status(201).json(session);
});

// GET /qod/v0/sessions — list all sessions
app.get('/qod/v0/sessions', (req, res) => {
  res.json([...qodSessions.values()]);
});

// GET /qod/v0/sessions/:sessionId
app.get('/qod/v0/sessions/:sessionId', (req, res) => {
  const s = qodSessions.get(req.params.sessionId);
  if (!s) return camaraErr(res, 404, 'NOT_FOUND', 'Session not found');
  res.json(s);
});

// DELETE /qod/v0/sessions/:sessionId
app.delete('/qod/v0/sessions/:sessionId', async (req, res) => {
  const s = qodSessions.get(req.params.sessionId);
  if (!s) return camaraErr(res, 404, 'NOT_FOUND', 'Session not found');

  // Cancel NEF Traffic Influence subscription if one exists
  if (s.nefSubscriptionId) {
    await callNef(`/nnef-trafficinfluence/v1/subscriptions/${s.nefSubscriptionId}`, {
      method: 'DELETE',
    });
  }

  qodSessions.delete(req.params.sessionId);
  res.status(204).send();
});

// ============================================================
// 4. DEVICE REACHABILITY SUBSCRIPTIONS  (CAMARA device-status v0.6)
//    Implementation: creates Free5GC NEF Event Exposure subs
// ============================================================

// POST /device-reachability/v0/subscriptions
app.post('/device-reachability/v0/subscriptions', async (req, res) => {
  const { device, webhook, subscriptionExpireTime, maxNumberOfReports } = req.body;
  if (!device)  return camaraErr(res, 400, 'MISSING_IDENTIFIER', 'device is required');
  if (!webhook) return camaraErr(res, 400, 'MISSING_WEBHOOK',    'webhook is required');

  const subId  = uid('rsub');
  const expiry = subscriptionExpireTime || new Date(Date.now() + 86400000).toISOString();

  // Create NEF Event Exposure subscription
  const supi = device.phoneNumber
    ? `imsi-${MCC}${MNC}${device.phoneNumber}`
    : undefined;

  const nefBody = {
    supi,
    anyUeInd: !device.phoneNumber,
    eventsSubs: [{ event: 'UE_REACHABILITY_FOR_DATA' }],
    eventsNotification: { notifId: subId, notifEvents: [] },
    notificationUri: webhook.notificationUrl,
    supportedFeatures: '0',
  };

  const nefRes = await callNef('/nnef-eventexposure/v1/subscriptions', {
    method: 'POST',
    body:   JSON.stringify(nefBody),
  });

  const sub = {
    subscriptionId:       subId,
    device,
    webhook,
    subscriptionExpireTime: expiry,
    startsAt:             new Date().toISOString(),
    maxNumberOfReports:   maxNumberOfReports || null,
    nefSubscriptionId:    nefRes.ok ? (nefRes.body.subscriptionId || null) : null,
    nefNote:              nefRes.ok ? null : 'NEF not reachable — sub tracked locally',
  };

  reachSubs.set(subId, sub);
  res.status(201).json(sub);
});

// GET /device-reachability/v0/subscriptions
app.get('/device-reachability/v0/subscriptions', (req, res) => {
  res.json([...reachSubs.values()]);
});

// GET /device-reachability/v0/subscriptions/:subscriptionId
app.get('/device-reachability/v0/subscriptions/:subscriptionId', (req, res) => {
  const s = reachSubs.get(req.params.subscriptionId);
  if (!s) return camaraErr(res, 404, 'NOT_FOUND', 'Subscription not found');
  res.json(s);
});

// DELETE /device-reachability/v0/subscriptions/:subscriptionId
app.delete('/device-reachability/v0/subscriptions/:subscriptionId', async (req, res) => {
  const s = reachSubs.get(req.params.subscriptionId);
  if (!s) return camaraErr(res, 404, 'NOT_FOUND', 'Subscription not found');

  if (s.nefSubscriptionId) {
    await callNef(`/nnef-eventexposure/v1/subscriptions/${s.nefSubscriptionId}`, {
      method: 'DELETE',
    });
  }

  reachSubs.delete(req.params.subscriptionId);
  res.status(204).send();
});

// ============================================================
// 5. SIMPLE EDGE DISCOVERY  (CAMARA simple-edge-discovery v1)
//    Spec: https://github.com/camaraproject/SimpleEdgeDiscovery
//    Implementation: exposes testbed's iPerf3 server as MEC
// ============================================================

// GET /simple-edge-discovery/v1/mec-platforms
app.get('/simple-edge-discovery/v1/mec-platforms', (req, res) => {
  res.json([
    {
      id:       'testbed-mec-01',
      name:     '5G Testbed MEC Platform',
      status:   'ACTIVE',
      zone:     { id: 'zone-01', name: 'Testbed Lab Zone' },
      endpoint: { ipv4Address: '10.45.0.200', port: 5201 }, // iPerf3 server
      supportedApis: ['iPerf3', 'TCP/UDP throughput'],
      location: { latitude: 0.0, longitude: 0.0, description: 'RF Simulator Node' },
    },
  ]);
});

// ============================================================
// 6. CALLBACK RECEIVER — NEF notification endpoint
// ============================================================

// POST /camara/callback — receives NEF notifications
app.post('/camara/callback', (req, res) => {
  const notification = req.body;
  addNotification('nef-notification', notification);
  console.log('[CAMARA] Notification received:', JSON.stringify(notification).slice(0, 200));
  res.status(204).send();
});

// ============================================================
// 7. DISCOVERY & META
// ============================================================

const API_CATALOG = [
  {
    name:        'device-status',
    version:     'v0.6',
    basePath:    '/device-status/v0',
    spec:        'https://github.com/camaraproject/DeviceStatus',
    description: 'UE connectivity status (CONNECTED_DATA / CONNECTED_SMS / NOT_CONNECTED) and roaming detection',
    endpoints:   [
      { method: 'GET', path: '/device-status/v0/connectivity', description: 'Get UE connectivity status' },
      { method: 'GET', path: '/device-status/v0/roaming',      description: 'Get UE roaming status' },
    ],
  },
  {
    name:        'location-verification',
    version:     'v0.2',
    basePath:    '/location-verification/v0',
    spec:        'https://github.com/camaraproject/DeviceLocation',
    description: 'Verify whether a UE is located within a specified area (UNKNOWN in RF simulator)',
    endpoints:   [
      { method: 'POST', path: '/location-verification/v0/verify', description: 'Verify UE location against area' },
    ],
  },
  {
    name:        'qod',
    version:     'v0.10',
    basePath:    '/qod/v0',
    spec:        'https://github.com/camaraproject/QualityOnDemand',
    description: 'Quality on Demand — create/manage QoS sessions backed by NEF Traffic Influence',
    endpoints:   [
      { method: 'POST',   path: '/qod/v0/sessions',         description: 'Create QoD session' },
      { method: 'GET',    path: '/qod/v0/sessions',         description: 'List all sessions' },
      { method: 'GET',    path: '/qod/v0/sessions/:id',     description: 'Get session details' },
      { method: 'DELETE', path: '/qod/v0/sessions/:id',     description: 'Delete session' },
    ],
  },
  {
    name:        'device-reachability',
    version:     'v0',
    basePath:    '/device-reachability/v0',
    spec:        'https://github.com/camaraproject/DeviceStatus',
    description: 'Subscribe to UE reachability events via NEF Event Exposure (nnef-eventexposure)',
    endpoints:   [
      { method: 'POST',   path: '/device-reachability/v0/subscriptions',     description: 'Create reachability subscription' },
      { method: 'GET',    path: '/device-reachability/v0/subscriptions',     description: 'List subscriptions' },
      { method: 'GET',    path: '/device-reachability/v0/subscriptions/:id', description: 'Get subscription' },
      { method: 'DELETE', path: '/device-reachability/v0/subscriptions/:id', description: 'Delete subscription' },
    ],
  },
  {
    name:        'simple-edge-discovery',
    version:     'v1',
    basePath:    '/simple-edge-discovery/v1',
    spec:        'https://github.com/camaraproject/SimpleEdgeDiscovery',
    description: 'Discover available MEC platforms — testbed exposes iPerf3 server as MEC',
    endpoints:   [
      { method: 'GET', path: '/simple-edge-discovery/v1/mec-platforms', description: 'List MEC platforms' },
    ],
  },
];

// GET /camara/health
app.get('/camara/health', async (req, res) => {
  const mgmt = await getMgmtStatus();
  res.json({
    status: 'UP',
    timestamp: new Date().toISOString(),
    mgmtApiReachable: mgmt !== null,
    qodSessions:      qodSessions.size,
    reachSubs:        reachSubs.size,
    notifications:    notifications.length,
    apis: API_CATALOG.map(a => a.name + '/' + a.version),
  });
});

// GET /camara/apis — API catalog
app.get('/camara/apis', (req, res) => {
  res.json({ apis: API_CATALOG, qosProfiles: QOS_PROFILES });
});

// GET /camara/notifications — recent callbacks
app.get('/camara/notifications', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, MAX_NOTIFICATIONS);
  res.json(notifications.slice(0, limit));
});

// DELETE /camara/notifications — clear notification log
app.delete('/camara/notifications', (req, res) => {
  notifications.length = 0;
  res.json({ cleared: true });
});

// 404
app.use((req, res) => {
  res.status(404).json({ status: 404, code: 'NOT_FOUND', message: `No CAMARA route: ${req.method} ${req.path}` });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[CAMARA] API server listening on :${PORT}`);
  console.log(`[CAMARA] Management API : ${MGMT_URL}`);
  console.log(`[CAMARA] PLMN           : MCC=${MCC} MNC=${MNC}`);
  console.log(`[CAMARA] APIs           : ${API_CATALOG.map(a => a.name).join(', ')}`);
});
