# 5G Testbed — Open5GS + UERANSIM + Management UI

**Full-stack 5G SA testbed with observability, throughput testing, and IDS**
Ubuntu 22.04 / 24.04 · Docker Compose · Kubernetes (K3s)

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          5G Testbed Stack                                │
├───────────────┬──────────────────────────┬───────────────────────────────┤
│  UERANSIM RAN │    Open5GS 5GC           │   Management & Observability  │
│  ───────────  │  ──────────────────────  │  ─────────────────────────── │
│  ueransim-gnb │  NRF  SCP  AMF  SMF      │  Testbed UI     :3000         │
│  ueransim-ue1 │  UPF  AUSF UDM  UDR      │  Open5GS WebUI  :9999         │
│  ueransim-ue2 │  PCF  BSF  NSSF          │  API Server     :5000         │
│  (optional)   │                          │  Grafana        :3001         │
│               │  iPerf3 server           │  Prometheus     :9090         │
│  OAI gNB+UE   │  (10.45.0.200)           │  Loki + Promtail              │
│  (--profile   │                          │  Zeek IDS (ctrl-plane)        │
│   oai)        │                          │  Scapy IDS (data-plane)       │
└───────────────┴──────────────────────────┴───────────────────────────────┘
```

## Quick Start

### Docker Compose (Recommended)
```bash
# Clone
git clone https://github.com/<YOUR_USER>/5g-testbed.git
cd 5g-testbed

# Install everything (Ubuntu 22.04/24.04) — takes ~5 min
sudo bash install.sh --docker

# Access UIs
open http://localhost:3000   # Testbed Management UI
open http://localhost:9999   # Open5GS WebUI  (admin / 1423)
open http://localhost:3001   # Grafana dashboards
```

### Kubernetes (K3s)
```bash
sudo bash install.sh --k8s
open http://<NODE_IP>:30300  # Testbed UI
open http://<NODE_IP>:30999  # Open5GS WebUI
```

### Manual
```bash
bash scripts/gen-configs.sh        # generate NF + RAN configs
make up                             # start full stack
make status                         # check container states
make info                           # show all URLs
```

---

## Management UI Pages

| Page | Description |
|------|-------------|
| **Dashboard** | Real-time NF status, interface utilization, live event feed |
| **Core NFs** | Start / stop / configure all Open5GS NFs (AMF, SMF, UPF …) |
| **RAN** | UERANSIM gNB + UE control; OAI legacy mode |
| **Network Slices** | Create slices (SST 1/2/3/4), set 5QI, DNN, bandwidth limits |
| **Subscribers** | Add / edit / delete UE subscriptions (IMSI, K, OPc, S-NSSAI) |
| **Topology** | Live architecture diagram with real NF status overlay |
| **Tracing** | PCAP capture on N2/N3/N4/SBI — start, stop, download |
| **Throughput** | iPerf3 DL / UL / BiDir tests through live PDU session |
| **Logs** | Aggregated log viewer for all NFs |
| **Dashboards** | Opens Grafana (5G Core / RAN / System dashboards) |
| **IDS Monitor** | Zeek + Scapy intrusion detection — alert feed, start/stop engines |

---

## Observability Stack

| Component | Port | Role |
|-----------|------|------|
| Prometheus | 9090 | Scrapes all 10 Open5GS NFs + cAdvisor |
| Grafana | 3001 | Auto-provisioned dashboards (Core / RAN / System) |
| cAdvisor | — | Container CPU / memory / network metrics |
| Loki | — | Log aggregation store |
| Promtail | — | Docker log shipper → Loki |

**Dashboards:** `5g-core` (AMF/SMF KPIs, UE counts, UPF throughput) · `5g-ran` (gNB/UE status, N2/N3 traffic) · `5g-system` (all-container resource view)

---

## IDS — Zeek + Scapy

```bash
make ids-up      # start both engines
make ids-down    # stop
make ids-status  # alert counts
make ids-clear   # clear alert files
```

| Engine | Interface | Detects |
|--------|-----------|---------|
| **Zeek** | SBI (HTTP/2, 7777) · N2 (NGAP, 38412) | SBI auth failure bursts · NRF registration floods · NF 5xx error spikes · N2 NGAP floods |
| **Scapy** | N3 (GTP-U, 2152) · N4 (PFCP, 8805) | GTP-U packet floods · High-throughput tunnels (>100 MB) · Inner GTP port scans · PFCP session floods |

Both engines run with `network_mode: host` to see all Docker bridge traffic.

---

## RAN Options

```bash
# Default: UERANSIM (lightweight, multi-UE support)
make up

# Second UE (needs IMSI 001010000000002 in Open5GS WebUI)
make ue2-up

