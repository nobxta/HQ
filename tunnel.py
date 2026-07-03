"""Auto-bootstrap a Cloudflare Tunnel for api.hqadz.io.

Built for Pterodactyl (Docker): everything is stored in the current working
directory — the only thing that survives container restarts. Import and call
`tunnel.start()` from main.py before the FastAPI app starts:

    import tunnel
    tunnel.start()
    # ... FastAPI starts normally on $SERVER_PORT ...

First run (no cert/creds): runs `cloudflared tunnel login`, prints the auth URL
to the console, waits for you to authorize the **hqadz.io** zone, creates the
named tunnel, routes api.hqadz.io to it, then launches the tunnel.

Later runs (cert + creds already on the volume): skip login/create/route and
just relaunch the tunnel in the background.

The tunnel forwards api.hqadz.io  ->  http://localhost:$SERVER_PORT.
A tunnel failure never crashes the app — the local API keeps running.

Reliability: cloudflared retries connection failures internally forever, but a
stuck connection (e.g. QUIC/UDP being unreliable inside a Docker/Pterodactyl
network) never crashes the process, so nothing here would ever notice or
restart it. `watchdog_loop()` polls cloudflared's local `/ready` metrics
endpoint and restarts the subprocess if it's been unreachable for too long.
Protocol defaults to http2 (TCP-based) instead of the auto-negotiated quic
(UDP-based) transport, since UDP is frequently blocked/lossy in containerized
hosts and is the most common cause of the
"failed to accept QUIC stream" / "no recent network activity" failure loop.
Override with TUNNEL_PROTOCOL=quic|http2|auto if your host's UDP path is solid.
"""
import asyncio
import atexit
import logging
import os
import shutil
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

logger = logging.getLogger("code.tunnel")

# ───────────────────────── config ─────────────────────────
DOMAIN = "api.hqadz.io"
ZONE = "hqadz.io"
TUNNEL_NAME = "adbot-tunnel"
CF_BIN_URL = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
PROTOCOL = os.getenv("TUNNEL_PROTOCOL", "http2").strip().lower() or "http2"
METRICS_PORT = int(os.getenv("TUNNEL_METRICS_PORT", "20241"))
METRICS_ADDR = f"127.0.0.1:{METRICS_PORT}"
READY_URL = f"http://{METRICS_ADDR}/ready"

# Watchdog tuning: how often to poll, and how long /ready may stay unhealthy
# before we kill + relaunch the subprocess.
WATCHDOG_POLL_SEC = 30
WATCHDOG_UNHEALTHY_RESTART_SEC = 180
# Back off restarts so a persistently broken tunnel doesn't spin-loop.
RESTART_BACKOFF_SEC = [5, 15, 30, 60, 120, 300]

# Everything stored in the current working directory (Pterodactyl persistent volume).
BASE = Path.cwd()
BIN_PATH = BASE / "cloudflared"
CERT_PATH = BASE / "cf-cert.pem"
CREDS_PATH = BASE / "cf-creds.json"

_proc: subprocess.Popen | None = None  # running tunnel subprocess
_proc_started_at: float = 0.0
_restart_count = 0


def _log(msg: str) -> None:
    print(f"[tunnel] {msg}", flush=True)


