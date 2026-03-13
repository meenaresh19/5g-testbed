#!/bin/bash
# ============================================================
# 5G Testbed Installer
# OAI RAN + Open5GS Core + Management UI
# Usage: sudo bash install.sh [--docker | --k8s]
# Tested: Ubuntu 22.04 LTS / 24.04 LTS
# ============================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

MODE="${1:---docker}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/opt/5g-testbed"
LOG="/var/log/5g-testbed-install.log"

log()  { echo -e "${GREEN}[✓]${NC} $*" | tee -a "$LOG"; }
warn() { echo -e "${YELLOW}[!]${NC} $*" | tee -a "$LOG"; }
err()  { echo -e "${RED}[✗]${NC} $*" | tee -a "$LOG"; exit 1; }
hdr()  { echo -e "\n${CYAN}${BOLD}══ $* ══${NC}\n" | tee -a "$LOG"; }

check_root() {
  [[ $EUID -eq 0 ]] || err "Run as root: sudo bash install.sh"
}

check_os() {
  hdr "Checking OS"
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "$ID" == "ubuntu" ]] || err "Ubuntu required (detected: $ID)"
  [[ "$VERSION_ID" == "22.04" || "$VERSION_ID" == "24.04" ]] || \
    warn "Tested on 22.04/24.04 (detected: $VERSION_ID) — proceeding anyway"
  log "OS: Ubuntu $VERSION_ID"
}

check_resources() {
  hdr "Checking System Resources"
  CPU=$(nproc)
  RAM_GB=$(awk '/MemTotal/{printf "%d", $2/1024/1024}' /proc/meminfo)
  DISK_GB=$(df -BG / | awk 'NR==2{gsub("G",""); print $4}')

  log "CPU cores: $CPU (min 4)"
  log "RAM: ${RAM_GB}GB (min 8GB)"
  log "Free disk: ${DISK_GB}GB (min 20GB)"

  [[ $CPU -ge 4 ]]      || warn "Low CPU ($CPU cores); performance may suffer"
  [[ $RAM_GB -ge 8 ]]   || warn "Low RAM (${RAM_GB}GB); recommend 16GB+"
  [[ $DISK_GB -ge 20 ]] || err  "Insufficient disk space (${DISK_GB}GB free)"
}

install_deps() {
  hdr "Installing System Dependencies"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq

  # Core utilities — required
  apt-get install -y -qq \
    curl wget git ca-certificates gnupg lsb-release \
    net-tools iproute2 iptables nftables \
    python3 python3-pip jq \
    2>&1 | tee -a "$LOG"

  # Kernel headers — non-fatal (may not match running kernel in some VMs)
  apt-get install -y -qq "linux-headers-$(uname -r)" 2>/dev/null \
    || warn "linux-headers-$(uname -r) not found; skipping"

  # SCTP tools — non-fatal (may require universe repo)
  apt-get install -y -qq sctp-tools lksctp-tools libsctp-dev 2>/dev/null \
    || warn "sctp-tools not available; SCTP features may be limited"

  # Network analysis tools — non-fatal (tshark prompts on headless)
  apt-get install -y -qq tcpdump 2>/dev/null || true
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tshark wireshark-common 2>/dev/null || true

  # yq — try apt (Ubuntu repos), fall back to binary
  if ! command -v yq &>/dev/null; then
    apt-get install -y -qq yq 2>/dev/null || {
      warn "yq not in apt; installing binary from GitHub"
      YQ_VERSION="v4.40.5"
      curl -fsSL "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_amd64" \
        -o /usr/local/bin/yq && chmod +x /usr/local/bin/yq \
        || warn "yq install failed; YAML manipulation unavailable"
    }
  fi

  log "System dependencies installed"
}

