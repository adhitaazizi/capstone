# VPS provisioning for Spraycount

Use this guide to provision a generic Ubuntu/Debian VPS for the Spraycount stack.

## 1) Update the server

```bash
sudo apt update
sudo apt upgrade -y
```

## 2) Install Docker Engine and the Compose plugin

```bash
sudo apt install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
```

If you are on Debian, use the matching Docker repository for Debian instead of the Ubuntu repo above.

## 3) Create the project directory

```bash
sudo mkdir -p /opt/spraycount
sudo chown "$USER":"$USER" /opt/spraycount
```

## 4) Copy the deployment files

Copy these files from your workstation to the VPS:

- `docker-compose.yml`
- `monitoring/`
- `.env`

Example:

```bash
scp docker-compose.yml user@your-vps:/opt/spraycount/
scp -r monitoring user@your-vps:/opt/spraycount/
scp .env user@your-vps:/opt/spraycount/
```

## 5) Start the services

From `/opt/spraycount`, start the stack:

```bash
docker compose up -d
```

## 6) Check the services

```bash
docker compose ps
docker compose logs -f
```

The stack includes RabbitMQ, the Python persistence worker, the Next.js dashboard, Prometheus, and Grafana.
