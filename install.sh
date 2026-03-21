#!/bin/bash
# ============================================================
# 5G Testbed Installer
# Open5GS 5G Core + UERANSIM RAN + Management UI
# Usage: sudo bash install.sh [--k8s | --docker]
# Tested: Ubuntu 22.04 LTS / 24.04 LTS
# ============================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

MODE="${1:---k8s}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="/var/log/5g-testbed-install.log"

log()     { echo -e "${GREEN}[✓]${NC} $*" | tee -a "$LOG"; }
warn()    { echo -e "${YELLOW}[!]${NC} $*" | tee -a "$LOG"; }
err()     { echo -e "${RED}[✗]${NC} $*" | tee -a "$LOG"; exit 1; }
section() { echo -e "\n${CYAN}${BOLD}══ $* ══${NC}\n" | tee -a "$LOG"; }

check_root() {
  [[ $EUID -eq 0 ]] || err "Run as root: sudo bash install.sh [--k8s | --docker]"
}

check_os() {
  section "Checking OS"
  # shellcheck source=/dev/null
  source /etc/os-release 2>/dev/null || true
  [[ "${ID:-}" == "ubuntu" ]] || warn "Ubuntu required (detected: ${ID:-unknown})"
  [[ "${VERSION_ID:-}" == "22.04" || "${VERSION_ID:-}" == "24.04" ]] || \
    warn "Tested on 22.04/24.04 (detected: ${VERSION_ID:-unknown}) — proceeding anyway"
  log "OS: Ubuntu ${VERSION_ID:-unknown}"
}

check_resources() {
  section "Checking System Resources"
  CPU=$(nproc)
  RAM_GB=$(awk '/MemTotal/{printf "%d", $2/1024/1024}' /proc/meminfo)
  DISK_GB=$(df -BG / | awk 'NR==2{gsub("G",""); print $4}')
  log "CPU: ${CPU} cores | RAM: ${RAM_GB}GB | Free disk: ${DISK_GB}GB"
  [[ $CPU -ge 4 ]]      || warn "Low CPU (${CPU} cores) — 4+ recommended"
  [[ $RAM_GB -ge 8 ]]   || warn "Low RAM (${RAM_GB}GB) — 8GB+ recommended"
  [[ $DISK_GB -ge 15 ]] || err  "Insufficient disk space (${DISK_GB}GB free, need 15GB+)"
}

install_deps() {
  section "Installing System Dependencies"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq \
    curl wget git ca-certificates gnupg lsb-release \
    net-tools iproute2 iptables \
    python3 python3-pip jq \
    2>&1 | tee -a "$LOG"

  apt-get install -y -qq "linux-headers-$(uname -r)" 2>/dev/null \
    || warn "linux-headers-$(uname -r) not found — skipping"
  apt-get install -y -qq sctp-tools lksctp-tools 2>/dev/null \
    || warn "sctp-tools not available"
  apt-get install -y -qq tcpdump 2>/dev/null || true

  log "System dependencies installed"
}

configure_kernel() {
  section "Configuring Kernel for 5G"
  cat > /etc/sysctl.d/99-5g-testbed.conf <<'EOF'
net.ipv4.ip_forward              = 1
net.ipv6.conf.all.forwarding     = 1
net.ipv4.conf.all.rp_filter      = 0
net.ipv4.conf.default.rp_filter  = 0
net.core.rmem_max                = 134217728
net.core.wmem_max                = 134217728
net.core.netdev_max_backlog      = 300000
net.netfilter.nf_conntrack_max   = 1048576
EOF
  sysctl -p /etc/sysctl.d/99-5g-testbed.conf &>/dev/null \
    || warn "Some sysctl params failed (may need reboot)"

  modprobe sctp 2>/dev/null && echo "sctp" > /etc/modules-load.d/sctp.conf \
    || warn "SCTP module not available"
  modprobe gtp 2>/dev/null \
    || warn "GTP module not available (UPF will use userspace path)"

  log "Kernel parameters configured"
}

