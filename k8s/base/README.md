# K3s Base Manifests for 5G Testbed

This directory contains the base Kubernetes manifests for deploying the 5G testbed on K3s.

## Directory Structure

- **namespace.yaml** — Creates the `5g-testbed` namespace
- **mongodb/** — MongoDB StatefulSet, PVC, and Service
- **open5gs-core/** — All Open5GS NFs (NRF, SCP, AMF, SMF, UPF, AUSF, UDM, UDR, PCF, BSF, NSSF, WebUI)
- **ran/** — RAN simulators (UERANSIM gNB + UE1/UE2)
- **observability/** — Prometheus, Grafana, Loki, Promtail, cAdvisor
- **management/** — testbed-api, testbed-ui (nginx), RBAC
- **ids/** — Zeek IDS, Scapy attacker
- **autoscaling/** — HPA, custom autoscaler controller, policies
- **networking/** — Multus NAD definitions (future use)
- **storage/** — Local storage class, PVC templates

## Deployment Order

1. **Namespace + MongoDB** (database, required by UDR/PCF/BSF)
2. **NRF + SCP** (service discovery, required by all NFs)
3. **AUSF, UDM** (authentication, no interdependencies)
4. **UDR, PCF, BSF** (depend on MongoDB + NRF)
5. **NSSF** (network slicing, depends on NRF)
6. **AMF, SMF** (core signaling, depend on NRF)
7. **UPF** (user plane, no hard dependencies but important for data path)
8. **WebUI** (subscriber management, depends on MongoDB)
9. **RAN** (gNB and UEs, depend on AMF for N2 connectivity)

Init containers in each deployment enforce this ordering.

## Key Configuration Changes for K8s

### Static IPs → Kubernetes DNS
- **Old:** `registerIPv4: 10.45.0.10` (hardcoded IP)
- **New:** Uses `nrf.5g-testbed.svc.cluster.local:7777` via env vars

### ConfigMaps
All YAML configs stored in `open5gs-core/configmap.yaml`:
- Mounted as volumes into pods
- Updated via ConfigMap changes (pod restart needed)
- All URLs use K8s DNS service names

### Resource Requests/Limits
- **NRF/SCP/AUSF/UDM/NSSF:** 100m CPU, 128Mi RAM (lightweight)
- **AMF/SMF:** 200m CPU, 256Mi RAM (can scale)
- **UPF:** 400m CPU, 512Mi RAM (privileged, GTP tunneling)
- **UDR/PCF/BSF:** 100m CPU, 128Mi RAM
- **MongoDB:** 250m CPU, 512Mi RAM
- **WebUI:** 100m CPU, 256Mi RAM

Adjust these in `kustomization.yaml` patches for your cluster size.

## Prerequisites

- K3s 1.20+ installed on Linux system
- `kubectl` installed and configured
- Local storage provisioner (default with K3s)
- ~5GB disk space for volumes

## Quick Start

```bash
# Install K3s
curl -sfL https://get.k3s.io | sh -

# Apply base manifests
kubectl apply -k k8s/base/

# Monitor rollout
kubectl rollout status deployment --all-namespaces -w

# Verify all pods running
kubectl get pods -n 5g-testbed
```

## Verification

```bash
# Check all pods are running
kubectl get pods -n 5g-testbed

# Check MongoDB is ready
kubectl logs mongodb-0 -n 5g-testbed | grep -i "ready"

# Check NRF registered
kubectl logs deployment/open5gs-nrf -n 5g-testbed | grep -i "register"

# Check metrics endpoint
kubectl port-forward svc/open5gs-nrf 9090:9090 -n 5g-testbed
curl http://localhost:9090/metrics
```

## Troubleshooting

### Pod stuck in CrashLoopBackOff
1. Check logs: `kubectl logs pod-name -n 5g-testbed`
2. Check init container: `kubectl logs pod-name -c wait-mongodb -n 5g-testbed`
3. Verify dependencies are running first

### NFs not registering with NRF
1. Verify NRF is running: `kubectl get pods -n 5g-testbed -l app=open5gs-nrf`
2. Check NRF logs: `kubectl logs deployment/open5gs-nrf -n 5g-testbed`
3. Verify DNS resolution: `kubectl exec -it nrf-pod -n 5g-testbed -- nslookup nrf.5g-testbed.svc.cluster.local`

### SCTP port issues (N2)
- K8s Flannel CNI natively supports SCTP in 1.20+
- If NGAP (port 38412) doesn't work, consider Multus CNI (future)

## Multus CNI (Future Enhancement)

When ready to separate networks (5g-core-net, ran-net, mgmt-net):

1. Install Multus: `kubectl apply -f https://raw.githubusercontent.com/k8snetworkplumbingwg/multus-cni/master/deployments/multus-daemonset.yml`
2. Define NetworkAttachmentDefinitions in `networking/multus-nad.yaml`
3. Update pod specs to request secondary networks
4. See `networking/README.md` for detailed migration path

## Next Steps After Phase 1

- Phase 2: Deploy testbed-api and testbed-ui
- Phase 3: Configure auto-scaling policies
- Phase 4: Set up Prometheus/Grafana observability
- Phase 5: (Optional) Multus CNI for true network separation
