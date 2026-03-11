#!/usr/bin/env python3
"""
5G Testbed — Scapy Data-Plane IDS
===================================
Monitors : N3 interface (GTP-U, UDP/2152)
           N4 interface (PFCP,  UDP/8805)
Runs as  : network_mode=host Docker container (sees all bridge traffic)
Detects  :
  - GTP_FLOOD           : GTP-U packet rate > threshold (pkt/s per TEID)
  - GTP_HIGH_THROUGHPUT : Single GTP tunnel volume > 100 MB
  - GTP_INNER_PORTSCAN  : Port scan detected inside GTP tunnel (inner IP)
  - PFCP_SESSION_FLOOD  : PFCP Session Establishment rate > threshold
Output   : /ids/scapy_alerts.jsonl  (one JSON object per line, UTC timestamps)
"""

import os
import json
import time
import threading
import logging
import sys
from collections import defaultdict
from datetime import datetime, timezone

# ── Optional Scapy import ─────────────────────────────────────
try:
    from scapy.all import sniff, IP, UDP, TCP, Raw, Packet, conf as scapy_conf
    from scapy.contrib.gtp import GTP_U_Header
    SCAPY_OK = True
except ImportError:
    SCAPY_OK = False

# ── Configuration (tunable via environment variables) ─────────
ALERTS_FILE       = os.environ.get('IDS_ALERTS_FILE', '/ids/scapy_alerts.jsonl')
GTP_PORT          = int(os.environ.get('GTP_PORT',  2152))
PFCP_PORT         = int(os.environ.get('PFCP_PORT', 8805))
GTP_FLOOD_PPS     = int(os.environ.get('GTP_FLOOD_PPS',      1000))   # pkt/s per TEID
GTP_HI_BYTES      = int(os.environ.get('GTP_HI_BYTES',  100_000_000)) # 100 MB per TEID
PFCP_SESS_LIMIT   = int(os.environ.get('PFCP_SESS_LIMIT',       15))  # sessions / 5 s
PORT_SCAN_THRESH  = int(os.environ.get('PORT_SCAN_THRESH',       20)) # unique dst ports / 10 s
WINDOW_SEC        = int(os.environ.get('WINDOW_SEC',             10)) # rate-calc window (s)
LOG_LEVEL         = os.environ.get('LOG_LEVEL', 'INFO').upper()

# ── Logging setup ─────────────────────────────────────────────
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format='%(asctime)s [ScapyIDS] %(levelname)s %(message)s',
    stream=sys.stdout,
)
log = logging.getLogger('scapy-ids')

# ── Shared state ──────────────────────────────────────────────
_lock = threading.Lock()

# GTP-U per-TEID: timestamp list for rate, byte counter for volume
gtp_pkt_times: dict = defaultdict(list)   # teid -> [float, ...]
gtp_bytes:     dict = defaultdict(int)    # teid -> total bytes seen

# Port scan: inner-src-IP -> {dst_port -> last_seen_ts}
inner_port_map: dict = defaultdict(dict)  # inner_src -> {port: ts}

# PFCP session establishment timestamps
pfcp_sess_ts: list = []

# De-duplication: track recently-fired alert keys (key -> expiry_ts)
recent_alerts: dict = {}
ALERT_COOLDOWN = 30  # seconds between same-key alerts

# ── Alert writer ──────────────────────────────────────────────
def _write_alert(severity: str, alert_type: str, source: str,
                 message: str, details: dict = None) -> None:
    """Append one JSON line to the alerts file. Thread-safe."""
    key = f"{alert_type}:{source}"
    now = time.time()

    with _lock:
        # Cooldown: suppress repeated same-type/same-source alerts
        if recent_alerts.get(key, 0) > now:
            return
        recent_alerts[key] = now + ALERT_COOLDOWN

        record = {
            'timestamp': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
            'engine':    'scapy',
            'severity':  severity,
            'type':      alert_type,
            'source':    source,
            'message':   message,
            'details':   details or {},
        }
        try:
            with open(ALERTS_FILE, 'a') as fh:
                fh.write(json.dumps(record) + '\n')
        except OSError as exc:
            log.error('Failed to write alert: %s', exc)

    log.warning('[%s] %s — %s | src=%s', severity, alert_type, message, source)