# ── Kubernetes (K3s + Cilium) ─────────────────────────────────────────────────
install_k8s() {
  section "Installing K3s + Cilium"

  K3S_VERSION="${K3S_VERSION:-v1.32.11+k3s1}"
  CILIUM_VER="${CILIUM_VER:-1.17.2}"

  if command -v k3s &>/dev/null; then
    log "K3s already installed: $(k3s --version | head -1)"
  else
    log "Installing K3s ${K3S_VERSION}..."
    curl -sfL https://get.k3s.io | \
      INSTALL_K3S_VERSION="${K3S_VERSION}" \
      INSTALL_K3S_EXEC="--flannel-backend=none --disable-network-policy --disable=traefik --write-kubeconfig-mode=644" \
      sh -

    export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
    echo 'export KUBECONFIG=/etc/rancher/k3s/k3s.yaml' > /etc/profile.d/k3s-kubeconfig.sh
    mkdir -p /root/.kube
    cp /etc/rancher/k3s/k3s.yaml /root/.kube/config

    if [[ -n "${SUDO_USER:-}" ]]; then
      USER_HOME=$(getent passwd "$SUDO_USER" | cut -d: -f6)
      mkdir -p "$USER_HOME/.kube"
      cp /etc/rancher/k3s/k3s.yaml "$USER_HOME/.kube/config"
      chown "$SUDO_USER:$SUDO_USER" "$USER_HOME/.kube/config"
    fi

    log "Installing Cilium CLI..."
    CILIUM_CLI_VERSION=$(curl -fsSL https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt)
    curl -fsSL "https://github.com/cilium/cilium-cli/releases/download/${CILIUM_CLI_VERSION}/cilium-linux-amd64.tar.gz" \
      | tar xz -C /usr/local/bin
    chmod +x /usr/local/bin/cilium

    log "Deploying Cilium ${CILIUM_VER}..."
    cilium install --version "${CILIUM_VER}"
    cilium status --wait --wait-duration 3m
    log "Cilium ready."
  fi

  export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"

  # Enable SCTP in Cilium
  SCTP_ENABLED=$(kubectl -n kube-system get configmap cilium-config \
    -o jsonpath='{.data.enable-sctp}' 2>/dev/null || echo "missing")
  if [[ "$SCTP_ENABLED" != "true" ]]; then
    log "Enabling SCTP in Cilium..."
    kubectl -n kube-system patch configmap cilium-config \
      --type merge -p '{"data":{"enable-sctp":"true"}}'
    kubectl -n kube-system rollout restart daemonset/cilium
    kubectl -n kube-system rollout status daemonset/cilium --timeout=120s
  else
    log "Cilium SCTP already enabled."
  fi
}

deploy_k8s() {
  section "Deploying 5G Testbed on Kubernetes"
  export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"

  cd "$SCRIPT_DIR"
  log "Applying manifests..."
  kubectl apply -k .

  log "Waiting for subscriber provisioning job..."
  kubectl -n 5g-testbed wait job/provision-subscribers \
    --for=condition=complete --timeout=300s 2>/dev/null \
    || warn "Subscriber job timed out"

  log "Waiting for deployments (this can take 5-10 min on first run)..."
  for deploy in \
    open5gs-nrf open5gs-scp open5gs-amf open5gs-smf open5gs-upf \
    open5gs-ausf open5gs-udm open5gs-udr open5gs-pcf open5gs-bsf open5gs-nssf \
    open5gs-webui prometheus grafana \
    testbed-api testbed-ui \
    ueransim-gnb ueransim-ue1 \
    autoscaler; do
    kubectl -n 5g-testbed rollout status deployment/"${deploy}" \
      --timeout=300s 2>/dev/null \
      && log "  ✓ ${deploy}" \
      || warn "  ✗ ${deploy} not ready"
  done
}

# ── Docker (legacy) ───────────────────────────────────────────────────────────
install_docker() {
  section "Installing Docker Engine"
  if command -v docker &>/dev/null; then
    log "Docker already installed: $(docker --version)"; return
  fi
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq \
    docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
  usermod -aG docker "${SUDO_USER:-$USER}" 2>/dev/null || true
  mkdir -p /etc/docker
  cat > /etc/docker/daemon.json <<'DOCKEREOF'
{
  "default-ulimits": { "nofile": { "Name": "nofile", "Hard": 65536, "Soft": 65536 } },
  "log-driver": "json-file",
  "log-opts": { "max-size": "100m", "max-file": "3" },
  "storage-driver": "overlay2"
}
DOCKEREOF
  systemctl restart docker
  log "Docker installed: $(docker --version)"
}

