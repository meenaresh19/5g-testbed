# K3s Deployment Guide for 5G Testbed

## Phase 1: Foundation - COMPLETE ✅

All core K8s manifests for Open5GS 5G NFs and UERANSIM RAN have been created.

### What's Deployed in Phase 1

**MongoDB:** 1 StatefulSet + 10Gi PVC (subscriber database)

**Open5GS Core NFs (13 NFs):**
- NRF (Service Discovery)
- SCP (Service Control Point)
- AMF (Access & Mobility) — **Multi-replica ready** (will scale based on UE count)
- SMF (Session Management) — **Multi-replica ready** (will scale based on session count)
- UPF (User Plane) — **Multi-replica ready** (privileged, GTP tunneling, will scale based on CPU/throughput)
- AUSF (Authentication)
- UDM (Unified Data Management)
- UDR (Data Repository) — requires MongoDB
- PCF (Policy Control) — requires MongoDB
- BSF (Binding Support) — requires MongoDB
- NSSF (Network Slice Selection)
- WebUI (Subscriber Management)

**RAN (UERANSIM):**
- gNB (gNodeB) — RF Simulator
- UE1 (Primary UE) — Always-on
- UE2 (Secondary UE) — Optional, disabled by default

### Quick Deploy (5 minutes)

```bash
# 1. Install K3s
curl -sfL https://get.k3s.io | sh -
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl get nodes

# 2. Apply manifests
kubectl apply -k /path/to/5g-testbed/k8s/base/

# 3. Monitor rollout
kubectl rollout status deployment --all-namespaces -w

# 4. Verify all pods running
kubectl get pods -n 5g-testbed
```

### Validation Checklist

- [ ] MongoDB running: `kubectl logs mongodb-0 -n 5g-testbed | grep -i "waiting"`
- [ ] NRF registered: `kubectl logs deployment/open5gs-nrf -n 5g-testbed | grep -i "register"`
- [ ] gNB running: `kubectl logs deployment/ueransim-gnb -n 5g-testbed | tail -20`
- [ ] UE connected: `kubectl logs deployment/ueransim-ue1 -n 5g-testbed | grep -i "connected\|pdusession"`
- [ ] All pods green: `kubectl get pods -n 5g-testbed | grep -c Running` should be ≥ 15

---

## Architecture Diagram

```
K3s Cluster (Single Node)
└── Namespace: 5g-testbed
    ├── Data Storage
    │   └── mongodb-0 ← 10Gi PVC
    │
    ├── 5G Core Network
    │   ├── open5gs-nrf (Service Discovery)
    │   ├── open5gs-scp (Service Control Point)
    │   ├── open5gs-amf ← HPA will scale on UE count
    │   ├── open5gs-smf ← HPA will scale on session count
    │   ├── open5gs-upf ← HPA will scale on CPU
    │   ├── open5gs-ausf, udm, udr, pcf, bsf, nssf
    │   └── open5gs-webui
    │
    ├── RAN Simulators
    │   ├── ueransim-gnb (gNodeB)
    │   ├── ueransim-ue1 (Always-on UE)
    │   └── ueransim-ue2 (Optional, disabled)
    │
    └── Kubernetes Services (DNS)
        ├── mongodb.5g-testbed.svc.cluster.local:27017
        ├── open5gs-nrf.5g-testbed.svc.cluster.local:7777
        ├── open5gs-amf.5g-testbed.svc.cluster.local:38412 (NGAP)
        └── ... (10 other NF services)
```

---

## Phase 2: Management Layer (Next)

Files to create for UI access:
- `k8s/base/management/api-deployment.yaml` — testbed-api (K8s client replaces docker socket)
- `k8s/base/management/ui-deployment.yaml` — testbed-ui (nginx + React)
- `k8s/base/management/service.yaml` — NodePort :3000 for browser access

This enables the web UI at `http://localhost:3000`.

---

## Phase 3: Auto-Scaling (After Phase 2)

Configurable auto-scaling policies:
- **AMF:** Scale up when UE count > 1000, scale down when < 500
- **SMF:** Scale up when session count > 800, scale down when < 400
- **UPF:** Scale up when CPU > 70%, scale down when < 50%

Configured via `k8s/autoscaling-policies.json`:
```json
{
  "nf": "open5gs-amf",
  "type": "metric",
  "metric": "fivegs_amf_registered_ue_nbr",
  "scale_up_threshold": 1000,
  "scale_down_threshold": 500,
  "min_replicas": 1,
  "max_replicas": 3
}
```

---

## Phase 4: Observability (After Phase 3)

