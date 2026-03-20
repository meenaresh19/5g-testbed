# 5G Testbed - Complete Observability Stack

## 🎯 Overview

Your 5G testbed now has **production-grade observability**:

- ✅ **MongoDB** - Persistent UE/subscriber storage
- ✅ **Prometheus** - Time-series metrics database
- ✅ **Grafana** - Beautiful dashboards and visualization

---

## 📦 What's Deployed

### **MongoDB (Existing)**
- **Purpose:** Store subscribers (UEs) with IMSI, K, OPc
- **Persistence:** 10Gi PVC (local-path)
- **Access:** `mongodb://mongodb.5g-testbed.svc.cluster.local:27017`
- **Database:** `open5gs` (standard Open5GS schema)

### **Prometheus (NEW)**
- **Purpose:** Collect metrics from all NFs
- **Storage:** 20Gi PVC, 30-day retention
- **Scrape Interval:** 15 seconds
- **Access:** `http://prometheus.5g-testbed.svc.cluster.local:9090`
- **Metrics:** CPU, memory, Open5GS KPIs

### **Grafana (NEW)**
- **Purpose:** Visualize metrics and create dashboards
- **Storage:** 5Gi PVC for dashboards
- **Admin:** `admin` / `admin123`
- **Access:** `http://localhost:30031` (via port-forward)
- **Default Dashboards:**
  - 5G Core Network Metrics
  - RAN Metrics
  - System Metrics

---

## 🚀 Deploy Now

### **Step 1: Pull Latest Code**
```bash
cd /path/to/5g-testbed
git pull origin main
```

### **Step 2: Update K3s Deployment**
```bash
# Restart all deployments to load new configs
kubectl delete pods -l app=testbed-api -n 5g-testbed
kubectl delete pods -l app=testbed-ui -n 5g-testbed

# Apply kustomization (includes new Prometheus + Grafana)
kubectl apply -k k8s/base/

# Monitor rollout
kubectl get pods -n 5g-testbed -w
```

**Expected pods (18+):**
```
✅ mongodb-0
✅ open5gs-nrf-xxx
✅ open5gs-scp-xxx
✅ open5gs-amf-xxx
✅ open5gs-smf-xxx
✅ open5gs-upf-xxx
✅ (other core NFs)
✅ ueransim-gnb-xxx
✅ ueransim-ue1-xxx
✅ testbed-api-xxx (with MongoDB client)
✅ testbed-ui-xxx (enhanced dashboard)
✅ prometheus-xxx (NEW)
✅ grafana-xxx (NEW)
```

### **Step 3: Verify All Services**
```bash
# Check all services
kubectl get svc -n 5g-testbed

# Should show:
# mongodb, open5gs-nrf, open5gs-amf, open5gs-smf, open5gs-upf,
# testbed-api, testbed-ui, prometheus, grafana, etc.
```

---

## 🔌 Access UI & Services

### **Testbed Dashboard (UE Management)**
```
http://localhost:30080
```
**Features:**
- Core Network tab (NF status)
- RAN tab (gNB + UE status)
- UE Management tab (add/delete UEs)
- Monitoring tab (live metrics)

### **Prometheus (Metrics Query)**
```bash
kubectl port-forward svc/prometheus 9090:9090 -n 5g-testbed
```
Then: `http://localhost:9090`

**Key metrics:**
```
fivegs_amf_registered_ue_nbr       # Registered UEs
fivegs_smf_session_nbr             # Active sessions
fivegs_upf_dl_bytes_total          # DL throughput
fivegs_upf_ul_bytes_total          # UL throughput
container_cpu_usage_seconds_total  # CPU per pod
container_memory_usage_bytes       # Memory per pod
```

### **Grafana (Visual Dashboards)**
```bash
kubectl port-forward svc/grafana 3000:3000 -n 5g-testbed
```
Then: `http://localhost:3000`

**Login:**
- Username: `admin`
- Password: `admin123`

**Default Dashboards:**
1. **5G Core Network Metrics**
   - Registered UEs (line chart, 30-min history)
   - Active Sessions (line chart)
   - AMF/SMF/UPF CPU usage (line charts)
   - DL/UL throughput (bar charts)

2. **5G RAN Metrics**
   - gNB status
   - UE1 status
   - N2 NGAP connections
   - gNB/UE CPU & Memory

3. **System Metrics**
   - Node CPU/Memory usage
   - Pod count
   - Container restart count

---

## 💾 MongoDB Integration

### **UE Persistence (via REST API)**

#### **List All UEs**
```bash
curl http://localhost:30050/api/ue
```

