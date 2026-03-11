# ============================================================
# 5G Testbed — Management Makefile
# Usage: make <target>
# ============================================================

COMPOSE = docker compose -f docker/docker-compose.yml --project-directory .
PROJECT = 5g-testbed

.PHONY: help up down restart logs status pull gen-config clean info ue2-up ue2-down oai-up oai-down iperf-ping ids-up ids-down ids-status ids-clear

help:
	@echo ""
	@echo "  5G Testbed — make targets"
	@echo "  ─────────────────────────────────────────────────"
	@echo "  up            Start full stack (Core + UERANSIM)"
	@echo "  down          Stop all services"
	@echo "  restart       Restart all services"
	@echo "  logs          Follow all logs (Ctrl-C to stop)"
	@echo "  status        Show container status"
	@echo "  pull          Pull latest images"
	@echo "  gen-config    Regenerate 5G config files"
	@echo "  clean         Stop and remove volumes (data loss!)"
	@echo "  info          Show access URLs"
	@echo "  ─────────────────────────────────────────────────"
	@echo "  ue2-up        Start UE2 (multi-UE testing)"
	@echo "  ue2-down      Stop UE2"
	@echo "  oai-up        Start OAI RAN (legacy, replaces UERANSIM)"
	@echo "  oai-down      Stop OAI RAN"
	@echo "  iperf-ping    Quick iPerf3 DL test from UE1 (10s)"
	@echo "  ─────────────────────────────────────────────────"
	@echo "  ids-up        Start IDS engines (Zeek + Scapy)"
	@echo "  ids-down      Stop IDS engines"
	@echo "  ids-status    Show IDS engine status + alert counts"
	@echo "  ids-clear     Clear all IDS alert files"
	@echo ""

up:
	@bash scripts/gen-configs.sh 2>/dev/null || true
	$(COMPOSE) up -d
	@$(MAKE) status

down:
	$(COMPOSE) down

restart:
	$(COMPOSE) restart
	@$(MAKE) status

logs:
	$(COMPOSE) logs -f --tail=50

logs-%:
	$(COMPOSE) logs -f --tail=100 $*

status:
	$(COMPOSE) ps

pull:
	$(COMPOSE) pull

gen-config:
	bash scripts/gen-configs.sh

clean:
	@echo "WARNING: This will delete all data including MongoDB subscriber DB."
	@read -p "Type 'yes' to confirm: " c; [ "$$c" = "yes" ] || exit 1
	$(COMPOSE) down -v --remove-orphans

info:
	@IP=$$(hostname -I | awk '{print $$1}'); \
	echo ""; \
	echo "  ╔══════════════════════════════════════════════════╗"; \
	echo "  ║         5G Testbed Access Points                 ║"; \
	echo "  ╠══════════════════════════════════════════════════╣"; \
	printf "  ║  Testbed UI    : http://%-24s ║\n" "$$IP:3000"; \
	printf "  ║  Open5GS UI    : http://%-24s ║\n" "$$IP:9999"; \
	printf "  ║  API Server    : http://%-24s ║\n" "$$IP:5000"; \
	printf "  ║  Grafana       : http://%-24s ║\n" "$$IP:3001"; \
	printf "  ║  Grafana (UI)  : http://%-24s ║\n" "$$IP:3000/grafana/"; \
	echo "  ╚══════════════════════════════════════════════════╝"; \
	echo ""

# ── UERANSIM UE2 ─────────────────────────────────────────
ue2-up:
	$(COMPOSE) --profile multi-ue up -d ueransim-ue2
	@echo "UE2 started. IMSI: 001010000000002"

ue2-down:
	$(COMPOSE) --profile multi-ue stop ueransim-ue2

# ── OAI RAN (legacy) ─────────────────────────────────────
oai-up:
	@echo "Stopping UERANSIM first..."
	-$(COMPOSE) stop ueransim-gnb ueransim-ue1 2>/dev/null || true
	$(COMPOSE) --profile oai up -d oai-gnb oai-nrue
	@echo "OAI gNB + nrUE started"

oai-down:
	$(COMPOSE) --profile oai stop oai-gnb oai-nrue

# ── Quick iPerf3 test from UE1 ────────────────────────────
iperf-ping:
	@TUN=$$(docker exec ueransim-ue1 ip addr show uesimtun0 2>/dev/null | grep -o 'inet [0-9.]*' | awk '{print $$2}'); \
	if [ -z "$$TUN" ]; then echo "ERROR: uesimtun0 not found — UE PDU session not established"; exit 1; fi; \
	echo "UE1 tunnel IP: $$TUN"; \
	echo "Running iPerf3 DL (10s) → 10.45.0.200 ..."; \
	docker exec ueransim-ue1 iperf3 -c 10.45.0.200 -p 5201 -t 10 -B $$TUN -R 2>&1 || \
	  echo "iPerf3 failed — is iperf3-server running? (make status)"

# ── IDS Engines (Zeek + Scapy) ────────────────────────────
ids-up:
	$(COMPOSE) --profile ids up -d zeek-ids scapy-ids
	@echo "IDS engines starting..."
	@echo "  Zeek  — control-plane monitor (SBI/N2)"
	@echo "  Scapy — data-plane monitor (N3/GTP-U + N4/PFCP)"
	@echo "  UI: http://localhost:3000  → IDS Monitor tab"

ids-down:
	$(COMPOSE) --profile ids stop zeek-ids scapy-ids
	@echo "IDS engines stopped"

ids-status:
	@echo "=== IDS Engine Status ==="
	@docker inspect 5g-zeek-ids  --format '  Zeek  : {{.State.Status}} ({{.Name}})' 2>/dev/null || echo "  Zeek  : not found"
	@docker inspect 5g-scapy-ids --format '  Scapy : {{.State.Status}} ({{.Name}})' 2>/dev/null || echo "  Scapy : not found"
	@echo ""
	@echo "=== IDS Alert Counts ==="
	@ZEEK=$$(docker exec 5g-testbed-api sh -c 'wc -l /ids/zeek/notice.log 2>/dev/null || echo 0' | awk '{print $$1}'); \
	SCAPY=$$(docker exec 5g-testbed-api sh -c 'wc -l /ids/scapy_alerts.jsonl 2>/dev/null || echo 0' | awk '{print $$1}'); \
	echo "  Zeek alerts  : $$ZEEK"; \
	echo "  Scapy alerts : $$SCAPY"

ids-clear:
	@docker exec 5g-testbed-api sh -c 'truncate -s0 /ids/zeek/notice.log /ids/scapy_alerts.jsonl 2>/dev/null; echo "IDS alerts cleared"'
