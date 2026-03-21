#!/bin/bash
# bootstrap.sh — One-shot setup for 5G testbed on a fresh Ubuntu 22.04/24.04 node
# Tested on: AWS EC2 (t3.xlarge+), bare-metal, and local VM
#
# Usage:
#   git clone https://github.com/meenaresh19/5g-testbed.git
#   cd 5g-testbed
#   chmod +x bootstrap.sh
#   sudo ./bootstrap.sh
#
# Environment overrides:
#   K3S_VERSION   — pin a specific K3s release  (default: v1.32.11+k3s1)
#   CILIUM_VER    — pin a specific Cilium version (default: 1.17.2)
#   SKIP_CILIUM   — set to "1" to skip Cilium install (use default flannel)
#
# What it does:
#   1. Pre-flight: OS/resource checks, SCTP kernel module
#   2. Installs K3s with Cilium CNI (SCTP-capable)
#   3. Enables SCTP support in Cilium (required for 5G NGAP/N2)
#   4. Deploys the full 5G testbed via kubectl apply -k
#   5. Waits for all pods — Core NFs, RAN, Management, Observability, Autoscaler
#   6. Prints access URLs (detects EC2 public IP automatically)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K3S_VERSION="${K3S_VERSION:-v1.32.11+k3s1}"
CILIUM_VER="${CILIUM_VER:-1.17.2}"
NAMESPACE="5g-testbed"

# ── colours ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'
BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }
section() { echo -e "\n${CYAN}${BOLD}── $* ──────────────────────────────────────────────────${NC}"; }

# ── 0. Pre-flight ─────────────────────────────────────────────────────────────
section "Pre-flight checks"
[[ $EUID -eq 0 ]] || error "Run as root: sudo $0"

# shellcheck source=/dev/null
source /etc/os-release 2>/dev/null || true
[[ "${ID:-}" == "ubuntu" ]] || warn "Not Ubuntu (detected: ${ID:-unknown}) — proceeding anyway"
[[ "${VERSION_ID:-}" == "22.04" || "${VERSION_ID:-}" == "24.04" ]] || \
  warn "Tested on 22.04/24.04 (detected: ${VERSION_ID:-unknown})"

TOTAL_MEM_GB=$(awk '/MemTotal/ {printf "%.0f", $2/1024/1024}' /proc/meminfo)
CPUS=$(nproc)
DISK_GB=$(df -BG / | awk 'NR==2{gsub("G",""); print $4}')

info "CPU: ${CPUS} cores | RAM: ${TOTAL_MEM_GB}GB | Free disk: ${DISK_GB}GB"
[[ $TOTAL_MEM_GB -ge 6 ]]  || warn "Low memory (${TOTAL_MEM_GB}GB) — 8GB+ recommended for all pods"
[[ $CPUS -ge 2 ]]          || warn "Low CPU (${CPUS} cores) — 4+ recommended"
[[ $DISK_GB -ge 15 ]]      || error "Insufficient disk (${DISK_GB}GB free, need 15GB+)"

# SCTP kernel module — required for 5G NGAP (N2 interface)
modprobe sctp 2>/dev/null && info "SCTP kernel module loaded" \
  || warn "SCTP module load failed — may still work if built-in"

# Persist SCTP module across reboots
echo "sctp" > /etc/modules-load.d/sctp.conf 2>/dev/null || true

# Kernel tuning for 5G workloads
cat > /etc/sysctl.d/99-5g-testbed.conf <<'SYSCTL'
net.ipv4.ip_forward            = 1
net.ipv6.conf.all.forwarding   = 1
net.ipv4.conf.all.rp_filter    = 0
net.ipv4.conf.default.rp_filter= 0
net.core.rmem_max              = 134217728
net.core.wmem_max              = 134217728
net.core.netdev_max_backlog    = 300000
net.netfilter.nf_conntrack_max = 1048576
SYSCTL
sysctl -p /etc/sysctl.d/99-5g-testbed.conf &>/dev/null || true
info "Kernel parameters applied"

