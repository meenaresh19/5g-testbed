#!/bin/bash
# ============================================================
# EC2 User Data Script — 5G Testbed
# Fully automated, no SSH needed. Paste into EC2 Launch
# "User data" field (Advanced Details → User data).
#
# Pre-requisites (EC2 Launch config):
#   AMI      : Ubuntu 22.04 or 24.04 LTS (64-bit x86)
#   Instance : t3.xlarge (4 vCPU, 16 GB) or larger
#   Storage  : 30 GB gp3 root volume
#   Sec Group: Inbound 22/TCP (SSH) + 30080/TCP (Dashboard)
#   IAM      : No special IAM role required
#
# What happens after launch:
#   1. Runs as root on first boot (user-data behaviour)
#   2. Installs K3s + Cilium, enables SCTP
#   3. Clones the repo and runs bootstrap.sh
#   4. Logs everything to /var/log/5g-testbed-setup.log
#   5. Creates /etc/motd with access URLs when done
#   6. Full setup takes ~10 min (image pulls dominate)
#
# Monitor progress (after SSHing in):
#   tail -f /var/log/5g-testbed-setup.log
#
# Check completion:
#   cat /etc/motd
# ============================================================

set -euo pipefail

LOG="/var/log/5g-testbed-setup.log"
REPO_URL="https://github.com/meenaresh19/5g-testbed.git"
INSTALL_DIR="/opt/5g-testbed"
NAMESPACE="5g-testbed"

exec > >(tee -a "$LOG") 2>&1
echo "════════════════════════════════════════════════════════"
echo "  5G Testbed — EC2 User Data setup starting"
echo "  $(date)"
echo "════════════════════════════════════════════════════════"

# ── System prep ───────────────────────────────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates

# ── Clone repo ────────────────────────────────────────────────────────────────
if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "[INFO] Repo already cloned — pulling latest..."
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo "[INFO] Cloning ${REPO_URL}..."
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# ── Run bootstrap ─────────────────────────────────────────────────────────────
echo "[INFO] Running bootstrap.sh..."
chmod +x bootstrap.sh
bash bootstrap.sh

# ── Write MOTD with access info ───────────────────────────────────────────────

# IMDSv2 public IP
TOKEN=$(curl -sfX PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null || true)
PUBLIC_IP=""
if [[ -n "$TOKEN" ]]; then
  PUBLIC_IP=$(curl -sf -H "X-aws-ec2-metadata-token: $TOKEN" \
    "http://169.254.169.254/latest/meta-data/public-ipv4" 2>/dev/null || true)
fi
INTERNAL_IP=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}' \
  2>/dev/null || hostname -I | awk '{print $1}')
ACCESS_IP="${PUBLIC_IP:-$INTERNAL_IP}"

cat > /etc/motd <<MOTD

╔══════════════════════════════════════════════════════╗
║          5G Testbed — Ready                          ║
╠══════════════════════════════════════════════════════╣
║  Dashboard UI  : http://${ACCESS_IP}:30080
║  Open5GS WebUI : http://${ACCESS_IP}:30080/open5gs
║  API           : http://${ACCESS_IP}:30080/api/status
╠══════════════════════════════════════════════════════╣
║  Admin login   : admin / admin                       ║
║  Open5GS login : admin / 1423                        ║
╠══════════════════════════════════════════════════════╣
║  kubectl -n 5g-testbed get pods                      ║
║  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml         ║
╚══════════════════════════════════════════════════════╝

MOTD

echo ""
echo "════════════════════════════════════════════════════════"
echo "  5G Testbed setup complete — $(date)"
echo "  Access: http://${ACCESS_IP}:30080"
echo "════════════════════════════════════════════════════════"

# Signal completion (useful for CloudFormation / cfn-signal)
which cfn-signal &>/dev/null && cfn-signal --success true --region "$(curl -sf \
  -H "X-aws-ec2-metadata-token: $TOKEN" \
  'http://169.254.169.254/latest/meta-data/placement/region' 2>/dev/null || true)" \
  --stack "${AWS_STACK_NAME:-}" --resource "${AWS_RESOURCE_ID:-}" 2>/dev/null || true
