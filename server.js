const express = require('express');
const mysql = require('mysql2/promise');
const moment = require('moment');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const { Server } = require('socket.io');
const { exec, execFile } = require('child_process');
const session = require('express-session');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const crypto = require('crypto');

require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'issabel-dashboard-encryption-key-32c'; // Must be 32 bytes
const key = crypto.createHash('sha256').update(String(ENCRYPTION_KEY)).digest();

function encrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
    try {
        const parts = text.split(':');
        const iv = Buffer.from(parts.shift(), 'hex');
        const encryptedText = Buffer.from(parts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (err) {
        console.error('Decryption failed:', err.message);
        return null;
    }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);
ffmpeg.setFfmpegPath('/usr/local/bin/ffmpeg');
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'issabel-dashboard-secret-change-me';

const ROOT_USER = 'root';
const ROOT_PASS = 'Admin@123';
let rootHash = null;

function safeIdentifier(name, value) {
    if (!/^[A-Za-z0-9_]+$/.test(value)) {
        throw new Error(`${name} must contain only letters, numbers, and underscores`);
    }
    return value;
}

const ASTERISK_DB = safeIdentifier('ASTERISK_DB', process.env.ASTERISK_DB || 'asterisk');
const CDR_DB = safeIdentifier('CDR_DB', process.env.CDR_DB || process.env.DB_NAME || 'asteriskcdrdb');
const ASTERISK_BIN = process.env.ASTERISK_BIN || '/usr/sbin/asterisk';
const RECORDING_ROOT = process.env.RECORDING_ROOT || '/var/spool/asterisk/monitor';
const AMI_HOST = process.env.AMI_HOST || '127.0.0.1';

function tableName(dbName, table) {
    return `\`${dbName}\`.\`${table}\``;
}

const tables = {
    cdr: tableName(CDR_DB, 'cdr'),
    users: tableName(ASTERISK_DB, 'users'),
    sip: tableName(ASTERISK_DB, 'sip'),
    sipfriends: tableName(ASTERISK_DB, 'sipfriends'),
    sippeers: tableName(ASTERISK_DB, 'sippeers'),
    psEndpoints: tableName(ASTERISK_DB, 'ps_endpoints')
};

function isInternalChannel(channel) {
    const value = String(channel || '').toUpperCase();
    return value.startsWith('SIP/') || value.startsWith('PJSIP/') || value.startsWith('IAX2/');
}

function isOutboundCdr(row) {
    return isInternalChannel(row.channel) && !isInternalChannel(row.dstchannel);
}

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- SESSION CONFIGURATION ---
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// --- DATABASE INIT & AUTO-PROVISION ---
const ALL_TABS = [
    'dashboard', 'cdr', 'voicemails', 'ext-stats', 'operator', 'gsm-dongles', 'contacts', 'users', 'config',
    'config-extensions', 'config-ringgroups', 'config-recordings', 'config-trunks', 'config-inbound', 'config-outbound'
];

async function initAuthDb() {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'admin',
        password: process.env.DB_PASS || 'admin',
        database: ASTERISK_DB
    });
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS dashboard_users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(100) NOT NULL UNIQUE,
            email VARCHAR(255) DEFAULT NULL,
            password_hash VARCHAR(255) NOT NULL,
            reset_token VARCHAR(255) DEFAULT NULL,
            reset_expires DATETIME DEFAULT NULL,
            group_id INT DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Add group_id column if it doesn't exist (for existing installs)
    try { await conn.execute('ALTER TABLE dashboard_users ADD COLUMN group_id INT DEFAULT NULL'); } catch (_) {}
    try { await conn.execute('ALTER TABLE dashboard_users ADD COLUMN reset_token_expires DATETIME DEFAULT NULL'); } catch (_) {}
    try { await conn.execute('ALTER TABLE dashboard_users ADD UNIQUE KEY idx_unique_email (email)'); } catch (_) {}
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS dashboard_settings (
            setting_key VARCHAR(100) PRIMARY KEY,
            setting_value TEXT DEFAULT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS dashboard_groups (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(100) NOT NULL UNIQUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.execute(`
        CREATE TABLE IF NOT EXISTS dashboard_group_permissions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            group_id INT NOT NULL,
            tab VARCHAR(50) NOT NULL,
            UNIQUE KEY idx_group_tab (group_id, tab)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Ensure "super admins" group exists
    const [existingGroups] = await conn.execute('SELECT id FROM dashboard_groups WHERE name = ?', ['super admins']);
    let superAdminGroupId;
    if (existingGroups.length === 0) {
        const [r] = await conn.execute('INSERT INTO dashboard_groups (name) VALUES (?)', ['super admins']);
        superAdminGroupId = r.insertId;
        for (const tab of ALL_TABS) {
            await conn.execute('INSERT INTO dashboard_group_permissions (group_id, tab) VALUES (?, ?)', [superAdminGroupId, tab]);
        }
        console.log('AUTH: Created "super admins" group with all permissions');
    } else {
        superAdminGroupId = existingGroups[0].id;
    }

    // Auto-provision default admin user
    rootHash = await bcrypt.hash(ROOT_PASS, 10);
    const [rows] = await conn.execute('SELECT COUNT(*) AS cnt FROM dashboard_users');
    if (rows[0].cnt === 0) {
        const hash = await bcrypt.hash('admin', 10);
        await conn.execute('INSERT INTO dashboard_users (username, password_hash, group_id) VALUES (?, ?, ?)', ['admin', hash, superAdminGroupId]);
        console.log('AUTH: Default admin user provisioned (admin / admin) in super admins group');
    } else {
        // Assign existing users without a group to the super admins group
        const [orphans] = await conn.execute('SELECT COUNT(*) AS cnt FROM dashboard_users WHERE group_id IS NULL');
        if (orphans[0].cnt > 0) {
            await conn.execute('UPDATE dashboard_users SET group_id = ? WHERE group_id IS NULL', [superAdminGroupId]);
            console.log('AUTH: Assigned ' + orphans[0].cnt + ' existing user(s) to super admins group');
        }
        console.log('AUTH: Dashboard users table ready, existing users found');
    }
    await conn.end();
}
initAuthDb().catch(err => console.error('AUTH DB init error:', err));

// --- SESSION HELPERS ---
function isSuperAdmin(req) {
    return req.session && req.session.userGroup === 'super admins';
}

async function getUserPermissions(userId) {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'admin',
        password: process.env.DB_PASS || 'admin',
        database: ASTERISK_DB
    });
    const [rows] = await conn.execute(`
        SELECT p.tab FROM dashboard_group_permissions p
        JOIN dashboard_users u ON u.group_id = p.group_id
        WHERE u.id = ?
    `, [userId]);
    await conn.end();
    return rows.map(r => r.tab);
}

const TAB_ROUTE_MAP = {
    '/': 'dashboard',
    '/cdr': 'cdr',
    '/voicemails': 'voicemails',
    '/ext-stats': 'ext-stats',
    '/operator': 'operator',
    '/gsm-dongles': 'gsm-dongles',
    '/contacts': 'contacts',
    '/users': 'users',
    '/config': 'config'
};

// --- AUTH MIDDLEWARE ---
function requireAuth(req, res, next) {
    if (req.session && req.session.userId) {
        res.locals.currentUser = req.session.username;
        return next();
    }
    const loginUrl = '/login' + (req.originalUrl !== '/' ? '?redirect=' + encodeURIComponent(req.originalUrl) : '');
    res.redirect(loginUrl);
}

function requireConfigPermission(subTab) {
    return (req, res, next) => {
        if (isSuperAdmin(req)) return next();
        const perms = req.session.userPermissions || [];
        if (perms.includes('config') || perms.includes('config-' + subTab)) {
            return next();
        }
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    };
}

// --- PROTECT ALL OPERATIONAL ROUTES ---
app.use((req, res, next) => {
    const publicPaths = [
        '/login', '/logout', '/forgot-password', '/reset-password',
        '/api/auth/forgot-password', '/api/auth/reset-password', '/api/network-info'
    ];
    if (publicPaths.includes(req.path) || req.path.startsWith('/public/')) {
        return next();
    }
    requireAuth(req, res, next);
});

// --- TAB PERMISSION MIDDLEWARE ---
app.use(async (req, res, next) => {
    res.locals.isSuperAdmin = isSuperAdmin(req);
    const tab = TAB_ROUTE_MAP[req.path];
    if (!tab) return next();
    // Load permissions if not cached
    if (!res.locals.isSuperAdmin && !req.session.userPermissions) {
        try {
            req.session.userPermissions = await getUserPermissions(req.session.userId);
        } catch (_) {
            req.session.userPermissions = [];
        }
    }
    // Dashboard and Contacts are accessible to everyone
    if (tab === 'dashboard' || tab === 'contacts') {
        res.locals.allowedTabs = res.locals.isSuperAdmin ? ALL_TABS : req.session.userPermissions;
        return next();
    }
    // Users tab is super admin only
    if (tab === 'users') {
        if (!res.locals.isSuperAdmin) return res.redirect('/');
        res.locals.allowedTabs = ALL_TABS;
        return next();
    }
    if (res.locals.isSuperAdmin) {
        res.locals.allowedTabs = ALL_TABS;
        return next();
    }
    res.locals.allowedTabs = req.session.userPermissions;
    if (req.session.userPermissions.includes(tab)) return next();
    if (tab === 'config' && req.session.userPermissions.some(p => p.startsWith('config-'))) {
        return next();
    }
    // Denied — redirect to the first tab they *can* access, or /login
    const tabToRoute = { dashboard: '/', cdr: '/cdr', voicemails: '/voicemails', 'ext-stats': '/ext-stats', operator: '/operator', 'gsm-dongles': '/gsm-dongles', contacts: '/contacts', users: '/users', config: '/config' };
    const firstAllowed = req.session.userPermissions.find(p => tabToRoute[p] || (p.startsWith('config-') && tabToRoute['config']));
    res.redirect(firstAllowed ? (tabToRoute[firstAllowed] || '/config') : '/login');
});

// --- CONFIG SUB-TAB API PERMISSIONS MIDDLEWARE ---
app.use('/api/config', (req, res, next) => {
    if (isSuperAdmin(req)) return next();
    
    let subTab = null;
    if (req.path.startsWith('/extensions')) {
        subTab = 'extensions';
    } else if (req.path.startsWith('/ringgroups')) {
        subTab = 'ringgroups';
    } else if (req.path.startsWith('/recordings')) {
        subTab = 'recordings';
    } else if (req.path.startsWith('/trunks')) {
        subTab = 'trunks';
    } else if (req.path.startsWith('/routes/inbound')) {
        subTab = 'inbound';
    } else if (req.path.startsWith('/routes/outbound')) {
        subTab = 'outbound';
    } else if (req.path === '/reload') {
        const perms = req.session.userPermissions || [];
        const hasAnyConfig = perms.includes('config') || perms.some(p => p.startsWith('config-'));
        if (hasAnyConfig) return next();
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    
    if (!subTab) return next();

    const perms = req.session.userPermissions || [];
    if (perms.includes('config') || perms.includes('config-' + subTab)) {
        return next();
    }
    
    return res.status(403).json({ success: false, error: 'Unauthorized: Permission denied for ' + subTab });
});

app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/gsm-dongles') {
        console.log(`HTTP [${new Date().toISOString()}] ${req.method} ${req.url} - Body: ${JSON.stringify(req.body)}`);
    }
    next();
});

// --- DATABASE CONNECTION POOL SETUP ---
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'admin',
    password: process.env.DB_PASS || 'admin',
    database: CDR_DB,
    waitForConnections: true,
    connectionLimit: 10
});

let activeCalls = {};
let peerStatus = {};
let peerIPs = {};
let pendingOffline = {};
let isPeerListLoaded = false;
let greetingConfig = { mode: 'none', extensions: [] };
const VM_GREETING_CONFIG_PATH = path.join(__dirname, 'vm_greeting_config.json');
function reloadGreetingConfig() {
    try {
        if (fs.existsSync(VM_GREETING_CONFIG_PATH)) {
            greetingConfig = JSON.parse(fs.readFileSync(VM_GREETING_CONFIG_PATH, 'utf8'));
        }
    } catch {}
}
let amiClient = null;

// --- AUTO-DETECT DONGLE IMEI/SIM & CONFIGURE TRUNKS ---
async function detectDonglesAndSetTrunkCID() {
    try {
        const { execFile: execFileCb } = require('child_process');
        const execFileAsync = (cmd, args) => new Promise((resolve) => {
            execFileCb(cmd, args, (err, stdout) => resolve(err ? '' : stdout || ''));
        });

        const devicesOutput = await execFileAsync(ASTERISK_BIN, ['-rx', 'dongle show devices']);
        if (!devicesOutput) return;

        const lines = devicesOutput.split('\n').filter(l => l.trim() && !l.startsWith('ID'));
        const dongleInfo = {};

        for (const line of lines) {
            const parts = line.trim().split(/\s{2,}/);
            if (parts.length < 10) continue;
            const name = parts[0];
            const imei = parts[9] || '';
            const number = parts[parts.length - 1] || '';
            if (imei && imei !== 'Unknown' && /^\d{15}$/.test(imei)) {
                dongleInfo[name] = { imei, number: (number && number !== 'Unknown' && number.startsWith('+')) ? number : null };
            }
        }

        if (!Object.keys(dongleInfo).length) {
            console.log('DONGLE-CID: No dongles with valid IMEI detected');
            return;
        }

        console.log('DONGLE-CID: Detected dongles:', dongleInfo);

        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });

        const [trunks] = await conn.execute('SELECT trunkid, channelid FROM trunks WHERE tech = ?', ['custom']);
        for (const trunk of trunks) {
            for (const [dongleName, info] of Object.entries(dongleInfo)) {
                if (trunk.channelid && trunk.channelid.includes(dongleName)) {
                    const newChannelId = `dongle/I:${info.imei}/$OUTNUM$`;
                    if (trunk.channelid !== newChannelId) {
                        await conn.execute('UPDATE trunks SET channelid = ? WHERE trunkid = ?', [newChannelId, trunk.trunkid]);
                        console.log(`DONGLE-CID: Updated trunk ${trunk.trunkid} channel to IMEI-based: ${newChannelId}`);
                    }
                    if (info.number) {
                        await execFileAsync(ASTERISK_BIN, ['-rx', `database put TRUNK ${trunk.trunkid} outcid ${info.number}`]);
                        console.log(`DONGLE-CID: Set trunk ${trunk.trunkid} (${dongleName}) caller ID to ${info.number}`);
                    }
                }
            }
        }

        await conn.end();

        const { execFile: rcExec } = require('child_process');
        rcExec('/var/lib/asterisk/bin/retrieve_conf', [], (err) => {
            if (!err) console.log('DONGLE-CID: retrieve_conf completed');
        });
    } catch (e) {
        console.error('DONGLE-CID: Detection error:', e.message);
    }
}

// --- ASTERISK AMI REAL-TIME MONITORING ---
function connectAMI() {
    activeCalls = {};
    peerStatus = {};
    pendingOffline = {};
    let loggedIn = false;
    let queriedPeers = false;
    const client = net.connect({ port: process.env.AMI_PORT || 5038, host: AMI_HOST }, () => {
        client.write(`Action: Login\r\nUsername: ${process.env.AMI_USER || 'admin'}\r\nSecret: ${process.env.AMI_PASS || 'admin'}\r\n\r\n`);
        console.log('AMI: Connection opened, login sent');
    });
    amiClient = client;

    // Fallback: if login detection fails, try SIPpeers and PJSIPShowEndpoints anyway after 3s
    setTimeout(() => {
        if (!queriedPeers) {
            console.log('AMI: Login not detected within 3s, sending SIPpeers and PJSIPShowEndpoints anyway');
            queriedPeers = true;
            client.write(`Action: SIPpeers\r\n\r\n`);
            client.write(`Action: PJSIPShowEndpoints\r\n\r\n`);
        }
    }, 3000);

    function queryPeerStatus() {
        if (queriedPeers) return;
        queriedPeers = true;
        console.log('AMI: Sending SIPpeers and PJSIPShowEndpoints');
        client.write(`Action: SIPpeers\r\n\r\n`);
        client.write(`Action: PJSIPShowEndpoints\r\n\r\n`);
    }

    let buffer = '';
    client.on('data', (data) => {
        buffer += data.toString();
        let packets = buffer.split('\r\n\r\n');
        buffer = packets.pop();

        packets.forEach(packet => {
            const lines = packet.split('\r\n');
            let event = {};
            lines.forEach(line => {
                const parts = line.split(': ');
                if (parts[0] && parts[1]) event[parts[0].trim()] = parts[1].trim();
            });

            // Detect successful login from Response or FullyBooted event
            if (!loggedIn) {
                if (event.Response === 'Success' || event.Event === 'FullyBooted') {
                    console.log('AMI: Login detected');
                    loggedIn = true;
                    queryPeerStatus();
                    detectDonglesAndSetTrunkCID();
                }
            }

            // Parse SIPpeers peer list entries
            if (event.Event === 'PeerEntry') {
                let name = event.ObjectName || '';
                let status = event.Status || '';
                if (name) {
                    peerStatus[name] = status.toUpperCase().startsWith('OK');
                    // Extract IP from IPaddress field
                    let ip = event.IPaddress || '';
                    if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
                        peerIPs[name] = ip;
                        io.emit('peerIPs', peerIPs);
                    }
                }
            }

            // Parse PJSIPShowEndpoints endpoint entries
            if (event.Event === 'EndpointList') {
                let name = event.ObjectName || '';
                if (name) {
                    let state = String(event.DeviceState || '').toLowerCase();
                    if (state === 'unavailable' || state === 'invalid' || state === 'unknown' || state === '5' || state === '4') {
                        peerStatus[name] = false;
                    } else {
                        peerStatus[name] = true;
                    }
                }
            }

            // Parse PJSIP ContactStatus events for IP info
            if (event.Event === 'ContactStatus') {
                let uri = event.URI || '';
                let aor = event.AOR || '';
                // Extract endpoint name from AOR (format: "endpoint/aor" or just "aor")
                let name = aor.split('/')[0] || '';
                if (name && uri) {
                    // Extract IP from contact URI (format: sip:user@IP:port;params)
                    let match = uri.match(/@(\d+\.\d+\.\d+\.\d+)/);
                    if (match) {
                        peerIPs[name] = match[1];
                        io.emit('peerIPs', peerIPs);
                    }
                }
            }

            // Emit peerStatus once initial list queries complete
            if (event.Event === 'PeerlistComplete' || event.Event === 'EndpointListComplete') {
                console.log('AMI: Peer list complete, peers:', Object.keys(peerStatus));
                isPeerListLoaded = true;
                io.emit('peerStatus', peerStatus);
                io.emit('peerIPs', peerIPs);
            }

            // Real-time peer registration changes
            if (event.Event === 'PeerStatus') {
                let name = event.Peer ? event.Peer.replace(/^(SIP|PJSIP)\//, '') : '';
                if (name) {
                    let isOnline = event.PeerStatus === 'Registered' || event.PeerStatus === 'Reachable';
                    
                    // Debounce offline transitions to smooth out SIP registration refresh flicker
                    if (peerStatus[name] && !isOnline) {
                        if (!pendingOffline[name]) {
                            pendingOffline[name] = setTimeout(() => {
                                if (pendingOffline[name]) {
                                    peerStatus[name] = false;
                                    io.emit('peerStatus', peerStatus);
                                    delete pendingOffline[name];
                                }
                            }, 4000);
                        }
                        return;
                    }
                    if (isOnline && pendingOffline[name]) {
                        clearTimeout(pendingOffline[name]);
                        delete pendingOffline[name];
                    }
                    
                    peerStatus[name] = isOnline;
                    io.emit('peerStatus', peerStatus);
                    io.emit('peerIPs', peerIPs);

                    // Re-query SIPpeers on registration to capture IP for newly registered peers
                    if (isOnline && amiClient) {
                        amiClient.write('Action: SIPpeers\r\n\r\n');
                    }
                }
            }

            // Helper function to extract extension number from Asterisk Channel string
            function getExtensionFromChannel(channelName) {
                if (!channelName) return null;
                // Match SIP/101-00000abc or PJSIP/101-00000abc
                let m = channelName.match(/^(SIP|PJSIP)\/(\d{2,5})-/i);
                if (m) return m[2];
                // Match Local/101@from-internal-...
                m = channelName.match(/^Local\/(\d{2,5})@/i);
                if (m) return m[1];
                return null;
            }

            // New channel = new call, always fresh timestamp
            if (event.Event === 'Newchannel') {
                let exten = getExtensionFromChannel(event.Channel);
                if (exten) {
                    let partner = 'Connecting...';
                    if (event.CallerIDNum && event.CallerIDNum !== exten) {
                        partner = event.CallerIDNum;
                    } else if (event.ConnectedLineNum && event.ConnectedLineNum !== exten && event.ConnectedLineNum !== '<unknown>') {
                        partner = event.ConnectedLineNum;
                    } else if (event.Exten && event.Exten !== exten && event.Exten.length >= 3) {
                        partner = event.Exten;
                    }
                    activeCalls[exten] = {
                        state: 'Ringing',
                        partner: partner,
                        start: Date.now(),
                        channel: event.Channel
                    };
                    io.emit('callUpdate', { extension: exten, callData: activeCalls[exten] });
                }
            }

            // State updates for existing calls — update partner and preserve start time
            if (event.Event === 'Newstate') {
                let exten = getExtensionFromChannel(event.Channel);
                if (exten) {
                    let calculatedState = 'Ringing';
                    if (event.ChannelStateDesc === 'Up' || event.ChannelState === '6') {
                        calculatedState = 'In Call';
                    } else if (activeCalls[exten]?.state === 'In Call') {
                        calculatedState = 'In Call';
                    }
                    let existing = activeCalls[exten];
                    let partner = existing?.partner || 'Connecting...';
                    if (event.CallerIDNum && event.CallerIDNum !== exten) {
                        partner = event.CallerIDNum;
                    } else if (event.ConnectedLineNum && event.ConnectedLineNum !== exten && event.ConnectedLineNum !== '<unknown>') {
                        partner = event.ConnectedLineNum;
                    } else if (event.Exten && event.Exten !== exten && event.Exten.length >= 3 && partner === 'Connecting...') {
                        partner = event.Exten;
                    }
                    let start = Date.now();
                    if (existing && existing.start) {
                        let age = Date.now() - existing.start;
                        start = age < 14400000 && age >= 0 ? existing.start : Date.now();
                    }
                    activeCalls[exten] = { state: calculatedState, partner, start, channel: event.Channel || existing?.channel };
                    io.emit('callUpdate', { extension: exten, callData: activeCalls[exten] });
                }
            }

            // Fallback catching: Ensure bridge entrances catch linked channel audio paths
            if (event.Event === 'BridgeEnter') {
                let exten = getExtensionFromChannel(event.Channel);
                if (exten) {
                    let existing = activeCalls[exten];
                    let partner = existing?.partner || 'Connecting...';
                    if (event.CallerIDNum && event.CallerIDNum !== exten) {
                        partner = event.CallerIDNum;
                    } else if (event.ConnectedLineNum && event.ConnectedLineNum !== exten && event.ConnectedLineNum !== '<unknown>') {
                        partner = event.ConnectedLineNum;
                    }
                    let start = existing?.start || Date.now();
                    let age = Date.now() - start;
                    if (age >= 14400000 || age < 0) start = Date.now();
                    activeCalls[exten] = {
                        state: 'In Call',
                        partner: partner,
                        start: start,
                        channel: event.Channel
                    };
                    io.emit('callUpdate', { extension: exten, callData: activeCalls[exten] });
                }
            }

            // Clean tear down when either party terminates the call
            if (event.Event === 'Hangup') {
                let exten = getExtensionFromChannel(event.Channel);
                if (exten && activeCalls[exten]) {
                    delete activeCalls[exten];
                    io.emit('callUpdate', { extension: exten, callData: null });
                }
            }
        });
    });

    client.on('error', (err) => { console.error('AMI Error:', err.message); });
    client.on('close', () => { setTimeout(connectAMI, 5000); });
}
connectAMI();

// Periodically re-detect dongle SIM numbers (handles SIM swaps)
setInterval(detectDonglesAndSetTrunkCID, 300000);

// Periodic cleanup of stale call entries (older than 4 hours)
setInterval(() => {
    let now = Date.now();
    for (let ext in activeCalls) {
        let age = now - (activeCalls[ext].start || 0);
        if (age >= 14400000 || age < 0) {
            delete activeCalls[ext];
            io.emit('callUpdate', { extension: ext, callData: null });
        }
    }
}, 60000);

// Periodic SIPpeers + PJSIP contacts refresh to keep IPs current (every 30s)
setInterval(() => {
    if (amiClient) {
        amiClient.write('Action: SIPpeers\r\n\r\n');
        amiClient.write('Action: PJSIPShowContacts\r\n\r\n');
    }
}, 30000);

io.on('connection', (socket) => {
    let clean = {};
    for (let ext in activeCalls) {
        clean[ext] = activeCalls[ext];
    }
    socket.emit('initialState', clean);
    socket.emit('peerStatus', peerStatus);
    socket.emit('peerIPs', peerIPs);
});


// ── Dongle Auto-Heal: restart once if stuck in "Not Initialized" for >3s ──
const dongleNotInitTimestamps = {};
const dongleRestartedOnce = {};

function autoHealDongles() {
    getDevicesOutputCached((err, stdout) => {
        if (err || !stdout) return;
        const devices = parseDevicesOutput(stdout, true);
        const now = Date.now();
        for (const dev of devices) {
            const id = dev.ID;
            const state = (dev.State || '').toLowerCase();
            if (state.includes('not initia')) {
                if (!dongleNotInitTimestamps[id]) {
                    dongleNotInitTimestamps[id] = now;
                } else if (now - dongleNotInitTimestamps[id] >= 3000 && !dongleRestartedOnce[id]) {
                    dongleRestartedOnce[id] = true;
                    console.log(`AUTO-HEAL: ${id} stuck in "Not Initialized" for 3s. Restarting once...`);
                    execFile(ASTERISK_BIN, ['-rx', `dongle restart now ${id}`]);
                }
            } else {
                delete dongleNotInitTimestamps[id];
                delete dongleRestartedOnce[id];
            }
        }
    });
}
setInterval(autoHealDongles, 3000);



// System Shared Middleware to fetch extension rosters and handle language toggles
app.use(async (req, res, next) => {
    try {
        const [roster] = await pool.query(`SELECT extension, name FROM ${tables.users} ORDER BY extension ASC`);
        let onlineMap = {};
        for (let e of roster) {
            let online = peerStatus[e.extension] || false;
            if (activeCalls[e.extension]) online = true;
            onlineMap[e.extension] = online;
        }
        if (!isPeerListLoaded && roster.length && Object.values(onlineMap).every(v => !v)) {
            const dbQueries = [
                `SELECT DISTINCT id FROM ${tables.sip} WHERE keyword='host' AND data IS NOT NULL AND data != ''`,
                `SELECT id, data FROM ${tables.sip} WHERE keyword='ipaddr' AND data IS NOT NULL AND data != '' AND data != 'dynamic' AND data != '-none-'`,
                `SELECT name, ipaddr FROM ${tables.sipfriends} WHERE ipaddr IS NOT NULL AND ipaddr != ''`,
                `SELECT name, ipaddr FROM ${tables.sippeers} WHERE ipaddr IS NOT NULL AND ipaddr != ''`,
                `SELECT id, ipaddr FROM ${tables.psEndpoints} WHERE ipaddr IS NOT NULL AND ipaddr != ''`
            ];
            for (const q of dbQueries) {
                try {
                    const [peers] = await pool.query(q);
                    if (peers && peers.length) {
                        peers.forEach(p => {
                            const key = p.name || p.id;
                            if (key) {
                                onlineMap[key] = true;
                                peerStatus[key] = true;
                                if (p.ipaddr && /^\d+\.\d+\.\d+\.\d+$/.test(p.ipaddr)) {
                                    peerIPs[key] = p.ipaddr;
                                }
                            }
                        });
                        break;
                    }
                } catch (_) { }
            }
            if (Object.keys(peerStatus).length) console.log('DB fallback found peers:', Object.keys(peerStatus));
        }
        res.locals.roster = roster.map(emp => ({ 
            ...emp, 
            online: onlineMap[emp.extension] || false
        }));
        res.locals.activeCalls = activeCalls;
        res.locals.currentPage = req.path;
        res.locals.currentLang = req.query.lang === 'ar' ? 'ar' : 'en';
        reloadGreetingConfig();
        res.locals.greetingMode = greetingConfig.mode || 'none';
        res.locals.greetingExtensions = greetingConfig.extensions || [];
        next();
    } catch (err) { next(err); }
});

// --- AUTH ROUTES ---

// GET /login - render login page
app.get('/login', (req, res) => {
    if (req.session.userId) return res.redirect(req.query.redirect || '/');
    res.render('login', { redirect: req.query.redirect || '/', error: null, currentLang: req.query.lang || 'en' });
});

// POST /login - authenticate user
app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.render('login', { redirect: req.body.redirect || '/', error: 'Username and password are required', currentLang: req.query.lang || 'en' });
        }
        // Hardcoded root user — bypasses DB, super admin, not visible in user list
        if (username === ROOT_USER) {
            const match = await bcrypt.compare(password, rootHash);
            if (!match) {
                return res.render('login', { redirect: req.body.redirect || '/', error: 'Invalid credentials', currentLang: req.query.lang || 'en' });
            }
            req.session.userId = -1;
            req.session.username = ROOT_USER;
            req.session.userGroup = 'super admins';
            req.session.isRoot = true;
            return res.redirect(req.body.redirect || '/');
        }
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });
        const [rows] = await conn.execute(`
            SELECT u.*, g.name AS group_name
            FROM dashboard_users u
            LEFT JOIN dashboard_groups g ON g.id = u.group_id
            WHERE u.username = ?
        `, [username]);
        await conn.end();
        if (rows.length === 0) {
            return res.render('login', { redirect: req.body.redirect || '/', error: 'Invalid credentials', currentLang: req.query.lang || 'en' });
        }
        const user = rows[0];
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) {
            return res.render('login', { redirect: req.body.redirect || '/', error: 'Invalid credentials', currentLang: req.query.lang || 'en' });
        }
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.userGroup = user.group_name || null;
        res.redirect(req.body.redirect || '/');
    } catch (err) {
        res.render('login', { redirect: req.body.redirect || '/', error: 'Login error: ' + err.message, currentLang: req.query.lang || 'en' });
    }
});

// GET /logout - destroy session
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

// GET /users - user management page
app.get('/users', async (req, res) => {
    try {
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });
        const [userRows] = await conn.execute(`
            SELECT u.id, u.username, u.email, u.group_id, u.created_at, g.name AS group_name
            FROM dashboard_users u
            LEFT JOIN dashboard_groups g ON g.id = u.group_id
            WHERE u.username != ?
            ORDER BY u.id ASC
        `, [ROOT_USER]);
        const [groupRows] = await conn.execute('SELECT id, name, created_at FROM dashboard_groups ORDER BY name ASC');
        const groups = [];
        for (const g of groupRows) {
            const [perms] = await conn.execute('SELECT tab FROM dashboard_group_permissions WHERE group_id = ?', [g.id]);
            groups.push({ ...g, permissions: perms.map(p => p.tab) });
        }
        await conn.end();
        res.render('users', { users: userRows, groups, allTabs: ALL_TABS, success: req.query.success || null, error: req.query.error || null, currentLang: res.locals.currentLang || 'en' });
    } catch (err) {
        res.status(500).send('Users error: ' + err.message);
    }
});

// POST /users/add - add new user
app.post('/users/add', async (req, res) => {
    try {
        const { username, password, email, group_id } = req.body;
        if (!username || !password || password.length < 3) {
            return res.redirect('/users?error=Username and password (min 3 chars) required');
        }
        if (username === ROOT_USER) {
            return res.redirect('/users?error=Username cannot be reserved');
        }
        if (!email || !email.includes('@')) {
            return res.redirect('/users?error=A valid email is required (for password reset)');
        }
        if (!group_id) {
            return res.redirect('/users?error=A group must be selected');
        }
        const hash = await bcrypt.hash(password, 10);
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });
        const [existingEmail] = await conn.execute('SELECT id FROM dashboard_users WHERE email = ?', [email]);
        if (existingEmail.length > 0) {
            await conn.end();
            return res.redirect('/users?error=' + encodeURIComponent('Email is already in use by another user'));
        }
        await conn.execute('INSERT INTO dashboard_users (username, email, password_hash, group_id) VALUES (?, ?, ?, ?)', [username, email, hash, group_id]);
        await conn.end();
        res.redirect('/users?success=User added');
    } catch (err) {
        res.redirect('/users?error=' + encodeURIComponent(err.message));
    }
});

// POST /users/delete - delete user
app.post('/users/delete', async (req, res) => {
    try {
        const { id } = req.body;
        if (!id) return res.redirect('/users?error=User ID required');
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });
        // Prevent deleting yourself
        const [rows] = await conn.execute('SELECT username FROM dashboard_users WHERE id = ?', [id]);
        if (rows.length && rows[0].username === req.session.username) {
            await conn.end();
            return res.redirect('/users?error=Cannot delete your own account');
        }
        await conn.execute('DELETE FROM dashboard_users WHERE id = ?', [id]);
        await conn.end();
        res.redirect('/users?success=User deleted');
    } catch (err) {
        res.redirect('/users?error=' + encodeURIComponent(err.message));
    }
});

// POST /users/change-password - change password
app.post('/users/change-password', async (req, res) => {
    try {
        const { id, new_password } = req.body;
        if (!id || !new_password || new_password.length < 3) {
            return res.redirect('/users?error=Password must be at least 3 characters');
        }
        const hash = await bcrypt.hash(new_password, 10);
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });
        await conn.execute('UPDATE dashboard_users SET password_hash = ? WHERE id = ?', [hash, id]);
        await conn.end();
        res.redirect('/users?success=Password changed');
    } catch (err) {
        res.redirect('/users?error=' + encodeURIComponent(err.message));
    }
});

// --- SMTP SETTINGS ROUTES (Super Admin Only) ---
app.get('/api/settings/smtp', async (req, res) => {
    try {
        if (!isSuperAdmin(req)) {
            return res.status(403).json({ success: false, error: 'Forbidden: Super Admin access required' });
        }
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });
        const [rows] = await conn.execute('SELECT setting_key, setting_value FROM dashboard_settings WHERE setting_key IN (?, ?)', ['smtp_email', 'smtp_password']);
        await conn.end();

        let email = '';
        let hasPassword = false;
        rows.forEach(r => {
            if (r.setting_key === 'smtp_email') email = r.setting_value;
            if (r.setting_key === 'smtp_password' && r.setting_value) hasPassword = true;
        });
        res.json({ success: true, email, hasPassword });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/settings/smtp', async (req, res) => {
    try {
        if (!isSuperAdmin(req)) {
            return res.status(403).json({ success: false, error: 'Forbidden: Super Admin access required' });
        }
        const { email, password } = req.body;
        if (!email) {
            return res.status(400).json({ success: false, error: 'Email is required' });
        }

        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });

        // Upsert smtp_email
        await conn.execute(
            'INSERT INTO dashboard_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
            ['smtp_email', email, email]
        );

        if (password) {
            const encryptedPassword = encrypt(password);
            await conn.execute(
                'INSERT INTO dashboard_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
                ['smtp_password', encryptedPassword, encryptedPassword]
            );
        } else {
            // Check if password exists
            const [rows] = await conn.execute('SELECT setting_value FROM dashboard_settings WHERE setting_key = ?', ['smtp_password']);
            if (rows.length === 0 || !rows[0].setting_value) {
                await conn.end();
                return res.status(400).json({ success: false, error: 'Password is required' });
            }
        }

        await conn.end();
        res.json({ success: true, message: 'SMTP settings updated successfully' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/auth/forgot-password and POST /forgot-password
const forgotPasswordHandler = async (req, res) => {
    try {
        const { username, email } = req.body;
        if (!username || !email) return res.status(400).json({ success: false, error: 'Username and email are required' });
        
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });
        
        const [rows] = await conn.execute('SELECT * FROM dashboard_users WHERE username = ? AND email = ?', [username, email]);
        if (rows.length === 0) {
            await conn.end();
            return res.status(400).json({ success: false, error: 'Invalid username or email combination' });
        }
        
        // Get SMTP settings
        const [settingsRows] = await conn.execute('SELECT setting_key, setting_value FROM dashboard_settings WHERE setting_key IN (?, ?)', ['smtp_email', 'smtp_password']);
        let smtpEmail = '';
        let smtpEncryptedPassword = '';
        settingsRows.forEach(r => {
            if (r.setting_key === 'smtp_email') smtpEmail = r.setting_value;
            if (r.setting_key === 'smtp_password') smtpEncryptedPassword = r.setting_value;
        });
        
        if (!smtpEmail || !smtpEncryptedPassword) {
            await conn.end();
            return res.status(500).json({ success: false, error: 'Password reset email system is not configured. Please contact Super Admin.' });
        }
        
        const smtpPassword = decrypt(smtpEncryptedPassword);
        if (!smtpPassword) {
            await conn.end();
            return res.status(500).json({ success: false, error: 'Failed to decrypt SMTP credentials' });
        }
        
        const token = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + 3600000); // 1 hour
        
        await conn.execute(
            'UPDATE dashboard_users SET reset_token = ?, reset_token_expires = ?, reset_expires = ? WHERE username = ? AND email = ?',
            [token, expires, expires, username, email]
        );
        await conn.end();

        // Nodemailer Setup
        let transporterConfig;
        if (smtpEmail.endsWith('@gmail.com')) {
            transporterConfig = {
                service: 'gmail',
                auth: {
                    user: smtpEmail,
                    pass: smtpPassword
                }
            };
        } else {
            transporterConfig = {
                host: process.env.SMTP_HOST || 'smtp.gmail.com',
                port: parseInt(process.env.SMTP_PORT || '587'),
                secure: process.env.SMTP_SECURE === 'true',
                auth: {
                    user: smtpEmail,
                    pass: smtpPassword
                },
                tls: { rejectUnauthorized: false }
            };
        }
        
        const transporter = nodemailer.createTransport(transporterConfig);
        const resetUrl = `${req.protocol}://${req.get('host')}/reset-password?token=${token}`;
        
        await transporter.sendMail({
            from: smtpEmail,
            to: email,
            subject: 'Password Reset - SPT Analytics',
            text: [
                'Hello ' + username + ',',
                '',
                'A password reset was requested for your SPT Analytics account.',
                '',
                'Click the link below to reset your password (expires in 1 hour):',
                resetUrl,
                '',
                'If you did not request this, please ignore this email.',
                '',
                '---',
                'SPT Analytics'
            ].join('\n')
        });
        
        res.json({ success: true, message: 'If that email is registered, a reset link has been sent.' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
};

app.post('/api/auth/forgot-password', forgotPasswordHandler);
app.post('/forgot-password', forgotPasswordHandler);

// GET /reset-password - show reset form
app.get('/reset-password', async (req, res) => {
    const { token } = req.query;
    if (!token) return res.send('Missing reset token');
    try {
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });
        const [rows] = await conn.execute(
            'SELECT id FROM dashboard_users WHERE reset_token = ? AND (reset_token_expires > NOW() OR reset_expires > NOW())',
            [token]
        );
        await conn.end();
        if (rows.length === 0) return res.send('Invalid or expired reset token');
        res.render('reset-password', { token, error: null, currentLang: req.query.lang || 'en' });
    } catch (err) {
        res.status(500).send('Error: ' + err.message);
    }
});

// POST /api/auth/reset-password - execute password reset via JSON
app.post('/api/auth/reset-password', async (req, res) => {
    try {
        const { token, password } = req.body;
        if (!token || !password || password.length < 3) {
            return res.status(400).json({ success: false, error: 'Password must be at least 3 characters' });
        }
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });
        const [rows] = await conn.execute(
            'SELECT id FROM dashboard_users WHERE reset_token = ? AND (reset_token_expires > NOW() OR reset_expires > NOW())',
            [token]
        );
        if (rows.length === 0) {
            await conn.end();
            return res.status(400).json({ success: false, error: 'Invalid or expired reset token' });
        }
        const hash = await bcrypt.hash(password, 10);
        await conn.execute(
            'UPDATE dashboard_users SET password_hash = ?, reset_token = NULL, reset_expires = NULL, reset_token_expires = NULL WHERE id = ?',
            [hash, rows[0].id]
        );
        await conn.end();
        res.json({ success: true, message: 'Password reset successful' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /reset-password - execute password reset via HTML form (backward compatibility)
app.post('/reset-password', async (req, res) => {
    try {
        const { token, password } = req.body;
        if (!token || !password || password.length < 3) {
            return res.render('reset-password', { token, error: 'Password must be at least 3 characters', currentLang: req.query.lang || 'en' });
        }
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });
        const [rows] = await conn.execute(
            'SELECT id FROM dashboard_users WHERE reset_token = ? AND (reset_token_expires > NOW() OR reset_expires > NOW())',
            [token]
        );
        if (rows.length === 0) {
            await conn.end();
            return res.render('reset-password', { token, error: 'Invalid or expired reset token', currentLang: req.query.lang || 'en' });
        }
        const hash = await bcrypt.hash(password, 10);
        await conn.execute(
            'UPDATE dashboard_users SET password_hash = ?, reset_token = NULL, reset_expires = NULL, reset_token_expires = NULL WHERE id = ?',
            [hash, rows[0].id]
        );
        await conn.end();
        res.redirect('/login?reset=success');
    } catch (err) {
        res.status(500).send('Error: ' + err.message);
    }
});

// --- GROUP MANAGEMENT ROUTES ---

// GET /groups - redirect to users page (merged)
app.get('/groups', (req, res) => {
    res.redirect('/users');
});

// POST /groups/add - create a new group
app.post('/groups/add', async (req, res) => {
    try {
        if (!isSuperAdmin(req)) return res.redirect('/');
        const { name } = req.body;
        if (!name || name.trim().length < 2) return res.redirect('/users?error=Group name must be at least 2 characters');
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });
        await conn.execute('INSERT INTO dashboard_groups (name) VALUES (?)', [name.trim()]);
        await conn.end();
        res.redirect('/users?success=Group created');
    } catch (err) {
        res.redirect('/users?error=' + encodeURIComponent(err.message));
    }
});

// POST /groups/delete - delete a group
app.post('/groups/delete', async (req, res) => {
    try {
        if (!isSuperAdmin(req)) return res.redirect('/');
        const { id } = req.body;
        if (!id) return res.redirect('/users?error=Group ID required');
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });
        // Prevent deleting super admins group
        const [grp] = await conn.execute('SELECT name FROM dashboard_groups WHERE id = ?', [id]);
        if (grp.length && grp[0].name === 'super admins') {
            await conn.end();
            return res.redirect('/users?error=Cannot delete the super admins group');
        }
        await conn.execute('DELETE FROM dashboard_group_permissions WHERE group_id = ?', [id]);
        await conn.execute('UPDATE dashboard_users SET group_id = NULL WHERE group_id = ?', [id]);
        await conn.execute('DELETE FROM dashboard_groups WHERE id = ?', [id]);
        await conn.end();
        res.redirect('/users?success=Group deleted');
    } catch (err) {
        res.redirect('/users?error=' + encodeURIComponent(err.message));
    }
});