# Switch to OAI RAN (RF simulator)
make oai-up     # stops UERANSIM, starts OAI gNB + nrUE
make oai-down
```

---

## iPerf3 Throughput Testing

iPerf3 server runs at `10.45.0.200:5201` on the 5G core network.

```bash
make iperf-ping   # quick 10s DL test from UE1
```

Or use the **Throughput** page in the UI to run DL / UL / BiDir tests with configurable duration (5–60 s) and parallel streams (1–8).

---

## PCAP Tracing

```bash
# Via UI: Tracing page → select interface → Start
# Interfaces: N2 (NGAP/SCTP), N3 (GTP-U), N4 (PFCP), SBI (HTTP/2), ALL

# Via CLI
curl -X POST http://localhost:5000/trace/start \
  -H 'Content-Type: application/json' \
  -d '{"label":"test1","interfaces":["n2","n3"]}'
```

PCAP files are written to `./traces/` and downloadable via the UI or `GET /trace/download/<filename>`.

---

## Network Topology

| Interface | Protocol | Path |
|-----------|----------|------|
| N2 (NGAP) | SCTP/38412 | gNB → AMF |
| N3 (GTP-U) | UDP/2152 | gNB → UPF |
| N4 (PFCP) | UDP/8805 | SMF → UPF |
| N6 (DN) | IP | UPF → Internet |
| SBI | HTTP/2 7777 | All NFs ↔ NRF |

## IP Address Plan

| Service | Network | IP |
|---------|---------|-----|
| MongoDB | core | 10.45.0.2 |
| NRF | core | 10.45.0.10 |
| AMF | core + ran | 10.45.0.12 · 192.168.70.12 |
| SMF | core | 10.45.0.13 |
| UPF | core | 10.45.0.14 |
| AUSF/UDM/UDR/PCF/BSF/NSSF | core | 10.45.0.15–20 |
| UERANSIM gNB | ran + core | 192.168.70.20 · 10.45.0.50 |
| UERANSIM UE1 | ran | 192.168.70.30 |
| UERANSIM UE2 | ran | 192.168.70.31 |
| iPerf3 server | core | 10.45.0.200 |
| Prometheus | core + mgmt | 10.45.0.80 · 172.22.0.80 |
| Grafana | mgmt | 172.22.0.81 (port 3001) |
| API | core + mgmt | 10.45.0.100 · 172.22.0.101 (port 5000) |
| UI (nginx) | mgmt | 172.22.0.100 (port 3000) |

---

## Default Credentials

| Service | Username | Password |
|---------|----------|----------|
| Open5GS WebUI | admin | 1423 |
| Grafana | admin | admin |

**Default UE:** IMSI `001010000000001` · K `fec86ba6eb707ed08905757b1bb44b8f` · OPc `C42449363BBAD02B66D16BC975D77CC1` · DNN `internet` · SST 1

---

## System Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 4 cores | 8+ cores |
| RAM | 8 GB | 16 GB |
| Disk | 20 GB | 40 GB |
| OS | Ubuntu 22.04 | Ubuntu 22.04 / 24.04 |
| Kernel | 5.15+ | 6.1+ |

---

## Makefile Reference

```
make up              Start full stack (Core + UERANSIM + Observability)
make down            Stop all services
make restart         Restart all services
make logs            Follow all logs
make status          Container status
make info            Show all access URLs
make gen-config      Regenerate NF + RAN configs
make clean           Stop + wipe volumes (destructive!)

make ue2-up          Start second UE (multi-UE load test)
make oai-up          Switch to OAI RAN
make iperf-ping      Quick iPerf3 DL test from UE1

make ids-up          Start Zeek + Scapy IDS engines
make ids-down        Stop IDS engines
make ids-status      Show IDS engine state + alert counts
make ids-clear       Clear alert files
```

---

## Troubleshooting

```bash
# NF logs
docker logs open5gs-amf -f
docker logs ueransim-gnb -f

# UE PDU session tunnel
docker exec ueransim-ue1 ip addr show uesimtun0

# GTP tunnel on UPF
docker exec open5gs-upf ip a show ogstun

# MongoDB subscribers
docker exec open5gs-mongodb mongosh open5gs --eval "db.subscribers.find()"

# PFCP session
docker exec open5gs-smf pfcpctl session list 2>/dev/null

# SCTP (N2)
docker exec open5gs-amf ss -s | grep sctp
```

---

## Component Versions

| Component | Version |
|-----------|---------|
| Open5GS | 2.7.0 |
| UERANSIM | v3.2.6 |
| OAI (legacy) | develop |
| MongoDB | 6.0 |
| Prometheus | latest |
| Grafana | latest |
| Zeek IDS | latest |
| Docker | 24+ |
| K3s | v1.29+ |