# ── Helpers ──────────────────────────────────────────────────
def _now() -> float:
    return time.monotonic()


def _prune(ts_list: list, cutoff: float) -> None:
    """Remove entries older than cutoff from a sorted timestamp list."""
    while ts_list and ts_list[0] < cutoff:
        ts_list.pop(0)


# ── GTP-U detectors ───────────────────────────────────────────
def _check_gtp_flood(teid: int, src: str) -> None:
    now = _now()
    ts  = gtp_pkt_times[teid]
    ts.append(now)
    _prune(ts, now - WINDOW_SEC)
    pps = len(ts) / WINDOW_SEC
    if pps >= GTP_FLOOD_PPS:
        _write_alert(
            'CRITICAL', 'GTP_FLOOD', src,
            f'GTP-U flood on TEID {hex(teid)}: {pps:.0f} pkt/s (threshold {GTP_FLOOD_PPS})',
            {'teid': hex(teid), 'pps': round(pps, 1), 'window_sec': WINDOW_SEC},
        )
        ts.clear()   # reset to avoid alert storm


def _check_gtp_volume(teid: int, pkt_len: int, src: str) -> None:
    gtp_bytes[teid] += pkt_len
    if gtp_bytes[teid] >= GTP_HI_BYTES:
        mb = gtp_bytes[teid] // 1_000_000
        _write_alert(
            'HIGH', 'GTP_HIGH_THROUGHPUT', src,
            f'GTP tunnel {hex(teid)} transferred ≥{mb} MB (threshold {GTP_HI_BYTES // 1_000_000} MB)',
            {'teid': hex(teid), 'bytes': gtp_bytes[teid], 'mb': mb},
        )
        gtp_bytes[teid] = 0   # reset after alert


def _check_inner_portscan(inner_src: str, dst_port: int) -> None:
    now = _now()
    ports = inner_port_map[inner_src]
    ports[dst_port] = now

    # Evict stale entries
    stale = [p for p, t in ports.items() if now - t > WINDOW_SEC]
    for p in stale:
        del ports[p]

    if len(ports) >= PORT_SCAN_THRESH:
        _write_alert(
            'CRITICAL', 'GTP_INNER_PORTSCAN', inner_src,
            f'Port scan inside GTP tunnel from {inner_src}: '
            f'{len(ports)} unique dst ports in {WINDOW_SEC}s',
            {'inner_src': inner_src,
             'port_count': len(ports),
             'sample_ports': sorted(ports)[:20],
             'threshold': PORT_SCAN_THRESH},
        )
        inner_port_map[inner_src].clear()


# ── PFCP detector ─────────────────────────────────────────────
def _check_pfcp_sess_flood(src: str) -> None:
    now = _now()
    pfcp_sess_ts.append(now)
    _prune(pfcp_sess_ts, now - 5)          # 5-second window for PFCP
    count = len(pfcp_sess_ts)
    if count > PFCP_SESS_LIMIT:
        _write_alert(
            'HIGH', 'PFCP_SESSION_FLOOD', src,
            f'PFCP Session Establishment flood: {count} sessions/5s (threshold {PFCP_SESS_LIMIT})',
            {'count': count, 'src': src, 'threshold': PFCP_SESS_LIMIT},
        )
        pfcp_sess_ts.clear()


