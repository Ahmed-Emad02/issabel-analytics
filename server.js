const express = require('express');
const mysql = require('mysql2/promise');
const moment = require('moment');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const { Server } = require('socket.io');
const { execFile } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

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
    psEndpoints: tableName(ASTERISK_DB, 'ps_endpoints'),
    agentStatus: tableName(ASTERISK_DB, 'synq_agent_status'),
    agentStatusLog: tableName(ASTERISK_DB, 'synq_agent_status_log')
};

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
let isPeerListLoaded = false;
let amiClient = null;

// --- ASTERISK AMI REAL-TIME MONITORING ---
function connectAMI() {
    activeCalls = {};
    peerStatus = {};
    let loggedIn = false;
    let queriedPeers = false;
    const client = net.connect({ port: process.env.AMI_PORT || 5038, host: AMI_HOST }, () => {
        client.write(`Action: Login\r\nUsername: ${process.env.AMI_USER || 'admin'}\r\nSecret: ${process.env.AMI_PASS || 'admin'}\r\n\r\n`);
        console.log('AMI: Connection opened, login sent');
    });
    amiClient = client;

    // Fallback: if login detection fails, try SIPpeers anyway after 3s
    setTimeout(() => {
        if (!queriedPeers) {
            console.log('AMI: Login not detected within 3s, sending SIPpeers anyway');
            queriedPeers = true;
            client.write(`Action: SIPpeers\r\n\r\n`);
            setTimeout(() => {
                if (!Object.keys(peerStatus).length) {
                    console.log('AMI: SIPpeers returned nothing, trying PJSIPShowEndpoints');
                    client.write(`Action: PJSIPShowEndpoints\r\n\r\n`);
                }
            }, 3000);
        }
    }, 3000);

    function queryPeerStatus() {
        if (queriedPeers) return;
        queriedPeers = true;
        console.log('AMI: Sending SIPpeers');
        client.write(`Action: SIPpeers\r\n\r\n`);
        setTimeout(() => {
            if (!Object.keys(peerStatus).length) {
                console.log('AMI: SIPpeers returned nothing, trying PJSIPShowEndpoints');
                client.write(`Action: PJSIPShowEndpoints\r\n\r\n`);
            }
        }, 2000);
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
                }
            }

            // Parse SIPpeers peer list entries
            if (event.Event === 'PeerEntry') {
                let name = event.ObjectName || '';
                let status = event.Status || '';
                if (name) {
                    peerStatus[name] = status.toUpperCase().startsWith('OK');
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

            // Emit peerStatus once initial list queries complete
            if (event.Event === 'PeerlistComplete' || event.Event === 'EndpointListComplete') {
                console.log('AMI: Peer list complete, peers:', Object.keys(peerStatus));
                isPeerListLoaded = true;
                io.emit('peerStatus', peerStatus);
            }

            // Real-time peer registration changes
            if (event.Event === 'PeerStatus') {
                let name = event.Peer ? event.Peer.replace(/^(SIP|PJSIP)\//, '') : '';
                if (name) {
                    let isOnline = event.PeerStatus === 'Registered' || event.PeerStatus === 'Reachable';
                    
                    // If they just disconnected, force their agent status to Offline
                    if (!isOnline && peerStatus[name] && agentStatuses[name] !== 'Offline') {
                        forceAgentOffline(name);
                    }
                    
                    peerStatus[name] = isOnline;
                    io.emit('peerStatus', peerStatus);
                }
            }

            // New channel = new call, always fresh timestamp
            if (event.Event === 'Newchannel') {
                let exten = event.CallerIDNum;
                let connectedLine = event.ConnectedLineNum || '';
                let channel = event.Channel || '';
                if (exten && exten.length <= 5) {
                    activeCalls[exten] = {
                        state: 'Ringing',
                        partner: connectedLine && connectedLine !== '<unknown>' ? connectedLine : 'Connecting...',
                        start: Date.now(),
                        channel: channel
                    };
                    io.emit('callUpdate', { extension: exten, callData: activeCalls[exten] });
                }
            }

            // State updates for existing calls — update partner and preserve start time
            if (event.Event === 'Newstate') {
                let exten = event.CallerIDNum;
                let connectedLine = event.ConnectedLineNum || '';
                let channel = event.Channel || '';
                if (exten && exten.length <= 5) {
                    let calculatedState = 'Ringing';
                    if (event.ChannelStateDesc === 'Up' || event.ChannelState === '6') {
                        calculatedState = 'In Call';
                    } else if (activeCalls[exten]?.state === 'In Call') {
                        calculatedState = 'In Call';
                    }
                    let existing = activeCalls[exten];
                    let partner = existing?.partner || 'Connecting...';
                    if (connectedLine && connectedLine !== '<unknown>') partner = connectedLine;
                    let start = Date.now();
                    if (existing && existing.start) {
                        let age = Date.now() - existing.start;
                        start = age < 60000 && age >= 0 ? existing.start : Date.now();
                    }
                    activeCalls[exten] = { state: calculatedState, partner, start, channel: channel || existing?.channel };
                    io.emit('callUpdate', { extension: exten, callData: activeCalls[exten] });
                }
            }

            // Fallback catching: Ensure bridge entrances catch linked channel audio paths
            if (event.Event === 'BridgeEnter') {
                let exten = event.CallerIDNum;
                let channel = event.Channel || '';
                if (exten && activeCalls[exten]) {
                    activeCalls[exten].state = 'In Call';
                    if (channel) activeCalls[exten].channel = channel;
                    let age = Date.now() - activeCalls[exten].start;
                    if (age >= 60000 || age < 0) activeCalls[exten].start = Date.now();
                    io.emit('callUpdate', { extension: exten, callData: activeCalls[exten] });
                }
            }

            // Clean tear down when either party terminates the call
            if (event.Event === 'Hangup') {
                let exten = event.CallerIDNum;
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

// Periodic cleanup of stale call entries (older than 60 seconds)
setInterval(() => {
    let now = Date.now();
    for (let ext in activeCalls) {
        let age = now - (activeCalls[ext].start || 0);
        if (age >= 60000 || age < 0) delete activeCalls[ext];
    }
}, 30000);

io.on('connection', (socket) => {
    let clean = {};
    let now = Date.now();
    for (let ext in activeCalls) {
        let age = now - (activeCalls[ext].start || 0);
        if (age < 60000 && age >= 0) clean[ext] = activeCalls[ext];
    }
    socket.emit('initialState', clean);
    socket.emit('peerStatus', peerStatus);
    socket.emit('agentStatus', agentStatuses);
});

// --- SYNQ AGENT STATUS MONITOR ---
let agentStatuses = {};

function isInternalChannel(channel) {
    const value = String(channel || '').toUpperCase();
    return value.startsWith('SIP/') || value.startsWith('PJSIP/') || value.startsWith('IAX2/');
}

function isOutboundCdr(row) {
    return isInternalChannel(row.channel) && !isInternalChannel(row.dstchannel);
}

async function forceAgentOffline(extension) {
    try {
        const [rows] = await pool.query(`SELECT status, last_update FROM ${tables.agentStatus} WHERE extension = ?`, [extension]);
        if (rows.length === 0) return;
        const current = rows[0];
        if (current.status === 'Offline') return;

        await pool.query(
            `INSERT INTO ${tables.agentStatusLog} (extension, status, start_time, end_time, duration_seconds) VALUES (?, ?, ?, NOW(), TIMESTAMPDIFF(SECOND, ?, NOW()))`,
            [extension, current.status, current.last_update, current.last_update]
        );

        await pool.query(
            `UPDATE ${tables.agentStatus} SET status = 'Offline', last_update = NOW() WHERE extension = ?`,
            [extension]
        );
        
        agentStatuses[extension] = 'Offline';
        io.emit('agentStatus', agentStatuses);
    } catch (e) {
        console.error("Force offline DB error:", e);
    }
}

async function refreshAgentStatus() {
    try {
        const [rows] = await pool.query(`SELECT extension, status FROM ${tables.agentStatus}`);
        let changed = false;
        let newStatuses = {};
        for (let row of rows) {
            let status = row.status;
            
            // Self-healing: if server thinks they are online in DB but Asterisk says they are disconnected
            if (isPeerListLoaded && !peerStatus[row.extension] && status !== 'Offline') {
                forceAgentOffline(row.extension);
                status = 'Offline';
            }
            
            newStatuses[row.extension] = status;
            if (agentStatuses[row.extension] !== status) changed = true;
        }
        if (Object.keys(agentStatuses).length !== Object.keys(newStatuses).length) changed = true;
        
        if (changed) {
            agentStatuses = newStatuses;
            io.emit('agentStatus', agentStatuses);
        }
    } catch (e) {}
}
setInterval(refreshAgentStatus, 3000);
setTimeout(refreshAgentStatus, 1000);

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
                            if (key) { onlineMap[key] = true; peerStatus[key] = true; }
                        });
                        break;
                    }
                } catch (_) { }
            }
            if (Object.keys(peerStatus).length) console.log('DB fallback found peers:', Object.keys(peerStatus));
        }
        res.locals.roster = roster.map(emp => ({ 
            ...emp, 
            online: onlineMap[emp.extension] || false,
            agentStatus: agentStatuses[emp.extension] || 'Offline'
        }));
        res.locals.activeCalls = activeCalls;
        res.locals.currentPage = req.path;
        res.locals.currentLang = req.query.lang === 'ar' ? 'ar' : 'en';
        next();
    } catch (err) { next(err); }
});

