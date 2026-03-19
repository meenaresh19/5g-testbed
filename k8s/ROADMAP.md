# 5G Testbed K8s Migration - Roadmap

## Current Status: Phase 1 + 2 Complete ✅

### What You Have Now
- ✅ Open5GS Core (13 NFs)
- ✅ UERANSIM RAN (gNB + UEs)
- ✅ MongoDB (persistent storage)
- ✅ Management API + UI
- ✅ K8s infrastructure (RBAC, services, DNS)

**Ready to deploy:** `kubectl apply -k k8s/base/`

---

## Phase 3: Auto-Scaling (Planned - 1 week)

### What Will Be Added
- HorizontalPodAutoscaler (HPA) for AMF, SMF, UPF
- Metric-based scaling policies
- Custom autoscaling controller

### Files to Create
```
k8s/base/autoscaling/
├── rbac.yaml                    # ServiceAccount for autoscaler
├── hpa.yaml                     # HPA definitions
├── policies.yaml                # ConfigMap with scaling policies
└── controller-deployment.yaml   # Autoscaler controller
```

### Scaling Rules (Example)
```yaml
- NF: open5gs-amf
  metric: fivegs_amf_registered_ue_nbr
  target: 1000 UEs per pod
  min_replicas: 1
  max_replicas: 5

- NF: open5gs-smf
  metric: fivegs_smf_session_nbr
  target: 500 sessions per pod
  min_replicas: 1
  max_replicas: 5

- NF: open5gs-upf
  metric: container_cpu_usage_seconds_total
  target: 70% CPU
  min_replicas: 1
  max_replicas: 3
```

---

## Phase 4: Observability (Planned - 1 week)

### What Will Be Added
- Prometheus (metrics collection + storage)
- Grafana (dashboards)
- Loki (log aggregation)
- Promtail (log shipper)
- cAdvisor (container metrics)

### Files to Create
```
k8s/base/observability/
├── configmap.yaml               # Prometheus, Grafana, Loki configs
├── prometheus-deployment.yaml   # TSDB + scrape targets
├── grafana-deployment.yaml      # Dashboard UI
├── loki-statefulset.yaml        # Log storage
├── promtail-daemonset.yaml      # Log collection
├── cadvisor-daemonset.yaml      # Container metrics
├── pvc.yaml                     # Storage for prometheus/loki/grafana
└── service.yaml                 # Services (ClusterIP + optional NodePort)
```

### Access Points
```
Prometheus:  http://localhost:30090  (metrics querying)
Grafana:     http://localhost:30091  (dashboards)
Loki:        http://localhost:3100   (internal)
```

---

## Future: IDS Components (Phase 2 Continuation)

### Important Note
These components were deferred because they require special networking capabilities:
- **Zeek IDS**: Needs packet capture, raw sockets
- **Scapy**: Needs raw socket access for traffic generation
- Both require: `hostNetwork: true` or Multus CNI

### Workaround Options (Choose One)

#### Option A: Docker Compose for IDS
Keep Zeek/Scapy in Docker Compose while K8s runs core:
```bash
# Terminal 1: K8s testbed
kubectl apply -k k8s/base/
kubectl get pods -n 5g-testbed -w

# Terminal 2: Docker Compose IDS
docker-compose up zeek scapy
```

Benefits:
- Simpler implementation
- Better isolation
- Can test K8s core without IDS first

#### Option B: Kubernetes with Host Networking (Phase 2 Cont.)
Create K8s manifests with `hostNetwork: true`:
```yaml
# k8s/base/ids/zeek-deployment.yaml
spec:
  hostNetwork: true              # Access host network for packet capture
  dnsPolicy: ClusterFirstWithHostNet
  containers:
  - name: zeek
    securityContext:
      privileged: true           # Required for packet capture
      capabilities:
        add:
        - NET_ADMIN
        - NET_RAW
```

Limitations:
- Requires privileged pods
- Less isolated
- Pod can see all host network traffic

#### Option C: Multus CNI (Phase 5)
Use Multus for secondary network interfaces:
```yaml
metadata:
  annotations:
    k8s.v1.cni.cncf.io/networks: 5g-core-net, ran-net, mgmt-net
```

Best practice but most complex.

---

## Recommended Path

### Immediate (This Week)
1. ✅ Deploy Phase 1 + 2 to K3s
2. ✅ Test basic 5G functionality
3. ✅ Verify all pods running
4. ✅ Test API endpoints

### Short-term (Next Week)
1. **Option A (Recommended)**: Keep IDS in Docker Compose
   - Simpler to implement
   - Less complexity in K8s
   - Both systems work independently

2. Run both:
   ```bash
   # K8s: Core 5G network
   kubectl apply -k k8s/base/

   # Docker: IDS components
   docker-compose up zeek scapy grafana prometheus
   ```

### Medium-term (2-4 Weeks)
1. Add Phase 3 (Auto-scaling)
2. Add Phase 4 (Observability to K8s)
3. Decide on IDS approach (Docker vs K8s)

