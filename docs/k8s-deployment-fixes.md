# Kubernetes Deployment Fixes — 5G Testbed

This document records every bug found and fixed during the first live deployment of the 5G testbed on K3s (Ubuntu 24.04, Kubernetes v1.32.11 with Cilium CNI).

---

## Environment

| Component | Version |
|-----------|---------|
| OS | Ubuntu 24.04 LTS |
| Kubernetes | K3s v1.32.11 |
| CNI | Cilium 1.17.12 |
| Open5GS | 2.7.0 (`gradiant/open5gs:2.7.0`) |
| UERANSIM | 3.2.6 (`gradiant/ueransim:3.2.6`) |
| MongoDB | 6.0 |

---

## Fix 1 — Kustomize root-level `kustomization.yaml`

**File:** `kustomization.yaml` (project root, created new)

**Symptom:**
```
Error: accumulating resources: ... file is not in or below '/k8s'
```

**Root cause:** Running `kubectl apply -k k8s/base` from the project root caused kustomize to reject relative paths that reference files outside the specified base directory.

**Fix:** Created a root-level `kustomization.yaml` that references `k8s/base` as a resource. All subsequent `kubectl apply -k .` calls run from the project root, keeping relative paths valid.

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - k8s/base
```

---

## Fix 2 — Removed unsupported `commonMetadata` field

**File:** `k8s/base/kustomization.yaml`

**Symptom:**
```
error: json: unknown field "commonMetadata"
```

**Root cause:** The `commonMetadata` field was added as a convenience but is not supported in the kubectl/kustomize version bundled with K3s v1.32.

**Fix:** Removed the `commonMetadata` block entirely.

---

## Fix 3 — Wrong UERANSIM image name

**File:** `k8s/base/kustomization.yaml`

**Symptom:**
```
Error response from daemon: manifest unknown: towards5gs/ueransim:v3.2.6 not found
```

**Root cause:** The original image reference `towards5gs/ueransim:v3.2.6` does not exist on Docker Hub. The maintained public image is published by `gradiant`.

**Fix:**
```yaml
images:
  - name: towards5gs/ueransim
    newName: gradiant/ueransim
    newTag: "3.2.6"
```

---

## Fix 4 — MongoDB PVC StorageClass not available

**File:** `k8s/base/mongodb/pvc.yaml`

**Symptom:** MongoDB PVC stuck in `Pending` state.

**Root cause:** The PVC referenced `storageClassName: local-path`, which is the default for a standard K3s install. However, this cluster uses Cilium's `csi-rawfile-default` StorageClass instead.

**Fix:**
```yaml
storageClassName: csi-rawfile-default
```

---

## Fix 5 — MongoDB auth crash (missing credentials secret)

**File:** `k8s/base/mongodb/statefulset.yaml`

**Symptom:**
```
error: environment variable MONGO_INITDB_ROOT_USERNAME is required
```

**Root cause:** The StatefulSet specified `MONGO_INITDB_ROOT_USERNAME` and `MONGO_INITDB_ROOT_PASSWORD` from a Secret named `mongodb-credentials` that was never created.

**Fix:** Removed the auth env vars entirely. This testbed runs MongoDB without authentication (appropriate for a local lab environment).

```yaml
env: []
```

---

## Fix 6 — UPF unschedulable due to empty nodeSelector

**File:** `k8s/base/open5gs-core/upf-deployment.yaml`

**Symptom:**
```
0/1 nodes are available: node affinity/selector mismatch
```

**Root cause:** The UPF Deployment had `nodeSelector: kubernetes.io/hostname: ""` — an empty value that no node could match.

**Fix:** Removed the `nodeSelector` block entirely.

---

## Fix 7 — Wrong binary path for all Open5GS NFs

**Files:** All NF deployment files

**Symptom:**
```
stat /open5gs/install/bin/open5gs-nrfd: no such file or directory
```

**Root cause:** The deployment commands used the path `/open5gs/install/bin/` which was the build-time path. The `gradiant/open5gs:2.7.0` image installs binaries to `/opt/open5gs/bin/`.

**Fix:** Changed all binary paths from `/open5gs/install/bin/<nf>d` to `/opt/open5gs/bin/<nf>d`.

---

## Fix 8 — Wrong log file path in Open5GS NF configs

**File:** `k8s/base/open5gs-core/configmap.yaml`

**Symptom:**
```
cannot open log file: /var/log/open5gs/nrf.log: No such file or directory
```

**Root cause:** The config used Docker-Compose-style log paths (`/var/log/open5gs/`). In the container image, only `/opt/open5gs/var/log/open5gs/` is pre-created.

**Fix:** Updated all NF configs to use:
```yaml
logger:
  file: /opt/open5gs/var/log/open5gs/<nf>.log
