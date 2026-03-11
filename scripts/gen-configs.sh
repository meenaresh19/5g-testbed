#!/bin/bash
# ============================================================
# Generate Open5GS and OAI configuration files
# Usage: bash gen-configs.sh [output-dir]
# All values can be overridden via environment variables.
# ============================================================
set -euo pipefail

CONF_DIR="${1:-./configs}"

# ── PLMN / TAC ────────────────────────────────────────────
MCC="${MCC:-001}"
MNC="${MNC:-01}"
TAC="${TAC:-1}"

# ── 5GC IP addresses (on 5g-core-net 10.45.0.0/16) ───────
MONGO_IP="${MONGO_IP:-10.45.0.2}"
NRF_IP="${NRF_IP:-10.45.0.10}"
SCP_IP="${SCP_IP:-10.45.0.11}"
AMF_IP="${AMF_IP:-10.45.0.12}"
SMF_IP="${SMF_IP:-10.45.0.13}"
UPF_IP="${UPF_IP:-10.45.0.14}"
AUSF_IP="${AUSF_IP:-10.45.0.15}"
UDM_IP="${UDM_IP:-10.45.0.16}"
UDR_IP="${UDR_IP:-10.45.0.17}"
PCF_IP="${PCF_IP:-10.45.0.18}"
BSF_IP="${BSF_IP:-10.45.0.19}"
NSSF_IP="${NSSF_IP:-10.45.0.20}"

# ── RAN (on ran-net 192.168.70.0/24 + 5g-core-net) ───────
GNB_IP="${GNB_IP:-10.45.0.50}"

mkdir -p "$CONF_DIR/open5gs" "$CONF_DIR/oai" "$CONF_DIR/zeek" "$CONF_DIR/ids"

# ── NRF ──────────────────────────────────────────────────
cat > "$CONF_DIR/open5gs/nrf.yaml" <<EOF
logger:
  file: /var/log/open5gs/nrf.log
  level: info

nrf:
  serving:
    - plmn_id:
        mcc: $MCC
        mnc: $MNC
  sbi:
    server:
      - address: $NRF_IP
        port: 7777
  metrics:
    server:
      - address: $NRF_IP
        port: 9090
EOF

# ── SCP ──────────────────────────────────────────────────
cat > "$CONF_DIR/open5gs/scp.yaml" <<EOF
logger:
  file: /var/log/open5gs/scp.log
  level: info

scp:
  sbi:
    server:
      - address: $SCP_IP
        port: 7777
    client:
      nrf:
        - uri: http://$NRF_IP:7777
EOF

# ── AMF ──────────────────────────────────────────────────
cat > "$CONF_DIR/open5gs/amf.yaml" <<EOF
logger:
  file: /var/log/open5gs/amf.log
  level: info

amf:
  sbi:
    server:
      - address: $AMF_IP
        port: 7777
    client:
      scp:
        - uri: http://$SCP_IP:7777
  ngap:
    server:
      - address: $AMF_IP
  metrics:
    server:
      - address: $AMF_IP
        port: 9090
  guami:
    - plmn_id:
        mcc: $MCC
        mnc: $MNC
      amf_id:
        region: 2
        set: 1
  tai:
    - plmn_id:
        mcc: $MCC
        mnc: $MNC
      tac: $TAC
  plmn_support:
    - plmn_id:
        mcc: $MCC
        mnc: $MNC
      s_nssai:
        - sst: 1
        - sst: 2
        - sst: 3
          sd: 000001
  security:
    integrity_order: [NIA2, NIA1, NIA0]
    ciphering_order: [NEA0, NEA2, NEA1]
  network_name:
    full: Open5GS-5G
    short: O5GS
  amf_name: AMF-1
EOF

# ── SMF ──────────────────────────────────────────────────
cat > "$CONF_DIR/open5gs/smf.yaml" <<EOF
logger:
  file: /var/log/open5gs/smf.log
  level: info

