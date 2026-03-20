# Subscriber Management Guide

## Overview

The 5G testbed now includes a **comprehensive subscriber management system** that replaces the need for the separate Open5GS WebUI. This system provides full CRUD operations, bulk import/export, and detailed subscriber profile management directly in the testbed dashboard.

---

## Features

### UI Features (Testbed Dashboard → Subscribers Tab)

1. **Subscriber List** with pagination
   - Search/filter by IMSI
   - Display all key fields: IMSI, K, OPc, slices, AMBR
   - Page size: 25 subscribers per page
   - Next/Previous navigation

2. **Add Subscriber**
   - Quick form button to create new subscriber
   - Full-featured modal editor with:
     - IMSI (unique identifier)
     - Security parameters (K, OPc, AMF)
     - AMBR (uplink/downlink rate limits)
     - APN configuration
     - RAU/TAU timer settings
   - Auto-populated with sensible defaults

3. **Edit Subscriber**
   - Click "Edit" button on any subscriber row
   - Modify all profile fields
   - Save changes back to MongoDB
   - IMSI field locked to prevent accidental changes

4. **Delete Subscriber**
   - Click "Delete" button with confirmation
   - Removes subscriber from MongoDB
   - Used for testing scale-down scenarios

5. **Bulk Export**
   - Export entire subscriber database as JSON
   - Auto-download as `subscribers.json`
   - Format: array of subscriber documents

6. **Bulk Import**
   - Paste JSON array of subscribers
   - Automatically skips duplicates (by IMSI)
   - Shows summary: imported/skipped/failed counts
   - Format validation and error reporting

---

## API Endpoints

All endpoints require the testbed-api pod to be running. Access via `/api/*` from the testbed dashboard.

### Get Single Subscriber

```bash
GET /api/subscriber/:imsi
```

**Response:**
```json
{
  "status": "ok",
  "subscriber": {
    "imsi": "001010000000001",
    "security": {
      "k": "fec86ba6eb707ed08ce33ae45b4a0fba",
      "opc": "c42449363464e2e4fa8adca3063168ca",
      "amf": "c3d4"
    },
    "slice": [{"sst": 1, "sd": "000000"}],
    "pdn": [{"type": 0, "apn": "internet", "slice": [{"sst": 1, "sd": "000000"}]}],
    "ambr": {"uplink": 1000000000, "downlink": 1000000000},
    "subscribed_rau_tau_timer": 12,
    "plmn": {"mcc": "001", "mnc": "01"}
  }
}
```

### List Subscribers (with Pagination & Search)

```bash
GET /api/subscribers?search=001010&page=1&limit=25
```

**Query Parameters:**
- `search` (optional): Filter by IMSI substring
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 50)

**Response:**
```json
{
  "status": "ok",
  "total": 150,
  "page": 1,
  "limit": 25,
  "pages": 6,
  "data": [
    {
      "imsi": "001010000000001",
      "security": {"k": "...", "opc": "...", "amf": "c3d4"},
      "slice": [{"sst": 1, "sd": "000000"}],
      "ambr": {"uplink": 1000000000, "downlink": 1000000000},
      "plmn": {"mcc": "001", "mnc": "01"},
      "pdn": [...]
    },
    ...
  ]
}
```

### Create Subscriber

```bash
POST /api/ue/add
Content-Type: application/json

{
  "imsi": "001010000000002",
  "k": "fec86ba6eb707ed08ce33ae45b4a0fba",
  "opc": "c42449363464e2e4fa8adca3063168ca"
}
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

### Update Subscriber

```bash
PUT /api/subscriber/:imsi
Content-Type: application/json

{
  "subscribed_rau_tau_timer": 15,
  "ambr": {"uplink": 2000000000, "downlink": 2000000000}
}
```

**Response:**
```json
{
  "status": "ok",
  "message": "Subscriber 001010000000001 updated",
  "subscriber": { ... }
}
```

### Delete Subscriber

```bash
DELETE /api/ue/delete?imsi=001010000000002
```

**Response:**
```json
{
  "status": "ok",
  "message": "UE 001010000000002 deleted from MongoDB",
  "deleted": 1
}
```

### Export All Subscribers

```bash
GET /api/subscribers/export
```

**Response:** Raw JSON array of all subscriber documents. Auto-downloads as `subscribers.json`.

### Bulk Import Subscribers

```bash
POST /api/subscribers/import
Content-Type: application/json