# ── 1. Install K3s with Cilium CNI ───────────────────────────────────────────
section "K3s + Cilium install"
if command -v k3s &>/dev/null; then
  info "K3s already installed ($(k3s --version | head -1)), skipping."
else
  info "Installing K3s ${K3S_VERSION} (no Flannel, no Traefik)..."
  curl -sfL https://get.k3s.io | \
    INSTALL_K3S_VERSION="${K3S_VERSION}" \
    INSTALL_K3S_EXEC="--flannel-backend=none --disable-network-policy --disable=traefik --write-kubeconfig-mode=644" \
    sh -

  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

  # Make kubeconfig available to non-root users
  mkdir -p /root/.kube
  cp /etc/rancher/k3s/k3s.yaml /root/.kube/config
  if [[ -n "${SUDO_USER:-}" ]]; then
    USER_HOME=$(getent passwd "$SUDO_USER" | cut -d: -f6)
    mkdir -p "$USER_HOME/.kube"
    cp /etc/rancher/k3s/k3s.yaml "$USER_HOME/.kube/config"
    chown "$SUDO_USER:$SUDO_USER" "$USER_HOME/.kube/config"
    info "kubeconfig copied to $USER_HOME/.kube/config"
  fi

  # Add to profile
  echo 'export KUBECONFIG=/etc/rancher/k3s/k3s.yaml' > /etc/profile.d/k3s-kubeconfig.sh

  if [[ "${SKIP_CILIUM:-0}" == "1" ]]; then
    warn "SKIP_CILIUM=1 — skipping Cilium install. SCTP may not work."
  else
    info "Installing Cilium CLI..."
    CILIUM_CLI_VERSION=$(curl -fsSL https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt)
    curl -fsSL "https://github.com/cilium/cilium-cli/releases/download/${CILIUM_CLI_VERSION}/cilium-linux-amd64.tar.gz" \
      | tar xz -C /usr/local/bin
    chmod +x /usr/local/bin/cilium

    info "Deploying Cilium ${CILIUM_VER}..."
    cilium install --version "${CILIUM_VER}"

    info "Waiting for Cilium to be ready (up to 3 min)..."
    cilium status --wait --wait-duration 3m
    info "Cilium ready."
  fi
fi

export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"

# ── 2. Enable SCTP in Cilium ─────────────────────────────────────────────────
section "Cilium SCTP"
SCTP_ENABLED=$(kubectl -n kube-system get configmap cilium-config \
  -o jsonpath='{.data.enable-sctp}' 2>/dev/null || echo "missing")

if [[ "$SCTP_ENABLED" != "true" ]]; then
  info "Enabling SCTP support in Cilium (required for 5G NGAP/N2)..."
  kubectl -n kube-system patch configmap cilium-config \
    --type merge -p '{"data":{"enable-sctp":"true"}}'
  kubectl -n kube-system rollout restart daemonset/cilium
  info "Waiting for Cilium to restart..."
  kubectl -n kube-system rollout status daemonset/cilium --timeout=120s
  info "Cilium SCTP enabled."
else
  info "Cilium SCTP already enabled."
fi

# ── 3. Deploy the 5G testbed ─────────────────────────────────────────────────
section "Deploy 5G testbed"
info "Applying manifests from ${REPO_DIR}..."
cd "$REPO_DIR"
kubectl apply -k .
info "Manifests applied."

# ── 4. Wait for everything to be ready ───────────────────────────────────────
section "Wait for pods"
info "Waiting for pods in namespace '${NAMESPACE}'..."
echo "  (first run pulls ~2GB of images — expect 5-10 min)"

# Subscriber provisioning job
info "Waiting for subscriber provisioning job..."
kubectl -n "${NAMESPACE}" wait job/provision-subscribers \
  --for=condition=complete \
  --timeout=300s 2>/dev/null \
  || warn "Subscriber job timed out — check: kubectl -n ${NAMESPACE} logs job/provision-subscribers"

