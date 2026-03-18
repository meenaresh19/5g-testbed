# Quick Start: Phases 1 & 2 Complete

## Prerequisites

- Linux system with K3s installed
- kubectl configured
- ~4 CPU cores, 8GB RAM minimum
- ~20GB free disk space

## One-Command Deploy

```bash
cd /path/to/5g-testbed

# Install K3s (if not already installed)
curl -sfL https://get.k3s.io | sh -
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# Deploy all manifests (Phase 1 + 2)
kubectl apply -k k8s/base/

# Monitor rollout
kubectl rollout status deployment --all-namespaces -w
```

## What Gets Deployed

**18+ Pods in 5g-testbed namespace:**

### Phase 1: Core 5G Network
- 1 MongoDB (database)
- 13 Open5GS NFs (NRF, SCP, AMF, SMF, UPF, etc.)
- 2 UERANSIM (gNB + UE1)

### Phase 2: Management Layer
- testbed-api (K8s API server)
- testbed-ui (React dashboard)
- testbed-proxy (Nginx reverse proxy)

## Access Points

| Service | URL | Purpose |
|---------|-----|---------|
| **testbed-ui** | `http://localhost:30080` | Main dashboard (NF status, logs, scale) |
| **Open5GS WebUI** | `http://localhost:30080/open5gs/` | Subscriber management (admin/1423) |
| **API** | `http://localhost:30080/api/` | REST API for NF control |

## Quick Validation

```bash
# All pods running?
kubectl get pods -n 5g-testbed

# NFs registered with NRF?
kubectl logs deployment/open5gs-nrf -n 5g-testbed | grep register

# UE connected?
kubectl logs deployment/ueransim-ue1 -n 5g-testbed | tail -20

# API working?
curl http://localhost:30080/api/status

# UI accessible?
curl http://localhost:30080
```

## Common Operations

### View NF Logs
```bash
kubectl logs deployment/open5gs-amf -n 5g-testbed --tail=100

# Or via API:
curl http://localhost:30080/api/nf/open5gs-amf/logs?lines=100
```

### Scale a Network Function
```bash
# Scale AMF to 2 replicas
kubectl scale deployment/open5gs-amf -n 5g-testbed --replicas=2

# Or via API:
curl -X POST http://localhost:30080/api/nf/open5gs-amf/start

# Or kubectl (scale to 0)
kubectl scale deployment/open5gs-amf -n 5g-testbed --replicas=0
```

### View Resource Usage
```bash
kubectl top pods -n 5g-testbed
```

### Port-Forward to Internal Services
```bash
# Access Open5GS WebUI directly (port 3000)
kubectl port-forward svc/open5gs-webui 3000:3000 -n 5g-testbed

# Access API directly (port 5000)
kubectl port-forward svc/testbed-api 5000:5000 -n 5g-testbed

# Access NRF metrics (port 9090)
kubectl port-forward svc/open5gs-nrf 9090:9090 -n 5g-testbed
```

## Troubleshooting

### Pods not starting?
```bash
# Check pod events
kubectl describe pod <pod-name> -n 5g-testbed

# Check logs
kubectl logs <pod-name> -n 5g-testbed

# Check init containers
kubectl logs <pod-name> -c wait-nrf -n 5g-testbed
```

### API not responding?
```bash
# Check testbed-api logs
kubectl logs deployment/testbed-api -n 5g-testbed

# Check it can access K8s API
kubectl logs deployment/testbed-api -n 5g-testbed | grep "K8s\|cluster"

# Verify RBAC is applied
kubectl get role,rolebinding -n 5g-testbed
kubectl get clusterrole,clusterrolebinding | grep testbed
```

### UE not registering?
```bash
# Check gNB is running and has AMF connectivity
kubectl logs deployment/ueransim-gnb -n 5g-testbed | grep -i "connect\|amf"

# Check UE logs
kubectl logs deployment/ueransim-ue1 -n 5g-testbed | tail -50

# Verify DNS resolution
kubectl exec -it <ue-pod> -- nslookup open5gs-amf.5g-testbed.svc.cluster.local
```

## Files Modified/Created

### Phase 1 Foundation
- ✅ `k8s/base/namespace.yaml` — Kubernetes namespace
- ✅ `k8s/base/mongodb/` — MongoDB StatefulSet + PVC
- ✅ `k8s/base/open5gs-core/` — All Open5GS NF deployments
- ✅ `k8s/base/ran/` — UERANSIM gNB + UEs
- ✅ `k8s/base/kustomization.yaml` — Base orchestration

### Phase 2 Management
- ✅ `k8s/base/management/rbac.yaml` — ServiceAccount + RBAC
- ✅ `k8s/base/management/api-configmap.yaml` — testbed-api code
- ✅ `k8s/base/management/api-deployment.yaml` — API server
- ✅ `k8s/base/management/ui-configmap.yaml` — UI code + nginx config
- ✅ `k8s/base/management/ui-deployment.yaml` — UI server
- ✅ `k8s/base/management/nginx-configmap.yaml` — Reverse proxy config
- ✅ `k8s/base/management/service.yaml` — NodePort + ClusterIP services
- ✅ `k8s/base/kustomization.yaml` — Updated with Phase 2

### Documentation
- ✅ `k8s/base/README.md` — Architecture guide
- ✅ `k8s/PHASE1_STATUS.md` — Phase 1 status
- ✅ `k8s/PHASE2_STATUS.md` — Phase 2 status
- ✅ `k8s/DEPLOYMENT_GUIDE.md` — Deployment reference
- ✅ `k8s/QUICK_START.md` — This file

## Next Phases

### Phase 3: Auto-Scaling
- HorizontalPodAutoscaler (HPA) for AMF, SMF, UPF
- Custom scaling policies based on metrics
- Controller for closed-loop scaling

### Phase 4: Observability
- Prometheus for metrics collection
- Grafana for dashboards
- Loki for log aggregation
- Promtail for log shipping
- cAdvisor for container metrics

### Phase 5: Advanced
- Multus CNI for network separation
- Service mesh integration
- Advanced security policies
- eBPF for networking

## Support

For issues or questions:
1. Check pod logs: `kubectl logs <pod> -n 5g-testbed`
2. Check pod status: `kubectl describe pod <pod> -n 5g-testbed`
3. Review documentation:
   - `k8s/base/README.md` — Architecture
   - `k8s/PHASE1_STATUS.md` — Core components
   - `k8s/PHASE2_STATUS.md` — Management layer
   - `k8s/DEPLOYMENT_GUIDE.md` — Detailed reference

---

**Ready to deploy? Run:**
```bash
kubectl apply -k k8s/base/ && kubectl get pods -n 5g-testbed -w
```

**When all pods are Running, open:**
```
http://localhost:30080
```

✅ 5G Testbed is live!