smf:
  sbi:
    server:
      - address: $SMF_IP
        port: 7777
    client:
      scp:
        - uri: http://$SCP_IP:7777
  pfcp:
    server:
      - address: $SMF_IP
    client:
      upf:
        - address: $UPF_IP
  gtpc:
    server:
      - address: $SMF_IP
  gtpu:
    server:
      - address: $SMF_IP
  metrics:
    server:
      - address: $SMF_IP
        port: 9090
  session:
    - subnet: 10.45.0.0/16
      gateway: 10.45.0.1
      dnn: internet
  dns:
    - 8.8.8.8
    - 8.8.4.4
  mtu: 1400
EOF

# ── UPF ──────────────────────────────────────────────────
cat > "$CONF_DIR/open5gs/upf.yaml" <<EOF
logger:
  file: /var/log/open5gs/upf.log
  level: info

upf:
  pfcp:
    server:
      - address: $UPF_IP
    client:
      smf:
        - address: $SMF_IP
  gtpu:
    server:
      - address: $UPF_IP
  session:
    - subnet: 10.45.0.0/16
      gateway: 10.45.0.1
      dnn: internet
  metrics:
    server:
      - address: $UPF_IP
        port: 9090
EOF

# ── AUSF ─────────────────────────────────────────────────
cat > "$CONF_DIR/open5gs/ausf.yaml" <<EOF
logger:
  file: /var/log/open5gs/ausf.log
  level: info

ausf:
  sbi:
    server:
      - address: $AUSF_IP
        port: 7777
    client:
      scp:
        - uri: http://$SCP_IP:7777
  metrics:
    server:
      - address: $AUSF_IP
        port: 9090
EOF

# ── UDM ──────────────────────────────────────────────────
cat > "$CONF_DIR/open5gs/udm.yaml" <<EOF
logger:
  file: /var/log/open5gs/udm.log
  level: info

udm:
  sbi:
    server:
      - address: $UDM_IP
        port: 7777
    client:
      scp:
        - uri: http://$SCP_IP:7777
  metrics:
    server:
      - address: $UDM_IP
        port: 9090
EOF

# ── UDR ──────────────────────────────────────────────────
cat > "$CONF_DIR/open5gs/udr.yaml" <<EOF
logger:
  file: /var/log/open5gs/udr.log
  level: info

udr:
  db_uri: mongodb://$MONGO_IP/open5gs
  sbi:
    server:
      - address: $UDR_IP
        port: 7777
    client:
      scp:
        - uri: http://$SCP_IP:7777
  metrics:
    server:
      - address: $UDR_IP
        port: 9090
EOF

# ── PCF ──────────────────────────────────────────────────
cat > "$CONF_DIR/open5gs/pcf.yaml" <<EOF
logger:
  file: /var/log/open5gs/pcf.log
  level: info

pcf:
  db_uri: mongodb://$MONGO_IP/open5gs
  sbi:
    server:
      - address: $PCF_IP
        port: 7777
    client:
      scp:
        - uri: http://$SCP_IP:7777
  metrics:
    server:
      - address: $PCF_IP
        port: 9090
EOF

# ── BSF ──────────────────────────────────────────────────
cat > "$CONF_DIR/open5gs/bsf.yaml" <<EOF
logger:
  file: /var/log/open5gs/bsf.log
  level: info

bsf:
  db_uri: mongodb://$MONGO_IP/open5gs
  sbi:
    server:
      - address: $BSF_IP
        port: 7777
    client:
      scp:
        - uri: http://$SCP_IP:7777
  metrics:
    server:
      - address: $BSF_IP
        port: 9090
EOF

# ── NSSF ─────────────────────────────────────────────────
cat > "$CONF_DIR/open5gs/nssf.yaml" <<EOF
logger:
  file: /var/log/open5gs/nssf.log
  level: info

nssf:
  sbi:
    server:
      - address: $NSSF_IP
        port: 7777
    client:
      scp:
        - uri: http://$SCP_IP:7777
  metrics:
    server:
      - address: $NSSF_IP
        port: 9090
  nsi:
    - addr: $AMF_IP
      port: 7777
      s_nssai:
        sst: 1
    - addr: $AMF_IP
      port: 7777
      s_nssai:
        sst: 2
    - addr: $AMF_IP
      port: 7777
      s_nssai:
        sst: 3
        sd: 000001
EOF

# ── UERANSIM gNB ─────────────────────────────────────────
# Primary RAN simulator — lighter than OAI, supports multi-UE
mkdir -p "$CONF_DIR/ueransim"