# ───────────────────────── binary ─────────────────────────
def _cloudflared() -> str:
    """Return a usable cloudflared path, downloading the linux-amd64 build if needed."""
    if BIN_PATH.exists():
        return str(BIN_PATH)
    on_path = shutil.which("cloudflared")
    if on_path:
        return on_path
    _log(f"cloudflared not found — downloading {CF_BIN_URL}")
    tmp = BIN_PATH.with_suffix(".download")
    urllib.request.urlretrieve(CF_BIN_URL, tmp)  # follows GitHub's redirect to the asset
    tmp.replace(BIN_PATH)
    BIN_PATH.chmod(BIN_PATH.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    _log(f"downloaded -> {BIN_PATH}")
    return str(BIN_PATH)


def _env() -> dict:
    """Pin cloudflared's origin cert + config dir to the current directory."""
    env = dict(os.environ)
    env["TUNNEL_ORIGIN_CERT"] = str(CERT_PATH)   # where login writes / create+route read the cert
    env["HOME"] = str(BASE)                        # keep any ~/.cloudflared writes on the volume too
    return env


def _run(args: list[str], capture: bool = False) -> subprocess.CompletedProcess:
    """Run cloudflared synchronously. When capture=False, output streams to the console."""
    kw: dict = {"env": _env(), "check": False}
    if capture:
        kw.update(capture_output=True, text=True)
    return subprocess.run([_cloudflared(), *args], **kw)


# ───────────────────────── setup steps ─────────────────────────
def _login() -> None:
    """Interactive: prints the auth URL and blocks until you authorize the zone."""
    _log("No cert found. Running 'cloudflared tunnel login'.")
    _log(f"Open the URL printed below and authorize the '{ZONE}' zone in your browser.")
    _run(["tunnel", "login"])  # stdout/stderr inherited → auth URL shows in the Pterodactyl console
    # Newer cloudflared honours TUNNEL_ORIGIN_CERT; older builds write ~/.cloudflared/cert.pem.
    if not CERT_PATH.exists():
        for fallback in (BASE / ".cloudflared" / "cert.pem", Path.home() / ".cloudflared" / "cert.pem"):
            if fallback.exists():
                shutil.copyfile(fallback, CERT_PATH)
                break
    if not CERT_PATH.exists():
        raise RuntimeError("Login finished but cf-cert.pem was not created — re-run and authorize the zone.")
    _log(f"cert saved -> {CERT_PATH}")


def _create_tunnel() -> None:
    """Create the named tunnel; write credentials to ./cf-creds.json."""
    _log(f"Creating tunnel '{TUNNEL_NAME}'")
    res = _run(["tunnel", "create", "--credentials-file", str(CREDS_PATH), TUNNEL_NAME], capture=True)
    out = (res.stdout or "") + (res.stderr or "")
    if out.strip():
        print(out, flush=True)
    if not CREDS_PATH.exists():
        if "already exists" in out.lower():
            raise RuntimeError(
                f"Tunnel '{TUNNEL_NAME}' already exists but cf-creds.json is missing. "
                f"Delete it under Cloudflare Zero Trust → Networks → Tunnels and restart, "
                f"or restore cf-creds.json to the volume."
            )
        raise RuntimeError("Tunnel creation failed — see cloudflared output above.")
    _log(f"credentials saved -> {CREDS_PATH}")


def _route_dns() -> None:
    """Point api.hqadz.io at the tunnel. Tolerates an already-routed record."""
    _log(f"Routing {DOMAIN} -> {TUNNEL_NAME}")
    res = _run(["tunnel", "route", "dns", TUNNEL_NAME, DOMAIN], capture=True)
    out = (res.stdout or "") + (res.stderr or "")
    if out.strip():
        print(out, flush=True)
    if res.returncode != 0 and "already" not in out.lower():
        _log(f"warning: 'route dns' exit {res.returncode}; verify the CNAME for {DOMAIN} in Cloudflare DNS")


def _start_tunnel() -> None:
    """Launch the tunnel as a background subprocess forwarding to the local API."""
    global _proc, _proc_started_at
    # Resolve the port EXACTLY like uvicorn does (api.utils.get_api_port:
    # API_PORT > SERVER_PORT > 8000) so the tunnel can never point at the wrong port.
    try:
        from api.utils import get_api_port
        port = str(get_api_port())
    except Exception:
        port = os.getenv("API_PORT") or os.getenv("SERVER_PORT") or "8000"
    # Use 127.0.0.1 (not "localhost") so cloudflared connects over IPv4 — uvicorn
    # binds 0.0.0.0 (IPv4 only); "localhost" can resolve to IPv6 ::1 → connection refused.
    local_url = f"http://127.0.0.1:{port}"
    _log(f"Starting tunnel: {DOMAIN} -> {local_url} (protocol={PROTOCOL}, metrics={METRICS_ADDR})")
    _proc = subprocess.Popen(
        [
            _cloudflared(),
            "tunnel",
            "--no-autoupdate",
            "--protocol", PROTOCOL,
            "--metrics", METRICS_ADDR,
            "run",
            "--cred-file", str(CREDS_PATH),
            "--url", local_url,
            TUNNEL_NAME,
        ],
        env=_env(),
    )
    _proc_started_at = time.monotonic()
    atexit.register(_stop)
    _log(f"tunnel running (pid {_proc.pid}); it will keep retrying the origin until the API is up")


def _stop() -> None:
    global _proc
    if _proc and _proc.poll() is None:
        _log("stopping tunnel")
        _proc.terminate()
        try:
            _proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            _proc.kill()


def _is_ready() -> bool:
    """Query cloudflared's local /ready endpoint (200 once >=1 edge connection is registered)."""
    try:
        with urllib.request.urlopen(READY_URL, timeout=5) as resp:
            return 200 <= resp.status < 300
    except (urllib.error.URLError, OSError, ValueError):
        return False


def _restart_locked() -> None:
    """Kill the current subprocess (if any) and relaunch, honoring backoff between restarts."""
    global _restart_count
    idx = min(_restart_count, len(RESTART_BACKOFF_SEC) - 1)
    backoff = RESTART_BACKOFF_SEC[idx]
    _log(f"restarting tunnel (attempt {_restart_count + 1}, backoff was {backoff}s)")
    _stop()
    try:
        _start_tunnel()
    except Exception as exc:
        _log(f"restart failed: {exc}")
    _restart_count += 1


async def watchdog_loop() -> None:
    """Restart cloudflared if the process died or its /ready endpoint stays unhealthy.

    cloudflared retries connection failures (QUIC drops, edge disconnects, etc.)
    forever on its own and never exits the process, so a stuck-but-alive tunnel
    is otherwise invisible. This polls /ready and force-restarts the subprocess
    if it hasn't reported healthy within WATCHDOG_UNHEALTHY_RESTART_SEC.
    """
    global _restart_count
    if _proc is None:
        return  # tunnel was never started (disabled / non-Linux / setup failed)
    unhealthy_since: float | None = None
    while True:
        await asyncio.sleep(WATCHDOG_POLL_SEC)
        try:
            if _proc.poll() is not None:
                _log(f"tunnel process exited (code {_proc.returncode}) — restarting")
                await asyncio.to_thread(_restart_locked)
                unhealthy_since = None
                continue

            ready = await asyncio.to_thread(_is_ready)
            now = time.monotonic()
            # Grace period right after (re)start before we start judging health.
            if now - _proc_started_at < WATCHDOG_POLL_SEC * 2:
                continue

            if ready:
                if unhealthy_since is not None:
                    _log("tunnel recovered")
                unhealthy_since = None
                _restart_count = 0
            else:
                if unhealthy_since is None:
                    unhealthy_since = now
                    _log("tunnel /ready check failing — monitoring")
                elif now - unhealthy_since >= WATCHDOG_UNHEALTHY_RESTART_SEC:
                    _log(f"tunnel unhealthy for {int(now - unhealthy_since)}s — forcing restart")
                    await asyncio.to_thread(_restart_locked)
                    unhealthy_since = None
        except Exception as exc:  # watchdog must never die
            logger.exception("tunnel watchdog error: %s", exc)


# ───────────────────────── entrypoint ─────────────────────────
def start() -> None:
    """Ensure the api.hqadz.io tunnel is set up and running. Safe to call once at boot.

    Idempotent and fail-open: the first run does login/create/route; later runs
    just relaunch. Any failure is logged and swallowed so the API still starts.
    Skips on non-Linux hosts (e.g. local dev) unless TUNNEL_FORCE=1. Disable with
    TUNNEL_DISABLE=1.
    """
    if os.getenv("TUNNEL_DISABLE", "").strip().lower() in ("1", "true", "yes"):
        _log("TUNNEL_DISABLE set — skipping tunnel")
        return
    if not sys.platform.startswith("linux") and os.getenv("TUNNEL_FORCE", "").strip().lower() not in ("1", "true", "yes"):
        _log(f"non-Linux host ({sys.platform}) — skipping tunnel (set TUNNEL_FORCE=1 to override)")
        return

    try:
        _cloudflared()
        have_cert = CERT_PATH.exists()
        have_creds = CREDS_PATH.exists()

        if have_cert and have_creds:
            _log("cert + creds present — skipping login/create")
        else:
            if not have_cert:
                _login()
            if not CREDS_PATH.exists():
                _create_tunnel()
            _route_dns()

        _start_tunnel()
    except Exception as exc:  # never take down the API because of the tunnel
        _log(f"ERROR: {exc}")
        _log("continuing without the tunnel — the local API still serves on $SERVER_PORT")