{
  "subscribers": [
    {
      "imsi": "001010000000050",
      "k": "fec86ba6eb707ed08ce33ae45b4a0fba",
      "opc": "c42449363464e2e4fa8adca3063168ca"
    },
    {
      "imsi": "001010000000051",
      "k": "fec86ba6eb707ed08ce33ae45b4a0fba",
      "opc": "c42449363464e2e4fa8adca3063168ca"
    }
  ]
}
```

**Response:**
```json
{
  "status": "ok",
  "imported": 2,
  "skipped": 0,
  "failed": 0,
  "results": [
    {"imsi": "001010000000050", "status": "success"},
    {"imsi": "001010000000051", "status": "success"}
  ]
}
```

---

## MongoDB Schema

Subscribers are stored in the `subscribers` collection in the `open5gs` database. Full Open5GS schema is supported:

```javascript
{
  "_id": ObjectId("..."),
  "imsi": "001010000000001",
  "pdn": [
    {
      "type": 0,                    // PDN type (0=IPv4, 1=IPv6, 2=IPv4v6)
      "apn": "internet",            // APN name
      "slice": [{"sst": 1, "sd": "000000"}],
      "ue_ipv4": "10.0.0.1",        // Optional: static IP
      "ue_ipv6": "fe80::1",         // Optional: static IPv6
      "qos": { "arp": {...} }       // QoS profile
    }
  ],
  "slice": [
    {"sst": 1, "sd": "000000"},     // Network slice
    {"sst": 2, "sd": "000001"}      // Multiple slices supported
  ],
  "security": {
    "k": "fec86ba6eb707ed08ce33ae45b4a0fba",    // 128-bit auth key
    "opc": "c42449363464e2e4fa8adca3063168ca",  // Operator key
    "amf": "c3d4",                              // Authentication mgmt field
    "sqn": 0                                    // Sequence number
  },
  "ambr": {
    "uplink": 1000000000,      // Aggregate max bitrate (bits/sec)
    "downlink": 1000000000
  },
  "subscribed_rau_tau_timer": 12,  // RAU/TAU timeout (minutes)
  "plmn": {
    "mcc": "001",
    "mnc": "01"
  },
  "access_restriction_data": 0,
  "network_access_mode": 2,
  "subscriber_status": 0
}
```

---

## Use Cases

### 1. Add Single UE for Testing

1. Go to **Subscribers** tab
2. Click **Add Subscriber** button
3. Enter IMSI (e.g., `001010000000050`)
4. Keep default K, OPc, AMF values
5. Click **Save**
6. UE appears in list and registers with gNB

### 2. Bulk Create 1000 UEs for Load Testing

```bash
# Generate JSON file with 1000 UEs
node -e "
const subs = [];
for (let i = 100; i < 1100; i++) {
  subs.push({
    imsi: String(1010000000000 + i).padStart(15, '0'),
    k: 'fec86ba6eb707ed08ce33ae45b4a0fba',
    opc: 'c42449363464e2e4fa8adca3063168ca'
  });
}
console.log(JSON.stringify(subs, null, 2));
" > subscribers.json

# Copy content and paste into Bulk Import textarea
# Click "Import Subscribers"
```

**Monitor in Grafana:**
- Watch `fivegs_amf_registered_ue_nbr` metric rise to 1000
- HPA triggers scale-up of AMF if configured
- Throughput metrics update in Monitoring tab

### 3. Export and Backup Subscriber Database

1. Click **Export** button
2. `subscribers.json` downloads
3. Commit to version control for backup
4. Share with team

### 4. Import Subscriber Database from File

1. Export from Open5GS WebUI (if migrating from old system)
2. Go to Bulk Import section
3. Paste JSON array
4. Click **Import Subscribers**
5. Review import summary (imported/skipped/failed)

### 5. Modify Subscriber QoS Settings

1. Search for subscriber by IMSI
2. Click **Edit**
3. Change UL/DL AMBR values (in Mbps)
4. Click **Save**
5. Change applies immediately in MongoDB
6. Open5GS reads new config on next registration

### 6. Delete Failed UEs

```bash
# Via API (e.g., in a cleanup script)
for imsi in 001010000000100 001010000000101; do
  curl -X DELETE "http://localhost:5000/api/ue/delete?imsi=$imsi"