install_docker() {
  hdr "Installing Docker Engine"
  if command -v docker &>/dev/null; then
    log "Docker already installed: $(docker --version)"
    return
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
  log "Docker installed: $(docker --version)"

  # Resource limits for 5G workloads
  mkdir -p /etc/docker
  cat > /etc/docker/daemon.json <<'DOCKEREOF'
{
  "default-ulimits": {
    "nofile": { "Name": "nofile", "Hard": 65536, "Soft": 65536 }
  },
  "log-driver": "json-file",
  "log-opts": { "max-size": "100m", "max-file": "3" },
  "storage-driver": "overlay2"
}
DOCKEREOF
  systemctl restart docker
}

install_kubectl_helm() {
  hdr "Installing kubectl + Helm"
  if ! command -v kubectl &>/dev/null; then
    KUBE_VER=$(curl -Lfs https://dl.k8s.io/release/stable.txt)
    curl -fsSL "https://dl.k8s.io/release/${KUBE_VER}/bin/linux/amd64/kubectl" \
      -o /usr/local/bin/kubectl
    chmod +x /usr/local/bin/kubectl
  fi
  log "kubectl: $(kubectl version --client 2>/dev/null | head -1)"

  if ! command -v helm &>/dev/null; then
    curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
  fi
  log "Helm: $(helm version --short)"
}

install_k3s() {
  hdr "Installing K3s (Lightweight Kubernetes)"
  if command -v k3s &>/dev/null; then
    log "K3s already installed"; return
  fi
  curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="\
    --disable traefik \
    --disable servicelb \
    --write-kubeconfig-mode 644 \
    --kubelet-arg=max-pods=250" sh -
  sleep 10
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
  echo "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml" >> /etc/profile.d/k3s.sh
  # MetalLB for LoadBalancer support
  kubectl apply -f https://raw.githubusercontent.com/metallb/metallb/v0.14.3/config/manifests/metallb-native.yaml
  log "K3s installed: $(k3s --version | head -1)"
}

configure_kernel() {
  hdr "Configuring Kernel for 5G"
  cat > /etc/sysctl.d/99-5g-testbed.conf <<'EOF'
# 5G Testbed kernel tuning
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.rp_filter = 0
net.ipv4.conf.all.rp_filter = 0

# SCTP for NGAP/N2
net.sctp.sctp_mem = 16777216 16777216 16777216
net.sctp.sctp_wmem = 4096 131072 16777216
net.sctp.sctp_rmem = 4096 131072 16777216

# UDP/GTP-U (N3 interface)
net.core.rmem_max = 134217728
net.core.wmem_max = 134217728
net.core.netdev_max_backlog = 300000

# Connection tracking for UE sessions
net.netfilter.nf_conntrack_max = 1048576
net.netfilter.nf_conntrack_udp_timeout = 60
EOF
  sysctl -p /etc/sysctl.d/99-5g-testbed.conf &>/dev/null || warn "Some sysctl params failed (may need reboot)"
  log "Kernel parameters configured"

  # Load SCTP module
  modprobe sctp 2>/dev/null && echo "sctp" >> /etc/modules-load.d/5g.conf || \
    warn "SCTP module not available (may need linux-modules-extra)"

  # GTP module for UPF — graceful fallback to userspace
  modprobe gtp 2>/dev/null || warn "GTP module not available (UPF will use userspace path)"
}

setup_testbed() {
  hdr "Setting Up 5G Testbed"
  mkdir -p "$INSTALL_DIR"

  # Copy project files if we are not already in INSTALL_DIR
  if [[ "$(realpath "$SCRIPT_DIR")" != "$(realpath "$INSTALL_DIR")" ]]; then
    cp -rf "$SCRIPT_DIR/." "$INSTALL_DIR/"
    log "Project files copied to $INSTALL_DIR"
  else
    log "Running from $INSTALL_DIR — skipping copy"
  fi

  cd "$INSTALL_DIR"

  # Traces directory — world-writable so tcpdump inside containers can write to it
  mkdir -p "$INSTALL_DIR/traces"
  chmod 777 "$INSTALL_DIR/traces"
  log "Traces directory: $INSTALL_DIR/traces"

  # IDS alert directories — world-writable so Zeek/Scapy containers (host-net) can write alerts
  mkdir -p "$INSTALL_DIR/ids/zeek"
  chmod 777 "$INSTALL_DIR/ids" "$INSTALL_DIR/ids/zeek"
  log "IDS directory: $INSTALL_DIR/ids  (Zeek + Scapy alert output)"

  # Grafana dashboard directory — must exist before grafana container starts
  mkdir -p "$INSTALL_DIR/configs/grafana/provisioning/datasources"
  mkdir -p "$INSTALL_DIR/configs/grafana/provisioning/dashboards"
  mkdir -p "$INSTALL_DIR/configs/grafana/dashboards"
  log "Grafana provisioning directories created"

  # Generate default 5G configs (idempotent — regenerates if UERANSIM configs missing)
  if [[ ! -d "$INSTALL_DIR/configs/open5gs" ]] || [[ ! -d "$INSTALL_DIR/configs/ueransim" ]]; then
    bash scripts/gen-configs.sh
    log "Configs generated (Open5GS + UERANSIM)"
  else
    log "Configs already present — skipping gen-configs.sh"
  fi

  if [[ "$MODE" == "--k8s" ]]; then
    log "Deploying on Kubernetes..."
    kubectl apply -k k8s/
    kubectl -n 5g-testbed rollout status deployment --timeout=300s
  else
    log "Pulling Docker images (this may take a few minutes)..."
    docker compose -f docker/docker-compose.yml --project-directory . pull 2>&1 | tee -a "$LOG" \
      || warn "Some images could not be pulled; will try on 'up'"
    log "Starting services..."
    if ! docker compose -f docker/docker-compose.yml --project-directory . up -d 2>&1 | tee -a "$LOG"; then
      err "docker compose up failed — check $LOG for details"
    fi
    docker compose -f docker/docker-compose.yml --project-directory . ps
  fi
}

print_summary() {
  hdr "Installation Complete"
  IP=$(hostname -I | awk '{print $1}')
  echo -e "${BOLD}"
  echo "  ╔══════════════════════════════════════════════════╗"
  echo "  ║         5G Testbed Access Points                 ║"
  echo "  ╠══════════════════════════════════════════════════╣"
  printf "  ║  Testbed UI    : http://%-24s ║\n" "$IP:3000"
  printf "  ║  Open5GS UI    : http://%-24s ║\n" "$IP:9999"
  printf "  ║  API Server    : http://%-24s ║\n" "$IP:5000"
  printf "  ║  Grafana       : http://%-24s ║\n" "$IP:3001"
  printf "  ║  Grafana (UI)  : http://%-24s ║\n" "$IP:3000/grafana/"
  echo "  ╠══════════════════════════════════════════════════╣"
  echo "  ║  Open5GS login : admin / 1423                    ║"
  echo "  ║  Grafana login : admin / admin  (change on 1st)  ║"
  echo "  ╚══════════════════════════════════════════════════╝"
  echo -e "${NC}"
  echo -e "${YELLOW}Next steps:${NC}"
  echo "  1. Open Testbed UI to view real-time NF status"
  echo "  2. Add subscribers in Open5GS WebUI (port 9999)"
  echo "  3. Create network slices via the Slice Manager"
  echo ""
  echo -e "  Manage: ${CYAN}make -C $INSTALL_DIR [up|down|logs|status]${NC}"
  echo -e "  Logs:   ${CYAN}docker compose -f $INSTALL_DIR/docker/docker-compose.yml --project-directory $INSTALL_DIR logs -f${NC}"
}

# ── Main ──────────────────────────────────────────────────
check_root
check_os
check_resources
install_deps
configure_kernel

case "$MODE" in
  --docker)
    install_docker
    setup_testbed
    ;;
  --k8s)
    install_docker
    install_k3s
    install_kubectl_helm
    setup_testbed
    ;;
  *)
    err "Usage: $0 [--docker | --k8s]"
    ;;
esac

print_summary