cat > "$CONF_DIR/ueransim/gnb.yaml" <<EOF
mcc: '$MCC'
mnc: '$MNC'
nci: '0x000000010'
idLength: 32
tac: $TAC

linkIp: 192.168.70.20   # RF sim link (ran-net, UEs connect here)
ngapIp: $GNB_IP         # N2/NGAP → AMF (5g-core-net)
gtpIp:  $GNB_IP         # N3/GTP-U → UPF (5g-core-net)

amfConfigs:
  - address: $AMF_IP
    port: 38412

slices:
  - sst: 1
  - sst: 2
  - sst: 3
    sd: 0x000001

ignoreStreamIds: true
EOF

# ── UERANSIM UE1 (default subscriber) ────────────────────
cat > "$CONF_DIR/ueransim/ue.yaml" <<EOF
supi: 'imsi-${MCC}${MNC}0000000001'
mcc: '$MCC'
mnc: '$MNC'
key: 'fec86ba6eb707ed08905757b1bb44b8f'
op:  'C42449363BBAD02B66D16BC975D77CC1'
opType: 'OPC'
amf: '8000'
imei:   '356938035643803'
imeiSv: '4370816125816151'

gnbSearchList:
  - 192.168.70.20

uacAic: {mps: false, mcs: false}
uacAcc: {normalClass: 0, class11: false, class12: false, class13: false, class14: false, class15: false}

sessions:
  - type: 'IPv4'
    apn: 'internet'
    slice: {sst: 1}

configured-nssai:
  - sst: 1

default-nssai:
  - sst: 1
    sd: 1

integrity: {IA1: true, IA2: true, IA3: true}
ciphering: {EA1: true, EA2: true, EA3: true}
integrityMaxRate: {uplink: 'full', downlink: 'full'}
EOF

# ── UERANSIM UE2 (2nd subscriber — multi-UE load test) ───
cat > "$CONF_DIR/ueransim/ue2.yaml" <<EOF
supi: 'imsi-${MCC}${MNC}0000000002'
mcc: '$MCC'
mnc: '$MNC'
key: 'fec86ba6eb707ed08905757b1bb44b8f'
op:  'C42449363BBAD02B66D16BC975D77CC1'
opType: 'OPC'
amf: '8000'
imei:   '356938035643804'
imeiSv: '4370816125816152'

gnbSearchList:
  - 192.168.70.20

uacAic: {mps: false, mcs: false}
uacAcc: {normalClass: 0, class11: false, class12: false, class13: false, class14: false, class15: false}

sessions:
  - type: 'IPv4'
    apn: 'internet'
    slice: {sst: 1}

configured-nssai:
  - sst: 1

default-nssai:
  - sst: 1
    sd: 1

integrity: {IA1: true, IA2: true, IA3: true}
ciphering: {EA1: true, EA2: true, EA3: true}
integrityMaxRate: {uplink: 'full', downlink: 'full'}
EOF

# ── OAI gNB ──────────────────────────────────────────────
# Legacy option — start with: docker compose --profile oai up -d
cat > "$CONF_DIR/oai/gnb.conf" <<EOF
Active_gNBs = ("oai-gnb-1");
Asn1_verbosity = "none";

gNBs = ({
  gNB_ID    = 0xe00;
  gNB_name  = "OAI-gNB-1";

  plmn_list = ({
    mcc = $MCC;
    mnc = $MNC;
    mnc_length = 2;
    snssaiList = (
      { sst = 1; },
      { sst = 2; },
      { sst = 3; sd = 0x000001; }
    );
  });

  tracking_area_code  = $TAC;
  nr_cellid = 12345678L;

  servingCellConfigCommon = ({
    physCellId = 0;
    absoluteFrequencySSB = 641280;
    dl_frequencyBand = 78;
    dl_absoluteFrequencyPointA = 640008;
    dl_carrierBandwidth = 106;
    initialDLBWPlocationAndBandwidth = 28875;
    initialDLBWPsubcarrierSpacing = 1;
    ul_frequencyBand = 78;
    ul_absoluteFrequencyPointA = 640008;
    ul_carrierBandwidth = 106;
    initialULBWPlocationAndBandwidth = 28875;
    initialULBWPsubcarrierSpacing = 1;
    pMax = 20;
    ssPBCH_BlockPower = -25;
    subcarrierSpacing = 30;
  });

  # AMF connection
  amf_ip_address = ({
    ipv4 = "$AMF_IP";
    ipv6 = "::1";
    active = "yes";
    preference = "ipv4";
  });

  NETWORK_INTERFACES :
  {
    GNB_INTERFACE_NAME_FOR_NG_AMF = "eth0";
    GNB_IPV4_ADDRESS_FOR_NG_AMF = "$GNB_IP/24";
    GNB_INTERFACE_NAME_FOR_NGU = "eth0";
    GNB_IPV4_ADDRESS_FOR_NGU = "$GNB_IP/24";
    GNB_PORT_FOR_S1U = 2152;
  };

  rfsimulator: {
    serveraddr = "server";
  };
});