Monitoring stack:
- **Prometheus:** Scrapes NF metrics (:9090/metrics)
- **Grafana:** Dashboards (already deployed in Docker Compose)
- **Loki:** Log aggregation
- **Promtail:** Log shipper
- **cAdvisor:** Container metrics

Access via `http://localhost:3001` (Grafana) after Phase 2.

---

## Key Differences from Docker Compose

### Configuration
| Aspect | Docker | K8s |
|--------|--------|-----|
| IP Resolution | Hardcoded (10.45.0.10) | Kubernetes DNS (nrf.5g-testbed.svc.cluster.local) |
| Configs | Bind-mounted /configs | ConfigMaps in cluster |
| Storage | Named volumes | PersistentVolumeClaims (local-path provisioner) |
| Service Discovery | Docker network bridge | K8s overlay network + Services |

### Scaling
| Aspect | Docker | K8s |
|--------|--------|-----|
| Multiple replicas | Manual docker-compose edit + restart | Declarative Deployment replicas |
| Auto-scaling | None | HPA + custom controller |
| Load balancing | Manual | Kubernetes Services |

---

## Troubleshooting

### Pods stuck in "CrashLoopBackOff"
```bash
# Check logs
kubectl logs pod-name -n 5g-testbed

# Check init container (wait-nrf, wait-mongodb)
kubectl logs pod-name -c wait-nrf -n 5g-testbed

# View events
kubectl describe pod pod-name -n 5g-testbed
```

### NRF not registering other NFs
```bash
# Verify NRF is running and healthy
kubectl get pods -n 5g-testbed -l app=open5gs-nrf

# Check NRF logs for "Register NF"
kubectl logs deployment/open5gs-nrf -n 5g-testbed | grep -i register

# Test DNS from a pod
kubectl exec -it nrf-pod -n 5g-testbed -- nslookup open5gs-nrf.5g-testbed.svc.cluster.local
```

### UE can't connect to gNB
```bash
# Check gNB logs
kubectl logs deployment/ueransim-gnb -n 5g-testbed | tail -50

# Check UE logs
kubectl logs deployment/ueransim-ue1 -n 5g-testbed | tail -50

# Verify SCTP connectivity
kubectl exec -it ue1-pod -n 5g-testbed -- nc -zv open5gs-amf.5g-testbed.svc.cluster.local 38412
```

### Metrics not available
Prometheus is deployed in Phase 4. For now, access metrics directly:
```bash
kubectl port-forward svc/open5gs-nrf 9090:9090 -n 5g-testbed
curl http://localhost:9090/metrics | grep fivegs_
```

---

## File Structure Summary

```
k8s/
├── base/
│   ├── README.md                       # Comprehensive base documentation
│   ├── namespace.yaml                  # 5g-testbed namespace
│   ├── kustomization.yaml              # Base kustomization
│   ├── mongodb/
│   │   ├── pvc.yaml                    # 10Gi volume
│   │   ├── service.yaml                # Headless service
│   │   └── statefulset.yaml            # MongoDB 1 replica
│   ├── open5gs-core/
│   │   ├── configmap.yaml              # All NF configs (13 NFs)
│   │   ├── nrf-deployment.yaml
│   │   ├── scp-deployment.yaml
│   │   ├── amf-deployment.yaml
│   │   ├── smf-deployment.yaml
│   │   ├── upf-deployment.yaml
│   │   ├── other-nfs-deployments.yaml  # AUSF, UDM, UDR, PCF, BSF, NSSF, WebUI
│   │   └── service.yaml                # ClusterIP services
│   ├── ran/
│   │   ├── configmap.yaml              # gNB + UE configs
│   │   ├── gnb-deployment.yaml
│   │   └── ue-deployment.yaml          # UE1 + UE2
│   ├── observability/                  # TODO: Phase 4
│   │   └── (Prometheus, Grafana, Loki)
│   ├── management/                     # TODO: Phase 2
│   │   └── (testbed-api, testbed-ui)
│   ├── ids/                            # TODO: Phase 2
│   │   └── (Zeek, Scapy)
│   └── autoscaling/                    # TODO: Phase 3
│       └── (HPA, policies, controller)
├── overlays/
│   ├── dev/                            # TODO: Patches for dev env
│   └── prod/                           # TODO: Patches for prod env
├── PHASE1_STATUS.md                    # Detailed Phase 1 status
└── DEPLOYMENT_GUIDE.md                 # This file
```

---

## Next Command to Test Phase 1

```bash
kubectl apply -k k8s/base/ && \
kubectl get pods -n 5g-testbed -w
```

All 15+ pods should reach "Running" status within 2-3 minutes.

Once verified, we proceed to **Phase 2: Management Layer** to deploy the testbed-api and testbed-ui.