done
```

---

## Comparison to Open5GS WebUI

| Feature | Open5GS WebUI | Testbed Subscriber Mgmt |
|---------|---|---|
| View subscribers | ✓ | ✓ |
| Add subscriber | ✓ | ✓ |
| Edit subscriber | ✓ | ✓ |
| Delete subscriber | ✓ | ✓ |
| Search/filter | ✓ | ✓ (IMSI search) |
| Bulk import | ✗ | ✓ |
| Bulk export | ✗ | ✓ |
| Pagination | ✓ | ✓ (25 per page) |
| Edit all fields | ✓ | Partial (main fields) |
| Integrated UI | ✗ | ✓ (same dashboard) |
| REST API | ✗ | ✓ (scriptable) |

---

## Default Values

When adding a subscriber without explicit values:

| Field | Default |
|-------|---------|
| K | `fec86ba6eb707ed08ce33ae45b4a0fba` |
| OPc | `c42449363464e2e4fa8adca3063168ca` |
| AMF | `c3d4` |
| AMBR UL/DL | 1000 Mbps each |
| APN | `internet` |
| Slice | SST=1, SD=000000 |
| RAU/TAU Timer | 12 minutes |
| PLMN | MCC=001, MNC=01 |

---

## Troubleshooting

### "MongoDB not connected" Error

**Symptom:** All API calls fail with 503 status

**Solution:**
1. Check MongoDB pod: `kubectl get pod mongodb-0 -n 5g-testbed`
2. Check testbed-api pod: `kubectl get pod -l app=testbed-api -n 5g-testbed`
3. Check testbed-api logs: `kubectl logs -f deployment/testbed-api -n 5g-testbed`
4. Verify MongoDB is accessible: `kubectl exec -it deployment/testbed-api -- nc -zv mongodb 27017`

### Bulk Import "Already Exists" Errors

**Symptom:** Some subscribers fail to import with "already exists"

**Solution:**
- This is expected behavior (no duplicates allowed)
- Delete existing subscribers first if reimporting entire database
- Or modify IMSIs to avoid conflicts

### UI Modal Not Opening

**Symptom:** Click "Add Subscriber" but nothing happens

**Solution:**
1. Check browser console for JavaScript errors (F12)
2. Verify API is responding: curl `http://localhost:5000/api/subscribers`
3. Refresh page and try again

### Pagination Not Working

**Symptom:** "Next →" button disabled on page 1

**Solution:**
- Less than 25 subscribers total (expected)
- Search filter reduced results below limit
- Click "Next →" will be enabled when >25 results exist

---

## API Examples

### cURL

```bash
# List subscribers
curl http://localhost:5000/api/subscribers?page=1&limit=25

# Get single subscriber
curl http://localhost:5000/api/subscriber/001010000000001

# Add subscriber
curl -X POST http://localhost:5000/api/ue/add \
  -H "Content-Type: application/json" \
  -d '{"imsi":"001010000000050","k":"...","opc":"..."}'

# Delete subscriber
curl -X DELETE 'http://localhost:5000/api/ue/delete?imsi=001010000000050'

# Export all
curl http://localhost:5000/api/subscribers/export > subscribers.json
```

### JavaScript (Frontend)

```javascript
// List subscribers
const res = await fetch('/api/subscribers?page=1&limit=25');
const data = await res.json();
console.log(data.data);  // Array of subscribers

// Add subscriber
const res = await fetch('/api/ue/add', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({imsi: "001010000000050", k: "...", opc: "..."})
});

// Delete subscriber
const res = await fetch('/api/ue/delete?imsi=001010000000050', {
  method: 'DELETE'
});
```

### Python

```python
import requests
import json

BASE_URL = 'http://localhost:5000'

# List subscribers
resp = requests.get(f'{BASE_URL}/api/subscribers', params={'page': 1, 'limit': 25})
subscribers = resp.json()['data']

# Add subscriber
resp = requests.post(f'{BASE_URL}/api/ue/add', json={
    'imsi': '001010000000050',
    'k': 'fec86ba6eb707ed08ce33ae45b4a0fba',
    'opc': 'c42449363464e2e4fa8adca3063168ca'
})

# Bulk import
with open('subscribers.json') as f:
    subs = json.load(f)

resp = requests.post(f'{BASE_URL}/api/subscribers/import', json={'subscribers': subs})
print(f"Imported: {resp.json()['imported']}, Failed: {resp.json()['failed']}")
```

---

## Next Steps

1. **Scale Testing**: Use bulk import to create 1000+ UEs and monitor AMF scaling
2. **Custom QoS**: Modify AMBR/APN settings and measure throughput impact
3. **Multi-Slice**: Update subscribers with multiple slices (SST=1,2,3) and test slice isolation
4. **Integration**: Use REST API in automation scripts for continuous testing

---

**Subscriber management is now fully integrated into the testbed dashboard. No need for separate Open5GS WebUI!**
