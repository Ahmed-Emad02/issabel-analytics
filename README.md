# SPT-ANALYTICS

Real-time PBX analytics dashboard for **Issabel 5 / Asterisk 18** with CDR logs, extension performance metrics, a live operator switchboard, and call recording playback.

## Quick Install

Run as root on a fresh Issabel 5 server:

```bash
curl -fsSL https://raw.githubusercontent.com/Ahmed-Emad02/issabel-analytics/main/install.sh | bash
```

## Features

- **Executive Dashboard** — KPI cards, inbound/outbound pie chart, date-range filtering
- **CDR Analytics** — Search call detail records by date, extension, status, source, destination. Custom audio player with seekable slider, playback speed control, and download
- **Extension Statistics** — Per-extension breakdown with disposition pie charts and daily call volume bar graphs. Console overview with sortable metrics for all extensions
- **Live Operator Board** — Real-time extension grid showing idle/ringing/in-call states, call timers, connected partner numbers, and SIP registration. Listen, Whisper, and Barge actions via ChanSpy
- **Light / Dark Mode** — Toggle between themes. Persists across sessions via localStorage
- **RTL / Arabic** — Full English and Arabic interface with automatic RTL layout
- **Custom Audio Player** — Themed play/pause, seekable progress bar, current time / duration display, 0.5×–2× speed selector, download button — replaces native browser audio controls

---

## Fresh Issabel 5 Installation (Copy-Paste)

> Run all commands as **root** on your Issabel 5 server.

### Step 1 — System Packages

```bash
yum install -y nano net-tools btop
systemctl disable --now fail2ban
```

### Step 2 — Install Node.js 22

```bash
curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
yum install -y nodejs
node -v
```

### Step 3 — Clone the Repository

```bash
yum install -y git net-tools
cd /opt
git clone https://github.com/Ahmed-Emad02/issabel-analytics.git issabel-dashboard
cd /opt/issabel-dashboard
```

### Step 4 — Install Dependencies

```bash
npm install
```

### Step 5 — Create the Environment File

This command automatically reads your MySQL root password from Issabel's config and creates the `.env` file — no manual editing needed:

```bash
MYSQL_PWD=$(grep mysqlrootpwd /etc/issabel.conf | cut -d= -f2- | xargs)
cat > /opt/issabel-dashboard/.env << EOF
PORT=3000
DB_HOST=localhost
DB_USER=root
DB_PASS=${MYSQL_PWD}
CDR_DB=asteriskcdrdb
ASTERISK_DB=asterisk
AMI_HOST=127.0.0.1
AMI_PORT=5038
AMI_USER=admin
AMI_PASS=admin
RECORDING_ROOT=/var/spool/asterisk/monitor
EOF
```

### Step 6 — Initialize Database Tables

Create the agent status tracking tables:

```bash
mysql -u root -p$(grep mysqlrootpwd /etc/issabel.conf | cut -d= -f2- | xargs) asterisk < /opt/issabel-dashboard/backend/install_db.sql
```

### Step 7 — Configure Asterisk AMI

Check if an AMI user already exists:

```bash
cat /etc/asterisk/manager.conf
```

If you see an `[admin]` section, ensure it has a `permit` line for localhost:

```bash
# Add permit line if missing (replaces any existing deny line)
sed -i '/^\[admin\]/,/^\[/ s/deny=.*/permit=127.0.0.1\/255.255.255.0/' /etc/asterisk/manager.conf
```

If the `[admin]` section does not exist at all, append it:

```bash
cat >> /etc/asterisk/manager.conf << 'EOF'

[admin]
secret = admin
read = system,call,agent,originate
write = system,call,agent,originate
permit = 127.0.0.1/255.255.255.0

EOF
```

Reload the AMI configuration:

```bash
asterisk -rx "manager reload"
```

### Step 8 — Add Required Dialplan Contexts

#### ChanSpy Dialplan (Listen / Whisper / Barge)

This enables the operator panel's call monitoring actions (codes `222`, `223`, `224`):

