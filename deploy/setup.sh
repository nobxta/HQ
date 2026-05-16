#!/bin/bash
# TAdbot Production Deployment Script
# Run as root on Ubuntu 22.04+ VPS
# Usage: sudo bash deploy/setup.sh

set -e

DOMAIN="${1:-your-domain.com}"
APP_DIR="/opt/tadbot"
APP_USER="tadbot"

echo "=== TAdbot Deployment Setup ==="
echo "Domain: $DOMAIN"
echo "App directory: $APP_DIR"
echo ""

# System packages
echo "[1/8] Installing system packages..."
apt-get update -qq
apt-get install -y python3.11 python3.11-venv python3.11-dev nginx certbot python3-certbot-nginx git

# Create app user
echo "[2/8] Creating app user..."
id -u $APP_USER &>/dev/null || useradd --system --shell /bin/bash --home $APP_DIR $APP_USER

# App directory
echo "[3/8] Setting up app directory..."
mkdir -p $APP_DIR
cp -r . $APP_DIR/ 2>/dev/null || true
chown -R $APP_USER:$APP_USER $APP_DIR

# Python venv + dependencies
echo "[4/8] Installing Python dependencies..."
cd $APP_DIR
sudo -u $APP_USER python3.11 -m venv venv
sudo -u $APP_USER venv/bin/pip install --upgrade pip
sudo -u $APP_USER venv/bin/pip install -r requirements.txt
sudo -u $APP_USER venv/bin/pip install fastapi uvicorn[standard] pyjwt bcrypt python-multipart

# Environment file
echo "[5/8] Setting up environment..."
if [ ! -f "$APP_DIR/.env" ]; then
    cp "$APP_DIR/.env.example" "$APP_DIR/.env"
    echo ""
    echo "!!! IMPORTANT: Edit $APP_DIR/.env with your actual values !!!"
    echo ""
fi

# Generate JWT secret if not set
if ! grep -q "JWT_SECRET=" "$APP_DIR/.env" 2>/dev/null; then
    JWT_SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
    echo "" >> "$APP_DIR/.env"
    echo "# API Configuration" >> "$APP_DIR/.env"
    echo "JWT_SECRET=$JWT_SECRET" >> "$APP_DIR/.env"
    echo "WEB_ADMIN_USER=admin" >> "$APP_DIR/.env"
    echo "# Generate hash: python -c \"import bcrypt; print(bcrypt.hashpw(b'yourpassword', bcrypt.gensalt()).decode())\"" >> "$APP_DIR/.env"
    echo "WEB_ADMIN_PASS_HASH=" >> "$APP_DIR/.env"
    echo "API_PORT=8000" >> "$APP_DIR/.env"
    echo "CORS_ORIGINS=https://$DOMAIN" >> "$APP_DIR/.env"
fi

# systemd service
echo "[6/8] Installing systemd service..."
cp "$APP_DIR/deploy/tadbot.service" /etc/systemd/system/tadbot.service
systemctl daemon-reload
systemctl enable tadbot

# Nginx
echo "[7/8] Configuring Nginx..."
sed "s/YOUR_DOMAIN/$DOMAIN/g" "$APP_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/tadbot
ln -sf /etc/nginx/sites-available/tadbot /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# SSL
echo "[8/8] Setting up SSL certificate..."
certbot --nginx -d $DOMAIN --non-interactive --agree-tos --email admin@$DOMAIN || echo "SSL setup failed - run manually: certbot --nginx -d $DOMAIN"

echo ""
echo "=== Deployment Complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit /opt/tadbot/.env (set all required variables)"
echo "  2. Generate password hash:"
echo "     /opt/tadbot/venv/bin/python -c \"import bcrypt; print(bcrypt.hashpw(b'YOUR_PASSWORD', bcrypt.gensalt()).decode())\""
echo "  3. Set WEB_ADMIN_PASS_HASH in .env"
echo "  4. Start the service: sudo systemctl start tadbot"
echo "  5. Check status: sudo systemctl status tadbot"
echo "  6. View logs: sudo journalctl -u tadbot -f"
echo ""
echo "API will be available at: https://$DOMAIN/api/docs"
echo "WebSocket at: wss://$DOMAIN/ws/dashboard"