### Long-term (1-2 Months)
1. Phase 5: Multus CNI if needed
2. Production hardening
3. Advanced features

---

## What Each Component Does (Reference)

### IDS Components (Deferred)

**Zeek IDS**
- Network intrusion detection system
- Passive packet monitoring
- Generates security alerts
- Requires: Network access, packet capture

**Scapy**
- Traffic generation tool
- DDoS attack simulation
- Stress testing
- Requires: Raw socket access

**Grafana** (Phase 4)
- Visualization dashboard
- Shows metrics from Prometheus
- Customizable graphs and alerts

**Prometheus** (Phase 4)
- Time-series database
- Collects metrics from all NFs
- Stores historical data
- Query language (PromQL)

**Loki** (Phase 4)
- Log aggregation
- Similar to Prometheus but for logs
- Better than grep for log searching

---

## Current Deployment Status

### Phase 1 ✅ COMPLETE
```
Open5GS Core:  13 NFs deployed
UERANSIM RAN:  2 simulators deployed
MongoDB:       Persistent storage ready
Services:      10+ internal services (DNS-based)
```

### Phase 2 ✅ COMPLETE
```
testbed-api:   REST API (K8s-native)
testbed-ui:    React SPA dashboard
testbed-proxy: Nginx reverse proxy
RBAC:          ServiceAccount + ClusterRole
```

### Phase 3 ⏳ NOT STARTED
```
HPA:           Needs metric collection (Phase 4 first)
Autoscaler:    Custom controller (optional)
Policies:      ConfigMap with thresholds
```

### Phase 4 ⏳ NOT STARTED
```
Prometheus:    Metrics database
Grafana:       Dashboards
Loki:          Log aggregation
cAdvisor:      Container metrics
```

### IDS Components ⏳ DEFERRED
```
Zeek:          Recommendation: Keep in Docker Compose
Scapy:         Recommendation: Keep in Docker Compose
Workaround:    Hybrid K8s + Docker setup
```

### Phase 5 ⏳ OPTIONAL
```
Multus CNI:    Multi-network support
Network Sep:   5g-core-net, ran-net, mgmt-net
Service Mesh:  Optional (Istio/Linkerd)
```

---

## Getting Started Today

### 1. Deploy K8s (Phase 1 + 2)
```bash
cd /path/to/5g-testbed

# Install K3s (if needed)
curl -sfL https://get.k3s.io | sh -
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# Deploy everything
kubectl apply -k k8s/base/

# Monitor
kubectl get pods -n 5g-testbed -w
```

### 2. Access UI
```
http://localhost:30080
```

### 3. (Optional) Keep IDS in Docker
```bash
# In another terminal
docker-compose up zeek scapy grafana prometheus
```

---

## Next Steps After Deployment

1. **Verify Core Works**
   - All 18+ pods running
   - NRF registered with all NFs
   - gNB connected to AMF
   - UE registered

2. **Test API**
   ```bash
   curl http://localhost:30080/api/status
   curl -X POST http://localhost:30080/api/nf/open5gs-smf/start
   ```

3. **Decide on Phase 3**
   - Auto-scaling needed?
   - How many concurrent UEs?

4. **Decide on Phase 4**
   - Need real-time dashboards?
   - Need detailed metrics history?

5. **Decide on IDS**
   - Keep in Docker Compose? (Option A - Recommended)
   - Migrate to K8s? (Option B - More complex)
   - Skip for now? (Option C - Simplest)

---

## Files Structure (Complete)

```
5g-testbed/
├── k8s/
│   ├── base/                    (Phase 1 + 2: DEPLOYED)
│   │   ├── namespace.yaml
│   │   ├── mongodb/             (3 files)
│   │   ├── open5gs-core/        (8 files)
│   │   ├── ran/                 (3 files)
│   │   └── management/          (7 files)
│   │
│   ├── autoscaling/             (Phase 3: TODO)
│   ├── observability/           (Phase 4: TODO)
│   └── ids/                     (Phase 2 Cont.: DEFERRED)
│
├── docker-compose.yml           (Still available for IDS components)
└── Documentation/
    ├── QUICK_START.md
    ├── README_K8s.md
    ├── DEPLOYMENT_GUIDE.md
    └── ROADMAP.md (this file)
```

---

## Summary

**Phase 1 + 2 are complete and ready for deployment.**

Zeek/Scapy can be added later via:
- **Option A (Recommended):** Keep in Docker Compose alongside K8s
- **Option B:** Migrate to K8s with `hostNetwork: true`
- **Option C:** Skip IDS components for now

**Next milestone:** Deploy to K3s and test basic 5G functionality.

After that: Decide on Phase 3 (auto-scaling) and Phase 4 (observability).

**Questions?** Refer to `k8s/QUICK_START.md` or `k8s/DEPLOYMENT_GUIDE.md`