# All deployments in dependency order
DEPLOYMENTS=(
  # Core 5G (NRF first — others depend on it)
  open5gs-nrf open5gs-scp
  open5gs-amf open5gs-smf open5gs-upf
  open5gs-ausf open5gs-udm open5gs-udr
  open5gs-pcf open5gs-bsf open5gs-nssf
  open5gs-webui
  # Observability
  prometheus grafana
  # Management
  testbed-api testbed-ui
  # RAN
  ueransim-gnb ueransim-ue1
  # Autoscaler (Phase 3)
  autoscaler
)

FAILED=()
for deploy in "${DEPLOYMENTS[@]}"; do
  if kubectl -n "${NAMESPACE}" get deployment/"${deploy}" &>/dev/null; then
    kubectl -n "${NAMESPACE}" rollout status deployment/"${deploy}" \
      --timeout=300s 2>/dev/null \
      && info "  ✓ ${deploy}" \
      || { warn "  ✗ ${deploy} not ready"; FAILED+=("${deploy}"); }
  else
    warn "  - ${deploy} deployment not found (skipping)"
  fi
done

if [[ ${#FAILED[@]} -gt 0 ]]; then
  warn "Some deployments not ready: ${FAILED[*]}"
  warn "Check with: kubectl -n ${NAMESPACE} get pods"
fi

# ── 5. Print access info ──────────────────────────────────────────────────────
section "Access info"

# Detect IP — prefer EC2 public IP (IMDSv2), fall back to internal
INTERNAL_IP=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}' 2>/dev/null || hostname -I | awk '{print $1}')

# Try EC2 IMDSv2 for public IP (silent fail on non-EC2)
PUBLIC_IP=""
if TOKEN=$(curl -sfX PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 10" 2>/dev/null); then
  PUBLIC_IP=$(curl -sf -H "X-aws-ec2-metadata-token: $TOKEN" \
    "http://169.254.169.254/latest/meta-data/public-ipv4" 2>/dev/null || true)
fi

ACCESS_IP="${PUBLIC_IP:-$INTERNAL_IP}"

echo ""
echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}║        5G Testbed deployed successfully!              ║${NC}"
echo -e "${GREEN}${BOLD}╠══════════════════════════════════════════════════════╣${NC}"
printf "${GREEN}${BOLD}║${NC}  %-52s ${GREEN}${BOLD}║${NC}\n" ""
printf "${GREEN}${BOLD}║${NC}  Dashboard UI   : ${CYAN}http://%-27s${GREEN}${BOLD}║${NC}\n" "${ACCESS_IP}:30080"
printf "${GREEN}${BOLD}║${NC}  Open5GS WebUI  : ${CYAN}http://%-27s${GREEN}${BOLD}║${NC}\n" "${ACCESS_IP}:30080/open5gs"
printf "${GREEN}${BOLD}║${NC}  API            : ${CYAN}http://%-27s${GREEN}${BOLD}║${NC}\n" "${ACCESS_IP}:30080/api/status"
printf "${GREEN}${BOLD}║${NC}  %-52s ${GREEN}${BOLD}║${NC}\n" ""
printf "${GREEN}${BOLD}║${NC}  Admin login    : %-34s ${GREEN}${BOLD}║${NC}\n" "admin / admin"
printf "${GREEN}${BOLD}║${NC}  Open5GS login  : %-34s ${GREEN}${BOLD}║${NC}\n" "admin / 1423"
printf "${GREEN}${BOLD}║${NC}  %-52s ${GREEN}${BOLD}║${NC}\n" ""
echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════════╝${NC}"
echo ""

if [[ -n "$PUBLIC_IP" ]]; then
  echo -e "${YELLOW}AWS EC2 detected — ensure Security Group allows:${NC}"
  echo "  • Port 30080 TCP  (Dashboard UI + API)"
  echo "  • Port 22    TCP  (SSH)"
  echo ""
fi

echo "  Verify UE registration:"
echo "    kubectl -n ${NAMESPACE} logs -l app=ueransim-ue1 | grep -E 'Registration|PDU|TUN'"
echo ""
echo "  Pod status:"
kubectl -n "${NAMESPACE}" get pods -o wide
echo ""