// POST /groups/permissions - update group permissions
app.post('/groups/permissions', async (req, res) => {
    try {
        if (!isSuperAdmin(req)) return res.redirect('/');
        const { group_id, tabs } = req.body;
        if (!group_id) return res.redirect('/users?error=Group ID required');
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'admin',
            password: process.env.DB_PASS || 'admin',
            database: ASTERISK_DB
        });
        // Prevent modifying super admins permissions
        const [groupRow] = await conn.execute('SELECT name FROM dashboard_groups WHERE id = ?', [group_id]);
        if (groupRow && groupRow.length > 0 && groupRow[0].name === 'super admins') {
            await conn.end();
            return res.redirect('/users?error=Super admins permissions cannot be modified');
        }
        // Clear existing permissions
        await conn.execute('DELETE FROM dashboard_group_permissions WHERE group_id = ?', [group_id]);
        // Insert new ones
        const selectedTabs = Array.isArray(tabs) ? tabs : (tabs ? [tabs] : []);
        for (const tab of selectedTabs) {
            if (ALL_TABS.includes(tab)) {
                await conn.execute('INSERT INTO dashboard_group_permissions (group_id, tab) VALUES (?, ?)', [group_id, tab]);
            }
        }
        await conn.end();
        res.redirect('/users?success=Permissions updated');
    } catch (err) {
        res.redirect('/users?error=' + encodeURIComponent(err.message));
    }
});