```

---

## Fix 9 — Completely rewrote Open5GS NF configs (obsolete format)

**File:** `k8s/base/open5gs-core/configmap.yaml`

**Symptom:** Multiple NFs crashed with YAML parse errors or assertion failures after startup.

**Root cause:** The configs used the Open5GS 2.4.x/2.5.x YAML schema (`db_uri` at root, `bindingIPv4`, `registerIPv4`, etc.). Open5GS 2.7.x uses a completely different schema.

**Fix:** Rewrote all 11 NF configs (NRF, SCP, AMF, SMF, UPF, AUSF, UDM, UDR, PCF, BSF, NSSF) using the 2.7.x schema:

- Server binds use `dev: eth0` (not `address: 0.0.0.0`)
- Client URIs use Kubernetes DNS names (e.g. `http://open5gs-nrf.5g-testbed.svc.cluster.local:7777`)
- All NFs include the mandatory `global:` key (see Fix 10)

---

## Fix 10 — `global:` key required in Open5GS 2.7.x configs

**File:** `k8s/base/open5gs-core/configmap.yaml`

**Symptom:**
```
Assertion 'context->epfd >= 0' failed
epoll_create1: No such file or directory
```

**Root cause:** Open5GS 2.7.x YAML parser requires a `global:` top-level key to be present (even if empty/null). Without it, the epoll initialization asserts and aborts.

**Fix:** Added `global:` as an empty key to every NF config:
```yaml
logger:
  file: /opt/open5gs/var/log/open5gs/nrf.log
global:
nrf:
  sbi: ...
```

---

## Fix 11 — HTTP/2 SBI probe failures

**Files:** All NF deployment files (NRF, SCP, AMF, SMF, AUSF, UDM, UDR, PCF, BSF, NSSF)

**Symptom:**
```
nghttp2_session_mem_recv() failed: Received bad client magic byte string
```
Probes reported pods as `NotReady` despite the NF being healthy.

**Root cause:** Open5GS SBI uses HTTP/2. Kubernetes `httpGet` liveness/readiness probes send HTTP/1.1 requests, which are rejected by the nghttp2 server with a bad magic byte error.

**Fix:** Changed all SBI probes from `httpGet` to `tcpSocket`:
```yaml
livenessProbe:
  tcpSocket:
    port: 7777
```

---

## Fix 12 — Missing `open5gs-scp` Kubernetes Service

**File:** `k8s/base/open5gs-core/service.yaml`

**Symptom:** All NFs failed to register because they couldn't reach the SCP.

**Root cause:** The SCP Deployment existed but there was no corresponding Kubernetes Service object. NFs resolve SCP via `http://open5gs-scp.5g-testbed.svc.cluster.local:7777` which requires a Service.

**Fix:** Added a ClusterIP Service for SCP to `service.yaml`.

---

## Fix 13 — NSSF crash: `nsi` entries used wrong format

**File:** `k8s/base/open5gs-core/configmap.yaml` (nssf.yaml section)

**Symptom:**
```
WARNING: unknown key `addr`
WARNING: unknown key `port`
ERROR: No nssf.nsi in '/etc/open5gs/nssf.yaml'
FATAL: Open5GS initialization failed.
```

**Root cause:** The NSSF `nsi` client entries used `addr:` + `port:` keys. In Open5GS 2.7.x, `nsi` entries must use `uri:` (same as other SBI clients).

**Fix:**
```yaml
# Wrong:
nsi:
- addr: open5gs-amf.5g-testbed.svc.cluster.local
  port: 7777
  s_nssai:
    sst: 1

# Correct:
nsi:
- uri: http://open5gs-nrf.5g-testbed.svc.cluster.local:7777
  s_nssai:
    sst: 1
```

---

## Fix 14 — UDR/PCF ignored `db_uri` from config file

**Files:** `k8s/base/open5gs-core/other-nfs-deployments.yaml`

**Symptom:**
```
WARNING: Failed to connect to server [mongodb://mongo/open5gs]
WARNING: Failed to initialize UDR/PCF
```