**Response:**
```json
{
  "status": "ok",
  "count": 2,
  "ues": [
    {
      "imsi": "001010000000001",
      "k": "fec86ba6eb707ed08ce33ae45b4a0fba",
      "opc": "c42449363464e2e4fa8adca3063168ca",
      "registered": true,
      "slices": [{"sst": 1, "sd": "000000"}]
    },
    {
      "imsi": "001010000000002",
      "k": "fec86ba6eb707ed08ce33ae45b4a0fba",
      "opc": "c42449363464e2e4fa8adca3063168ca",
      "registered": false,
      "slices": [{"sst": 1, "sd": "000000"}]
    }
  ]
}
```

#### **Add New UE**
```bash
curl -X POST http://localhost:30050/api/ue/add \
  -H "Content-Type: application/json" \
  -d '{
    "imsi": "001010000000002",
    "k": "fec86ba6eb707ed08ce33ae45b4a0fba",
    "opc": "c42449363464e2e4fa8adca3063168ca"
  }'
```

**Response:**
```json
{
  "status": "ok",
  "message": "UE 001010000000002 added to MongoDB",
  "ue": {
    "imsi": "001010000000002",
    "k": "fec86ba6eb707ed08ce33ae45b4a0fba",
    "opc": "c42449363464e2e4fa8adca3063168ca",
    "registered": true
  }
}
```

#### **Delete UE**
```bash
curl -X DELETE "http://localhost:30050/api/ue/delete?imsi=001010000000002"
```

**Response:**
```json
{
  "status": "ok",
  "message": "UE 001010000000002 deleted from MongoDB",
  "deleted": 1
}
```

### **Direct MongoDB Access**
```bash
# Port-forward to MongoDB
kubectl port-forward svc/mongodb 27017:27017 -n 5g-testbed

# Connect with mongosh
mongosh "mongodb://localhost:27017/open5gs"

# Query subscribers
db.subscribers.find()

# Add subscriber directly
db.subscribers.insertOne({
  imsi: "001010000000003",
  pdn: [{type: 0, apn: "internet", slice: [{sst: 1, sd: "000000"}]}],
  slice: [{sst: 1, sd: "000000"}],
  security: {
    k: "fec86ba6eb707ed08ce33ae45b4a0fba",
    opc: "c42449363464e2e4fa8adca3063168ca",
    amf: "c3d4"
  }
})
```

---

## 📊 Prometheus Scrape Targets

All NF metrics are automatically scraped every 15 seconds:

| NF | Job Name | Metrics | Port |
|----|----------|---------|------|
| NRF | open5gs-nrf | Service discovery, registration | 9090 |
| SCP | open5gs-scp | Service control, routing | 9090 |
| AMF | open5gs-amf | Registered UEs, N2 connections | 9090 |
| SMF | open5gs-smf | Session count, PDU sessions | 9090 |
| UPF | open5gs-upf | DL/UL throughput, GTP statistics | 9090 |
| AUSF | open5gs-ausf | Authentication events | 9090 |
| UDM/UDR/PCF | All | Subscription management | 9090 |
| K8s API Server | kubernetes-apiservers | API latency, request counts | 443 |
| K8s Nodes | kubernetes-nodes | CPU, Memory, Disk | 10250 |
| K8s Pods | kubernetes-pods | Resource usage by pod | 10250 |

---

## 🎨 Grafana Dashboard Setup

### **Create Custom Dashboard**
1. Login to Grafana: `http://localhost:3000` (admin/admin123)
2. Click **+** → **Dashboard** → **New Dashboard**
3. Add panels:
   ```
   - Metric: fivegs_amf_registered_ue_nbr (Registered UEs)
   - Metric: fivegs_smf_session_nbr (Active Sessions)
   - Metric: rate(fivegs_upf_dl_bytes_total[1m]) (DL Throughput)
   - Metric: container_cpu_usage_seconds_total (CPU Usage)
   ```
4. Save dashboard

### **Import Existing Dashboards**
1. Go to **+** → **Import**
2. Upload JSON dashboard files (or paste JSON)
3. Select Prometheus as datasource

---

## 🔍 Monitoring & Alerting

### **Example Prometheus Queries (PromQL)**

**Registered UEs:**
```promql
fivegs_amf_registered_ue_nbr
```

**Active Sessions:**
```promql
fivegs_smf_session_nbr
```

**UPF Throughput (5-min rate):**
```promql
rate(fivegs_upf_dl_bytes_total[5m]) / 1024 / 1024  # Mbps
```

**AMF CPU (last 5 min):**
```promql
avg(container_cpu_usage_seconds_total{pod=~'open5gs-amf.*'})
```

