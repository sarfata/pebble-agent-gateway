# Public HTTPS with Tailscale Funnel

The Pebble mobile app needs a normal public HTTPS endpoint. For self-hosted Docker, run the gateway locally and expose it with Tailscale Funnel instead of raw HTTP, IP-address HTTP, or self-signed TLS.

```bash
docker compose -f deploy/docker-compose.yml up --build
tailscale funnel 3000
```

Set `PUBLIC_BASE_URL` to the HTTPS Funnel URL before provisioning rings.
