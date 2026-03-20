# Applying Enhanced UI Dashboard

## 🎉 What's New

Your testbed-ui has been completely rebuilt with:

### **4 Main Sections (Tabs)**
1. **Core Network** — NF status, health, replicas
2. **RAN** — gNB, UEs, N2 connectivity
3. **UE Management** — Add/remove subscribers, IMSI management
4. **Monitoring** — Real-time metrics, CPU, throughput

### **Features**
- ✅ Clean, modern UI with cyan/dark theme
- ✅ Real-time NF status updates
- ✅ Add/delete UEs from dashboard
- ✅ CPU and throughput metrics
- ✅ Responsive grid layouts
- ✅ Status badges (Running/Pending/Failed)

---

## 🚀 Apply Changes

### **Step 1: Pull Latest Code**
```bash
cd /path/to/5g-testbed
git pull origin main
```

### **Step 2: Restart Deployments**
The UI and API ConfigMaps are updated. Restart them to load the new code:

```bash
# Restart testbed-ui (UI dashboard)
kubectl rollout restart deployment/testbed-ui -n 5g-testbed

# Restart testbed-api (API backend)
kubectl rollout restart deployment/testbed-api -n 5g-testbed

# Watch the rollout
kubectl rollout status deployment/testbed-ui -n 5g-testbed
kubectl rollout status deployment/testbed-api -n 5g-testbed
```

### **Step 3: Verify New Pods**
```bash
kubectl get pods -n 5g-testbed | grep testbed
# Should show new testbed-ui and testbed-api pods starting
```

### **Step 4: Access Dashboard**
```
http://localhost:30080
```

---

## 📋 Dashboard Sections

### **Core Network Tab**
Shows all 13 Open5GS NFs with:
- Total NF count
- Running count
- Individual NF status cards
- Health indicators

### **RAN Tab**
gNodeB and User Equipment information:
- gNB status (Band 78, 3.5 GHz)
- Connected UE count
- N2 link status (gNB ↔ AMF)
- UE list with IMSI

### **UE Management Tab**
Add/remove subscribers:
- Form to add new UE (IMSI, K, OPc)
- Default pre-configured UE: `001010000000001`
- Table of registered UEs
- Delete button per UE
- Active session count

**Default UE (Pre-configured):**
```
IMSI: 001010000000001
K: fec86ba6eb707ed08ce33ae45b4a0fba
OPc: c42449363464e2e4fa8adca3063168ca
```

### **Monitoring Tab**
Real-time metrics:
- Registered UEs
- Active PDU sessions
- UPF throughput (DL/UL)
- NF CPU usage (AMF, SMF, UPF)
- Progress bars for CPU usage

---

## 🔌 API Endpoints

The testbed-api has new UE management endpoints:

### **Get All UEs**
```bash
curl http://localhost:30050/api/ue
```

**Response:**
```json
{
  "status": "ok",
  "count": 1,
  "ues": [
    {
      "imsi": "001010000000001",
      "k": "fec86ba6eb707ed08ce33ae45b4a0fba",
      "opc": "c42449363464e2e4fa8adca3063168ca",
      "registered": true
    }
  ]
}
```

### **Add New UE**
```bash
curl -X POST http://localhost:30050/api/ue/add \
  -H "Content-Type: application/json" \
  -d '{
    "imsi": "001010000000002",
    "k": "fec86ba6eb707ed08ce33ae45b4a0fba",
    "opc": "c42449363464e2e4fa8adca3063168ca"
  }'
```

### **Delete UE**
```bash
curl -X DELETE "http://localhost:30050/api/ue/delete?imsi=001010000000002"
```

---

## 🎨 UI Design

- **Theme:** Dark cyan/teal with accents
- **Colors:**
  - Success: `#00e676` (green)
  - Warning: `#ffb800` (orange)
  - Danger: `#ff3b5c` (red)
  - Primary: `#00c8ff` (cyan)

- **Fonts:**
  - Headers: Orbitron (futuristic)
  - Body: Exo 2 (modern)
  - Monospace: Share Tech Mono (technical)

---

## 🔧 Testing Checklist

- [ ] UI loads at `http://localhost:30080`
- [ ] Core Network tab shows all 13 NFs
- [ ] RAN tab shows gNB + UE1 running
- [ ] UE Management tab shows default UE
- [ ] Can add new UE via form
- [ ] Can delete UE via button
- [ ] Monitoring tab shows metrics
- [ ] Tabs switch smoothly
- [ ] Status badges update in real-time

---

## 📊 What's Next

**Phase 3 (Auto-scaling):**
- HPA for AMF/SMF/UPF
- Metric-based scaling
- Scaling policies

**Phase 4 (Observability):**
- Prometheus integration
- Grafana dashboards
- Loki log aggregation

**Phase 5 (Advanced):**
- Multus CNI networking
- Service mesh (optional)
- Advanced security policies

---

## 💡 Notes

- UE management currently uses in-memory storage
- Production version should connect to MongoDB
- Metrics are placeholder values until Prometheus integration
- API responses follow REST conventions

---

## 🆘 Troubleshooting

### UI doesn't show new dashboard
```bash
# Force pod restart
kubectl delete pod -l app=testbed-ui -n 5g-testbed

# Monitor new pod startup
kubectl logs -f deployment/testbed-ui -n 5g-testbed
```

### API endpoints not working
```bash
# Check API pod logs
kubectl logs -f deployment/testbed-api -n 5g-testbed

# Verify service
kubectl get svc testbed-api -n 5g-testbed
```

### ConfigMap changes not reflected
```bash
# Check if ConfigMap is updated
kubectl describe cm testbed-ui-config -n 5g-testbed

# Force rollout (kills old pods)
kubectl rollout restart deployment/testbed-ui -n 5g-testbed
```

---

## 📞 Support

See main README for additional support information.

**Latest commit:** Merged K8s deployment fixes + Enhanced UI dashboard

Enjoy your new 5G testbed dashboard! 🚀
