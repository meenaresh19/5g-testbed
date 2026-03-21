# Installation Guide — 5G Testbed on Kubernetes

Tested on Ubuntu 22.04 / 24.04 — AWS EC2, bare metal, or local VM.

---

## Quick Start

```bash
git clone https://github.com/meenaresh19/5g-testbed.git
cd 5g-testbed
chmod +x bootstrap.sh
sudo ./bootstrap.sh
```

Access the dashboard at `http://<node-ip>:30080` when done.

---

## AWS EC2 — Automated (User Data)

The fastest way: paste `scripts/ec2-userdata.sh` into the **User data** field
when launching an EC2 instance. No SSH required — the instance sets itself up
on first boot (~10 min).

### EC2 Launch Settings

| Setting | Value |
|---------|-------|
| AMI | Ubuntu 22.04 or 24.04 LTS (x86_64) |
| Instance type | **t3.xlarge** (4 vCPU, 16 GB) minimum |
| Storage | 30 GB gp3 root volume |
| Security Group | Port **30080** TCP (Dashboard) + **22** TCP (SSH) |
| IAM role | None required |

### Monitor Setup Progress

```bash
# SSH in, then:
tail -f /var/log/5g-testbed-setup.log

# Check done:
cat /etc/motd
```

---

## Manual Installation

### 1. System Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 4 cores | 8 cores |
| RAM | 8 GB | 16 GB |
| Disk | 20 GB free | 40 GB |
| OS | Ubuntu 22.04 | Ubuntu 24.04 |

---

### 2. Install K3s with Cilium

```bash
# Install K3s without Flannel
curl -sfL https://get.k3s.io | \
  INSTALL_K3S_VERSION="v1.32.11+k3s1" \
  INSTALL_K3S_EXEC="--flannel-backend=none --disable-network-policy --disable=traefik --write-kubeconfig-mode=644" \
  sh -

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# Install Cilium CLI
CILIUM_CLI_VERSION=$(curl -fsSL https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt)
curl -fsSL "https://github.com/cilium/cilium-cli/releases/download/${CILIUM_CLI_VERSION}/cilium-linux-amd64.tar.gz" \
  | tar xz -C /usr/local/bin

# Deploy Cilium
cilium install --version 1.17.2
cilium status --wait
```

---

### 3. Enable SCTP in Cilium ⚠️ Critical

**Mandatory.** Without this the gNB cannot connect to the AMF over NGAP (SCTP).

```bash
kubectl -n kube-system patch configmap cilium-config \
  --type merge -p '{"data":{"enable-sctp":"true"}}'

kubectl -n kube-system rollout restart daemonset/cilium
kubectl -n kube-system rollout status daemonset/cilium --timeout=120s
```

---

### 4. Deploy the Testbed

```bash
git clone https://github.com/meenaresh19/5g-testbed.git
cd 5g-testbed
kubectl apply -k .
```

Deploys:
- **Open5GS 5G Core** — NRF, SCP, AMF, SMF, UPF, AUSF, UDM, UDR, PCF, BSF, NSSF
- **UERANSIM** — gNB + UE simulators
- **MongoDB** — persistent storage
- **Prometheus + Grafana** — observability
- **Autoscaler** — custom 5G metric-based scaling (Phase 3)
- **Management UI + API** — dashboard on port 30080

---

### 5. Verify Deployment

```bash
# All pods should reach Running
kubectl -n 5g-testbed get pods

# UE should register and get a PDU session
kubectl -n 5g-testbed logs -l app=ueransim-ue1 | grep -E "Registration|PDU|TUN"
```

Expected:
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

Default logins:
- Dashboard admin: `admin / admin`
- Open5GS WebUI: `admin / 1423`

All traffic routes through nginx on port 30080 — no other ports need to be opened.

---

## Update Existing Deployment

After pulling new code:

```bash
cd 5g-testbed
git pull
kubectl apply -k .
kubectl -n 5g-testbed rollout restart deployment/testbed-ui deployment/testbed-api
```

---

## Teardown

```bash
# Remove testbed
kubectl delete namespace 5g-testbed

# Full uninstall (removes K3s + all data)
/usr/local/bin/k3s-uninstall.sh
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| gNB stuck connecting / no NGAP | Cilium SCTP disabled | Re-run Step 3 |
| PVC stuck `Pending` | No default StorageClass | `kubectl get storageclass` |
| UDR/PCF can't reach MongoDB | Wrong `DB_URI` env | Check env vars in deployment |
| UE rejected `PLMN_NOT_ALLOWED` | Subscriber not in DB | Wait for `provision-subscribers` job |
| CLA tab not visible | Pod running old ConfigMap | `kubectl rollout restart deployment/testbed-ui` |
| Autoscaler not scaling | No metric data from Prometheus | Check `kubectl -n 5g-testbed logs deployment/autoscaler` |

See [`docs/k8s-deployment-fixes.md`](docs/k8s-deployment-fixes.md) for full root-cause analysis.