deploy_docker() {
  section "Deploying 5G Testbed with Docker Compose"
  COMPOSE_FILE="docker/docker-compose.yml"
  [[ -f "$SCRIPT_DIR/$COMPOSE_FILE" ]] \
    || err "Docker Compose file not found: $SCRIPT_DIR/$COMPOSE_FILE"
  cd "$SCRIPT_DIR"
  log "Pulling images..."
  docker compose -f "$COMPOSE_FILE" --project-directory . pull 2>&1 | tee -a "$LOG" || true
  log "Starting services..."
  docker compose -f "$COMPOSE_FILE" --project-directory . up -d 2>&1 | tee -a "$LOG" \
    || err "docker compose up failed — check $LOG"
  docker compose -f "$COMPOSE_FILE" --project-directory . ps
}

# ── Summary ───────────────────────────────────────────────────────────────────
print_summary() {
  section "Installation Complete"

  # EC2 public IP detection (IMDSv2)
  PUBLIC_IP=""
  if TOKEN=$(curl -sfX PUT "http://169.254.169.254/latest/api/token" \
      -H "X-aws-ec2-metadata-token-ttl-seconds: 10" 2>/dev/null); then
    PUBLIC_IP=$(curl -sf -H "X-aws-ec2-metadata-token: $TOKEN" \
      "http://169.254.169.254/latest/meta-data/public-ipv4" 2>/dev/null || true)
  fi

  if [[ "$MODE" == "--k8s" ]]; then
    NODE_IP=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}' 2>/dev/null || hostname -I | awk '{print $1}')
    ACCESS_IP="${PUBLIC_IP:-$NODE_IP}"

    echo -e "${BOLD}"
    echo "  ╔══════════════════════════════════════════════════╗"
    echo "  ║       5G Testbed — Kubernetes Access Points      ║"
    echo "  ╠══════════════════════════════════════════════════╣"
    printf "  ║  Dashboard UI  : http://%-24s ║\n" "${ACCESS_IP}:30080"
    printf "  ║  Open5GS WebUI : http://%-24s ║\n" "${ACCESS_IP}:30080/open5gs"
    printf "  ║  API           : http://%-24s ║\n" "${ACCESS_IP}:30080/api/status"
    echo "  ╠══════════════════════════════════════════════════╣"
    echo "  ║  Admin login   : admin / admin                   ║"
    echo "  ║  Open5GS login : admin / 1423                    ║"
    echo "  ╚══════════════════════════════════════════════════╝"
    echo -e "${NC}"
    if [[ -n "$PUBLIC_IP" ]]; then
      echo -e "${YELLOW}AWS EC2: ensure Security Group allows port 30080 TCP${NC}"
    fi
    echo "  Logs:    kubectl -n 5g-testbed logs -l app=<name> -f"
    echo "  Status:  kubectl -n 5g-testbed get pods"
  else
    IP="${PUBLIC_IP:-$(hostname -I | awk '{print $1}')}"
    echo -e "${BOLD}"
    echo "  ╔══════════════════════════════════════════════════╗"
    echo "  ║       5G Testbed — Docker Access Points          ║"
    echo "  ╠══════════════════════════════════════════════════╣"
    printf "  ║  Dashboard UI  : http://%-24s ║\n" "${IP}:3000"
    printf "  ║  Open5GS WebUI : http://%-24s ║\n" "${IP}:9999"
    printf "  ║  Grafana       : http://%-24s ║\n" "${IP}:3001"
    printf "  ║  API           : http://%-24s ║\n" "${IP}:5000"
    echo "  ╠══════════════════════════════════════════════════╣"
    echo "  ║  Open5GS login : admin / 1423                    ║"
    echo "  ║  Grafana login : admin / admin                   ║"
    echo "  ╚══════════════════════════════════════════════════╝"
    echo -e "${NC}"
    echo "  Logs:    docker compose -f docker/docker-compose.yml logs -f"
    echo "  Stop:    docker compose -f docker/docker-compose.yml down"
  fi
  echo ""
}

# ── Main ──────────────────────────────────────────────────────────────────────
check_root
check_os
check_resources
install_deps
configure_kernel

case "$MODE" in
  --k8s)
    install_k8s
    deploy_k8s
    ;;
  --docker)
    install_docker
    deploy_docker
    ;;
  *)
    err "Usage: $0 [--k8s | --docker]"
    ;;
esac

print_summary
