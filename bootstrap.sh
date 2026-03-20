#!/bin/bash
# bootstrap.sh — One-shot setup for 5G testbed on a fresh Ubuntu 22.04/24.04 node
# Tested on: AWS EC2 (t3.xlarge+), bare-metal, and local VM
#
# Usage:
#   chmod +x bootstrap.sh
#   sudo ./bootstrap.sh
#
# What it does:
#   1. Installs K3s with Cilium CNI
#   2. Enables SCTP support in Cilium (required for 5G NGAP)
#   3. Deploys the full 5G testbed via kubectl apply -k
#   4. Waits for all pods to be ready

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K3S_VERSION="${K3S_VERSION:-v1.32.11+k3s1}"
NAMESPACE="5g-testbed"

# ── colours ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ── 0. Pre-flight checks ─────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || error "Run as root: sudo $0"

info "Checking system requirements..."
TOTAL_MEM_GB=$(awk '/MemTotal/ {printf "%.0f", $2/1024/1024}' /proc/meminfo)
CPUS=$(nproc)
[[ $TOTAL_MEM_GB -ge 6 ]]  || warn "Low memory: ${TOTAL_MEM_GB}GB (8GB+ recommended)"
[[ $CPUS -ge 2 ]]          || warn "Low CPU: ${CPUS} cores (4+ recommended)"

# Load SCTP kernel module early
modprobe sctp 2>/dev/null && info "SCTP kernel module loaded" || warn "SCTP module load failed — may still work if built-in"

# ── 1. Install K3s with Cilium ───────────────────────────────────────────────
if command -v k3s &>/dev/null; then
  info "K3s already installed ($(k3s --version | head -1)), skipping install."
else
  info "Installing K3s ${K3S_VERSION} with Cilium CNI..."
  curl -sfL https://get.k3s.io | \
    INSTALL_K3S_VERSION="${K3S_VERSION}" \
    INSTALL_K3S_EXEC="--flannel-backend=none --disable-network-policy --disable=traefik" \
    sh -

  info "Installing Cilium CLI..."
  CILIUM_CLI_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt)
  curl -sfL "https://github.com/cilium/cilium-cli/releases/download/${CILIUM_CLI_VERSION}/cilium-linux-amd64.tar.gz" \
    | tar xz -C /usr/local/bin

  info "Deploying Cilium into the cluster..."
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
  cilium install --version 1.17.2

  info "Waiting for Cilium to be ready..."
  cilium status --wait --wait-duration 3m
fi

export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"

# ── 2. Enable SCTP in Cilium ─────────────────────────────────────────────────
SCTP_ENABLED=$(kubectl -n kube-system get configmap cilium-config \
  -o jsonpath='{.data.enable-sctp}' 2>/dev/null || echo "missing")

if [[ "$SCTP_ENABLED" != "true" ]]; then
  info "Enabling SCTP support in Cilium..."
  kubectl -n kube-system patch configmap cilium-config \
    --type merge -p '{"data":{"enable-sctp":"true"}}'
  kubectl -n kube-system rollout restart daemonset/cilium
  info "Waiting for Cilium to restart..."
  kubectl -n kube-system rollout status daemonset/cilium --timeout=120s
else
  info "Cilium SCTP already enabled."
fi

# ── 3. Deploy the 5G testbed ─────────────────────────────────────────────────
info "Deploying 5G testbed from ${REPO_DIR}..."
cd "$REPO_DIR"
kubectl apply -k .

# ── 4. Wait for everything to be ready ───────────────────────────────────────
info "Waiting for all pods in namespace '${NAMESPACE}' to be ready..."
echo "  (this can take 3-5 minutes on first run while images are pulled)"

# Wait for the subscriber provisioning job to complete
info "Waiting for subscriber provisioning job..."
kubectl -n "${NAMESPACE}" wait job/provision-subscribers \
  --for=condition=complete \
  --timeout=300s 2>/dev/null || \
  warn "Subscriber job timed out — check: kubectl -n ${NAMESPACE} logs job/provision-subscribers"

# Wait for all deployments
for deploy in \
  open5gs-nrf open5gs-scp open5gs-amf open5gs-smf open5gs-upf \
  open5gs-ausf open5gs-udm open5gs-udr open5gs-pcf open5gs-bsf open5gs-nssf \
  open5gs-webui prometheus grafana \
  testbed-api testbed-proxy testbed-ui \
  ueransim-gnb ueransim-ue1; do
  kubectl -n "${NAMESPACE}" rollout status deployment/"${deploy}" \
    --timeout=300s 2>/dev/null || warn "Deployment ${deploy} not ready yet"
done

# ── 5. Print access info ──────────────────────────────────────────────────────
NODE_IP=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')

echo ""
echo -e "${GREEN}════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  5G Testbed deployed successfully!             ${NC}"
echo -e "${GREEN}════════════════════════════════════════════════${NC}"
echo ""
echo "  Dashboard UI  : http://${NODE_IP}:30080"
echo "  Open5GS WebUI : http://${NODE_IP}:30080/open5gs"
echo ""
echo "  Verify UE registration:"
echo "    kubectl -n ${NAMESPACE} logs -l app=ueransim-ue1 | grep -E 'Registration|PDU|TUN'"
echo ""
echo "  Pod status:"
kubectl -n "${NAMESPACE}" get pods
echo ""