**Root cause:** The `gradiant/open5gs:2.7.0` image has `DB_URI=mongodb://mongo/open5gs` baked in as a Docker environment variable default. When a container starts, this env var takes precedence over the `db_uri` key in the config file. Since our custom configmap was mounted as a file (not overriding the env var), the binary connected to the Docker Compose default hostname `mongo` which doesn't exist in Kubernetes.

**Fix:** Explicitly set `DB_URI` env var in UDR and PCF deployments to override the image default:
```yaml
env:
- name: DB_URI
  value: mongodb://mongodb.5g-testbed.svc.cluster.local/open5gs
```

---

## Fix 15 — Open5GS WebUI running on wrong port

**File:** `k8s/base/open5gs-core/other-nfs-deployments.yaml`

**Symptom:** WebUI pod `Running` but `0/1 Ready`. HTTP probes failing.

**Root cause:** The Deployment and Service configured port 3000, but the `gradiant/open5gs-webui:2.7.0` image runs the Node.js app on port **9999**.

**Fix:** Changed all port references from 3000 to 9999:
```yaml
containerPort: 9999
livenessProbe:
  httpGet:
    port: 9999
readinessProbe:
  httpGet:
    port: 9999
```

---

## Fix 16 — UERANSIM UE config used wrong field names (v3.2.6 schema)

**File:** `k8s/base/ran/configmap.yaml`

**Symptom:**
```
Field 'op' is missing
Field 'EA3' is missing
Field 'imeiSv' is too small
```

**Root cause:** The UE YAML config used field names from an older UERANSIM version. In v3.2.6:

| Old field | New field |
|-----------|-----------|
| `opc:` | `op:` + `opType: OPC` |
| `sessionConfig:` | `sessions:` |
| `ConfiguredNssai:` | `configured-nssai:` |
| short `imeiSv` | 16-digit `imeiSv` |
| `EA0/EA1/EA2` only | `EA0/EA1/EA2/EA3` all required |

**Fix:** Rewrote both `ue.yaml` and `ue2.yaml` with the correct v3.2.6 schema.

---

## Fix 17 — gNB init container used TCP check for SCTP port

**File:** `k8s/base/ran/gnb-deployment.yaml`

**Symptom:** gNB pod stuck in `Init:0/1` indefinitely despite the AMF being healthy.

**Root cause:** The init container used `nc -z open5gs-amf.5g-testbed.svc.cluster.local 38412` to wait for the AMF's NGAP port. `nc -z` performs a TCP check. NGAP uses SCTP (protocol 132), so TCP never succeeds.

**Fix:** Changed the init container to wait on the AMF SBI port (TCP 7777) instead:
```bash
until nc -z open5gs-amf.5g-testbed.svc.cluster.local 7777; do sleep 2; done
```

---

## Fix 18 — Wrong gNB binary name in gradiant/ueransim image

**File:** `k8s/base/ran/gnb-deployment.yaml`

**Symptom:**
```
exec: "gnb": executable file not found in $PATH
```

**Root cause:** The Deployment command used `gnb` as the binary name. In the `gradiant/ueransim:3.2.6` image, the gNB binary is `nr-gnb` (not `gnb`).

**Fix:**
```yaml
command:
- nr-gnb
- -c
- /etc/ueransim/gnb.yaml
```

---

## Fix 19 — UE pod `sendto: Operation not permitted`

**File:** `k8s/base/ran/ue-deployment.yaml`

**Symptom:**
```
terminate called after throwing an instance of 'LibError'
  what(): sendto failed: Operation not permitted
```

**Root cause:** UERANSIM creates TUN interfaces and sends raw packets (GTP-U, SCTP). The capabilities `NET_ADMIN` + `NET_RAW` alone were insufficient. Full `privileged: true` is required for the UE to operate correctly in Kubernetes.

**Fix:**
```yaml
securityContext:
  privileged: true
  capabilities:
    add:
    - NET_ADMIN
    - NET_RAW
```

---

## Fix 20 — Cilium dropping SCTP packets (CT: Unknown L4 protocol)

**Component:** Cilium CNI configuration (`kube-system/cilium-config` ConfigMap)

**Symptom:** gNB could not complete SCTP handshake with AMF. The gNB's SCTP socket remained in `COOKIE_WAIT` state indefinitely. The AMF showed no SCTP associations despite the gNB sending INIT packets.

**Diagnosis:** Cilium metrics showed:
```
cilium_drop_count_total  direction=EGRESS  reason=CT: Unknown L4 protocol  65
```
SCTP is protocol 132. Cilium's eBPF connection tracking treated it as an unknown L4 protocol and silently dropped all SCTP packets.