MACRLCs = ({
  num_cc = 1;
  tr_s_preference = "local_L1";
  tr_n_preference = "local_RRC";
  ulsch_max_NMinus1_harq_retransmissions = 1;
});

L1s = ({
  num_cc = 1;
  tr_n_preference = "local_mac";
  pusch_proc_threads = 8;
  prach_dtx_threshold = 120;
  pucch0_dtx_threshold = 150;
  ofdm_offset_divisor = 8;
});

RUs = ({
  local_rf = "yes";
  nb_tx = 1;
  nb_rx = 1;
  att_tx = 0;
  att_rx = 0;
  bands = [78];
  max_pdschReferenceSignalPower = -27;
  max_rxgain = 114;
  eNB_instances = [0];
  sl_mode = 0;
});

THREAD_STRUCT = ({
  parallel_config = "PARALLEL_RU_L1_SPLIT";
  worker_config = "WORKER_ENABLE";
});

log_config = {
  global_log_level = "info";
  gnb_log_level = "debug";
  phy_log_level = "info";
  mac_log_level = "info";
  rlc_log_level = "info";
  pdcp_log_level = "info";
  rrc_log_level = "info";
  nr_rrc_log_level = "info";
  ngap_log_level = "debug";
};
EOF

# ── OAI UE ───────────────────────────────────────────────
cat > "$CONF_DIR/oai/ue.conf" <<EOF
uicc0 = {
  imsi = "001010000000001";
  key = "fec86ba6eb707ed08905757b1bb44b8f";
  opc= "C42449363BBAD02B66D16BC975D77CC1";
  dnn= "internet";
  nssai_sst = 1;
};
EOF

# ── Free5GC NEF ───────────────────────────────────────────
# NEF (Network Exposure Function) — opt-in via: make nef-up
NEF_IP="${NEF_IP:-10.45.0.25}"
mkdir -p "$CONF_DIR/free5gc"

cat > "$CONF_DIR/free5gc/nef.yaml" <<EOF
info:
  version: 1.0.7
  description: NEF local configuration

configuration:
  nefName: NEF

  sbi:
    scheme: http
    registerIPv4: ${NEF_IP}
    bindingIPv4: 0.0.0.0
    port: 8000

  serviceNameList:
    - nnef-pfdmanagement
    - nnef-eventexposure
    - nnef-trafficinfluence

  nrfUri: http://${NRF_IP}:7777
  mongoDBUrl: mongodb://${MONGO_IP}:27017
  mongoDBName: free5gc

  # Disable TLS for testbed/research use (plain HTTP between NFs)
  locationReportingEventSubscriptionList: []
  onlySupportHTTPBasedMSG: true
EOF

echo "✓ Configs generated in $CONF_DIR"
echo "  Open5GS NFs  : $CONF_DIR/open5gs/"
echo "  UERANSIM RAN : $CONF_DIR/ueransim/  (gnb.yaml, ue.yaml, ue2.yaml)"
echo "  OAI RAN      : $CONF_DIR/oai/  (--profile oai)"
echo "  IDS (Zeek)   : $CONF_DIR/zeek/local.zeek"
echo "  IDS (Scapy)  : $CONF_DIR/ids/scapy_ids.py"
echo "  NEF (Free5GC): $CONF_DIR/free5gc/nef.yaml  (make nef-up)"