```bash
cat >> /etc/asterisk/extensions_custom.conf << 'DIALPLAN'

[from-internal-custom]
exten => _222X.,1,NoOp(Spying on extension ${EXTEN:3} in Listen-only mode)
exten => _222X.,n,Answer()
exten => _222X.,n,Set(spyee_dial=${DB(DEVICE/${EXTEN:3}/dial)})
exten => _222X.,n,GotoIf($["${spyee_dial}" = ""]?fallback)
exten => _222X.,n,ChanSpy(${spyee_dial},q)
exten => _222X.,n,Hangup()
exten => _222X.,n(fallback),ChanSpy(PJSIP/${EXTEN:3},q)
exten => _222X.,n,ChanSpy(SIP/${EXTEN:3},q)
exten => _222X.,n,Hangup()

exten => _223X.,1,NoOp(Spying on extension ${EXTEN:3} in Whisper mode)
exten => _223X.,n,Answer()
exten => _223X.,n,Set(spyee_dial=${DB(DEVICE/${EXTEN:3}/dial)})
exten => _223X.,n,GotoIf($["${spyee_dial}" = ""]?fallback)
exten => _223X.,n,ChanSpy(${spyee_dial},qw)
exten => _223X.,n,Hangup()
exten => _223X.,n(fallback),ChanSpy(PJSIP/${EXTEN:3},qw)
exten => _223X.,n,ChanSpy(SIP/${EXTEN:3},qw)
exten => _223X.,n,Hangup()

exten => _224X.,1,NoOp(Spying on extension ${EXTEN:3} in Barge mode)
exten => _224X.,n,Answer()
exten => _224X.,n,Set(spyee_dial=${DB(DEVICE/${EXTEN:3}/dial)})
exten => _224X.,n,GotoIf($["${spyee_dial}" = ""]?fallback)
exten => _224X.,n,ChanSpy(${spyee_dial},qB)
exten => _224X.,n,Hangup()
exten => _224X.,n(fallback),ChanSpy(PJSIP/${EXTEN:3},qB)
exten => _224X.,n,ChanSpy(SIP/${EXTEN:3},qB)
exten => _224X.,n,Hangup()

DIALPLAN
```

> **Important:** If `[from-internal-custom]` already exists in the file, do NOT add a duplicate header. Paste only the `exten =>` lines inside the existing context block.

#### GSM Dongle Context (SMS / USSD / Caller ID)

This handles incoming SMS logging, USSD responses, and sets the correct caller ID on dongle calls:

```bash
cat >> /etc/asterisk/extensions_custom.conf << 'DIALPLAN'

[from-dongle-custom]
exten => sms,1,NoOp(--- Incoming SMS on ${DONGLENAME} ---)
same => n,Verbose(1, [SMS-RECEIVE] Dongle: ${DONGLENAME}, Sender: ${CALLERID(num)}, Content: ${SMS})
same => n,Hangup()

exten => ussd,1,NoOp(--- Incoming USSD on ${DONGLENAME} ---)
same => n,NoOp(USSD Session Type: ${USSD_TYPE})
same => n,NoOp(USSD Content: ${USSD})
same => n,Hangup()

exten => s,1,NoOp(--- Incoming call from Dongle ---)
same => n,Set(MY_SIM_NUMBER=${DB(DONGLE_NUMBERS/${DONGLEIMEI})})
same => n,NoOp(This call arrived on SIM number: ${MY_SIM_NUMBER})
same => n,Set(CALLERID(dnid)=${MY_SIM_NUMBER})
same => n,Goto(from-trunk,${MY_SIM_NUMBER},1)

[macro-dialout-trunk-predial-hook]
exten => s,1,NoOp(--- Outbound call via Dongle ---)
same => n,Set(MY_SIM_NUMBER=${DB(DONGLE_NUMBERS/${DONGLEIMEI})})
same => n,Set(CALLERID(all)=${MY_SIM_NUMBER})
same => n,MacroExit()

DIALPLAN
```

Reload the dialplan:

```bash
asterisk -rx "dialplan reload"
```

Verify it loaded:

```bash
asterisk -rx "dialplan show from-internal-custom" | head -20
asterisk -rx "dialplan show from-dongle-custom" | head -10
```

### Step 9 — GSM Dongle Setup

Install build dependencies and compile `chan_dongle` for Huawei GSM modem support:

```bash
yum -y install gcc gcc-c++ make automake autoconf libtool sqlite-devel usbutils usb_modeswitch minicom
yum -y install asterisk18-devel

cd /usr/src
git clone https://github.com/wdoekes/asterisk-chan-dongle.git
cd asterisk-chan-dongle
./bootstrap
./configure --with-astversion=18.19.0
make
make install
```