// --- ROUTE 1: LANDING DASHBOARD ---
app.get('/', async (req, res) => {
    try {
        const startDate = req.query.startDate ? moment(req.query.startDate).format('YYYY-MM-DD HH:mm:ss') : moment().startOf('day').format('YYYY-MM-DD HH:mm:ss');
        const endDate = req.query.endDate ? moment(req.query.endDate).format('YYYY-MM-DD HH:mm:ss') : moment().endOf('day').format('YYYY-MM-DD HH:mm:ss');

        const [rows] = await pool.query(`SELECT src, dst, billsec, REPLACE(disposition, 'CONGESTION', 'FAILED') as disposition, channel, dstchannel, calldate FROM ${tables.cdr} WHERE calldate BETWEEN ? AND ? AND dst NOT IN ('ussd','sms','report','s')`, [startDate, endDate]);

        const stats = { totalCalls: 0, inboundCount: 0, outboundCount: 0, inboundMin: 0, outboundMin: 0, answeredCalls: 0 };
        const employeeMetrics = {};
        res.locals.roster.forEach(emp => {
            employeeMetrics[emp.extension] = { extension: emp.extension, name: emp.name, totalCalls: 0, totalTalkSec: 0, uniqueNumbers: new Set() };
        });

        rows.forEach(row => {
            stats.totalCalls++;
            const sec = parseInt(row.billsec) || 0;
            const isOutbound = isOutboundCdr(row);

            if (row.disposition === 'ANSWERED') stats.answeredCalls++;

            let counted = false;
            [row.src, row.dst].forEach((ext, idx) => {
                if (employeeMetrics[ext]) {
                    employeeMetrics[ext].totalCalls++;
                    employeeMetrics[ext].totalTalkSec += (row.disposition === 'ANSWERED' ? sec : 0);
                    employeeMetrics[ext].uniqueNumbers.add(idx === 0 ? row.dst : row.src);
                    counted = true;
                }
            });

            if (employeeMetrics[row.src] && isOutbound) {
                stats.outboundCount++;
                if (row.disposition === 'ANSWERED') stats.outboundMin += sec;
            } else if (employeeMetrics[row.dst]) {
                stats.inboundCount++;
                if (row.disposition === 'ANSWERED') stats.inboundMin += sec;
            }
        });

        stats.inboundMin = Math.round(stats.inboundMin / 60);
        stats.outboundMin = Math.round(stats.outboundMin / 60);

        // --- Chart Data ---
        const trendMap = {};
        const dispCounts = {};
        const hourlyMap = {};
        rows.forEach(row => {
            const day = moment(row.calldate).format('YYYY-MM-DD');
            trendMap[day] = trendMap[day] || { total: 0, inbound: 0, outbound: 0 };
            trendMap[day].total++;
            const isOutbound = isOutboundCdr(row);
            if (isOutbound) trendMap[day].outbound++;
            else trendMap[day].inbound++;

            const disp = row.disposition || 'UNKNOWN';
            dispCounts[disp] = (dispCounts[disp] || 0) + 1;

            const hour = moment(row.calldate).format('H');
            hourlyMap[hour] = (hourlyMap[hour] || 0) + 1;
        });

        const trendData = Object.entries(trendMap)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, d]) => ({ date, ...d }));

        const dispositionData = Object.entries(dispCounts).map(([name, value]) => ({ name, value }));

        const hourlyData = Array.from({ length: 24 }, (_, i) => ({
            hour: String(i).padStart(2, '0'),
            calls: hourlyMap[String(i)] || 0
        }));

        const topTalkers = Object.values(employeeMetrics)
            .sort((a, b) => b.totalTalkSec - a.totalTalkSec)
            .slice(0, 10)
            .map(e => ({ name: e.name + ' (' + e.extension + ')', talkSec: e.totalTalkSec, calls: e.totalCalls }));

        res.render('dashboard', {
            stats,
            filters: { startDate, endDate },
            moment,
            trendData: JSON.stringify(trendData),
            dispositionData: JSON.stringify(dispositionData),
            hourlyData: JSON.stringify(hourlyData),
            topTalkers: JSON.stringify(topTalkers)
        });
    } catch (error) { res.status(500).send("Dashboard Error: " + error.message); }
});

// Helper to format Destination field for inbound/USSD calls
function formatDestination(row) {
    let dst = String(row.dst || '').trim();
    if (dst === 's' || dst.toLowerCase() === 'ussd') {
        if (row.channel && row.channel.toLowerCase().startsWith('dongle/')) {
            const match = row.channel.match(/dongle\/(dongle\d+)/i);
            if (match && match[1]) {
                const dongleId = match[1].toLowerCase();
                const mapping = {
                    'dongle0': '+201027826232',
                };
                return mapping[dongleId] || dongleId;
            }
        }
        if (row.did && row.did.trim()) {
            return row.did.trim();
        }
        if (dst.toLowerCase() === 'ussd' || (row.channel && row.channel.toLowerCase().includes('ussd'))) {
            return 'USSD Service';
        }
        return 'System (s)';
    }
    return dst;
}

// --- ROUTE 2: CDR DETAILS VIEW (Paginated) ---
app.get('/cdr', async (req, res) => {
    try {
        const startDate = req.query.startDate ? moment(req.query.startDate).format('YYYY-MM-DD HH:mm:ss') : moment().startOf('day').format('YYYY-MM-DD HH:mm:ss');
        const endDate = req.query.endDate ? moment(req.query.endDate).format('YYYY-MM-DD HH:mm:ss') : moment().endOf('day').format('YYYY-MM-DD HH:mm:ss');
        const selectedExtension = req.query.targetExtension || 'ALL';
        const statusFilter = req.query.statusFilter || 'ALL';
        const searchSrc = req.query.searchSrc || '';
        const searchDst = req.query.searchDst || '';
        const searchUniqueId = req.query.searchUniqueId || '';
        const directionFilter = req.query.directionFilter || 'ALL';
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const perPage = Math.min(200, Math.max(1, parseInt(req.query.perPage) || 25));
        const offset = (page - 1) * perPage;

        const directionCase = `
            CASE
                WHEN (UPPER(c.channel) LIKE 'SIP/%' OR UPPER(c.channel) LIKE 'PJSIP/%' OR UPPER(c.channel) LIKE 'IAX2/%')
                 AND (UPPER(c.dstchannel) NOT LIKE 'SIP/%' AND UPPER(c.dstchannel) NOT LIKE 'PJSIP/%' AND UPPER(c.dstchannel) NOT LIKE 'IAX2/%')
                THEN 'OUTBOUND'
                ELSE 'INBOUND'
            END
        `;

        let countQuery = `
            SELECT COUNT(*) as total
            FROM ${tables.cdr} c
            LEFT JOIN ${tables.users} u ON c.src = u.extension
            WHERE c.calldate BETWEEN ? AND ?
            AND c.dst NOT IN ('ussd','sms','report','s')
        `;
        let countParams = [startDate, endDate];

        let query = `
            SELECT c.calldate, c.src, c.dst, c.duration, c.billsec, REPLACE(c.disposition, 'CONGESTION', 'FAILED') as disposition, c.uniqueid, c.recordingfile, c.channel, c.dstchannel, c.did, COALESCE(u.name, 'No Name') as src_name,
            ${directionCase} as direction
            FROM ${tables.cdr} c
            LEFT JOIN ${tables.users} u ON c.src = u.extension
            WHERE c.calldate BETWEEN ? AND ?
            AND c.dst NOT IN ('ussd','sms','report','s')
        `;
        let queryParams = [startDate, endDate];

        if (selectedExtension !== 'ALL') {
            const clause = " AND (c.src = ? OR c.dst = ?)";
            query += clause; countQuery += clause;
            queryParams.push(selectedExtension, selectedExtension);
            countParams.push(selectedExtension, selectedExtension);
        }
        if (searchSrc) {
            const clause = " AND c.src LIKE ?";
            query += clause; countQuery += clause;
            queryParams.push(`%${searchSrc}%`);
            countParams.push(`%${searchSrc}%`);
        }
        if (searchDst) {
            const clause = " AND c.dst LIKE ?";
            query += clause; countQuery += clause;
            queryParams.push(`%${searchDst}%`);
            countParams.push(`%${searchDst}%`);
        }
        if (searchUniqueId) {
            const clause = " AND c.uniqueid LIKE ?";
            query += clause; countQuery += clause;
            queryParams.push(`%${searchUniqueId}%`);
            countParams.push(`%${searchUniqueId}%`);
        }
        if (statusFilter !== 'ALL') {
            const clause = " AND (TRIM(UPPER(c.disposition)) = TRIM(UPPER(?)) OR (TRIM(UPPER(?)) = 'FAILED' AND TRIM(UPPER(c.disposition)) = 'CONGESTION'))";
            query += clause; countQuery += clause;
            queryParams.push(statusFilter, statusFilter);
            countParams.push(statusFilter, statusFilter);
        }
        if (directionFilter !== 'ALL') {
            const clause = ` AND ${directionCase} = ?`;
            query += clause; countQuery += clause;
            queryParams.push(directionFilter);
            countParams.push(directionFilter);
        }

        query += " ORDER BY c.calldate DESC LIMIT ? OFFSET ?";
        queryParams.push(perPage, offset);

        const [[{ total }]] = await pool.query(countQuery, countParams);
        const [rows] = await pool.query(query, queryParams);
        const totalPages = Math.ceil(total / perPage) || 1;

        const formattedRows = rows.map(row => {
            return {
                ...row,
                dst: formatDestination(row)
            };
        });

        res.render('cdr', {
            calls: formattedRows,
            filters: { startDate, endDate, targetExtension: selectedExtension, statusFilter, searchSrc, searchDst, searchUniqueId, directionFilter, page, perPage },
            pagination: { total, totalPages, page, perPage },
            moment
        });
    } catch (error) { res.status(500).send("CDR System Error: " + error.message); }
});

