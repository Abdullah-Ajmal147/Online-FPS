Colyseus trusts the X-Real-IP header for the player's IP, and the API takes the first X-Forwarded-For entry. So nginx must overwrite both headers with the real address. The common $proxy_add_x_forwarded_for would let a player fake their IP and dodge IP bans.

Here's everything, in order.

1. docker-compose.override.yml

Put this next to docker-compose.yml on the server; Docker Compose loads it automatically. It switches off the bundled Caddy, which would take ports 80/443, and exposes the game and API to the server itself only:

services:
caddy:
profiles: ['caddy'] # off: nginx on the host handles 80/443
game:
ports: - '127.0.0.1:2567:2567'
api:
ports:
├─────────────────────────┼─────────────────────────────────────────────────────────┤
│ SENTINEL_ADMIN_PASSWORD │ ✅ 24 characters (needs 12+) │
├─────────────────────────┼─────────────────────────────────────
│ SITE_ADDRESS │ ✅ valid format, see the dummy-domain note below │
├─────────────────────────┼─────────────────────────────────────────────────────────┤
│ SENTINEL_IMAGE │ ✅ matches the Docker Hub image your workflow publishes │
├─────────────────────────┼─────────────────────────────────────────────────────────┤
│ SITE_URL │ ✅ https:// + the same domain
└─────────────────────────┴─────────────────────────────────────────────────────────┘

Two things to know:

1. You pasted the secret and admin password into this chat. They're now in this conversation's history. That's fine for testing, but before real players
   arrive, generate fresh values and don't share them. The .env.new the values are never shown.

2. The dummy domain. On EC2, Caddy will try to get an HTTPS certificate for play.remoteref.com. That only works if the domain's DNS points to your EC2 IP.
   Otherwise it fails and keeps retrying, and Let's Encrypt temporas.

- Until your real domain is ready, use plain HTTP on the server's IP:
  SITE_ADDRESS=:80
  SITE_URL=http://<your-EC2-public-IP>
  Then open http://<EC2-IP> in the browser. Everything works over plain HTTP, including invite links; only the Copy button falls back to "Press Ctrl+C". Make sure the security group allows port 80.
- When the real domain points to the Elastic IP, switch both bacth https://) and restart with docker compose up -d. Caddy thengets the certificate automatically.

The Vite fix for the CI failures is still waiting whenever you w

✻ Churned for 12s · done 5:01 PM

❯ give me ngnix conf i can copy and paste when image up

Checking how docker-compose.yml exposes the containers, so the nght ports:
erver; Docker Compose loads it automatically. It switches off the bundled Caddy, which would take ports 80/443, and exposes the game and API to the server itself only:

services:
caddy:
profiles: ['caddy'] # off: nginx on the host handles 80/443
game:
ports: - '127.0.0.1:2567:2567'
api:
ports: - '127.0.0.1:8787:8787'

2. /etc/nginx/sites-available/sentinel

   client_max_body_size 64k;

   gzip on;
   gzip_types text/css application/javascript application/json image/svg+xml;

   add_header X-Content-Type-Options nosniff always;
   add_header Referrer-Policy strict-origin-when-cross-origin a
   server_tokens off;

   # API: /api/profiles/... -> api /profiles/... (the trailing

   location /api/ {
   proxy_pass http://127.0.0.1:8787/;
   proxy_http_version 1.1;
   proxy_set_header Host $host; # Overwrite, never append: the API trusts the first entry (IP bans, rate limits).
   proxy_set_header X-Forwarded-For $remote_addr;
   IP from X-Real-IP: always set it here.
   proxy_set_header X-Real-IP $remote_addr;
   proxy_set_header X-Forwarded-For $remote_addr;
   proxy_set_header X-Forwarded-Proto $scheme; # Matches last 10+ minutes on one WebSocket: don't cut idle-looking connections.
   proxy_read_timeout 3600s;
   proxy_send_timeout 3600s;
   proxy_buffering off;
   }
   }

3. Commands on the server

sudo apt install -y nginx
sudo nano /etc/nginx/sites-available/sentinel # paste the config above
sudo ln -s /etc/nginx/sites-available/sentinel /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

docker compose pull && docker compose up -d # game + api (Caddy stays off)
curl -s http://localhost/api/healthz # {"ok":true,"service":"api"}

Then open http://<EC2-public-IP>. Security group: open 80 and 443 only (2567/8787 are local-only now).

4. HTTPS, once the real domain points to the Elastic IP

sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d play.remoteref.com --redirect

Certbot adds the certificate, the HTTP→HTTPS redirect and automaE_URL=https://play.remoteref.com in ENV_FILE, so the next imagebuild uses the right link-preview address.
