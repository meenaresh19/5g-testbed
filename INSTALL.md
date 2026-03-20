# Installation Guide — 5G Testbed on Kubernetes

Tested on Ubuntu 22.04 / 24.04 — bare metal, local VM, or AWS EC2.

---

## Quick Start (automated)

```bash
git clone https://github.com/meenaresh19/5g-testbed.git
cd 5g-testbed
chmod +x bootstrap.sh
sudo ./bootstrap.sh
```

The script handles everything:
- Installs K3s with Cilium CNI
- Enables SCTP (required for 5G NGAP — disabled by default in Cilium)
- Deploys all pods via `kubectl apply -k .`
- Provisions test subscribers in MongoDB

Access the dashboard at `http://<node-ip>:30080` when done.

---

## Manual Installation

### 1. System Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 4 cores | 8 cores |
| RAM | 8 GB | 16 GB |
| Disk | 30 GB | 60 GB |
| OS | Ubuntu 22.04 | Ubuntu 24.04 |

AWS EC2 recommended instance: **t3.xlarge** (4 vCPU, 16 GB) or larger.

---

### 2. Install K3s with Cilium

```bash
# Install K3s without the default Flannel CNI
curl -sfL https://get.k3s.io | \
  INSTALL_K3S_VERSION="v1.32.11+k3s1" \
  INSTALL_K3S_EXEC="--flannel-backend=none --disable-network-policy --disable=traefik" \
  sh -

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# Install Cilium CLI
CILIUM_CLI_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt)
curl -sfL "https://github.com/cilium/cilium-cli/releases/download/${CILIUM_CLI_VERSION}/cilium-linux-amd64.tar.gz" \
  | tar xz -C /usr/local/bin

# Deploy Cilium
cilium install --version 1.17.2
cilium status --wait
```

---

### 3. Enable SCTP in Cilium ⚠️ Critical

**This step is mandatory.** Without it, the gNB cannot establish NGAP (SCTP) to the AMF.
Cilium ships with `enable-sctp: false` by default.

```bash
kubectl -n kube-system patch configmap cilium-config \
  --type merge -p '{"data":{"enable-sctp":"true"}}'

kubectl -n kube-system rollout restart daemonset/cilium
kubectl -n kube-system rollout status daemonset/cilium --timeout=120s
```

---

### 4. Clone and Deploy

```bash
git clone https://github.com/meenaresh19/5g-testbed.git
cd 5g-testbed

kubectl apply -k .
```

This deploys:
- Open5GS 5G Core (NRF, SCP, AMF, SMF, UPF, AUSF, UDM, UDR, PCF, BSF, NSSF)
- UERANSIM gNB + UE simulators
- MongoDB
- Open5GS WebUI
- Testbed management UI + API
- Prometheus + Grafana observability stack

Subscribers (IMSI `001010000000001` and `001010000000002`) are automatically provisioned by a Kubernetes Job.

---

### 5. Verify Deployment

```bash
# All pods should reach 1/1 Running
kubectl -n 5g-testbed get pods

# UE should register and get a PDU session
kubectl -n 5g-testbed logs -l app=ueransim-ue1 | grep -E "Registration|PDU|TUN"
```

Expected output:
```
[nas] info  Initial Registration is successful
[nas] info  PDU Session establishment is successful PSI[1]
[app] info  Connection setup for PDU session[1] is successful,
            TUN interface[uesimtun0, 10.45.0.2] is up.
```

---

### 6. Access the Testbed

| Service | URL |
|---------|-----|
| **Dashboard UI** | `http://<node-ip>:30080` |
| **Open5GS WebUI** | `http://<node-ip>:30080/open5gs` |
| **API** | `http://<node-ip>:30080/api/status` |

> The nginx proxy on port 30080 routes all traffic. No other ports need to be opened.

---

## AWS EC2 Notes

### Security Group

Open the following inbound rules:

| Port | Protocol | Purpose |
|------|----------|---------|
| 30080 | TCP | Dashboard UI + API |
| 22 | TCP | SSH access |

> No other ports need to be exposed. All 5G internal traffic (SCTP/NGAP, GTP-U, SBI) stays within the cluster.

### Recommended Instance

| Use Case | Instance Type |
|----------|--------------|
| Development / testing | t3.xlarge (4 vCPU, 16 GB) |
| Performance testing | c5.2xlarge (8 vCPU, 16 GB) |
| Multi-UE simulation | c5.4xlarge (16 vCPU, 32 GB) |

### EBS Volume

Use at least a **30 GB gp3** root volume. The default StorageClass on K3s (`local-path`) will provision PVCs automatically on EBS.

---

## Adding More Subscribers

Use the Open5GS WebUI at `http://<node-ip>:30080/open5gs` (admin / 1423).

Or via MongoDB directly:
```bash
kubectl -n 5g-testbed exec mongodb-0 -- mongosh open5gs --eval '
  db.subscribers.insertOne({
    imsi: "001010000000003",
    security: {
      k: "fec86ba6eb707ed08ce33ae45b4a0fba",
      opc: "c42449363464e2e4fa8adca3063168ca",
      amf: "8000", sqn: Long("0")
    },
    slice: [{ sst: 1, session: [{ name: "internet", type: 3 }] }],
    ambr: { downlink: { value: 1, unit: 3 }, uplink: { value: 1, unit: 3 } },
    subscriber_status: 0, network_access_mode: 0, __v: 0
  });
'
```

---

## Teardown

```bash
# Remove all testbed resources
kubectl delete namespace 5g-testbed

# Uninstall K3s completely
/usr/local/bin/k3s-uninstall.sh
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| gNB stuck connecting, no NGAP | Cilium SCTP disabled | Run Step 3 above |
| PVC stuck `Pending` | No default StorageClass | Check `kubectl get storageclass` |
| UDR/PCF can't reach MongoDB | Wrong DB_URI env | Check `DB_URI` env var in deployment |
| UE rejected `PLMN_NOT_ALLOWED` | Subscriber not in DB | Wait for `provision-subscribers` job to complete |
| Open5GS NF crashes at startup | Missing `global:` key in config | Already fixed in this repo |
| SBI probes failing | HTTP/2 vs HTTP/1.1 mismatch | Already fixed (tcpSocket probes) |

See [`docs/k8s-deployment-fixes.md`](docs/k8s-deployment-fixes.md) for full root-cause analysis of all known issues.
