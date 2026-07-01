#!/bin/bash
# SPT-ANALYTICS — Automated installer for Issabel 5 / Asterisk 18
# Run as root on a fresh Issabel 5 installation.
# Usage: bash install.sh

set -euo pipefail

INSTALL_DIR=/opt/issabel-dashboard
REPO_URL=https://github.com/Ahmed-Emad02/issabel-analytics.git
NODE_SETUP_URL=https://rpm.nodesource.com/setup_22.x
MYSQL_ROOT_PWD=$(grep mysqlrootpwd /etc/issabel.conf | cut -d= -f2- | xargs)

echo "============================================"
echo " SPT-ANALYTICS Installer"
echo " Target: Issabel 5 / Asterisk 18"
echo "============================================"

# ──────────────────────────────────────────────
# Step 1 — System Packages + Disable Fail2Ban
# ──────────────────────────────────────────────
echo "[1/11] Installing system packages..."
yum install -y nano net-tools btop
systemctl disable --now fail2ban
echo "  fail2ban disabled"

# ──────────────────────────────────────────────
# Step 2 — Install Node.js 22
# ──────────────────────────────────────────────
echo "[2/11] Installing Node.js 22..."
if ! command -v node &>/dev/null; then
    curl -fsSL "$NODE_SETUP_URL" | bash -
    yum install -y nodejs
else
    echo "  Node.js already installed: $(node -v)"
fi

# ──────────────────────────────────────────────
# Step 3 — Clone the Repository
# ──────────────────────────────────────────────
echo "[3/11] Cloning repository..."
yum install -y git net-tools
if [ -d "$INSTALL_DIR" ]; then
    echo "  Directory $INSTALL_DIR exists, pulling latest..."
    cd "$INSTALL_DIR"
    git pull origin main
else
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# ──────────────────────────────────────────────
# Step 4 — Install Dependencies
# ──────────────────────────────────────────────
echo "[4/11] Installing npm dependencies..."
npm install

# ──────────────────────────────────────────────
# Step 5 — Create the Environment File
# ──────────────────────────────────────────────
echo "[5/11] Creating .env file..."
if [ -f "$INSTALL_DIR/.env" ]; then
    echo "  .env already exists, skipping"
else
    cat > "$INSTALL_DIR/.env" << EOF
PORT=3000
DB_HOST=localhost
DB_USER=root
DB_PASS=${MYSQL_ROOT_PWD}
CDR_DB=asteriskcdrdb
ASTERISK_DB=asterisk
AMI_HOST=127.0.0.1
AMI_PORT=5038
AMI_USER=admin
AMI_PASS=admin
RECORDING_ROOT=/var/spool/asterisk/monitor
EOF
    echo "  .env created"
fi

# ──────────────────────────────────────────────
# Step 6 — Initialize Database Tables
# ──────────────────────────────────────────────
echo "[6/11] Initializing database tables..."
mysql -u root -p"$MYSQL_ROOT_PWD" asterisk < "$INSTALL_DIR/backend/install_db.sql"
echo "  synq_agent_status / synq_agent_status_log tables ensured"

# ──────────────────────────────────────────────
# Step 7 — Configure Asterisk AMI
# ──────────────────────────────────────────────
echo "[7/11] Configuring Asterisk AMI..."
if grep -q '^\[admin\]' /etc/asterisk/manager.conf; then
    sed -i '/^\[admin\]/,/^\[/ s/deny=.*/permit=127.0.0.1\/255.255.255.0/' /etc/asterisk/manager.conf
    echo "  [admin] section updated with permit line"
else
    cat >> /etc/asterisk/manager.conf << 'AMIEOF'

[admin]
secret = admin
read = system,call,agent,originate
write = system,call,agent,originate
permit = 127.0.0.1/255.255.255.0

AMIEOF
    echo "  [admin] section appended"
fi
asterisk -rx "manager reload" 2>/dev/null || true
echo "  AMI reloaded"

# ──────────────────────────────────────────────
# Step 8 — Add Required Dialplan Contexts
# ──────────────────────────────────────────────
echo "[8/11] Adding dialplan contexts..."
DIALPLAN_FILE=/etc/asterisk/extensions_custom.conf

# Ensure file exists
touch "$DIALPLAN_FILE"

# Helper: append a block only if its context header is not already present
append_context() {
    local header="$1"
    local label="$2"
    if grep -qF "$header" "$DIALPLAN_FILE"; then
        echo "  $label already present, skipping"
    else
        cat >> "$DIALPLAN_FILE"
        echo "  $label appended"
    fi
}

# Append ChanSpy from-internal-custom
append_context '[from-internal-custom]' '[from-internal-custom]' << 'CHANSPY'

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

CHANSPY

# Append from-dongle-custom
append_context '[from-dongle-custom]' '[from-dongle-custom]' << 'DONGLE'

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

DONGLE

# Append macro-dialout-trunk-predial-hook
append_context '[macro-dialout-trunk-predial-hook]' '[macro-dialout-trunk-predial-hook]' << 'MACRO'

[macro-dialout-trunk-predial-hook]
exten => s,1,NoOp(--- Outbound call via Dongle ---)
same => n,Set(MY_SIM_NUMBER=${DB(DONGLE_NUMBERS/${DONGLEIMEI})})
same => n,Set(CALLERID(all)=${MY_SIM_NUMBER})
same => n,MacroExit()