# ── Packet handler ────────────────────────────────────────────
def _handle_packet(pkt: Packet) -> None:
    """Called for every captured packet. Must never raise."""
    try:
        if not pkt.haslayer(UDP):
            return

        dport = pkt[UDP].dport
        sport = pkt[UDP].sport
        src   = pkt[IP].src if pkt.haslayer(IP) else 'unknown'

        # ── N3: GTP-U ────────────────────────────────────────
        if dport == GTP_PORT or sport == GTP_PORT:
            if pkt.haslayer(GTP_U_Header):
                gtp  = pkt[GTP_U_Header]
                teid = int(gtp.teid)

                _check_gtp_flood(teid, src)
                _check_gtp_volume(teid, len(pkt), src)

                # Inspect inner IP for port scan detection
                inner = gtp.payload
                if inner and inner.haslayer(IP):
                    inner_src = inner[IP].src
                    if inner.haslayer(TCP):
                        _check_inner_portscan(inner_src, inner[TCP].dport)
                    elif inner.haslayer(UDP):
                        _check_inner_portscan(inner_src, inner[UDP].dport)

        # ── N4: PFCP ─────────────────────────────────────────
        elif dport == PFCP_PORT or sport == PFCP_PORT:
            if pkt.haslayer(Raw):
                raw = bytes(pkt[Raw])
                # PFCP header: octet 0 = flags, octet 1 = message type
                # Type 50 = PFCP Session Establishment Request (3GPP TS 29.244)
                if len(raw) >= 4 and raw[1] == 50:
                    _check_pfcp_sess_flood(src)

    except Exception as exc:  # noqa: BLE001 — never crash the sniffer
        log.debug('Packet handler error: %s', exc)


# ── Cleanup thread: evict stale per-TEID rate windows ────────
def _cleanup_loop() -> None:
    while True:
        time.sleep(60)
        cutoff = _now() - WINDOW_SEC * 2
        with _lock:
            for teid in list(gtp_pkt_times):
                _prune(gtp_pkt_times[teid], cutoff)
                if not gtp_pkt_times[teid]:
                    del gtp_pkt_times[teid]
            for key in list(recent_alerts):
                if recent_alerts[key] < time.time():
                    del recent_alerts[key]


# ── Main ─────────────────────────────────────────────────────
def main() -> None:
    if not SCAPY_OK:
        log.error('Scapy is not installed. Run: pip install scapy')
        sys.exit(1)

    os.makedirs(os.path.dirname(ALERTS_FILE), exist_ok=True)

    # Suppress Scapy's verbose output
    scapy_conf.verb = 0

    log.info('Starting Scapy data-plane IDS')
    log.info('  GTP-U port     : %d', GTP_PORT)
    log.info('  PFCP port      : %d', PFCP_PORT)
    log.info('  GTP flood pps  : %d', GTP_FLOOD_PPS)
    log.info('  GTP hi-throughput : %d MB', GTP_HI_BYTES // 1_000_000)
    log.info('  PFCP sess limit: %d / 5s', PFCP_SESS_LIMIT)
    log.info('  Port scan limit: %d ports / %ds', PORT_SCAN_THRESH, WINDOW_SEC)
    log.info('  Alerts file    : %s', ALERTS_FILE)

    # Write startup alert
    _write_alert('INFO', 'IDS_STARTED', 'system',
                 'Scapy data-plane IDS started — monitoring N3(GTP-U) and N4(PFCP)',
                 {'gtp_flood_pps': GTP_FLOOD_PPS,
                  'gtp_hi_mb': GTP_HI_BYTES // 1_000_000,
                  'pfcp_sess_limit': PFCP_SESS_LIMIT,
                  'port_scan_thresh': PORT_SCAN_THRESH})

    # Start background cleanup thread
    t = threading.Thread(target=_cleanup_loop, daemon=True, name='cleanup')
    t.start()

    bpf = f'udp port {GTP_PORT} or udp port {PFCP_PORT}'
    log.info('Starting sniffer on all interfaces with BPF: %s', bpf)
    sniff(
        filter=bpf,
        prn=_handle_packet,
        store=False,
        iface='any',
    )


if __name__ == '__main__':
    main()
