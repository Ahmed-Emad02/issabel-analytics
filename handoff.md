# Sokrat VoIP Dashboard — Session Handoff

## Repositories & Locations

| Repo | Local Path | GitHub | Install Dir |
|---|---|---|---|
| **Dev** | `C:\Users\0xSiTe\Desktop\sokrat-voip-dev` | `Ahmed-Emad02/sokrat-voip-dev.git` | `/opt/sokrat-voip` |
| **Stable** | `C:\Users\0xSiTe\Desktop\sokrat-voip-stable` | `Ahmed-Emad02/sokrat-voip-stable.git` | `/opt/sokrat-voip` |
| **Server** | `192.168.100.118` | — | `/opt/sokrat-voip` |

**Important:** Dev and Stable repos are synced (same files). The server is deployed from dev files via scp + `systemctl restart sokrat-voip`.

---

## What's Been Implemented

### 1. Time/Timezone Settings (sidebar settings dropdown)
- **Backend:** `GET/POST /api/settings/time` in `server.js`  
  Uses `timedatectl` to read/set timezone, NTP, and manual date/time
- **Frontend:** Time Settings button + modal in `views/sidebar.ejs`  
  Searchable timezone selector (419 zones), NTP toggle, manual date/time inputs
- **Languages:** Full EN/AR translations
- **Auth:** Super admin only (same as SMTP settings)

### 2. Install Script (`install.sh`)
- `INSTALL_DIR=/opt/sokrat-voip`
- `REPO_URL` points to appropriate GitHub repo (dev or stable)
- Systemd service: `sokrat-voip.service` (WorkingDirectory: `/opt/sokrat-voip`)
- **Step 12:** Sets timezone to `Africa/Cairo` via `timedatectl`

### 3. Config Diagram — Time Conditions
- `views/config.ejs` (~3950 lines)
- Time Condition nodes appear as yellow cards in column 1 of the diagram
- Wires: Inbound→TC (yellow), TC True→Dest (green), TC False→Dest (red)
- Backend API `/api/config/diagram` returns `timeconditions` with details

### 4. Server Migration
- Apache reverse proxy unchanged (port 80/443 → 8080)
- Old service removed: `issabel-dashboard.service`
- New service: `sokrat-voip.service`

---

## How to Deploy Changes

```bash
# Sync dev file to server
scp server.js root@192.168.100.118:/opt/sokrat-voip/
scp views/config.ejs root@192.168.100.118:/opt/sokrat-voip/views/
scp views/sidebar.ejs root@192.168.100.118:/opt/sokrat-voip/views/
# Restart
ssh root@192.168.100.118 "systemctl restart sokrat-voip"
```

## How to Sync Dev → Stable
```powershell
Copy-Item "C:\Users\0xSiTe\Desktop\sokrat-voip-dev\server.js" "C:\Users\0xSiTe\Desktop\sokrat-voip-stable\server.js" -Force
# ... same for other files
# Then fix install.sh REPO_URL back to sokrat-voip-stable.git
```

---

## Key Users
- **admin / admin** (super admin — can access settings, time, SMTP)
- Apache proxy: `dashboard.conf` (port 80 → 8080)
- Database: `dashboard_settings` table stores SMTP config