MACRO

asterisk -rx "dialplan reload" 2>/dev/null || true
echo "  Dialplan reloaded"

# ──────────────────────────────────────────────
# Step 9 — GSM Dongle Setup
# ──────────────────────────────────────────────
echo ""
echo "[9/11] Setting up GSM dongles & chan_dongle..."

# 9a — Install Build Dependencies
echo "  [9a] Installing build dependencies..."
yum -y install gcc gcc-c++ make automake autoconf libtool sqlite-devel usbutils usb_modeswitch minicom
yum -y install asterisk18-devel

# 9b — Compile and Install chan_dongle
echo "  [9b] Compiling chan_dongle..."
if [ ! -f /usr/lib/asterisk/modules/chan_dongle.so ]; then
    cd /usr/src
    if [ ! -d asterisk-chan-dongle ]; then
        git clone https://github.com/wdoekes/asterisk-chan-dongle.git
    fi
    cd asterisk-chan-dongle
    git pull origin master 2>/dev/null || true
    ./bootstrap
    ./configure --with-astversion=18.19.0
    make
    make install
    echo "  chan_dongle compiled and installed"
else
    echo "  chan_dongle already installed"
fi

# 9c — Apply dongle.conf
echo "  [9c] Applying dongle.conf..."
cp "$INSTALL_DIR/dongle.conf" /etc/asterisk/dongle.conf
echo "  dongle.conf copied (10 dongles configured)"

# 8c2 — Ensure /var/log/asterisk/full captures VERBOSE messages (required for SMS/USSD parsing)
echo "  [9c2] Enabling verbose logging in Asterisk logger.conf..."
if grep -q '^full\s*=>' /etc/asterisk/logger.conf; then
    if ! grep -q 'verbose' /etc/asterisk/logger.conf; then
        sed -i 's/^\(full\s*=>.*\)/\1,verbose/' /etc/asterisk/logger.conf
        echo "  verbose added to full log channel"
    else
        echo "  verbose already in full log channel"
    fi
fi

# 9d — Permissions & udev
echo "  [9d] Configuring permissions and udev..."
usermod -a -G lock,dialout asterisk
chgrp asterisk /run/lock 2>/dev/null || true
chmod 775 /run/lock 2>/dev/null || true

cat > /etc/tmpfiles.d/legacy.conf << 'TMPFILES'
d /run/lock 0775 root asterisk -
L /var/lock - - - - ../run/lock
d /run/lock/subsys 0755 root root -
r! /forcefsck
r! /fastboot
r! /forcequotacheck
TMPFILES
echo "  tmpfiles.d configured"

cat > /etc/udev/rules.d/99-huawei-dongle.rules << 'UDEV'
ACTION=="add", SUBSYSTEM=="tty", ATTRS{idVendor}=="12d1", MODE="0666", GROUP="dialout", TAG+="systemd", ENV{SYSTEMD_WANTS}="dongle-auto-reload.service"
UDEV
echo "  udev rules created"

cat > /etc/systemd/system/dongle-auto-reload.service << 'DASRV'
[Unit]
Description=Auto reload chan_dongle after Huawei USB dongle plug
After=asterisk.service

[Service]
Type=oneshot
ExecStart=/bin/bash -c 'sleep 15; chmod 666 /dev/ttyUSB* 2>/dev/null; /usr/sbin/asterisk -rx "dongle reload" 2>/dev/null; /usr/sbin/asterisk -rx "module reload chan_dongle.so" 2>/dev/null'
DASRV
echo "  dongle-auto-reload.service created"

# 9e — Reload and restart
echo "  [9e] Reloading rules and restarting Asterisk..."
systemctl daemon-reload
udevadm control --reload-rules 2>/dev/null || true
udevadm trigger 2>/dev/null || true
systemctl restart asterisk
echo "  Asterisk restarted"

# 9f — Initialize sim_mappings.json
echo "  [9f] Initializing sim_mappings.json..."
if [ ! -f "$INSTALL_DIR/sim_mappings.json" ]; then
    echo '{}' > "$INSTALL_DIR/sim_mappings.json"
    chmod 644 "$INSTALL_DIR/sim_mappings.json"
    echo "  sim_mappings.json created"
else
    echo "  sim_mappings.json already exists"
fi

# ──────────────────────────────────────────────
# Step 10 — Create systemd Service
# ──────────────────────────────────────────────
echo "[10/11] Creating systemd service..."
cat > /etc/systemd/system/issabel-dashboard.service << 'UNIT'
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
UNIT

systemctl daemon-reload
systemctl enable --now issabel-dashboard
echo "  Service enabled and started"

# ──────────────────────────────────────────────
# Step 11 — Verify
# ──────────────────────────────────────────────
echo ""
echo "[11/11] Verifying installation..."
sleep 2
systemctl status issabel-dashboard --no-pager -l | head -12
echo ""
echo "--- Last 10 log lines ---"
journalctl -u issabel-dashboard -n 10 --no-pager -l
echo ""
echo "============================================"
echo " Installation complete!"
echo " Open http://<your-issabel-ip>:3000"
echo "============================================"