**Pod Count by Status:**
```promql
count by (phase) (kube_pod_info{namespace='5g-testbed'})
```

---

## 📈 Scaling & Performance

### **Auto-Scaling Ready**
Prometheus metrics are available for HPA:
- Scale AMF on `fivegs_amf_registered_ue_nbr > 1000`
- Scale SMF on `fivegs_smf_session_nbr > 500`
- Scale UPF on `cpu_usage > 70%`

### **Data Retention**
- **Prometheus:** 30 days
- **Grafana:** Unlimited (UI only)
- **MongoDB:** Unlimited (data layer)

---

## 🔧 Troubleshooting

### **Prometheus not scraping metrics**
```bash
# Check Prometheus targets
kubectl port-forward svc/prometheus 9090:9090 -n 5g-testbed
# Open: http://localhost:9090/targets
# Should show all NF endpoints as "UP"
```

### **Grafana datasource not working**
```bash
# Check Grafana logs
kubectl logs -f deployment/grafana -n 5g-testbed | grep -i prometheus

# Verify Prometheus is reachable from Grafana pod
kubectl exec -it deployment/grafana -n 5g-testbed -- \
  curl http://prometheus.5g-testbed.svc.cluster.local:9090/-/ready
```

### **MongoDB connection issues**
```bash
# Check MongoDB is running
kubectl get pod mongodb-0 -n 5g-testbed

# Check testbed-api logs
kubectl logs -f deployment/testbed-api -n 5g-testbed | grep -i mongo

# Test connection from API pod
kubectl exec -it deployment/testbed-api -n 5g-testbed -- \
  mongosh mongodb://mongodb.5g-testbed.svc.cluster.local:27017/open5gs
```

---

## 📋 Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    5G Testbed Stack                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  UI Layer (Port 30080)                                │
│  ┌──────────────────────────────────────────────────┐ │
│  │ Testbed Dashboard                                │ │
│  │ - Core Network Tab                              │ │
│  │ - RAN Tab                                        │ │
│  │ - UE Management Tab (MongoDB ↔)                 │ │
│  │ - Monitoring Tab (Prometheus ↔)                 │ │
│  └──────────────────────────────────────────────────┘ │
│                       ↓ REST API                        │
│  API Layer (Port 30050)                               │
│  ┌──────────────────────────────────────────────────┐ │
│  │ testbed-api                                      │ │
│  │ - /api/status (NF status)                        │ │
│  │ - /api/ue/* (UE management with MongoDB)         │ │
│  │ - /api/metrics/* (Prometheus proxy)              │ │
│  └──────────────────────────────────────────────────┘ │
│                       ↓                                  │
│  Data & Metrics Layer                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │  MongoDB     │  │ Prometheus   │  │   Grafana     │ │
│  │              │  │              │  │               │ │
│  │ - UEs        │  │ - Metrics    │  │ - Dashboards  │ │
│  │ - Slices     │  │ - K8s stats  │  │ - Alerts      │ │
│  │ - Sessions   │  │ - NF KPIs    │  │ - Panels      │ │
│  └──────────────┘  └──────────────┘  └───────────────┘ │
│         ↑                 ↑                    ↑         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  5G Core Network (13 NFs)                         │  │
│  │  + RAN (gNB, UEs)                                 │  │
│  │  [All NFs emit metrics to Prometheus on :9090]    │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## ✅ Verification Checklist

- [ ] All 18+ pods running (`kubectl get pods -n 5g-testbed`)
- [ ] Testbed UI loads at `http://localhost:30080`
- [ ] Can add/delete UEs in UE Management tab
- [ ] Prometheus targets UP at `http://localhost:9090/targets`
- [ ] Grafana loads at `http://localhost:3000` (admin/admin123)
- [ ] Prometheus datasource configured in Grafana
- [ ] Default dashboards available in Grafana
- [ ] Metrics flowing: `curl http://localhost:9090/api/v1/query?query=up`

---

## 🎯 Next Steps

1. **Test UE Management:**
   - Add multiple UEs via dashboard
   - Verify they appear in MongoDB
   - Delete UEs

2. **Monitor Metrics:**
   - Watch UE registration in Grafana Core Network dashboard
   - Check CPU/Memory spikes in System Metrics dashboard
   - Monitor N2 connections in RAN dashboard

3. **Create Custom Dashboards:**
   - Build custom Grafana dashboards for your use case
   - Set up alerts for SLA violations
   - Export dashboards as JSON

4. **Enable Auto-Scaling (Phase 5):**
   - Set up HPA with Prometheus metrics
   - Configure custom scaling policies
   - Test scaling with load generation

---

**Complete observability stack ready for production monitoring!** 🚀
