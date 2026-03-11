# ============================================================
# 5G Testbed — Zeek IDS: Control-Plane Security Monitor
# Monitors: SBI (HTTP/2, port 7777) + N2 (NGAP/SCTP, port 38412)
# Output:   JSON notice.log → /ids/zeek/notice.log
#
# Run via docker-compose: zeek-ids service (network_mode: host)
# Command: cd /ids/zeek && zeek -C -i any /etc/zeek/site/local.zeek \
#          "LogAscii::use_json=T"
# ============================================================

@load base/protocols/conn
@load base/protocols/http
@load base/frameworks/notice

module FiveG;

export {
  redef enum Notice::Type += {
    SBI_AuthFailure,     ##< Burst of HTTP 4xx errors on SBI port 7777
    SBI_NfRegFlood,      ##< Rapid NF registrations flooding NRF
    SBI_HighErrorRate,   ##< NF returning excessive 5xx errors
    N2_NgapFlood,        ##< NGAP connection establishment rate exceeded
    IDS_Status,          ##< Informational: IDS started / heartbeat
  };

  ## SBI auth failure alert threshold (failures within 60 s rolling window)
  const auth_fail_threshold: count = 5  &redef;

  ## NF registration flood threshold (PUT/nf-instances within 30 s window)
  const nf_reg_threshold: count = 10 &redef;

  ## N2 NGAP connection flood threshold (new conns within 10 s window)
  const n2_conn_threshold: count = 50 &redef;
}

# ── Port constants ───────────────────────────────────────────
const SBI_PORT: port = 7777/tcp;
const N2_PORT:  port = 38412/tcp;

# ── State: per-source HTTP auth failure counters (60 s TTL) ──
global sbi_auth_fails: table[addr] of count
    &default = 0
    &create_expire = 60secs;

# ── State: per-NF 5xx error counters (60 s TTL) ─────────────
global sbi_5xx_counts: table[addr] of count
    &default = 0
    &create_expire = 60secs;

# ── State: NF registration flood counters (30 s TTL) ─────────
global nf_reg_counts: table[addr] of count
    &default = 0
    &create_expire = 30secs;

# ── State: N2 NGAP connection window ─────────────────────────
global n2_window_conns: count = 0;
global n2_window_start: time  = double_to_time(0.0);

# ── IDS startup notice ───────────────────────────────────────
event zeek_init() {
  NOTICE([$note       = IDS_Status,
          $msg        = "5G Testbed Zeek IDS active — SBI(7777) N2(38412) monitoring started",
          $sub        = "INFO",
          $identifier = "zeek-init"]);
}

# ── SBI: HTTP 4xx auth-failure and 5xx error detection ───────
event http_reply(c: connection, version: string, code: count, reason: string) {
  if ( c$id$resp_p != SBI_PORT ) return;

  # Track auth-related failures (401 Unauthorized, 403 Forbidden, 429 Too Many Requests)
  if ( code in { 400, 401, 403, 429 } ) {
    sbi_auth_fails[c$id$orig_h] += 1;
    if ( sbi_auth_fails[c$id$orig_h] >= auth_fail_threshold ) {
      NOTICE([$note       = SBI_AuthFailure,
              $conn       = c,
              $msg        = fmt("SBI auth failure burst: %s caused %d HTTP %d responses in 60s",
                                c$id$orig_h,
                                sbi_auth_fails[c$id$orig_h],
                                code),
              $sub        = "HIGH",
              $identifier = cat(c$id$orig_h)]);
      delete sbi_auth_fails[c$id$orig_h];
    }
  }

  # Track 5xx NF internal errors
  if ( code >= 500 ) {
    sbi_5xx_counts[c$id$resp_h] += 1;
    if ( sbi_5xx_counts[c$id$resp_h] >= 20 ) {
      NOTICE([$note       = SBI_HighErrorRate,
              $conn       = c,
              $msg        = fmt("NF %s excessive 5xx errors: %d responses in 60s",
                                c$id$resp_h,
                                sbi_5xx_counts[c$id$resp_h]),
              $sub        = "MEDIUM",
              $identifier = cat(c$id$resp_h)]);
      delete sbi_5xx_counts[c$id$resp_h];
    }
  }
}

# ── SBI: NRF registration flood ──────────────────────────────
event http_request(c: connection, method: string, original_URI: string,
                   unescaped_URI: string, version: string) {
  if ( c$id$resp_p != SBI_PORT ) return;
  if ( method != "PUT" && method != "POST" ) return;
  if ( /nnrf-nfm\/v1\/nf-instances/ !in unescaped_URI ) return;

  nf_reg_counts[c$id$orig_h] += 1;
  if ( nf_reg_counts[c$id$orig_h] > nf_reg_threshold ) {
    NOTICE([$note       = SBI_NfRegFlood,
            $conn       = c,
            $msg        = fmt("NF registration flood from %s: %d PUT /nf-instances in 30s",
                              c$id$orig_h,
                              nf_reg_counts[c$id$orig_h]),
            $sub        = "MEDIUM",
            $identifier = cat(c$id$orig_h)]);
    delete nf_reg_counts[c$id$orig_h];
  }
}

# ── N2: NGAP connection flood detection ──────────────────────
event connection_established(c: connection) {
  if ( c$id$resp_p != N2_PORT ) return;

  if ( n2_window_start == double_to_time(0.0) )
    n2_window_start = network_time();

  n2_window_conns += 1;
  local elapsed = network_time() - n2_window_start;

  if ( elapsed >= 10secs ) {
    if ( n2_window_conns > n2_conn_threshold ) {
      NOTICE([$note       = N2_NgapFlood,
              $conn       = c,
              $msg        = fmt("N2 NGAP flood: %d connections in %.0f s (threshold %d)",
                                n2_window_conns, elapsed, n2_conn_threshold),
              $sub        = "CRITICAL",
              $identifier = "n2-flood"]);
    }
    n2_window_conns  = 0;
    n2_window_start  = network_time();
  }
}

# ── Notice policy: log all notices (no email) ─────────────────
hook Notice::policy(n: Notice::Info) {
  add n$actions[Notice::ACTION_LOG];
}