Copy the pre-configured 10-slot layout:

```bash
cp /opt/issabel-dashboard/dongle.conf /etc/asterisk/dongle.conf
```

Enable verbose logging in Asterisk's `full` log (required for SMS/USSD parsing):

```bash
sed -i 's/^\(full\s*=>.*\)/\1,verbose/' /etc/asterisk/logger.conf
```

Grant Asterisk serial port and lock file access:

```bash
usermod -a -G lock,dialout asterisk
chgrp asterisk /run/lock
chmod 775 /run/lock
```

Persist lock permissions across reboots:

```bash
cat > /etc/tmpfiles.d/legacy.conf << 'EOF'
d /run/lock 0775 root asterisk -
L /var/lock - - - - ../run/lock
d /run/lock/subsys 0755 root root -
r! /forcefsck
r! /fastboot
r! /forcequotacheck
EOF
```

Create udev rules for automatic reload upon USB replug:

```bash
cat > /etc/udev/rules.d/99-huawei-dongle.rules << 'EOF'
ACTION=="add", SUBSYSTEM=="tty", ATTRS{idVendor}=="12d1", MODE="0666", GROUP="dialout", TAG+="systemd", ENV{SYSTEMD_WANTS}="dongle-auto-reload.service"
EOF
```

Create the auto-reload systemd service:

```bash
cat > /etc/systemd/system/dongle-auto-reload.service << 'EOF'
[Unit]
Description=Auto reload chan_dongle after Huawei USB dongle plug
After=asterisk.service

[Service]
Type=oneshot
ExecStart=/bin/bash -c 'sleep 15; chmod 666 /dev/ttyUSB* 2>/dev/null; /usr/sbin/asterisk -rx "dongle reload" 2>/dev/null; /usr/sbin/asterisk -rx "module reload chan_dongle.so" 2>/dev/null'
EOF
```

Reload rules and restart Asterisk:

```bash
systemctl daemon-reload
udevadm control --reload-rules
udevadm trigger
systemctl restart asterisk
```

Initialize the SIM number mapping file:

```bash
echo '{}' > /opt/issabel-dashboard/sim_mappings.json
chmod 644 /opt/issabel-dashboard/sim_mappings.json
```

The dongle ttyUSB mapping used (`dongle0`–`dongle9`):

| Dongle | Audio | Data  | Dongle | Audio | Data  |
|--------|-------|-------|--------|-------|-------|
| dongle0 | ttyUSB1 | ttyUSB2 | dongle5 | ttyUSB16 | ttyUSB17 |
| dongle1 | ttyUSB4 | ttyUSB5 | dongle6 | ttyUSB19 | ttyUSB20 |
| dongle2 | ttyUSB7 | ttyUSB8 | dongle7 | ttyUSB22 | ttyUSB23 |
| dongle3 | ttyUSB10 | ttyUSB11 | dongle8 | ttyUSB25 | ttyUSB26 |
| dongle4 | ttyUSB13 | ttyUSB14 | dongle9 | ttyUSB28 | ttyUSB29 |

> **USB port numbering rules:** Each dongle uses 3 ttyUSB ports (audio, data, and one unused). With 10 dongles you need 30 consecutive ttyUSB ports starting at ttyUSB1. If your physical USB hub maps differently, update `dongle.conf` accordingly.

Then use the **GSM Dongles** page in the dashboard to manually enter each SIM's phone number. The dashboard will save the mapping to `sim_mappings.json` and attempt to write it to the SIM via AT commands.

### Step 10 — Create systemd Service

```bash
cat > /etc/systemd/system/issabel-dashboard.service << 'EOF'
[Unit]
Description=SPT-ANALYTICS Dashboard
After=network.target mysqld.service asterisk.service

[Service]
Type=simple
WorkingDirectory=/opt/issabel-dashboard
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
User=root
Environment=NODE_ENV=production
Environment=LANG=en_US.UTF-8
Environment=LC_ALL=en_US.UTF-8

[Install]
WantedBy=multi-user.target
EOF
```

Enable and start:

```bash
systemctl daemon-reload
systemctl enable --now issabel-dashboard
```

### Step 11 — Verify

Check the service is running:

```bash
systemctl status issabel-dashboard
```

Tail the live logs to confirm everything initialized:

```bash
journalctl -u issabel-dashboard -n 30 --no-pager -l
```

You should see lines like:
```
GSM MONITOR: Starting tail process on /var/log/asterisk/full...
Real-Time Enterprise Engine active on port 3000
AMI: Connection opened, login sent
AMI: Login detected
```

Open in your browser:

```
http://<your-issabel-ip>:3000
```

## Configuration Reference

All settings live in `/opt/issabel-dashboard/.env`:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port for the dashboard |
| `DB_HOST` | `localhost` | MySQL host |
| `DB_USER` | `root` | MySQL username |
| `DB_PASS` | — | MySQL password (auto-read from `/etc/issabel.conf`) |
| `CDR_DB` | `asteriskcdrdb` | CDR database name |
| `ASTERISK_DB` | `asterisk` | Asterisk config database name |
| `AMI_HOST` | `127.0.0.1` | Asterisk Manager Interface host |
| `AMI_PORT` | `5038` | AMI port |
| `AMI_USER` | `admin` | AMI username |
| `AMI_PASS` | `admin` | AMI secret |
| `RECORDING_ROOT` | `/var/spool/asterisk/monitor` | Path to call recordings |

---

## Routes

| Route | Description |
|---|---|
| `/` | Executive dashboard with KPI cards and call direction chart |
| `/cdr` | CDR logs with filters and custom audio player |
| `/ext-stats` | Extension statistics with overview grid and per-extension charts |
| `/operator` | Live operator switchboard with Listen/Whisper/Barge actions |
| `/gsm-dongles` | GSM dongle monitor, SIM number management, and USSD console |

Append `?lang=ar` or `?lang=en` to any route for language switching.

---

## Project Structure

```
issabel-dashboard/
├── server.js              # Express app, MySQL queries, AMI handler, Socket.io, all routes
├── dongle.conf            # Sample 10-dongle chan_dongle configuration
├── package.json
├── backend/
│   ├── install_db.sql     # Agent status tracking tables
│   └── synq_status.php    # Agent status PHP endpoint for SynQ
├── scripts/
│   └── auto-number-dongle.sh  # Auto-provision SIM numbers via USSD
├── views/
│   ├── sidebar.ejs        # Shared top navigation bar, theme toggle, clock
│   ├── dashboard.ejs      # Executive KPI dashboard
│   ├── cdr.ejs            # CDR logs with custom audio player
│   ├── ext-stats.ejs      # Extension statistics with charts
│   ├── gsm-dongles.ejs    # GSM dongle monitor & USSD console
│   └── operator.ejs       # Live operator switchboard
├── public/
│   ├── logo.png           # Light mode logo
│   ├── logo_dark.png      # Dark mode logo
│   └── favicon.png        # Browser tab icon
├── .env                   # Credentials (gitignored)
├── .gitignore
└── README.md
```

## Tech Stack

- **Backend:** Node.js 22, Express 4, Socket.io 4, mysql2
- **Frontend:** EJS, Tailwind CSS v4 (CDN), ECharts 5, Roboto / IBM Plex Sans Arabic fonts
- **Real-time:** Asterisk AMI (raw TCP), Socket.io WebSocket
- **Database:** MySQL (Issabel CDR — `asteriskcdrdb`)

---

## Troubleshooting

### "The number you have dialed is not in service"

The ChanSpy dialplan was not loaded. Run:

```bash
# Check for Windows line endings (common if edited on Windows)
sed -i 's/\r//' /etc/asterisk/extensions_custom.conf
asterisk -rx "dialplan reload"
```

### No audio on Listen/Whisper/Barge

Ensure the `[from-internal-custom]` context uses the correct channel technology lookup. The dialplan above tries `DB(DEVICE/ext/dial)` first, then falls back to `PJSIP/ext` and `SIP/ext`.

### Dashboard shows 0 calls / empty roster

Check your MySQL credentials in `.env` match the Issabel root password:

```bash
mysql -u root -p -e "SELECT COUNT(*) FROM asteriskcdrdb.cdr;"
```

### All extensions show offline

AMI needs the correct permissions. Verify:

```bash
asterisk -rx "manager show user admin"
```

Ensure `read` includes `system,call`.

---

## Updating

```bash
cd /opt/issabel-dashboard
git pull origin main
systemctl restart issabel-dashboard
```