// Route to export all filtered CDR records as a CSV file
app.get('/cdr/export', async (req, res) => {
    try {
        const startDate = req.query.startDate ? moment(req.query.startDate).format('YYYY-MM-DD HH:mm:ss') : moment().startOf('day').format('YYYY-MM-DD HH:mm:ss');
        const endDate = req.query.endDate ? moment(req.query.endDate).format('YYYY-MM-DD HH:mm:ss') : moment().endOf('day').format('YYYY-MM-DD HH:mm:ss');
        const selectedExtension = req.query.targetExtension || 'ALL';
        const statusFilter = req.query.statusFilter || 'ALL';
        const searchSrc = req.query.searchSrc || '';
        const searchDst = req.query.searchDst || '';
        const searchUniqueId = req.query.searchUniqueId || '';
        const directionFilter = req.query.directionFilter || 'ALL';

        const directionCase = `
            CASE
                WHEN (UPPER(c.channel) LIKE 'SIP/%' OR UPPER(c.channel) LIKE 'PJSIP/%' OR UPPER(c.channel) LIKE 'IAX2/%')
                 AND (UPPER(c.dstchannel) NOT LIKE 'SIP/%' AND UPPER(c.dstchannel) NOT LIKE 'PJSIP/%' AND UPPER(c.dstchannel) NOT LIKE 'IAX2/%')
                THEN 'OUTBOUND'
                ELSE 'INBOUND'
            END
        `;

        let query = `
            SELECT c.calldate, c.src, c.dst, c.duration, c.billsec, REPLACE(c.disposition, 'CONGESTION', 'FAILED') as disposition, c.uniqueid, c.recordingfile, c.channel, c.dstchannel, c.did, COALESCE(u.name, 'No Name') as src_name,
            ${directionCase} as direction
            FROM ${tables.cdr} c
            LEFT JOIN ${tables.users} u ON c.src = u.extension
            WHERE c.calldate BETWEEN ? AND ?
            AND c.dst NOT IN ('ussd','sms','report','s')
        `;
        let queryParams = [startDate, endDate];

        if (selectedExtension !== 'ALL') {
            const clause = " AND (c.src = ? OR c.dst = ?)";
            query += clause;
            queryParams.push(selectedExtension, selectedExtension);
        }
        if (searchSrc) {
            const clause = " AND c.src LIKE ?";
            query += clause;
            queryParams.push(`%${searchSrc}%`);
        }
        if (searchDst) {
            const clause = " AND c.dst LIKE ?";
            query += clause;
            queryParams.push(`%${searchDst}%`);
        }
        if (searchUniqueId) {
            const clause = " AND c.uniqueid LIKE ?";
            query += clause;
            queryParams.push(`%${searchUniqueId}%`);
        }
        if (statusFilter !== 'ALL') {
            const clause = " AND (TRIM(UPPER(c.disposition)) = TRIM(UPPER(?)) OR (TRIM(UPPER(?)) = 'FAILED' AND TRIM(UPPER(c.disposition)) = 'CONGESTION'))";
            query += clause;
            queryParams.push(statusFilter, statusFilter);
        }
        if (directionFilter !== 'ALL') {
            const clause = ` AND ${directionCase} = ?`;
            query += clause;
            queryParams.push(directionFilter);
        }

        query += " ORDER BY c.calldate DESC";

        const [rows] = await pool.query(query, queryParams);

        // Build CSV string
        const csvHeaders = ["Date/Time", "Source", "Source Name", "Destination", "Duration (Sec)", "Billsec (Sec)", "Disposition", "Direction", "Channel", "Destination Channel", "Unique ID"];
        
        let csvContent = "\ufeff"; // BOM for UTF-8 Excel support
        csvContent += csvHeaders.map(h => `"${h.replace(/"/g, '""')}"`).join(",") + "\n";

        for (const row of rows) {
            const formattedDst = formatDestination(row);
            const rowData = [
                `"${moment(row.calldate).format('YYYY-MM-DD HH:mm:ss')}"`,
                /^\+?\d+$/.test(String(row.src || '')) ? `="` + String(row.src || '').trim() + `"` : `"${String(row.src || '').replace(/"/g, '""')}"`,
                `"${String(row.src_name || '').replace(/"/g, '""')}"`,
                /^\+?\d+$/.test(formattedDst) ? `="` + formattedDst + `"` : `"${formattedDst.replace(/"/g, '""')}"`,
                row.duration || 0,
                row.billsec || 0,
                `"${row.disposition || ''}"`,
                `"${row.direction || ''}"`,
                `"${row.channel || ''}"`,
                `"${row.dstchannel || ''}"`,
                `"${row.uniqueid || ''}"`
            ];
            csvContent += rowData.join(",") + "\n";
        }

        const filename = `cdr_export_${moment().format('YYYYMMDD_HHmmss')}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csvContent);

    } catch (error) {
        res.status(500).send("CDR Export Error: " + error.message);
    }
});

// --- VOICEMAIL ---
const VM_ROOT = '/var/spool/asterisk/voicemail/default';

function parseVmTxt(filePath) {
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const meta = {};
        for (const line of raw.split('\n')) {
            const idx = line.indexOf('=');
            if (idx > 0) meta[line.substring(0, idx).trim()] = line.substring(idx + 1).trim();
        }
        return meta;
    } catch { return null; }
}

function scanVoicemails() {
    const messages = [];
    if (!fs.existsSync(VM_ROOT)) return messages;
    const extDirs = fs.readdirSync(VM_ROOT, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const ext of extDirs) {
        const inbox = path.join(VM_ROOT, ext.name, 'INBOX');
        if (!fs.existsSync(inbox)) continue;
        const files = fs.readdirSync(inbox).filter(f => f.endsWith('.txt'));
        for (const txt of files) {
            const meta = parseVmTxt(path.join(inbox, txt));
            if (!meta) continue;
            const wavFile = txt.replace(/\.txt$/, '.wav');
            const wavPath = path.join(inbox, wavFile);
            const exists = fs.existsSync(wavPath);
            const origtime = meta.origtime ? parseInt(meta.origtime) * 1000 : 0;
            messages.push({
                mailbox: ext.name,
                callerid: (meta.callerid || '').replace(/"/g, ''),
                origdate: meta.origdate || '',
                origtime,
                duration: parseInt(meta.duration) || 0,
                context: meta.context || '',
                extension: meta.extension || '',
                wavFile: exists ? wavFile : null,
                txtFile: txt,
                read: meta.message === 'read'
            });
        }
    }
    messages.sort((a, b) => b.origtime - a.origtime);
    return messages;
}

app.get('/voicemails', (req, res) => {
    const allMsgs = scanVoicemails();
    const searchCallerid = req.query.searchCallerid || '';
    const searchMailbox = req.query.searchMailbox || '';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const perPage = Math.min(200, Math.max(1, parseInt(req.query.perPage) || 25));

    let filtered = allMsgs;
    if (searchCallerid) filtered = filtered.filter(m => m.callerid.toLowerCase().includes(searchCallerid.toLowerCase()));
    if (searchMailbox) filtered = filtered.filter(m => m.mailbox === searchMailbox);

    const total = filtered.length;
    const totalPages = Math.ceil(total / perPage) || 1;
    const paged = filtered.slice((page - 1) * perPage, page * perPage);

    const mailboxes = [...new Set(allMsgs.map(m => m.mailbox))].sort();

    res.render('voicemails', {
        messages: paged, mailboxes, moment,
        filters: { searchCallerid, searchMailbox, page, perPage },
        pagination: { total, totalPages, page, perPage }
    });
});

app.get('/api/voicemails', (req, res) => {
    const allMsgs = scanVoicemails();
    const searchCallerid = req.query.searchCallerid || '';
    const searchMailbox = req.query.searchMailbox || '';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const perPage = Math.min(200, Math.max(1, parseInt(req.query.perPage) || 25));

    let filtered = allMsgs;
    if (searchCallerid) filtered = filtered.filter(m => m.callerid.toLowerCase().includes(searchCallerid.toLowerCase()));
    if (searchMailbox) filtered = filtered.filter(m => m.mailbox === searchMailbox);

    const total = filtered.length;
    const totalPages = Math.ceil(total / perPage) || 1;
    const paged = filtered.slice((page - 1) * perPage, page * perPage);
    const mailboxes = [...new Set(allMsgs.map(m => m.mailbox))].sort();

    res.json({ messages: paged, mailboxes, pagination: { total, totalPages, page, perPage } });
});

app.get('/vm-audio/:mailbox/:file', (req, res) => {
    const filePath = path.join(VM_ROOT, req.params.mailbox, 'INBOX', req.params.file);
    if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' };
    const contentType = mimeTypes[ext] || 'audio/wav';
    const isDownload = req.query.download === '1';
    const range = req.headers.range;
    if (range && !isDownload) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': contentType });
        fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
        res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Content-Disposition': `${isDownload ? 'attachment' : 'inline'}; filename="${req.params.file}"` });
        fs.createReadStream(filePath).pipe(res);
    }
});

app.get('/vm-export', (req, res) => {
    const allMsgs = scanVoicemails();
    const searchCallerid = req.query.searchCallerid || '';
    const searchMailbox = req.query.searchMailbox || '';
    let filtered = allMsgs;
    if (searchCallerid) filtered = filtered.filter(m => m.callerid.toLowerCase().includes(searchCallerid.toLowerCase()));
    if (searchMailbox) filtered = filtered.filter(m => m.mailbox === searchMailbox);

    const csvHeaders = ["Mailbox", "Caller ID", "Date", "Duration (Sec)", "Extension", "File"];
    let csv = "\ufeff" + csvHeaders.map(h => `"${h}"`).join(",") + "\n";
    for (const m of filtered) {
        csv += [`"${m.mailbox}"`, `"${m.callerid}"`, `"${m.origtime ? moment(m.origtime).format('YYYY-MM-DD HH:mm:ss') : ''}"`, m.duration, `"${m.extension}"`, `"${m.wavFile || ''}"`].join(",") + "\n";
    }
    const filename = `voicemails_${moment().format('YYYYMMDD_HHmmss')}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
});

// --- API: GENERAL EXTENSIONS OVERVIEW ---
app.get('/api/ext-overview', async (req, res) => {
    try {
        const startDate = req.query.startDate ? moment(req.query.startDate).format('YYYY-MM-DD HH:mm:ss') : moment().startOf('day').format('YYYY-MM-DD HH:mm:ss');
        const endDate = req.query.endDate ? moment(req.query.endDate).format('YYYY-MM-DD HH:mm:ss') : moment().endOf('day').format('YYYY-MM-DD HH:mm:ss');

        const [rows] = await pool.query(`SELECT src, dst, billsec, REPLACE(disposition, 'CONGESTION', 'FAILED') as disposition, channel, dstchannel FROM ${tables.cdr} WHERE calldate BETWEEN ? AND ? AND dst NOT IN ('ussd','sms','report','s')`, [startDate, endDate]);

        const employeeMetrics = {};
        res.locals.roster.forEach(emp => {
            employeeMetrics[emp.extension] = { 
                extension: emp.extension, 
                name: emp.name, 
                online: emp.online,
                totalCalls: 0, 
                inboundCalls: 0,
                outboundCalls: 0,
                inboundTalkSec: 0, 
                outboundTalkSec: 0, 
                totalTalkSec: 0,
                uniqueContactCount: 0,
                uniqueNumbers: new Set() 
            };
        });

        rows.forEach(row => {
            const sec = parseInt(row.billsec) || 0;
            const isOutbound = isOutboundCdr(row);

            if (employeeMetrics[row.src]) {
                employeeMetrics[row.src].totalCalls++;
                employeeMetrics[row.src].uniqueNumbers.add(row.dst);
                if (isOutbound) {
                    employeeMetrics[row.src].outboundCalls++;
                    if (row.disposition === 'ANSWERED') employeeMetrics[row.src].outboundTalkSec += sec;
                } else {
                    employeeMetrics[row.src].inboundCalls++;
                    if (row.disposition === 'ANSWERED') employeeMetrics[row.src].inboundTalkSec += sec;
                }
            }
            if (employeeMetrics[row.dst]) {
                employeeMetrics[row.dst].totalCalls++;
                employeeMetrics[row.dst].uniqueNumbers.add(row.src);
                if (isOutbound) {
                    employeeMetrics[row.dst].outboundCalls++;
                    if (row.disposition === 'ANSWERED') employeeMetrics[row.dst].outboundTalkSec += sec;
                } else {
                    employeeMetrics[row.dst].inboundCalls++;
                    if (row.disposition === 'ANSWERED') employeeMetrics[row.dst].inboundTalkSec += sec;
                }
            }
        });

        const list = Object.values(employeeMetrics).map(emp => {
            emp.totalTalkSec = emp.inboundTalkSec + emp.outboundTalkSec;
            emp.uniqueContactCount = emp.uniqueNumbers.size;
            delete emp.uniqueNumbers;
            return emp;
        });

        res.json(list);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- ROUTE: EXTENSION STATISTICS VIEW ---
app.get('/ext-stats', (req, res) => {
    try {
        res.render('ext-stats', { moment });
    } catch (error) { res.status(500).send("Extension Stats Error: " + error.message); }
});

// --- API: EXTENSION STATISTICS DATA ---
app.get('/api/ext-stats/:extension', async (req, res) => {
    try {
        const { extension } = req.params;
        const startDate = req.query.startDate ? moment(req.query.startDate).format('YYYY-MM-DD HH:mm:ss') : moment().startOf('day').format('YYYY-MM-DD HH:mm:ss');
        const endDate = req.query.endDate ? moment(req.query.endDate).format('YYYY-MM-DD HH:mm:ss') : moment().endOf('day').format('YYYY-MM-DD HH:mm:ss');
        const direction = req.query.direction || 'all';

        const [rows] = await pool.query(
             `SELECT c.calldate, c.src, c.dst, c.duration, c.billsec, REPLACE(c.disposition, 'CONGESTION', 'FAILED') as disposition, c.channel, c.dstchannel, c.uniqueid
              FROM ${tables.cdr} c
              WHERE c.calldate BETWEEN ? AND ?
             AND (c.src = ? OR c.dst = ?)
             ORDER BY c.calldate DESC`,
            [startDate, endDate, extension, extension]
        );

        const stats = {
            extension,
            totalCalls: 0, answeredCalls: 0,
            inboundCalls: 0, outboundCalls: 0,
            inboundTalkSec: 0, outboundTalkSec: 0,
            totalTalkSec: 0, avgTalkSec: 0,
            uniqueContacts: new Set(),
            dispositionCounts: {},
            dailyBreakdown: {}
        };

        rows.forEach(row => {
            const sec = parseInt(row.billsec) || 0;
            const isOutboundCall = isOutboundCdr(row);
            const isSrc = row.src === extension;
            const isDst = row.dst === extension;

            if (!isSrc && !isDst) return;

            let callDirection = 'internal';
            if (isSrc && isOutboundCall) callDirection = 'outbound';
            else if (isDst && !isOutboundCall) callDirection = 'inbound';
            if (isSrc && isDst) callDirection = 'internal';

            if (direction === 'inbound' && callDirection !== 'inbound') return;
            if (direction === 'outbound' && callDirection !== 'outbound') return;

            stats.totalCalls++;
            if (row.disposition === 'ANSWERED') stats.answeredCalls++;

            if (callDirection === 'outbound') {
                stats.outboundCalls++;
                if (row.disposition === 'ANSWERED') stats.outboundTalkSec += sec;
                stats.uniqueContacts.add(row.dst);
            } else if (callDirection === 'inbound') {
                stats.inboundCalls++;
                if (row.disposition === 'ANSWERED') stats.inboundTalkSec += sec;
                stats.uniqueContacts.add(row.src);
            } else {
                stats.uniqueContacts.add(row.dst);
                stats.uniqueContacts.add(row.src);
            }

            const disp = row.disposition || 'UNKNOWN';
            stats.dispositionCounts[disp] = (stats.dispositionCounts[disp] || 0) + 1;

            const day = moment(row.calldate).format('YYYY-MM-DD');
            if (!stats.dailyBreakdown[day]) {
                stats.dailyBreakdown[day] = { total: 0, answered: 0, inbound: 0, outbound: 0 };
            }
            stats.dailyBreakdown[day].total++;
            if (row.disposition === 'ANSWERED') stats.dailyBreakdown[day].answered++;
            if (callDirection === 'inbound') stats.dailyBreakdown[day].inbound++;
            if (callDirection === 'outbound') stats.dailyBreakdown[day].outbound++;
        });

        stats.totalTalkSec = stats.inboundTalkSec + stats.outboundTalkSec;
        stats.avgTalkSec = stats.answeredCalls ? Math.round(stats.totalTalkSec / stats.answeredCalls) : 0;
        stats.uniqueContactCount = stats.uniqueContacts.size;
        stats.uniqueContacts = [...stats.uniqueContacts];
        stats.dispositionData = Object.entries(stats.dispositionCounts).map(([name, value]) => ({ name, value }));
        stats.dailyData = Object.entries(stats.dailyBreakdown)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, data]) => ({ date, ...data }));

        stats.recentCalls = [];
        for (const row of rows) {
            const sec = parseInt(row.billsec) || 0;
            const isOutboundCall = isOutboundCdr(row);
            const isSrc = row.src === extension;
            const isDst = row.dst === extension;
            if (!isSrc && !isDst) continue;
            let callDirection = 'internal';
            if (isSrc && isOutboundCall) callDirection = 'outbound';
            else if (isDst && !isOutboundCall) callDirection = 'inbound';
            if (isSrc && isDst) callDirection = 'internal';
            if (direction === 'inbound' && callDirection !== 'inbound') continue;
            if (direction === 'outbound' && callDirection !== 'outbound') continue;
            stats.recentCalls.push({
                calldate: row.calldate,
                src: row.src, dst: row.dst,
                billsec: sec, disposition: row.disposition
            });
            if (stats.recentCalls.length >= 50) break;
        }

        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Hangup endpoint to end call on a specific extension
app.post('/api/hangup/:extension', (req, res) => {
    try {
        const { extension } = req.params;
        const call = activeCalls[extension];
        if (!call || !call.channel) {
            return res.status(404).json({ success: false, error: 'No active channel found for extension.' });
        }
        if (amiClient) {
            amiClient.write(`Action: Hangup\r\nChannel: ${call.channel}\r\n\r\n`);
            return res.json({ success: true });
        } else {
            return res.status(500).json({ success: false, error: 'AMI not connected.' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- ROUTE 3: DEDICATED LIVE OPERATOR PANEL VIEW ---
app.get('/operator', (req, res) => {
    try {
        res.render('operator', { moment });
    } catch (error) { res.status(500).send("Operator Panel Engine Error: " + error.message); }
});

// --- GSM DONGLES MONITOR & USSD ROUTING ENGINE ---
let latestUssdResponses = {}; // dongle_id -> { text, timestamp, logTime }
let latestAtResponses = {};  // dongle_id -> { text, timestamp }
const atResponsePattern = /\[([^\]]+)\] VERBOSE\[\d+\] at_response\.c:\s+\[([^\]]+)\] Got Response for user's command:'(.*)/s;

// Persistent IMSI-to-Phone number mapping database on disk
const MAPPINGS_FILE = '/opt/issabel-dashboard/sim_mappings.json';

function readSimMappings() {
    const fs = require('fs');
    try {
        if (fs.existsSync(MAPPINGS_FILE)) {
            return JSON.parse(fs.readFileSync(MAPPINGS_FILE, 'utf8'));
        }
    } catch (err) {
        console.error("GSM MONITOR: Error reading sim mappings:", err);
    }
    // Default seed mapping
    return {
        '602019513016594': '+201027826232'
    };
}

function saveSimMappings(mappings) {
    const fs = require('fs');
    try {
        fs.writeFileSync(MAPPINGS_FILE, JSON.stringify(mappings, null, 4), 'utf8');
        console.log("GSM MONITOR: Saved SIM mappings to", MAPPINGS_FILE);
    } catch (err) {
        console.error("GSM MONITOR: Error saving sim mappings:", err);
    }
}

// Helper to read all configured numbers from /etc/asterisk/dongle.conf
function getConfiguredDongleNumbers() {
    const fs = require('fs');
    const filePath = '/etc/asterisk/dongle.conf';
    const numbers = {};
    if (!fs.existsSync(filePath)) return numbers;
    
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split(/\r?\n/);
        let currentDongle = null;
        
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(';')) continue;
            
            const sectionMatch = trimmed.match(/^\[(dongle\d+)\]$/i);
            if (sectionMatch) {
                currentDongle = sectionMatch[1].toLowerCase();
                continue;
            }
            
            if (currentDongle && (trimmed.toLowerCase().startsWith('number=') || trimmed.toLowerCase().startsWith('exten='))) {
                const parts = trimmed.split('=');
                if (parts.length >= 2) {
                    const num = parts.slice(1).join('=').split(';')[0].trim();
                    if (num) {
                        numbers[currentDongle] = num;
                    }
                }
            }
        }
    } catch (err) {
        console.error("GSM MONITOR: Error reading config for numbers:", err);
    }
    return numbers;
}

// Enrich device state with precise value from 'dongle show device state'
function enrichPreciseState(devices, callback) {
    // Pass-through — mirror raw dongle show devices output exactly
    callback(devices);
}

// Caching layer for 'dongle show devices' to prevent CLI command storms
let cachedDevicesOutput = null;
let lastDevicesOutputFetch = 0;
const DEVICES_CACHE_TTL = 1000;

function getDevicesOutputCached(callback) {
    const now = Date.now();
    if (cachedDevicesOutput && (now - lastDevicesOutputFetch) < DEVICES_CACHE_TTL) {
        return callback(null, cachedDevicesOutput);
    }
    execFile(ASTERISK_BIN, ['-rx', 'dongle show devices'], (error, stdout, stderr) => {
        if (error) return callback(error || new Error(stderr), null);
        cachedDevicesOutput = stdout;
        lastDevicesOutputFetch = now;
        callback(null, stdout);
    });
}

// Parse Asterisk 'dongle show devices' CLI output
function parseDevicesOutput(output, keepRaw = false, astDbMappings = {}) {
    const lines = output.trim().split('\n');
    if (lines.length === 0) return [];
    const header = lines[0];
    const colNames = ["ID", "Group", "State", "RSSI", "Mode", "Submode", "Provider Name", "Model", "Firmware", "IMEI", "IMSI", "Number"];
    const indices = colNames.map(name => header.indexOf(name));
    indices.push(header.length + 100);
    
    const devices = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim() || line.startsWith('-----') || line.includes('ID')) {
            continue;
        }
        const row = {};
        for (let j = 0; j < colNames.length; j++) {
            const start = indices[j];
            const end = indices[j+1];
            if (start !== -1 && start < line.length) {
                row[colNames[j]] = line.substring(start, Math.min(end, line.length)).trim();
            } else {
                row[colNames[j]] = '';
            }
        }
        if (row.ID && row.ID.startsWith("dongle")) {
            // Fallback for transpositions where the firmware reports IMEI in the IMSI field
            if ((!row.IMEI || row.IMEI === '-' || row.IMEI === 'Unknown') && row.IMSI && (row.IMSI.startsWith('86') || row.IMSI.startsWith('35'))) {
                row.IMEI = row.IMSI;
            }
            const mapped = astDbMappings[row.IMSI] || astDbMappings[row.IMEI] || null;
            if (mapped && (!row.Number || row.Number === 'Unknown' || row.Number === '-')) {
                row.Number = mapped;
            }
            devices.push(row);
        }
    }
    return devices;
}

// Local cache to throttle USSD phone number queries to avoid spamming the carrier networks
let lastUssdQueryTimes = {}; // IMSI -> timestamp (Date)

function extractPhoneNumber(text) {
    if (!text) return null;
    
    // Convert Arabic numerals to standard English digits
    const arabicDigits = [/٠/g, /١/g, /٢/g, /٣/g, /٤/g, /٥/g, /٦/g, /٧/g, /٨/g, /٩/g];
    let cleanText = String(text);
    for (let i = 0; i < 10; i++) {
        cleanText = cleanText.replace(arabicDigits[i], String(i));
    }
    
    // Strip spaces, dashes, brackets, colons, equal signs
    cleanText = cleanText.replace(/[\s\-\(\)\:\+\=]/g, '');
    
    // Look for 11 digits starting with 1xxxxxxxx or 01xxxxxxxx (which are standard Egyptian Mobile structures)
    const match = cleanText.match(/\b(?:20)?(1[0125]\d{8})\b/);
    if (match) {
        return '+20' + match[1];
    }
    
    // Fallback: search for any sequence of 10 or 11 digits
    const generalMatch = cleanText.match(/\b(1[0125]\d{8})\b/) || cleanText.match(/\b(01[0125]\d{8})\b/);
    if (generalMatch) {
        let numStr = generalMatch[1];
        if (numStr.startsWith('0')) numStr = numStr.substring(1);
        return '+20' + numStr;
    }
    
    return null;
}

// Read the hot-plug number mappings from Asterisk AstDB (DONGLE_NUMBERS family)
function getAstDbNumbers(callback) {
    execFile(ASTERISK_BIN, ['-rx', 'database show DONGLE_NUMBERS'], (error, stdout) => {
        const mappings = {};
        if (error || !stdout) {
            return callback(mappings);
        }
        const lines = stdout.split('\n');
        lines.forEach(line => {
            // Match pattern: /DONGLE_NUMBERS/<key>                   : <number>
            const match = /\/DONGLE_NUMBERS\/([a-zA-Z0-9_]+)\s*:\s*(\+?\d+)/.exec(line);
            if (match) {
                const key = match[1];
                const number = match[2];
                mappings[key] = number;
            }
        });
        callback(mappings);
    });
}

// Start background tail log monitor on the Asterisk verbose log file
function startUssdLogMonitor() {
    console.log("GSM MONITOR: Starting tail process on /var/log/asterisk/full...");
    const tail = spawn('tail', ['-n', '0', '-F', '/var/log/asterisk/full']);
    
    let logBuffer = "";
    let flushTimeout = null;
    
    const responsePattern = /\[([^\]]+)\] VERBOSE\[\d+\] at_response\.c:\s+\[([^\]]+)\] Got USSD type \d+ '[^']*':\s*'(.*)/s; // Added /s flag to capture multi-line USSD response!
    const dongleLogPattern = /chan_dongle|at_response|app_ussd|dongle[0-9]+/i;

    function processLogStatement(statement) {
        if (!statement.trim()) return;
        
        // Log streaming
        if (dongleLogPattern.test(statement)) {
            io.emit('dongleLog', statement.trim());
        }
        
        // Parse SMS received log directly from chan_dongle at_response.c core to support multi-line and multi-part SMS reassembly
        if (statement.includes('Got full SMS from')) {
            const smsPattern = /\[([^\]]+)\] VERBOSE\[\d+\] at_response\.c:\s+\[([^\]]+)\] Got full SMS from ([^:]+):\s*'(.*)/s;
            const smsMatch = smsPattern.exec(statement);
            if (smsMatch) {
                const dongleId = smsMatch[2].trim();
                const sender = smsMatch[3].trim();
                let content = smsMatch[4].trim();
                // Trim trailing quote
                content = content.replace(/'\s*$/, '').trim();
                
                const newSms = {
                    id: Date.now() + '-' + Math.floor(Math.random() * 1000),
                    dongleId,
                    sender,
                    content,
                    timestamp: Date.now()
                };
                const inbox = readSmsInbox();
                inbox.unshift(newSms);
                if (inbox.length > 100) inbox.pop();
                saveSmsInbox(inbox);
                io.emit('newSms', newSms);
                console.log(`GSM MONITOR: Saved incoming SMS on ${dongleId} from ${sender} -> ${content}`);
            }
        }
        
        // Parse USSD response
        const match = responsePattern.exec(statement);
        if (match) {
            const logTime = match[1].trim();
            const dongleId = match[2].trim();
            let text = match[3].trim();
            // Trim trailing quote if it exists (Asterisk log format wrapper)
            text = text.replace(/'\s*$/, '').trim();
            console.log(`GSM MONITOR: Captured USSD response for ${dongleId} -> ${text}`);
            latestUssdResponses[dongleId] = {
                text: text,
                timestamp: Date.now(),
                logTime: logTime
            };
            io.emit('ussdResponse', { dongleId, text, logTime });
        }

        const atMatch = atResponsePattern.exec(statement);
        if (atMatch) {
            const dongleId = atMatch[2].trim();
            let text = atMatch[3].trim();
            text = text.replace(/'$/, '').trim();
            latestAtResponses[dongleId] = {
                text: text,
                timestamp: Date.now()
            };
        }
    }

    function flushLogBuffer() {
        if (!logBuffer.trim()) return;
        
        const lines = logBuffer.split('\n');
        logBuffer = "";
        
        let currentStatement = null;
        for (const line of lines) {
            const isNewStatement = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/.test(line);
            if (isNewStatement) {
                if (currentStatement) {
                    processLogStatement(currentStatement);
                }
                currentStatement = line;
            } else {
                if (currentStatement) {
                    currentStatement += '\n' + line;
                } else {
                    currentStatement = line;
                }
            }
        }
        if (currentStatement) {
            processLogStatement(currentStatement);
        }
    }
    
    tail.stdout.on('data', (data) => {
        logBuffer += data.toString();
        if (flushTimeout) clearTimeout(flushTimeout);
        flushTimeout = setTimeout(flushLogBuffer, 50);
    });
    
    tail.stderr.on('data', (data) => {
        console.error(`GSM MONITOR: tail stderr: ${data}`);
    });
    
    tail.on('close', (code) => {
        console.log(`GSM MONITOR: tail process closed with code ${code}. Reconnecting in 5s...`);
        setTimeout(startUssdLogMonitor, 5000);
    });
}

// Import spawn from child_process
const { spawn } = require('child_process');
startUssdLogMonitor();

function normalizeMsisdn(raw) {
    let num = raw.replace(/[^0-9+]/g, '');
    if (num.startsWith('+')) return num;
    if (num.startsWith('00')) return '+' + num.slice(2);
    if (num.startsWith('01')) return '+20' + num.slice(1);
    return '+' + num;
}

function sendAtAndWait(dongleId, atCmd, timeoutMs, callback) {
    delete latestAtResponses[dongleId];
    execFile(ASTERISK_BIN, ['-rx', `dongle cmd ${dongleId} ${atCmd}`], (err) => {
        if (err) return callback({ error: err.message });
        const start = Date.now();
        function poll() {
            const resp = latestAtResponses[dongleId];
            if (resp) {
                delete latestAtResponses[dongleId];
                const text = resp.text || '';
                const isOk = /OK/i.test(text) || text.includes('+CPBW');
                return callback({ error: isOk ? null : ('AT response: ' + text), output: text });
            }
            if (Date.now() - start >= timeoutMs) return callback({ error: 'timeout', output: '' });
            setTimeout(poll, 400);
        }
        setTimeout(poll, 1500);
    });
}

// Endpoint to manually set/save a SIM's phone number mapping
app.post('/api/gsm-dongles/save-number', (req, res) => {
    try {
        const { imsi, number, dongleId } = req.body;
        if (!imsi || !number) {
            return res.status(400).json({ success: false, error: 'IMSI and phone number are required.' });
        }

        const simMappings = readSimMappings();
        simMappings[imsi] = number;
        saveSimMappings(simMappings);

        const normalized = normalizeMsisdn(number);
        console.log(`GSM MONITOR: Manual save number for IMSI: ${imsi} -> ${number} (normalized: ${normalized})`);

        execFile(ASTERISK_BIN, ['-rx', 'dongle show devices'], (errDevs, stdoutDevs) => {
            let imei = null;
            if (!errDevs && stdoutDevs) {
                const devices = parseDevicesOutput(stdoutDevs, true);
                const dev = devices.find(d => d.ID.toLowerCase() === dongleId.toLowerCase() || d.IMSI === imsi);
                if (dev && dev.IMEI && dev.IMEI !== '-') imei = dev.IMEI;
            }
            if (imei) execFile(ASTERISK_BIN, ['-rx', `database put DONGLE_NUMBERS ${imei} ${number}`]);
            execFile(ASTERISK_BIN, ['-rx', `database put DONGLE_NUMBERS ${imsi} ${number}`]);

            io.emit('dongleNumberUpdated', { dongleId, number });
            return res.json({ success: true, message: 'SIM number saved to dashboard and AstDB.' });
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// API endpoint to reset USB port for a dongle (unplug/replug simulation)
app.post('/api/gsm-dongles/reset-usb-port', (req, res) => {
    const { dongleId } = req.body;
    if (!dongleId || !/^dongle[0-9]+$/.test(dongleId)) {
        return res.status(400).json({ success: false, error: 'Valid dongle ID required.' });
    }

    const results = [];
    const runAsterisk = (cmd) => new Promise((resolve, reject) => {
        execFile(ASTERISK_BIN, ['-rx', cmd], (err) => {
            if (err) return reject(err.message);
            results.push({ step: cmd, error: null, output: cmd + ' ok' });
            resolve();
        });
    });
    const delay = (ms) => new Promise(r => setTimeout(r, ms));

    runAsterisk('module unload chan_dongle.so')
        .then(() => delay(1000))
        .then(() => runAsterisk('module load chan_dongle.so'))
        .then(() => delay(8000))
        .then(() => {
            execFile(ASTERISK_BIN, ['-rx', 'dongle show devices'], (err, stdout) => {
                const found = stdout && stdout.includes(dongleId) && !stdout.includes('Not connec');
                io.emit('dongleProvisionResult', { dongleId, results });
                io.emit('usbDevicesUpdated');
                if (found) {
                    res.json({ success: true, message: dongleId + ' reset successfully.', results });
                } else {
                    res.json({ success: false, error: dongleId + ' did not reconnect after module reload.', results });
                }
            });
        })
        .catch(error => {
            io.emit('dongleProvisionResult', { dongleId, results });
            io.emit('usbDevicesUpdated');
            res.json({ success: false, error: 'Module reload failed: ' + error, results });
        });
});
// Page View route
app.get('/gsm-dongles', (req, res) => {
    try {
        getAstDbNumbers(astDbMappings => {
            getDevicesOutputCached((error, stdout) => {
                let devices = [];
                if (!error && stdout) {
                    devices = parseDevicesOutput(stdout, false, astDbMappings);
                }
                enrichPreciseState(devices, enriched => {
                    res.render('gsm-dongles', {
                        devices: enriched,
                        moment
                    });
                });
            });
        });
    } catch (error) {
        res.status(500).send("GSM Dongle System Error: " + error.message);
    }
});

// API Endpoint to fetch latest device status
app.get('/api/gsm-dongles', (req, res) => {
    getAstDbNumbers(astDbMappings => {
        getDevicesOutputCached((error, stdout) => {
            if (error) {
                return res.status(500).json({ success: false, error: error.message });
            }
            const devices = parseDevicesOutput(stdout, false, astDbMappings);
            enrichPreciseState(devices, enriched => {
                res.json({ success: true, devices: enriched });
            });
        });
    });
});

// API Endpoint to reload specific dongle
app.post('/api/gsm-dongles/reload/:dongleId', (req, res) => {
    const { dongleId } = req.params;
    if (!/^dongle[0-9]+$/.test(dongleId)) {
        return res.status(400).json({ success: false, error: "Invalid dongle ID format" });
    }
    execFile(ASTERISK_BIN, ['-rx', `dongle restart now ${dongleId}`], (error, stdout, stderr) => {
        if (error) {
            return res.status(500).json({ success: false, error: stderr || error.message });
        }
        io.emit('usbDevicesUpdated');
        res.json({ success: true, output: stdout.trim() });
    });
});

// API Endpoint to re-detect dongle SIM numbers and update trunk caller IDs
app.post('/api/gsm-dongles/redetect', async (req, res) => {
    try {
        await detectDonglesAndSetTrunkCID();
        io.emit('usbDevicesUpdated');
        res.json({ success: true, message: 'Dongle SIM numbers re-detected and trunk caller IDs updated' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Internal endpoint for auto-restart script to emit USB update event
app.post('/api/gsm-dongles/emit-usb-update', (req, res) => {
    io.emit('usbDevicesUpdated');
    res.json({ ok: true });
});

// API Endpoint to list /dev/ttyUSB* devices with dongle mapping
app.get('/api/gsm-dongles/ttyusb-devices', requireAuth, (req, res) => {
    const { execSync } = require('child_process');
    const fs = require('fs');
    try {
        const raw = execSync('ls /dev/ | grep -i ttyusb', { encoding: 'utf8', timeout: 5000 }).trim();
        const devices = raw ? raw.split('\n').filter(Boolean) : [];

        // Parse dongle.conf to map ports to dongle IDs
        const portMap = {};
        try {
            const conf = fs.readFileSync('/etc/asterisk/dongle.conf', 'utf8');
            let currentSection = null;
            for (const line of conf.split('\n')) {
                const secMatch = line.match(/^\[([^\]]+)\]/);
                if (secMatch) { currentSection = secMatch[1]; continue; }
                if (!currentSection || currentSection === 'general') continue;
                const audioMatch = line.match(/^\s*audio\s*=\s*\/dev\/(ttyUSB\d+)/i);
                if (audioMatch) portMap[audioMatch[1]] = { dongleId: currentSection, portType: 'audio' };
                const dataMatch = line.match(/^\s*data\s*=\s*\/dev\/(ttyUSB\d+)/i);
                if (dataMatch) portMap[dataMatch[1]] = { dongleId: currentSection, portType: 'data' };
            }
        } catch (_) {}

        const enriched = devices.map(d => ({
            name: d,
            dongleId: portMap[d] ? portMap[d].dongleId : null,
            portType: portMap[d] ? portMap[d].portType : null
        }));

        res.json({ success: true, devices: enriched });
    } catch (e) {
        res.json({ success: true, devices: [] });
    }
});

// API Endpoint to send USSD request
app.post('/api/gsm-dongles/ussd', (req, res) => {
    const { dongle, code } = req.body;
    if (!dongle || !code) {
        return res.status(400).json({ success: false, error: "Dongle and USSD code are required" });
    }
    if (!/^dongle[0-9]+$/.test(dongle)) {
        return res.status(400).json({ success: false, error: "Invalid dongle ID format" });
    }
    if (!/^[0-9*#+,]+$/.test(code)) {
        return res.status(400).json({ success: false, error: "Invalid USSD code format" });
    }
    
    // Clear previous response for this dongle
    delete latestUssdResponses[dongle];
    
    execFile(ASTERISK_BIN, ['-rx', `dongle ussd ${dongle} ${code}`], (error, stdout, stderr) => {
        if (error) {
            return res.status(500).json({ success: false, error: stderr || error.message });
        }
        
        // Poll for response (up to 15 seconds)
        const timeout = 15000;
        const pollInterval = 250;
        const startTime = Date.now();
        
        const checkResponse = () => {
            if (latestUssdResponses[dongle]) {
                const resp = latestUssdResponses[dongle];
                delete latestUssdResponses[dongle]; // consume
                return res.json({
                    success: true,
                    response: resp.text,
                    logTime: resp.logTime
                });
            }
            
            if (Date.now() - startTime >= timeout) {
                return res.status(504).json({
                    success: false,
                    error: "Timeout waiting for USSD response from the cellular network."
                });
            }
            
            setTimeout(checkResponse, pollInterval);
        };
        
        setTimeout(checkResponse, pollInterval);
    });
});


// --- ROUTE 5: AUDIO STREAM / DOWNLOAD PIPELINE ---
app.get('/audio/:uniqueid', async (req, res) => {
    try {
        const { uniqueid } = req.params;
        const [rows] = await pool.query(`SELECT calldate, recordingfile FROM ${tables.cdr} WHERE uniqueid = ? LIMIT 1`, [uniqueid]);
        if (!rows.length || !rows[0].recordingfile) return res.status(404).send("Audio not found.");

        const callDate = moment(rows[0].calldate);
        const filename = rows[0].recordingfile;
        const pathsToSearch = [
            path.join(RECORDING_ROOT, callDate.format('YYYY'), callDate.format('MM'), callDate.format('DD'), filename),
            path.join(RECORDING_ROOT, filename)
        ];

        let targetPath = null;
        for (const p of pathsToSearch) { if (fs.existsSync(p)) { targetPath = p; break; } }
        if (!targetPath) return res.status(404).send("Audio file missing.");

        const stat = fs.statSync(targetPath);
        const fileSize = stat.size;
        const ext = path.extname(filename).toLowerCase();
        const mimeTypes = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wma': 'audio/x-ms-wma', '.sln': 'audio/wav', '.wav49': 'audio/wav' };
        const contentType = mimeTypes[ext] || 'audio/wav';

        const isDownload = req.query.download === '1';
        const range = req.headers.range;
        if (range && !isDownload) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunkSize = end - start + 1;
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunkSize,
                'Content-Type': contentType
            });
            fs.createReadStream(targetPath, { start, end }).pipe(res);
        } else {
            const disposition = isDownload ? 'attachment' : 'inline';
            res.writeHead(200, {
                'Content-Length': fileSize,
                'Content-Type': contentType,
                'Accept-Ranges': 'bytes',
                'Content-Disposition': `${disposition}; filename="${filename}"`
            });
            fs.createReadStream(targetPath).pipe(res);
        }
    } catch (err) { res.status(500).send("Audio Error: " + err.message); }
});

const SMS_INBOX_FILE = path.join(__dirname, 'sms_inbox.json');
function readSmsInbox() {
    try {
        if (fs.existsSync(SMS_INBOX_FILE)) {
            return JSON.parse(fs.readFileSync(SMS_INBOX_FILE, 'utf8'));
        }
    } catch (e) {
        console.error("GSM MONITOR: Failed to read sms_inbox.json:", e);
    }
    return [];
}
function saveSmsInbox(inbox) {
    try {
        fs.writeFileSync(SMS_INBOX_FILE, JSON.stringify(inbox, null, 2), 'utf8');
    } catch (e) {
        console.error("GSM MONITOR: Failed to save sms_inbox.json:", e);
    }
}

// Endpoint to fetch SMS inbox
app.get('/api/gsm-dongles/sms', (req, res) => {
    try {
        const inbox = readSmsInbox();
        res.json({ success: true, sms: inbox });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Endpoint to clear SMS inbox
app.post('/api/gsm-dongles/clear-sms', (req, res) => {
    try {
        saveSmsInbox([]);
        io.emit('smsCleared');
        res.json({ success: true, message: 'SMS inbox cleared.' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Watchdog disabled — number provisioning is manual only


// --- CONTACTS MANAGEMENT (SQLite address_book.db) ---
const sqliteDbPath = '/var/www/db/address_book.db';

function runSqlite(sql) {
    return new Promise((resolve, reject) => {
        const proc = spawn('sqlite3', [sqliteDbPath]);
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', data => stdout += data);
        proc.stderr.on('data', data => stderr += data);
        proc.on('close', code => {
            if (code === 0) resolve(stdout);
            else reject(new Error(stderr || `sqlite3 exited with code ${code}`));
        });
        proc.stdin.write(sql);
        proc.stdin.end();
    });
}

function runSqliteQuery(sql) {
    return new Promise((resolve, reject) => {
        const proc = spawn('sqlite3', ['-separator', '~~~', sqliteDbPath]);
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', data => stdout += data);
        proc.stderr.on('data', data => stderr += data);
        proc.on('close', code => {
            if (code === 0) resolve(stdout);
            else reject(new Error(stderr || `sqlite3 exited with code ${code}`));
        });
        proc.stdin.write(sql);
        proc.stdin.end();
    });
}

function parseSqliteRows(stdout) {
    const lines = stdout.split('\n');
    const rows = [];
    for (let line of lines) {
        if (!line.trim()) continue;
        const parts = line.split('~~~');
        if (parts.length >= 4) {
            rows.push({
                id: parts[0],
                name: parts[1],
                last_name: parts[2],
                telefono: parts[3]
            });
        }
    }
    return rows;
}

function escapeSql(str) {
    return String(str || '').replace(/'/g, "''").trim();
}

app.get('/contacts', requireAuth, async (req, res) => {
    try {
        const stdout = await runSqliteQuery("SELECT id, name, last_name, telefono FROM contact ORDER BY name ASC, last_name ASC;");
        const contacts = parseSqliteRows(stdout);
        const currentLang = req.query.lang || 'en';
        res.render('contacts', {
            contacts,
            currentPage: '/contacts',
            currentLang,
            isSuperAdmin: isSuperAdmin(req)
        });
    } catch (err) {
        res.status(500).send("Database Error: " + err.message);
    }
});

app.post('/api/contacts/add', async (req, res) => {
    if (!isSuperAdmin(req)) {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    try {
        const { firstName, lastName, phone } = req.body;
        if (!firstName || !phone) {
            return res.status(400).json({ success: false, error: 'First name and Phone number are required' });
        }
        
        const fEsc = escapeSql(firstName);
        const lEsc = escapeSql(lastName);
        const cleanedPhone = phone.replace(/[\s\-\(\)\.]/g, '');
        let finalPhone = cleanedPhone;
        if (/^\d+$/.test(cleanedPhone) && !cleanedPhone.startsWith('0') && cleanedPhone.length >= 7) {
            finalPhone = '0' + cleanedPhone;
        }
        const pEsc = escapeSql(finalPhone);
        
        const sql = `INSERT INTO contact (name, last_name, telefono, iduser, status, directory) VALUES ('${fEsc}', '${lEsc}', '${pEsc}', 1, 'isPublic', 'external');`;
        await runSqlite(sql);
        res.json({ success: true, message: 'Contact saved successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/contacts/edit', async (req, res) => {
    if (!isSuperAdmin(req)) {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    try {
        const { id, firstName, lastName, phone } = req.body;
        if (!id || !firstName || !phone) {
            return res.status(400).json({ success: false, error: 'ID, First Name and Phone number are required' });
        }
        const idEsc = escapeSql(id);
        const fEsc = escapeSql(firstName);
        const lEsc = escapeSql(lastName);
        const cleanedPhone = phone.replace(/[\s\-\(\)\.]/g, '');
        let finalPhone = cleanedPhone;
        if (/^\d+$/.test(cleanedPhone) && !cleanedPhone.startsWith('0') && cleanedPhone.length >= 7) {
            finalPhone = '0' + cleanedPhone;
        }
        const pEsc = escapeSql(finalPhone);
        
        const sql = `UPDATE contact SET name = '${fEsc}', last_name = '${lEsc}', telefono = '${pEsc}' WHERE id = ${idEsc};`;
        await runSqlite(sql);
        res.json({ success: true, message: 'Contact updated successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/contacts/delete', async (req, res) => {
    if (!isSuperAdmin(req)) {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    try {
        const { id } = req.body;
        if (!id) {
            return res.status(400).json({ success: false, error: 'ID is required' });
        }
        const idEsc = escapeSql(id);
        const sql = `DELETE FROM contact WHERE id = ${idEsc};`;
        await runSqlite(sql);
        res.json({ success: true, message: 'Contact deleted successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- PBX CONFIGURATION TAB VIEW & REST APIS ---

// GET /config - render Configuration Management page
app.get('/config', requireAuth, (req, res) => {
    const currentLang = req.query.lang || 'en';
    res.render('config', {
        moment,
        currentPage: '/config',
        currentLang,
        isRtl: currentLang === 'ar',
        isSuperAdmin: isSuperAdmin(req)
    });
});

// Helper function to reload PBX config via retrieve_conf & core reload
function reloadPbxConfig(callback) {
    const cmd = 'sudo -u asterisk /var/lib/asterisk/bin/retrieve_conf && /usr/sbin/asterisk -rx "core reload"';
    exec(cmd, (error, stdout, stderr) => {
        if (error) {
            console.error('PBX Reload error:', error.message);
            return callback({ success: false, error: error.message, details: stderr });
        }
        console.log('PBX Reload success:', stdout);
        return callback({ success: true, output: stdout });
    });
}

// POST /api/config/reload - Trigger retrieve_conf and core reload
app.post('/api/config/reload', (req, res) => {
    reloadPbxConfig((result) => {
        if (!result.success) {
            return res.status(500).json(result);
        }
        res.json(result);
    });
});

// --- 1. EXTENSIONS MANAGEMENT APIs ---

// Helper function to manage /etc/asterisk/voicemail.conf for FreePBX/Issabel GUI
function updateVoicemailConf(extNum, displayName, vmVal) {
    const vmFile = '/etc/asterisk/voicemail.conf';
    try {
        if (!fs.existsSync(vmFile)) return;
        let content = fs.readFileSync(vmFile, 'utf8');
        let lines = content.split('\n');
        
        // Remove existing entry for this extension
        lines = lines.filter(line => !line.trim().startsWith(`${extNum} =>`));
        
        if (vmVal === 'default' || vmVal === 'enabled') {
            const entry = `${extNum} => ,${displayName || extNum},,,attach=no|saycid=no|envelope=no|delete=no`;
            lines.push(entry);
        }
        
        fs.writeFileSync(vmFile, lines.join('\n'), 'utf8');
        exec(`${ASTERISK_BIN} -rx 'voicemail reload'`, (err) => {
            if (err) console.error('Voicemail reload error:', err.message);
        });
    } catch (e) {
        console.error('updateVoicemailConf error:', e.message);
    }
}

// Helper function to sync extension astdb recording & user settings
function setExtensionAstdbDefaults(extNum, displayName, vmVal = 'novm') {
    const commands = [
        `database put AMPUSER ${extNum}/answermode disabled`,
        `database put AMPUSER ${extNum}/cfringtimer 0`,
        `database put AMPUSER ${extNum}/cidname "${displayName}"`,
        `database put AMPUSER ${extNum}/cidnum "${extNum}"`,
        `database put AMPUSER ${extNum}/concurrency_limit 0`,
        `database put AMPUSER ${extNum}/device "${extNum}"`,
        `database put AMPUSER ${extNum}/recording/in/external always`,
        `database put AMPUSER ${extNum}/recording/in/internal always`,
        `database put AMPUSER ${extNum}/recording/ondemand disabled`,
        `database put AMPUSER ${extNum}/recording/out/external always`,
        `database put AMPUSER ${extNum}/recording/out/internal always`,
        `database put AMPUSER ${extNum}/recording/priority 10`,
        `database put AMPUSER ${extNum}/ringtimer 0`,
        `database put AMPUSER ${extNum}/voicemail ${vmVal}`
    ];
    commands.forEach(cmd => {
        exec(`${ASTERISK_BIN} -rx '${cmd}'`, (err) => {
            if (err) console.error(`AstDB error (${cmd}):`, err.message);
        });
    });

    updateVoicemailConf(extNum, displayName, vmVal);
}

// GET /api/config/extensions - List all Extensions
app.get('/api/config/extensions', async (req, res) => {
    try {
        const [extensions] = await pool.query(`
            SELECT u.extension, u.name, u.outboundcid, u.recording, u.voicemail,
                   s_secret.data AS secret, s_context.data AS context, s_nat.data AS nat
            FROM \`asterisk\`.\`users\` u
            LEFT JOIN \`asterisk\`.\`sip\` s_secret ON s_secret.id = u.extension AND s_secret.keyword = 'secret'
            LEFT JOIN \`asterisk\`.\`sip\` s_context ON s_context.id = u.extension AND s_context.keyword = 'context'
            LEFT JOIN \`asterisk\`.\`sip\` s_nat ON s_nat.id = u.extension AND s_nat.keyword = 'nat'
            ORDER BY CAST(u.extension AS UNSIGNED) ASC
        `);
        res.json({ success: true, extensions });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/config/extensions - Create new Generic SIP Extension
app.post('/api/config/extensions', async (req, res) => {
    try {
        const { extension, name, secret, voicemail } = req.body;
        if (!extension || !/^\d+$/.test(extension)) {
            return res.status(400).json({ success: false, error: 'Valid numeric Extension number is required.' });
        }
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'Display Name is required.' });
        }
        if (!secret || !secret.trim()) {
            return res.status(400).json({ success: false, error: 'Secret (password) is required.' });
        }

        const extNum = String(extension).trim();
        const displayName = String(name).trim();
        const extSecret = String(secret).trim();
        const vmVal = (voicemail === 'default' || voicemail === 'enabled' || voicemail === true) ? 'default' : 'novm';
        const extContext = 'from-internal';

        // Check if extension already exists
        const [existing] = await pool.query('SELECT extension FROM `asterisk`.`users` WHERE extension = ?', [extNum]);
        if (existing.length > 0) {
            return res.status(400).json({ success: false, error: `Extension ${extNum} already exists.` });
        }

        // 1. Insert into users with recording='out=always|in=always'
        await pool.query(`
            INSERT INTO \`asterisk\`.\`users\` (extension, password, name, voicemail, ringtimer, noanswer, recording, outboundcid, sipname, mohclass)
            VALUES (?, '', ?, ?, 0, '', 'out=always|in=always', '', '', 'default')
        `, [extNum, displayName, vmVal]);

        // 2. Insert into devices (Generic SIP Device)
        await pool.query(`
            INSERT INTO \`asterisk\`.\`devices\` (id, tech, dial, devicetype, user, description, emergency_cid)
            VALUES (?, 'sip', CONCAT('SIP/', ?), 'fixed', ?, ?, '')
        `, [extNum, extNum, extNum, displayName]);

        // 3. Batch insert into sip table with nat=yes
        const sipPairs = [
            [extNum, 'account', extNum, 32],
            [extNum, 'accountcode', '', 28],
            [extNum, 'allow', '', 26],
            [extNum, 'avpf', 'no', 15],
            [extNum, 'callerid', `${displayName} <${extNum}>`, 33],
            [extNum, 'canreinvite', 'no', 4],
            [extNum, 'context', extContext, 5],
            [extNum, 'deny', '0.0.0.0/0.0.0.0', 30],
            [extNum, 'dial', `SIP/${extNum}`, 27],
            [extNum, 'disallow', '', 25],
            [extNum, 'dtmfmode', 'rfc2833', 3],
            [extNum, 'encryption', 'no', 22],
            [extNum, 'host', 'dynamic', 6],
            [extNum, 'mailbox', `${extNum}@device`, 29],
            [extNum, 'nat', 'yes', 10],
            [extNum, 'permit', '0.0.0.0/0.0.0.0', 31],
            [extNum, 'port', '5060', 11],
            [extNum, 'qualify', 'yes', 12],
            [extNum, 'qualifyfreq', '60', 13],
            [extNum, 'secret', extSecret, 2],
            [extNum, 'sendrpid', 'no', 8],
            [extNum, 'transport', 'udp', 14],
            [extNum, 'trustrpid', 'yes', 7],
            [extNum, 'type', 'friend', 9]
        ];

        for (const [id, kw, data, flags] of sipPairs) {
            await pool.query(`
                INSERT INTO \`asterisk\`.\`sip\` (id, keyword, data, flags)
                VALUES (?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE data = VALUES(data), flags = VALUES(flags)
            `, [id, kw, data, flags]);
        }

        // 4. Update astdb entries for call recording ALWAYS and Voicemail setting
        setExtensionAstdbDefaults(extNum, displayName, vmVal);

        res.json({ success: true, message: `Extension ${extNum} created with Voicemail (${vmVal === 'default' ? 'Enabled' : 'Disabled'}) successfully.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// PUT /api/config/extensions/:extension - Modify Extension
app.put('/api/config/extensions/:extension', async (req, res) => {
    try {
        const extNum = String(req.params.extension).trim();
        const { name, secret, voicemail } = req.body;

        const displayName = String(name || '').trim();
        const extSecret = String(secret || '').trim();
        const vmVal = (voicemail === 'default' || voicemail === 'enabled' || voicemail === true) ? 'default' : 'novm';

        if (displayName) {
            await pool.query('UPDATE `asterisk`.`users` SET name = ? WHERE extension = ?', [displayName, extNum]);
            await pool.query('UPDATE `asterisk`.`devices` SET description = ? WHERE id = ?', [displayName, extNum]);
            await pool.query('UPDATE `asterisk`.`sip` SET data = ? WHERE id = ? AND keyword = "callerid"', [`${displayName} <${extNum}>`, extNum]);
        }
        if (extSecret) {
            await pool.query('UPDATE `asterisk`.`sip` SET data = ? WHERE id = ? AND keyword = "secret"', [extSecret, extNum]);
        }

        // Update voicemail & nat in users and sip table
        await pool.query('UPDATE `asterisk`.`users` SET voicemail = ?, recording = "out=always|in=always" WHERE extension = ?', [vmVal, extNum]);
        await pool.query('UPDATE `asterisk`.`sip` SET data = "yes" WHERE id = ? AND keyword = "nat"', [extNum]);
        
        setExtensionAstdbDefaults(extNum, displayName || extNum, vmVal);

        res.json({ success: true, message: `Extension ${extNum} updated successfully.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/config/extensions/:extension - Delete Extension
app.delete('/api/config/extensions/:extension', async (req, res) => {
    try {
        const extNum = String(req.params.extension).trim();
        await pool.query('DELETE FROM `asterisk`.`users` WHERE extension = ?', [extNum]);
        await pool.query('DELETE FROM `asterisk`.`devices` WHERE id = ?', [extNum]);
        await pool.query('DELETE FROM `asterisk`.`sip` WHERE id = ?', [extNum]);

        // Clean up astdb AMPUSER & voicemail.conf
        exec(`${ASTERISK_BIN} -rx 'database deltree AMPUSER ${extNum}'`, (err) => {
            if (err) console.error(`AstDB deltree error for ${extNum}:`, err.message);
        });
        updateVoicemailConf(extNum, '', 'novm');

        res.json({ success: true, message: `Extension ${extNum} deleted successfully.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- 2. RING GROUPS MANAGEMENT APIs ---

// GET /api/config/ringgroups - List all Ring Groups
app.get('/api/config/ringgroups', async (req, res) => {
    try {
        const [ringgroups] = await pool.query(`
            SELECT grpnum, strategy, grptime, grplist, description, annmsg_id, postdest, cwignore, recording
            FROM \`asterisk\`.\`ringgroups\`
            ORDER BY CAST(grpnum AS UNSIGNED) ASC
        `);
        res.json({ success: true, ringgroups });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/config/ringgroups - Create Ring Group
app.post('/api/config/ringgroups', async (req, res) => {
    try {
        const { grpnum, description, grplist, strategy, grptime, annmsg_id, postdest } = req.body;
        if (!grpnum || !/^\d+$/.test(grpnum)) {
            return res.status(400).json({ success: false, error: 'Valid numeric Ring Group number is required.' });
        }
        if (!description || !description.trim()) {
            return res.status(400).json({ success: false, error: 'Description is required.' });
        }
        if (!grplist || !grplist.trim()) {
            return res.status(400).json({ success: false, error: 'Extension List is required.' });
        }

        const num = String(grpnum).trim();
        const desc = String(description).trim();

        // Format extension list (e.g. "101-102-103")
        const extListFormatted = String(grplist).replace(/[\r\n, ]+/g, '-').replace(/^-+|-+$/g, '');
        const ringStrategy = strategy || 'ringall';
        const ringTime = parseInt(grptime, 10) || 20;
        const annMsgId = parseInt(annmsg_id, 10) || 0;
        const postDest = (postdest && postdest.trim()) ? postdest.trim() : `ext-group,${num},1`;

        const [existing] = await pool.query('SELECT grpnum FROM `asterisk`.`ringgroups` WHERE grpnum = ?', [num]);
        if (existing.length > 0) {
            return res.status(400).json({ success: false, error: `Ring Group ${num} already exists.` });
        }

        // Defaults: skip busy agent -> cwignore='CHECKED', record calls -> recording='always'
        await pool.query(`
            INSERT INTO \`asterisk\`.\`ringgroups\` 
            (grpnum, strategy, grptime, grppre, grplist, annmsg_id, postdest, description, alertinfo, remotealert_id, needsconf, toolate_id, ringing, cwignore, cfignore, cpickup, recording)
            VALUES (?, ?, ?, '', ?, ?, ?, ?, '', 0, '', 0, 'Ring', 'CHECKED', '', '', 'always')
        `, [num, ringStrategy, ringTime, extListFormatted, annMsgId, postDest, desc]);

        res.json({ success: true, message: `Ring Group ${num} created with Skip Busy=Yes & Record=Always successfully.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// PUT /api/config/ringgroups/:grpnum - Modify Ring Group
app.put('/api/config/ringgroups/:grpnum', async (req, res) => {
    try {
        const num = String(req.params.grpnum).trim();
        const { description, grplist, strategy, grptime, annmsg_id, postdest } = req.body;

        const desc = String(description || '').trim();
        const extListFormatted = String(grplist || '').replace(/[\r\n, ]+/g, '-').replace(/^-+|-+$/g, '');
        const ringStrategy = strategy || 'ringall';
        const ringTime = parseInt(grptime, 10) || 20;
        const annMsgId = parseInt(annmsg_id, 10) || 0;
        const postDest = (postdest && postdest.trim()) ? postdest.trim() : `ext-group,${num},1`;

        await pool.query(`
            UPDATE \`asterisk\`.\`ringgroups\`
            SET description = ?, grplist = ?, strategy = ?, grptime = ?, annmsg_id = ?, cwignore = 'CHECKED', recording = 'always', postdest = ?
            WHERE grpnum = ?
        `, [desc, extListFormatted, ringStrategy, ringTime, annMsgId, postDest, num]);

        res.json({ success: true, message: `Ring Group ${num} updated successfully.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/config/ringgroups/:grpnum - Delete Ring Group
app.delete('/api/config/ringgroups/:grpnum', async (req, res) => {
    try {
        const num = String(req.params.grpnum).trim();
        await pool.query('DELETE FROM `asterisk`.`ringgroups` WHERE grpnum = ?', [num]);
        res.json({ success: true, message: `Ring Group ${num} deleted successfully.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- SYSTEM RECORDINGS MANAGEMENT APIs ---

// GET /api/config/recordings - List all system recordings
app.get('/api/config/recordings', async (req, res) => {
    try {
        const [recordings] = await pool.query(`
            SELECT id, displayname, filename, description
            FROM \`asterisk\`.\`recordings\`
            ORDER BY id DESC
        `);
        res.json({ success: true, recordings });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/config/recordings/:id - Delete system recording
app.delete('/api/config/recordings/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ success: false, error: 'Invalid recording ID.' });

        const [rows] = await pool.query('SELECT filename FROM `asterisk`.`recordings` WHERE id = ?', [id]);
        if (rows.length > 0) {
            const relFile = rows[0].filename;
            if (relFile) {
                const soundPath = path.join('/var/lib/asterisk/sounds', relFile + '.wav');
                if (fs.existsSync(soundPath)) {
                    try { fs.unlinkSync(soundPath); } catch (e) {}
                }
            }
            await pool.query('DELETE FROM `asterisk`.`recordings` WHERE id = ?', [id]);
        }
        res.json({ success: true, message: 'Recording deleted successfully.' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/config/recordings/audio/:id - Stream or download system recording
app.get('/api/config/recordings/audio/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).send("Invalid recording ID.");

        const [rows] = await pool.query('SELECT filename, displayname FROM `asterisk`.`recordings` WHERE id = ?', [id]);
        if (!rows.length || !rows[0].filename) return res.status(404).send("Recording not found.");

        const relFile = rows[0].filename;
        const soundPath = path.join('/var/lib/asterisk/sounds', relFile + '.wav');
        if (!fs.existsSync(soundPath)) return res.status(404).send("Recording file missing on disk.");

        const stat = fs.statSync(soundPath);
        const fileSize = stat.size;
        const contentType = 'audio/wav';
        const isDownload = req.query.download === '1';
        const displayFilename = (rows[0].displayname || path.basename(relFile)) + '.wav';

        const range = req.headers.range;
        if (range && !isDownload) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunkSize = end - start + 1;
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunkSize,
                'Content-Type': contentType
            });
            fs.createReadStream(soundPath, { start, end }).pipe(res);
        } else {
            const disposition = isDownload ? 'attachment' : 'inline';
            res.writeHead(200, {
                'Content-Length': fileSize,
                'Content-Type': contentType,
                'Accept-Ranges': 'bytes',
                'Content-Disposition': `${disposition}; filename="${encodeURIComponent(displayFilename)}"`
            });
            fs.createReadStream(soundPath).pipe(res);
        }
    } catch (err) {
        res.status(500).send("Audio Error: " + err.message);
    }
});


// --- 3. TRUNKS MANAGEMENT APIs ---

// GET /api/config/trunks - List Trunks
app.get('/api/config/trunks', async (req, res) => {
    try {
        const [trunks] = await pool.query(`
            SELECT trunkid, name, tech, channelid, disabled
            FROM \`asterisk\`.\`trunks\`
            ORDER BY trunkid ASC
        `);
        res.json({ success: true, trunks });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/config/trunks - Create Custom Trunk
app.post('/api/config/trunks', async (req, res) => {
    try {
        const { name, channelid } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'Trunk Name is required.' });
        }
        if (!channelid || !channelid.trim()) {
            return res.status(400).json({ success: false, error: 'Custom Dial String is required.' });
        }

        const trunkName = String(name).trim();
        const dialString = String(channelid).trim();

        // Insert into trunks table as tech='custom'
        await pool.query(`
            INSERT INTO \`asterisk\`.\`trunks\` (name, tech, outcid, keepcid, maxchans, failscript, dialoutprefix, channelid, disabled, \`continue\`)
            VALUES (?, 'custom', '', 'off', '', '', '', ?, 'off', 'off')
        `, [trunkName, dialString]);

        res.json({ success: true, message: `Custom Trunk '${trunkName}' created successfully.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// PUT /api/config/trunks/:trunkid - Modify Custom Trunk
app.put('/api/config/trunks/:trunkid', async (req, res) => {
    try {
        const trunkId = parseInt(req.params.trunkid, 10);
        const { name, channelid } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'Trunk Name is required.' });
        }
        if (!channelid || !channelid.trim()) {
            return res.status(400).json({ success: false, error: 'Custom Dial String is required.' });
        }

        const trunkName = String(name).trim();
        const dialString = String(channelid).trim();

        await pool.query(`
            UPDATE \`asterisk\`.\`trunks\`
            SET name = ?, channelid = ?, tech = 'custom'
            WHERE trunkid = ?
        `, [trunkName, dialString, trunkId]);

        res.json({ success: true, message: `Custom Trunk '${trunkName}' updated successfully.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/config/trunks/:trunkid - Delete Trunk
app.delete('/api/config/trunks/:trunkid', async (req, res) => {
    try {
        const trunkId = parseInt(req.params.trunkid, 10);
        const [tRows] = await pool.query('SELECT name FROM `asterisk`.`trunks` WHERE trunkid = ?', [trunkId]);
        const name = tRows[0] ? tRows[0].name : '';

        await pool.query('DELETE FROM `asterisk`.`trunks` WHERE trunkid = ?', [trunkId]);
        await pool.query('DELETE FROM `asterisk`.`sip` WHERE id = ? OR id = ?', [`tr-trunk-${trunkId}`, name]);
        await pool.query('DELETE FROM `asterisk`.`outbound_route_trunks` WHERE trunk_id = ?', [trunkId]);

        res.json({ success: true, message: `Trunk deleted successfully.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- 4. INBOUND & OUTBOUND ROUTES MANAGEMENT APIs ---

// GET /api/config/routes/inbound - List Inbound Routes
app.get('/api/config/routes/inbound', async (req, res) => {
    try {
        const [routes] = await pool.query(`
            SELECT cidnum, extension, destination, description
            FROM \`asterisk\`.\`incoming\`
            ORDER BY description ASC
        `);
        res.json({ success: true, routes });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/config/routes/inbound - Create Inbound Route
app.post('/api/config/routes/inbound', async (req, res) => {
    try {
        const { description, extension, destination } = req.body;
        if (!description || !description.trim()) {
            return res.status(400).json({ success: false, error: 'Route Description is required.' });
        }
        if (!destination || !destination.trim()) {
            return res.status(400).json({ success: false, error: 'Destination is required.' });
        }

        const desc = String(description).trim();
        const ext = String(extension || '').trim();
        const cid = ''; // Default cidnum to empty string
        const dest = String(destination).trim();

        await pool.query(`
            INSERT INTO \`asterisk\`.\`incoming\`
            (cidnum, extension, destination, answer, wait, privacyman, mohclass, description, grppre, delay_answer, pricid, pmmaxretries, pmminlength)
            VALUES (?, ?, ?, NULL, NULL, 0, 'default', ?, '', 0, '', '3', '10')
        `, [cid, ext, dest, desc]);

        res.json({ success: true, message: `Inbound Route '${desc}' created successfully.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// PUT /api/config/routes/inbound - Modify Inbound Route
app.put('/api/config/routes/inbound', async (req, res) => {
    try {
        const { originalExtension, originalDescription, description, extension, destination } = req.body;
        if (!description || !description.trim()) {
            return res.status(400).json({ success: false, error: 'Route Description is required.' });
        }
        if (!destination || !destination.trim()) {
            return res.status(400).json({ success: false, error: 'Destination is required.' });
        }

        const desc = String(description).trim();
        const ext = String(extension || '').trim();
        const dest = String(destination).trim();

        await pool.query(`
            UPDATE \`asterisk\`.\`incoming\`
            SET description = ?, extension = ?, destination = ?
            WHERE (extension = ? OR (extension IS NULL AND ? = ''))
              AND (cidnum = '' OR cidnum IS NULL)
              AND description = ?
        `, [desc, ext, dest, originalExtension || '', originalExtension || '', originalDescription || '']);

        res.json({ success: true, message: `Inbound Route '${desc}' updated successfully.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/config/routes/inbound - Delete Inbound Route
app.delete('/api/config/routes/inbound', async (req, res) => {
    try {
        const { extension, description } = req.body;
        await pool.query(`
            DELETE FROM \`asterisk\`.\`incoming\`
            WHERE (extension = ? OR (extension IS NULL AND ? = ''))
              AND (cidnum = '' OR cidnum IS NULL)
              AND description = ?
        `, [extension || '', extension || '', description || '']);

        res.json({ success: true, message: 'Inbound Route deleted successfully.' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/config/routes/outbound - List Outbound Routes
app.get('/api/config/routes/outbound', async (req, res) => {
    try {
        const [routesRows] = await pool.query(`
            SELECT route_id, name FROM \`asterisk\`.\`outbound_routes\` ORDER BY route_id ASC
        `);
        const [patternsRows] = await pool.query(`
            SELECT route_id, match_pattern_prefix, match_pattern_pass, match_cid, prepend_digits
            FROM \`asterisk\`.\`outbound_route_patterns\`
        `);
        const [trunksRows] = await pool.query(`
            SELECT rt.route_id, rt.trunk_id, rt.seq, t.name AS trunk_name
            FROM \`asterisk\`.\`outbound_route_trunks\` rt
            LEFT JOIN \`asterisk\`.\`trunks\` t ON t.trunkid = rt.trunk_id
            ORDER BY rt.seq ASC
        `);

        // Group them
        const routes = routesRows.map(r => {
            const route_id = r.route_id;
            const patterns = patternsRows
                .filter(p => p.route_id === route_id)
                .map(p => ({
                    prefix: p.match_pattern_prefix || '',
                    pattern: p.match_pattern_pass || '',
                    cid: p.match_cid || '',
                    prepend: p.prepend_digits || ''
                }));
            const trunks = trunksRows
                .filter(t => t.route_id === route_id)
                .map(t => ({
                    trunk_id: t.trunk_id,
                    seq: t.seq,
                    trunk_name: t.trunk_name || `ID #${t.trunk_id}`
                }));

            return {
                route_id,
                name: r.name,
                patterns,
                trunks
            };
        });

        res.json({ success: true, routes });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/config/routes/outbound - Create Outbound Route
app.post('/api/config/routes/outbound', async (req, res) => {
    try {
        const { name, patterns, trunks } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'Route Name is required.' });
        }
        if (!patterns || !Array.isArray(patterns) || patterns.length === 0) {
            return res.status(400).json({ success: false, error: 'At least one Dial Pattern is required.' });
        }
        if (!trunks || !Array.isArray(trunks) || trunks.length === 0) {
            return res.status(400).json({ success: false, error: 'At least one Trunk in sequence is required.' });
        }

        const routeName = String(name).trim();

        // 1. Insert into outbound_routes
        const [rResult] = await pool.query(`
            INSERT INTO \`asterisk\`.\`outbound_routes\` (name, outcid, outcid_mode, password, emergency_route, intracompany_route, mohclass)
            VALUES (?, '', '', '', '', '', 'default')
        `, [routeName]);

        const routeId = rResult.insertId;

        // 2. Insert patterns
        for (const p of patterns) {
            await pool.query(`
                INSERT INTO \`asterisk\`.\`outbound_route_patterns\` (route_id, match_pattern_prefix, match_pattern_pass, match_cid, prepend_digits)
                VALUES (?, ?, ?, ?, ?)
            `, [routeId, String(p.prefix || '').trim(), String(p.pattern || '').trim(), String(p.cid || '').trim(), String(p.prepend || '').trim()]);
        }

        // 3. Insert trunks in order (seq)
        for (let i = 0; i < trunks.length; i++) {
            await pool.query(`
                INSERT INTO \`asterisk\`.\`outbound_route_trunks\` (route_id, trunk_id, seq)
                VALUES (?, ?, ?)
            `, [routeId, parseInt(trunks[i], 10), i]);
        }

        // 4. Insert sequence
        await pool.query(`
            INSERT INTO \`asterisk\`.\`outbound_route_sequence\` (route_id, seq)
            VALUES (?, 0)
        `, [routeId]);

        res.json({ success: true, message: `Outbound Route '${routeName}' created successfully.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// PUT /api/config/routes/outbound/:route_id - Modify Outbound Route
app.put('/api/config/routes/outbound/:route_id', async (req, res) => {
    try {
        const routeId = parseInt(req.params.route_id, 10);
        const { name, patterns, trunks } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'Route Name is required.' });
        }
        if (!patterns || !Array.isArray(patterns) || patterns.length === 0) {
            return res.status(400).json({ success: false, error: 'At least one Dial Pattern is required.' });
        }
        if (!trunks || !Array.isArray(trunks) || trunks.length === 0) {
            return res.status(400).json({ success: false, error: 'At least one Trunk in sequence is required.' });
        }

        const routeName = String(name).trim();

        // 1. Update outbound_routes name
        await pool.query(`
            UPDATE \`asterisk\`.\`outbound_routes\`
            SET name = ?
            WHERE route_id = ?
        `, [routeName, routeId]);

        // 2. Refresh patterns
        await pool.query('DELETE FROM `asterisk`.`outbound_route_patterns` WHERE route_id = ?', [routeId]);
        for (const p of patterns) {
            await pool.query(`
                INSERT INTO \`asterisk\`.\`outbound_route_patterns\` (route_id, match_pattern_prefix, match_pattern_pass, match_cid, prepend_digits)
                VALUES (?, ?, ?, ?, ?)
            `, [routeId, String(p.prefix || '').trim(), String(p.pattern || '').trim(), String(p.cid || '').trim(), String(p.prepend || '').trim()]);
        }

        // 3. Refresh trunks in order
        await pool.query('DELETE FROM `asterisk`.`outbound_route_trunks` WHERE route_id = ?', [routeId]);
        for (let i = 0; i < trunks.length; i++) {
            await pool.query(`
                INSERT INTO \`asterisk\`.\`outbound_route_trunks\` (route_id, trunk_id, seq)
                VALUES (?, ?, ?)
            `, [routeId, parseInt(trunks[i], 10), i]);
        }

        res.json({ success: true, message: `Outbound Route '${routeName}' updated successfully.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/config/routes/outbound/:route_id - Delete Outbound Route
app.delete('/api/config/routes/outbound/:route_id', async (req, res) => {
    try {
        const routeId = parseInt(req.params.route_id, 10);
        await pool.query('DELETE FROM `asterisk`.`outbound_routes` WHERE route_id = ?', [routeId]);
        await pool.query('DELETE FROM `asterisk`.`outbound_route_patterns` WHERE route_id = ?', [routeId]);
        await pool.query('DELETE FROM `asterisk`.`outbound_route_trunks` WHERE route_id = ?', [routeId]);
        await pool.query('DELETE FROM `asterisk`.`outbound_route_sequence` WHERE route_id = ?', [routeId]);

        res.json({ success: true, message: 'Outbound Route deleted successfully.' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

const csvUpload = multer({
    dest: '/tmp/',
    limits: { fileSize: 10 * 1024 * 1024 }
});

app.post('/api/contacts/csv-import', csvUpload.single('file'), async (req, res) => {
    if (!isSuperAdmin(req)) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    try {
        if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
        
        const lines = fs.readFileSync(req.file.path, 'utf8').split(/\r?\n/);
        const values = [];
        for (let line of lines) {
            if (!line.trim()) continue;
            const cells = line.split(',').map(c => {
                let cleaned = c.trim();
                if (cleaned.startsWith('="') && cleaned.endsWith('"')) {
                    cleaned = cleaned.substring(2, cleaned.length - 1);
                }
                cleaned = cleaned.replace(/^["']|["']$/g, '');
                return cleaned.trim();
            });
            if (cells.length < 3) continue;
            
            const first = cells[0];
            const last = cells[1];
            let phone = cells[2];
            
            // Skip headers
            if (first.toLowerCase() === 'name' || first.toLowerCase() === 'first name' || (phone && phone.toLowerCase() === 'phone')) {
                continue;
            }
            
            if (first && phone) {
                // Clean spaces, dashes, and parentheses
                phone = phone.replace(/[\s\-\(\)]/g, '');
                
                // Auto-recover leading zero if stripped by Excel (starts with 1-9, is purely numeric, and is at least 7 digits long)
                if (/^\d+$/.test(phone) && !phone.startsWith('0') && phone.length >= 7) {
                    phone = '0' + phone;
                }
                
                values.push(`('${escapeSql(first)}', '${escapeSql(last)}', '${escapeSql(phone)}', 1, 'isPublic', 'external')`);
            }
        }
        
        if (values.length > 0) {
            const sql = `INSERT INTO contact (name, last_name, telefono, iduser, status, directory) VALUES ${values.join(',')};`;
            await runSqlite(sql);
            fs.unlinkSync(req.file.path);
            res.json({ success: true, message: `${values.length} contacts imported successfully.` });
        } else {
            fs.unlinkSync(req.file.path);
            res.status(400).json({ success: false, error: 'No valid contacts found in CSV.' });
        }
    } catch (err) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ success: false, error: err.message });
    }
});


// --- RECORDING UPLOAD ---
const UPLOAD_TMP = '/tmp/dashboard-uploads';
const STAGING_DIR = '/tmp/dashboard-staging';
if (!fs.existsSync(UPLOAD_TMP)) fs.mkdirSync(UPLOAD_TMP, { recursive: true });
if (!fs.existsSync(STAGING_DIR)) fs.mkdirSync(STAGING_DIR, { recursive: true });

const recordingStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_TMP),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, Date.now() + '-' + crypto.randomBytes(4).toString('hex') + ext);
    }
});
const upload = multer({
    storage: recordingStorage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['.mp3', '.m4a', '.wav', '.ogg', '.wma', '.flac', '.aac', '.mpeg', '.mpg'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowed.includes(ext)) return cb(null, true);
        cb(new Error('Unsupported audio format: ' + ext));
    }
});

function convertToWav(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .audioCodec('pcm_s16le')
            .audioFrequency(8000)
            .audioChannels(1)
            .format('wav')
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(err))
            .save(outputPath);
    });
}

async function saveRecordingToFS(wavPath, recordingName) {
    const safeName = recordingName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const destDir = '/var/lib/asterisk/sounds/custom';
    const destPath = destDir + '/' + safeName + '.wav';
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(wavPath, destPath);
    fs.unlinkSync(wavPath);

    // Insert into recordings table
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASS || 'admin',
        database: ASTERISK_DB
    });
    const displayName = recordingName.replace(/[_]/g, ' ');
    await conn.execute(
        'INSERT INTO recordings (displayname, filename) VALUES (?, ?)',
        [displayName, 'custom/' + safeName]
    );
    await conn.end();

    // Reload Asterisk so it picks up the new sound
    require('child_process').exec('/usr/sbin/asterisk -rx "module reload sounds"', () => {});

    return destPath;
}

app.post('/api/settings/recordings/upload', (req, res) => {
    upload.single('file')(req, res, async (err) => {
        if (err) {
            if (err instanceof multer.MulterError) {
                return res.status(400).json({ success: false, error: 'Upload error: ' + err.message });
            }
            return res.status(400).json({ success: false, error: err.message });
        }
        if (!req.file) return res.status(400).json({ success: false, error: 'No file provided' });
        const recordingName = req.body.name || path.basename(req.file.originalname, path.extname(req.file.originalname));

        const rawPath = req.file.path;
        const safeName = recordingName.replace(/[^a-zA-Z0-9_-]/g, '_');
        const wavPath = path.join(STAGING_DIR, safeName + '.wav');

        try {
            // Convert to strict WAV format
            await convertToWav(rawPath, wavPath);
            // Delete raw upload
            fs.unlinkSync(rawPath);

            // Save to Issabel filesystem + DB
            await saveRecordingToFS(wavPath, recordingName);

            res.json({ success: true, message: 'Recording "' + recordingName + '" uploaded successfully.' });
        } catch (convErr) {
            // Cleanup on failure
            if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath);
            if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
            console.error('Recording upload failed:', convErr);
            res.status(500).json({ success: false, error: 'Conversion or upload failed: ' + (convErr.message || convErr) });
        }
    });
});

// --- VOICEMAIL GREETING UPLOAD ---
const VM_SOUNDS_DIR = '/var/lib/asterisk/sounds/en';
const VM_BACKUP_DIR = path.join(VM_SOUNDS_DIR, 'backups');
const VM_MAILBOX_ROOT = '/var/spool/asterisk/voicemail/default';

const VM_AUDIO_EXTS = ['.gsm', '.wav', '.wav49', '.sln', '.slin', '.ulaw', '.alaw', '.g722', '.sln16', '.slin16'];

function removeVmFile(dir, name) {
    VM_AUDIO_EXTS.forEach(ext => {
        const p = path.join(dir, name + ext);
        if (fs.existsSync(p)) fs.unlinkSync(p);
    });
}

function writeSilentWav(path) {
    const sr = 8000, bits = 16, channels = 1, samples = sr;
    const dataSize = samples * channels * (bits / 8);
    const buf = Buffer.alloc(44 + dataSize);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(channels, 22); buf.writeUInt32LE(sr, 24);
    buf.writeUInt32LE(sr * channels * (bits / 8), 28);
    buf.writeUInt16LE(channels * (bits / 8), 32); buf.writeUInt16LE(bits, 34);
    buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
    fs.writeFileSync(path, buf);
}

function ensureVmBackups() {
    if (!fs.existsSync(VM_BACKUP_DIR)) fs.mkdirSync(VM_BACKUP_DIR, { recursive: true });
    ['unavailable', 'vm-leavemsg', 'vm-intro'].forEach(name => {
        const bak = path.join(VM_BACKUP_DIR, name + '.gsm.orig');
        const src = path.join(VM_SOUNDS_DIR, name + '.gsm');
        if (!fs.existsSync(bak) && fs.existsSync(src)) fs.copyFileSync(src, bak);
    });
}

function writeVmSound(name, wavPath) {
    removeVmFile(VM_SOUNDS_DIR, name);
    fs.copyFileSync(wavPath, path.join(VM_SOUNDS_DIR, name + '.wav'));
}

function removeVmSound(name) {
    removeVmFile(VM_SOUNDS_DIR, name);
}

function getVoicemailMailboxes() {
    const mailboxes = new Set();
    try {
        const vmconf = fs.readFileSync('/etc/asterisk/voicemail.conf', 'utf8');
        let inSection = false;
        for (const line of vmconf.split('\n')) {
            const t = line.trim();
            if (t.startsWith('[') && t.endsWith(']')) { inSection = !t.startsWith('[general]') && !t.startsWith('[') || (t.startsWith('[general]') ? false : true); inSection = t !== '[general]' && !t.startsWith('[template') && !t.startsWith(';;'); continue; }
            if (inSection && t && !t.startsWith(';') && !t.startsWith('#')) {
                const m = t.match(/^\s*(\d+)\s*=>/);
                if (m) mailboxes.add(m[1]);
            }
        }
    } catch {}
    try {
        if (fs.existsSync(VM_MAILBOX_ROOT)) {
            fs.readdirSync(VM_MAILBOX_ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).forEach(d => mailboxes.add(d.name));
        }
    } catch {}
    return [...mailboxes].sort();
}

function convertToGsm(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .audioCodec('pcm_s16le')
            .audioFrequency(8000)
            .audioChannels(1)
            .format('wav')
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(err))
            .save(outputPath);
    });
}

app.post('/api/voicemail-greeting/upload', (req, res) => {
    upload.single('file')(req, res, async (err) => {
        if (err) {
            if (err instanceof multer.MulterError) return res.status(400).json({ success: false, error: 'Upload error: ' + err.message });
            return res.status(400).json({ success: false, error: err.message });
        }
        if (!req.file) return res.status(400).json({ success: false, error: 'No file provided' });
        const mode = req.body.mode;
        let exts = [];
        if (mode === 'extension' && req.body.extensions) {
            try { exts = JSON.parse(req.body.extensions); } catch { exts = []; }
        }
        if (!mode || !['universal', 'extension'].includes(mode)) {
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            return res.status(400).json({ success: false, error: 'Invalid mode.' });
        }
        if (mode === 'extension' && (!exts || !exts.length)) {
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            return res.status(400).json({ success: false, error: 'At least one extension required.' });
        }
        const wavPath = path.join(UPLOAD_TMP, 'vm-greeting-' + Date.now() + '.wav');
        try {
            await convertToGsm(req.file.path, wavPath);
            fs.unlinkSync(req.file.path);
            ensureVmBackups();
            if (mode === 'universal') {
                if (fs.existsSync(VM_MAILBOX_ROOT)) {
                    fs.readdirSync(VM_MAILBOX_ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).forEach(ext => {
                        removeVmFile(path.join(VM_MAILBOX_ROOT, ext.name), 'unavail');
                    });
                }
                writeVmSound('unavailable', wavPath);
                removeVmSound('vm-leavemsg');
                writeSilentWav(path.join(VM_SOUNDS_DIR, 'vm-leavemsg.wav'));
                removeVmSound('vm-intro');
                writeSilentWav(path.join(VM_SOUNDS_DIR, 'vm-intro.wav'));
                greetingConfig = { mode: 'universal', extensions: [] };
                fs.writeFileSync(VM_GREETING_CONFIG_PATH, JSON.stringify(greetingConfig, null, 2));
                require('child_process').exec('/usr/sbin/asterisk -rx "module reload sounds"', () => {});
                res.json({ success: true, message: 'Universal greeting uploaded successfully.' });
            } else {
                // Per-extension: save to mailbox unavail, silence system prompts
                removeVmSound('vm-leavemsg');
                writeSilentWav(path.join(VM_SOUNDS_DIR, 'vm-leavemsg.wav'));
                removeVmSound('vm-intro');
                writeSilentWav(path.join(VM_SOUNDS_DIR, 'vm-intro.wav'));
                for (const ext of exts) {
                    const dir = path.join(VM_MAILBOX_ROOT, ext);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    removeVmFile(dir, 'unavail');
                    fs.copyFileSync(wavPath, path.join(dir, 'unavail.wav'));
                }
                greetingConfig = { mode: 'extension', extensions: exts };
                fs.writeFileSync(VM_GREETING_CONFIG_PATH, JSON.stringify(greetingConfig, null, 2));
                require('child_process').exec('/usr/sbin/asterisk -rx "module reload sounds"', () => {});
                res.json({ success: true, message: 'Greeting for ' + exts.length + ' extension(s) uploaded successfully.' });
            }
            if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
        } catch (convErr) {
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
            console.error('VM greeting upload failed:', convErr);
            res.status(500).json({ success: false, error: 'Conversion failed: ' + (convErr.message || convErr) });
        }
    });
});

app.get('/api/voicemail-greeting/status', (req, res) => {
    reloadGreetingConfig();
    res.json({ mode: greetingConfig.mode, extensions: greetingConfig.extensions, mailboxes: getVoicemailMailboxes() });
});

app.post('/api/voicemail-greeting/reset', (req, res) => {
    try {
        ensureVmBackups();
        const origUnavail = path.join(VM_BACKUP_DIR, 'unavailable.gsm.orig');
        const origLeaveMsg = path.join(VM_BACKUP_DIR, 'vm-leavemsg.gsm.orig');
        const origIntro = path.join(VM_BACKUP_DIR, 'vm-intro.gsm.orig');
        removeVmSound('unavailable');
        removeVmSound('vm-leavemsg');
        removeVmSound('vm-intro');
        if (fs.existsSync(origUnavail)) fs.copyFileSync(origUnavail, path.join(VM_SOUNDS_DIR, 'unavailable.gsm'));
        if (fs.existsSync(origLeaveMsg)) fs.copyFileSync(origLeaveMsg, path.join(VM_SOUNDS_DIR, 'vm-leavemsg.gsm'));
        if (fs.existsSync(origIntro)) fs.copyFileSync(origIntro, path.join(VM_SOUNDS_DIR, 'vm-intro.gsm'));
        if (fs.existsSync(VM_MAILBOX_ROOT)) {
            fs.readdirSync(VM_MAILBOX_ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).forEach(ext => {
                removeVmFile(path.join(VM_MAILBOX_ROOT, ext.name), 'unavail');
            });
        }
        greetingConfig = { mode: 'none', extensions: [] };
        fs.writeFileSync(VM_GREETING_CONFIG_PATH, JSON.stringify(greetingConfig, null, 2));
        require('child_process').exec('/usr/sbin/asterisk -rx "module reload sounds"', () => {});
        res.json({ success: true, message: 'Voicemail greeting reset to defaults.' });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Reset failed: ' + err.message });
    }
});

// --- NETWORK INFO ROUTE ---
app.get('/api/network-info', async (req, res) => {
    try {
        const { execFile } = require('child_process');
        let interfaces = {};
        let gateway = '';
        let errors = [];

        const run = (cmd, args) => new Promise((resolve, reject) => {
            execFile(cmd, args, (err, stdout) => {
                if (err) reject(err);
                else resolve(stdout);
            });
        });

        try {
            const [ip4Out, ip6Out, linkOut, routeOut] = await Promise.all([
                run('ip', ['-o', '-4', 'a']),
                run('ip', ['-o', '-6', 'a']),
                run('ip', ['link']),
                run('ip', ['route', 'show', 'default'])
            ]);

            // Parse IPv4
            for (const line of ip4Out.trim().split('\n')) {
                const m = line.match(/^\d+:\s+(\S+)\s+inet\s+(\S+)/);
                if (m) {
                    const name = m[1].replace(/@.*$/, '');
                    if (!interfaces[name]) interfaces[name] = { name, ip4: '', ip6: '', mac: '', state: 'unknown' };
                    interfaces[name].ip4 = m[2].replace(/\/\d+$/, '');
                }
            }

            // Parse IPv6 (exclude fe80::/10 link-local)
            for (const line of ip6Out.trim().split('\n')) {
                const m = line.match(/^\d+:\s+(\S+)\s+inet6\s+(\S+)/);
                if (m) {
                    const name = m[1].replace(/@.*$/, '');
                    const addr = m[2].replace(/\/\d+$/, '');
                    if (addr.startsWith('fe80')) continue;
                    if (!interfaces[name]) interfaces[name] = { name, ip4: '', ip6: '', mac: '', state: 'unknown' };
                    interfaces[name].ip6 = addr;
                }
            }

            // Parse link info (MAC + state)
            let currentIface = '';
            for (const line of linkOut.split('\n')) {
                const ifaceMatch = line.match(/^\d+:\s+(\S+):\s+<.*>\s+.*state\s+(\S+)/);
                if (ifaceMatch) {
                    currentIface = ifaceMatch[1].replace(/@.*$/, '');
                    if (!interfaces[currentIface]) interfaces[currentIface] = { name: currentIface, ip4: '', ip6: '', mac: '', state: 'unknown' };
                    interfaces[currentIface].state = ifaceMatch[2].toLowerCase();
                }
                const macMatch = line.match(/link\/(\S+)\s+([0-9a-fA-F:]{17})/);
                if (macMatch && currentIface) {
                    interfaces[currentIface].mac = macMatch[2];
                }
            }

            // Parse default gateway
            const gwMatch = routeOut.match(/^default\s+via\s+(\S+)/m);
            if (gwMatch) gateway = gwMatch[1];

        } catch (e) {
            errors.push(e.message);
        }

        res.json({ success: true, interfaces: Object.values(interfaces), gateway, errors: errors.length ? errors : undefined });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- BROWSER ERROR LOGGER ---
app.post('/log_error', (req, res) => {
    console.error('[BROWSER-ERROR]', req.body.error);
    res.json({ success: true });
});

server.listen(PORT, () => console.log(`Real-Time Enterprise Engine active on port ${PORT}`));