// --- ROUTE 1: LANDING DASHBOARD ---
app.get('/', async (req, res) => {
    try {
        const startDate = req.query.startDate ? moment(req.query.startDate).format('YYYY-MM-DD HH:mm:ss') : moment().startOf('day').format('YYYY-MM-DD HH:mm:ss');
        const endDate = req.query.endDate ? moment(req.query.endDate).format('YYYY-MM-DD HH:mm:ss') : moment().endOf('day').format('YYYY-MM-DD HH:mm:ss');

        const [rows] = await pool.query(`SELECT src, dst, billsec, REPLACE(disposition, 'CONGESTION', 'FAILED') as disposition, channel, dstchannel, calldate FROM ${tables.cdr} WHERE calldate BETWEEN ? AND ?`, [startDate, endDate]);

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

        const calls = rows.slice(0, 50).map(r => ({
            calldate: r.calldate, src: r.src, dst: r.dst, billsec: r.billsec, disposition: r.disposition
        }));

        res.render('dashboard', { stats, employeeMetrics: Object.values(employeeMetrics), calls, filters: { startDate, endDate }, moment });
    } catch (error) { res.status(500).send("Dashboard Error: " + error.message); }
});

// --- ROUTE 2: CDR DETAILS VIEW (Paginated) ---
app.get('/cdr', async (req, res) => {
    try {
        const startDate = req.query.startDate ? moment(req.query.startDate).format('YYYY-MM-DD HH:mm:ss') : moment().startOf('day').format('YYYY-MM-DD HH:mm:ss');
        const endDate = req.query.endDate ? moment(req.query.endDate).format('YYYY-MM-DD HH:mm:ss') : moment().endOf('day').format('YYYY-MM-DD HH:mm:ss');
        const selectedExtension = req.query.targetExtension || 'ALL';
        const statusFilter = req.query.statusFilter || 'ALL';
        const searchSrc = req.query.searchSrc || '';
        const searchDst = req.query.searchDst || '';
        const directionFilter = req.query.directionFilter || 'ALL';
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const perPage = Math.min(200, Math.max(10, parseInt(req.query.perPage) || 10));
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
        `;
        let countParams = [startDate, endDate];

        let query = `
            SELECT c.calldate, c.src, c.dst, c.duration, c.billsec, REPLACE(c.disposition, 'CONGESTION', 'FAILED') as disposition, c.uniqueid, c.recordingfile, c.channel, c.dstchannel, COALESCE(u.name, 'No Name') as src_name,
            ${directionCase} as direction
            FROM ${tables.cdr} c
            LEFT JOIN ${tables.users} u ON c.src = u.extension
            WHERE c.calldate BETWEEN ? AND ?
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

        res.render('cdr', {
            calls: rows,
            filters: { startDate, endDate, targetExtension: selectedExtension, statusFilter, searchSrc, searchDst, directionFilter, page, perPage },
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
            SELECT c.calldate, c.src, c.dst, c.duration, c.billsec, REPLACE(c.disposition, 'CONGESTION', 'FAILED') as disposition, c.uniqueid, c.recordingfile, c.channel, c.dstchannel, COALESCE(u.name, 'No Name') as src_name,
            ${directionCase} as direction
            FROM ${tables.cdr} c
            LEFT JOIN ${tables.users} u ON c.src = u.extension
            WHERE c.calldate BETWEEN ? AND ?
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
            const rowData = [
                moment(row.calldate).format('YYYY-MM-DD HH:mm:ss'),
                row.src || '',
                row.src_name || '',
                row.dst || '',
                row.duration || 0,
                row.billsec || 0,
                row.disposition || '',
                row.direction || '',
                row.channel || '',
                row.dstchannel || '',
                row.uniqueid || ''
            ];
            csvContent += rowData.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",") + "\n";
        }

        const filename = `cdr_export_${moment().format('YYYYMMDD_HHmmss')}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csvContent);

    } catch (error) {
        res.status(500).send("CDR Export Error: " + error.message);
    }
});

// --- API: GENERAL EXTENSIONS OVERVIEW ---
app.get('/api/ext-overview', async (req, res) => {
    try {
        const startDate = req.query.startDate ? moment(req.query.startDate).format('YYYY-MM-DD HH:mm:ss') : moment().startOf('day').format('YYYY-MM-DD HH:mm:ss');
        const endDate = req.query.endDate ? moment(req.query.endDate).format('YYYY-MM-DD HH:mm:ss') : moment().endOf('day').format('YYYY-MM-DD HH:mm:ss');

        const [rows] = await pool.query(`SELECT src, dst, billsec, REPLACE(disposition, 'CONGESTION', 'FAILED') as disposition, channel, dstchannel FROM ${tables.cdr} WHERE calldate BETWEEN ? AND ?`, [startDate, endDate]);

        const employeeMetrics = {};
        res.locals.roster.forEach(emp => {
            employeeMetrics[emp.extension] = { 
                extension: emp.extension, 
                name: emp.name, 
                online: emp.online,
                agentStatus: emp.agentStatus,
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

// Parse Asterisk 'dongle show devices' CLI output
function parseDevicesOutput(output) {
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
            devices.push(row);
        }
    }
    return devices;
}

// Start background tail log monitor on the Asterisk verbose log file
function startUssdLogMonitor() {
    console.log("GSM MONITOR: Starting tail process on /var/log/asterisk/full...");
    const tail = spawn('tail', ['-n', '0', '-F', '/var/log/asterisk/full']);
    
    tail.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        const responsePattern = /\[([^\]]+)\] VERBOSE\[\d+\] at_response\.c:\s+\[([^\]]+)\] Got USSD type \d+ '[^']*': '(.*)'/;
        const dongleLogPattern = /chan_dongle|at_response|app_ussd|dongle[0-9]+/i;
        
        for (const line of lines) {
            if (!line.trim()) continue;
            
            // Log streaming
            if (dongleLogPattern.test(line)) {
                io.emit('dongleLog', line.trim());
            }
            
            // Parse USSD response
            const match = responsePattern.exec(line);
            if (match) {
                const logTime = match[1];
                const dongleId = match[2];
                const text = match[3];
                console.log(`GSM MONITOR: Captured USSD response for ${dongleId} -> ${text}`);
                latestUssdResponses[dongleId] = {
                    text: text,
                    timestamp: Date.now(),
                    logTime: logTime
                };
                io.emit('ussdResponse', { dongleId, text, logTime });
            }
        }
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

// Self-healing SIM number auto-provisioning mapping list
const dongleNumberMappings = {
    'dongle0': '+201027826232',
    // Add other default/placeholder slots if needed
};

function autoProvisionSimNumbers() {
    execFile(ASTERISK_BIN, ['-rx', 'dongle show devices'], (error, stdout, stderr) => {
        if (error || !stdout) return;
        
        const devices = parseDevicesOutput(stdout);
        devices.forEach(d => {
            const state = String(d.State || '').toLowerCase();
            const number = String(d.Number || '').toLowerCase();
            const dongleId = d.ID;
            
            // Only auto-provision if the device is Free/Active (registered) and the number is Unknown/empty
            if (state === 'free' && (number === 'unknown' || number === '')) {
                const targetNumber = dongleNumberMappings[dongleId];
                if (targetNumber) {
                    console.log(`GSM MONITOR: Auto-provisioning SIM own number for ${dongleId} -> ${targetNumber}...`);
                    
                    // Write to SIM own numbers storage (ON)
                    execFile(ASTERISK_BIN, ['-rx', `dongle cmd ${dongleId} AT+CPBS="ON"`], (err1, out1) => {
                        if (err1) return console.error(`GSM MONITOR: Failed CPBS select for ${dongleId}`, err1);
                        
                        execFile(ASTERISK_BIN, ['-rx', `dongle cmd ${dongleId} AT+CPBW=1,"${targetNumber}","Number"`], (err2, out2) => {
                            if (err2) return console.error(`GSM MONITOR: Failed CPBW write for ${dongleId}`, err2);
                            
                            console.log(`GSM MONITOR: Wrote number ${targetNumber} to ${dongleId} SIM. Restarting dongle...`);
                            
                            // Software restart to re-read SIM card MSISDN
                            execFile(ASTERISK_BIN, ['-rx', `dongle restart now ${dongleId}`], (err3, out3) => {
                                if (err3) console.error(`GSM MONITOR: Failed soft restart for ${dongleId}`, err3);
                            });
                        });
                    });
                }
            }
        });
    });
}

// Run the auto-provisioning check every 30 seconds
setInterval(autoProvisionSimNumbers, 30000);
// Run initially after 10 seconds
setTimeout(autoProvisionSimNumbers, 10000);

// Page View route
app.get('/gsm-dongles', (req, res) => {
    try {
        execFile(ASTERISK_BIN, ['-rx', 'dongle show devices'], (error, stdout, stderr) => {
            let devices = [];
            if (!error && stdout) {
                devices = parseDevicesOutput(stdout);
            }
            res.render('gsm-dongles', {
                devices,
                moment
            });
        });
    } catch (error) {
        res.status(500).send("GSM Dongle System Error: " + error.message);
    }
});

// API Endpoint to fetch latest device status
app.get('/api/gsm-dongles', (req, res) => {
    execFile(ASTERISK_BIN, ['-rx', 'dongle show devices'], (error, stdout, stderr) => {
        if (error) {
            return res.status(500).json({ success: false, error: stderr || error.message });
        }
        const devices = parseDevicesOutput(stdout);
        res.json({ success: true, devices });
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
        res.json({ success: true, output: stdout.trim() });
    });
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

// --- ROUTE 4.5: AGENT STATUS REPORTS VIEW ---
app.get('/agent-status', async (req, res) => {
    try {
        const startDate = req.query.startDate ? moment(req.query.startDate).format('YYYY-MM-DD HH:mm:ss') : moment().startOf('day').format('YYYY-MM-DD HH:mm:ss');
        const endDate = req.query.endDate ? moment(req.query.endDate).format('YYYY-MM-DD HH:mm:ss') : moment().endOf('day').format('YYYY-MM-DD HH:mm:ss');
        const selectedExtension = req.query.targetExtension || 'ALL';
        
        let query = `
            SELECT id, extension, status, start_time, end_time, duration_seconds 
            FROM ${tables.agentStatusLog}
            WHERE start_time BETWEEN ? AND ?
        `;
        let queryParams = [startDate, endDate];
        
        if (selectedExtension !== 'ALL') {
            query += " AND extension = ?";
            queryParams.push(selectedExtension);
        }
        query += " ORDER BY start_time DESC";
        
        const [logs] = await pool.query(query, queryParams);
        
        // Calculate totals
        const totals = {};
        logs.forEach(log => {
            if (!totals[log.status]) totals[log.status] = 0;
            totals[log.status] += (log.duration_seconds || 0);
        });

        res.render('agent-status', { 
            logs, 
            totals,
            filters: { startDate, endDate, targetExtension: selectedExtension }, 
            moment 
        });
    } catch (error) { res.status(500).send("Agent Status Error: " + error.message); }
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

server.listen(PORT, () => console.log(`Real-Time Enterprise Engine active on port ${PORT}`));
