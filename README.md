# Issabel Analytics Dashboard

Real-time PBX analytics dashboard for Issabel/Asterisk with CDR logs, employee performance metrics, and a live operator switchboard.

## Features

- **CDR Analytics** — Search/filter call detail records by date, extension, status, source, and destination. Download recorded audio.
- **Employee Metrics** — Per-extension breakdown of inbound/outbound talk time, total interactions, and unique contact footprint.
- **Live Operator Board** — Real-time extension grid showing idle/ringing/in-call states, call timers, connected partner numbers, and SIP registration status — powered by Asterisk AMI + Socket.io.
- **RTL / Arabic** — Full English and Arabic interface with RTL layout.
- **System Clock** — Digital clock in the sidebar.

## Prerequisites

- **Issabel 4+** or any Asterisk-based PBX with MySQL (CDR database) and AMI (port 5038) enabled
- **Node.js 18+** and **npm**
- AMI user credentials configured in `/etc/asterisk/manager.conf`

## Installation

```bash
# 1. Clone the repo
git clone https://github.com/Ahmed-Emad02/issabel-dashboard.git
cd issabel-dashboard

# 2. Install dependencies
npm install

# 3. Create environment config
cp .env.example .env
# Edit .env with your DB and AMI credentials (see Configuration below)

# 4. Start the server
node server.js
```

The dashboard runs on **port 3000** by default. Open `http://<server-ip>:3000` in your browser.

## Configuration

Create a `.env` file in the project root:

```env
PORT=3000
DB_HOST=localhost
DB_USER=root
DB_PASS=your_mysql_password
DB_NAME=asteriskcdrdb
AMI_PORT=5038
AMI_USER=your_ami_user
AMI_PASS=your_ami_secret
```

### AMI setup

In `/etc/asterisk/manager.conf`, ensure you have:

```ini
[your_ami_user]
secret = your_ami_secret
read = system,call,agent,originate
write = system,call,agent,originate
permit = 127.0.0.1
```

### Custom Asterisk Dialplan Setup

For the Live Operator panel's Listen (ChanSpy), Whisper (ChanSpy with whisper option), and Barge (ChanSpy with barge option) features to function correctly, you must define the call codes `222`, `223`, and `224` in `/etc/asterisk/extensions_custom.conf`:

1. Open `/etc/asterisk/extensions_custom.conf` on your Issabel server.
2. Add the following dialplan block inside the `[from-internal-custom]` context:

```asterisk
[from-internal-custom]
exten => _222X.,1,NoOp(Spying on extension ${EXTEN:3} in Listen-only mode)
exten => _222X.,n,ChanSpy(PJSIP/${EXTEN:3},q)
exten => _222X.,n,ChanSpy(SIP/${EXTEN:3},q)
exten => _222X.,n,Hangup()

exten => _223X.,1,NoOp(Spying on extension ${EXTEN:3} in Whisper mode)
exten => _223X.,n,ChanSpy(PJSIP/${EXTEN:3},qw)
exten => _223X.,n,ChanSpy(SIP/${EXTEN:3},qw)
exten => _223X.,n,Hangup()

exten => _224X.,1,NoOp(Spying on extension ${EXTEN:3} in Barge mode)
exten => _224X.,n,ChanSpy(PJSIP/${EXTEN:3},qB)
exten => _224X.,n,ChanSpy(SIP/${EXTEN:3},qB)
exten => _224X.,n,Hangup()
```

3. Reload the Asterisk dialplan configuration from your terminal:
```bash
/usr/bin/asterisk.reload
# Or directly via Asterisk CLI:
asterisk -rx "dialplan reload"
```


## Running as a service (auto-start)

### Option 1: systemd (Linux — recommended)

Create `/etc/systemd/system/issabel-dashboard.service`:

```ini
[Unit]
Description=Issabel Analytics Dashboard
After=network.target mysql.service asterisk.service

[Service]
WorkingDirectory=/path/to/issabel-dashboard
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now issabel-dashboard
```

### Option 2: pm2 (process manager)

```bash
npm install -g pm2
pm2 start server.js --name issabel-dashboard
pm2 save
pm2 startup   # follow the instructions
```

## Routes

| Route | View | Description |
|---|---|---|
| `/` | — | Redirects to `/cdr` |
| `/cdr` | `cdr.ejs` | CDR logs with date/extension/status/src/dst filters, audio download |
| `/employees` | `employees.ejs` | Employee performance metrics with inbound/outbound split |
| `/operator` | `operator.ejs` | Live real-time switchboard (WebSocket) |
| `/download-audio?uniqueid=xxx` | — | Download recorded `.wav` file by `uniqueid` |

Append `?lang=ar` or `?lang=en` to any route for language switching.

## Project structure

```
issabel-dashboard/
├── server.js              # Express app, AMI handler, Socket.io, routes
├── views/
│   ├── sidebar.ejs        # Shared nav + digital clock
│   ├── cdr.ejs            # CDR logs view
│   ├── employees.ejs      # Employee metrics view
│   ├── operator.ejs       # Live operator switchboard
│   └── dashboard.ejs      # KPI dashboard (needs dedicated route)
├── .env                   # Credentials (gitignored)
├── .gitignore
├── package.json
└── README.md
```

## Tech stack

- **Backend:** Node.js, Express 4, Socket.io 4, mysql2
- **Frontend:** EJS, Tailwind CSS v4 (CDN), Cairo font
- **Real-time:** Asterisk AMI (raw TCP), Socket.io WebSocket
- **Database:** MySQL (Issabel CDR — `asteriskcdrdb`)

## Notes

- The operator panel only monitors internal extensions (CallerIDNum ≤ 5 digits) to skip trunk calls.
- If all SIP peers show as offline via AMI `PeerStatus` events, the dashboard falls back to querying `sipfriends`/`sippeers` tables for peers with non-empty `ipaddr`.
- Recorded audio files are loaded from `/var/spool/asterisk/monitor/YYYY/MM/DD/`.
- The `dashboard.ejs` view exists but is not wired to a route yet.