**Root cause:** Cilium 1.17 ships with `enable-sctp: "false"` by default. SCTP support (for ClusterIP services and pod-to-pod) must be explicitly enabled.

**Fix:**
```bash
kubectl -n kube-system patch configmap cilium-config \
  --type merge -p '{"data":{"enable-sctp":"true"}}'
kubectl -n kube-system rollout restart daemonset/cilium
```

**Impact:** This is a **cluster-level fix** required for any 5G Core deployment on Cilium. Must be applied before deploying.

---

## Fix 21 — Added headless AMF NGAP service (reference, reverted after Fix 20)

**File:** `k8s/base/open5gs-core/service.yaml`

**Note:** A headless service `open5gs-amf-ngap` (clusterIP: None) was added as a workaround to bypass Cilium's eBPF load balancing for SCTP. After Fix 20 (enabling SCTP in Cilium), the gNB was reverted to use the standard `open5gs-amf` service. The headless service remains in the manifests and is harmless.

---

## Fix 22 — Subscriber not provisioned in MongoDB

**Component:** Open5GS UDR / AMF subscriber lookup

**Symptom:**
```
[gmm] WARNING: [suci-0-001-01-0000-0-0-0000000001] Cannot find SUCI [404]
[amf] WARNING: Registration reject [11]   # cause: PLMN_NOT_ALLOWED
```

**Root cause:** The UE's IMSI (`001010000000001`) was not in the Open5GS subscriber database (MongoDB). The AMF queries the UDM/UDR for subscriber data during Initial Registration. When the SUCI lookup returns 404, the AMF sends a Registration Reject with cause `#11 PLMN not allowed`.

**Fix:** Added the subscriber record directly via MongoDB shell:
```javascript
db = db.getSiblingDB("open5gs");
db.subscribers.insertOne({
  imsi: "001010000000001",
  security: {
    k: "fec86ba6eb707ed08ce33ae45b4a0fba",
    opc: "c42449363464e2e4fa8adca3063168ca",
    amf: "8000",
    sqn: NumberLong("0")
  },
  slice: [{ sst: 1, session: [{ name: "internet", type: 3 }] }],
  ...
});
```

Subscribers can also be provisioned via the Open5GS WebUI at `http://<node-ip>:30300` (NodePort, if configured) using credentials `admin` / `1423`.

---

## Final Validation

After all fixes, full end-to-end registration succeeded:

```
[rrc] info  RRC connection established
[nas] info  UE switches to state [MM-REGISTERED/NORMAL-SERVICE]
[nas] info  Initial Registration is successful
[nas] debug PDU Session Establishment Accept received
[nas] info  PDU Session establishment is successful PSI[1]
[app] info  Connection setup for PDU session[1] is successful,
            TUN interface[uesimtun0, 10.45.0.2] is up.
```

**Pod status (all healthy):**
```
NAME                             READY   STATUS    RESTARTS
mongodb-0                        1/1     Running   0
open5gs-amf                      1/1     Running   0
open5gs-ausf                     1/1     Running   0
open5gs-bsf                      1/1     Running   0
open5gs-nrf                      1/1     Running   0
open5gs-nssf                     1/1     Running   0
open5gs-pcf                      1/1     Running   0
open5gs-scp                      1/1     Running   0
open5gs-smf                      1/1     Running   0
open5gs-udm                      1/1     Running   0
open5gs-udr                      1/1     Running   0
open5gs-upf                      1/1     Running   0
open5gs-webui                    1/1     Running   0
testbed-api                      1/1     Running   0
testbed-proxy                    1/1     Running   0
testbed-ui                       1/1     Running   0
ueransim-gnb                     1/1     Running   0
ueransim-ue1                     1/1     Running   0
```

---

## Key Lessons for Fresh Installs

1. **Enable Cilium SCTP before deploying** — `enable-sctp: true` in `cilium-config`. Without this, gNB→AMF NGAP (SCTP) is silently dropped.
2. **Check image env var defaults** — `gradiant/open5gs` sets `DB_URI=mongodb://mongo/open5gs` as a Docker default; always override in the Deployment spec.
3. **Open5GS 2.7.x requires `global:` key** — Even empty, it must be present in every NF config or epoll init will assert-fail.
4. **Use `tcpSocket` probes for Open5GS SBI** — The SBI server speaks HTTP/2; standard `httpGet` probes send HTTP/1.1 and are rejected.
5. **Provision subscribers** — Initial Registration will always fail until the IMSI exists in MongoDB.
