#!/usr/bin/env node
const { program } = require('commander');
const path = require('path');
const os = require('os');
const fastify = require('fastify')({ logger: true });
const fs = require('fs/promises');
const nodeCrypto = require('crypto');
const Holesail = require('holesail');
const { default: pLimit } = require('p-limit');
const pkg = require('../package.json');
const auth = require('./auth');

const accessTokenExpirySeconds = 10 * 60; // 10 minutes

// Determine default data directory based on OS
function getDefaultDataDir() {
  const appName = 'holesail-switchboard';
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), appName);
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', appName);
    default: // linux and others
      return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), appName);
  }
}

function getDefaultDataFile() {
  if (process.env.HSSB_DATA_FILE) {
    return path.isAbsolute(process.env.HSSB_DATA_FILE)
      ? process.env.HSSB_DATA_FILE
      : path.join(__dirname, '..', process.env.HSSB_DATA_FILE);
  }
  return path.join(getDefaultDataDir(), 'data.json');
}

let dataFile = getDefaultDataFile();
let clientHost = process.env.HSSB_CLIENT_HOST || '127.0.0.1';
const subtitle = process.env.HSSB_SUBTITLE;
const fixedClientPortsString = process.env.HSSB_FIXED_CLIENT_PORTS;

let webServerHost = process.env.HSSB_HOST || '127.0.0.1';
let webServerPort = process.env.HSSB_PORT || 3000; // will be converted to a number later

const holesailServers = [];
const holesailClients = [];
let passwordHash = null; // "salt:derivedKey" when set


// Validation helpers
function isValidServerKey(key) {
  // See: https://github.com/holesail/holesail/issues/64
  return typeof key === 'string' && (
    (key === '') || (64 <= key.length && key.length <= 1000 && key[5] !== 's')
  );
}

function isValidClientKey(key) {
  return typeof key === 'string' && ((key === '') || key.startsWith('hs://'));
}

function isValidPort(port) {
  return typeof port === 'number' && Number.isInteger(port) && port >= 0 && port <= 65535;
}

function isValidHost(host) {
  return typeof host === 'string' && host.length <= 255;
}

// Save data to file
async function saveData() {
  await fs.writeFile(dataFile, JSON.stringify({
    servers: holesailServers.map((server) => ({ ...server, hs: undefined, state: undefined })),
    clients: holesailClients.map((client) => ({ ...client, hs: undefined, state: undefined })),
    passwordHash
  }, null, 2));
}

// Initialize data file
async function ensureDataFile(fixedClientPorts) {
  try {
    console.info(`Using data file: ${dataFile}`);
    await fs.mkdir(path.dirname(dataFile), { recursive: true });
    try {
      const fileContent = await fs.readFile(dataFile, 'utf-8');
      const data = JSON.parse(fileContent);
      if (Array.isArray(data.servers)) {
        holesailServers.push(...data.servers);
      }
      if (data.passwordHash && typeof data.passwordHash === 'string') {
        passwordHash = data.passwordHash;
      }
      if (Array.isArray(data.clients)) {
        holesailClients.push(...data.clients.filter(
          (client) => !fixedClientPorts || fixedClientPorts.has(client.port))
        );
      }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        console.info(`Data file does not exist, creating empty data file`);
      } else {
        console.warn('Error initializing data file - resetting', error);
      }
      await saveData();
    }
  } catch (err) {
    console.error('Error initializing data file', err);
    return false;
  }
  return true;
}

// Server management
async function startServer(index) {
  const holesailServer = holesailServers[index];
  if (!holesailServer) {
    return;
  }
  holesailServer.state = 'initializing';
  if (!holesailServer.enabled) {
    holesailServer.state = 'disabled';
    return;
  }

  try {
    const hs = new Holesail({
      server: true,
      host: holesailServer.host,
      port: holesailServer.port,
      key: holesailServer.key,
      secure: holesailServer.secure,
    });
    await hs.ready();
    holesailServer.hs = hs;
    holesailServer.state = 'running';
    fastify.log.info(`Server ${index} started: ${holesailServer.host}:${holesailServer.port}`);
  } catch (err) {
    holesailServer.state = 'failed';
    fastify.log.error(`Server ${index} failed to start:`, err);
  }
}

async function stopServer(index) {
  const holesailServer = holesailServers[index];
  holesailServer.state = 'stopping';
  if (holesailServer.hs) {
    try {
      await holesailServer.hs.close();
    } catch (err) {
      fastify.log.error(`Error stopping server ${index}:`, err);
    }
    delete holesailServer.hs;
  }
  holesailServer.state = 'stopped';
}

// Client management
async function startClient(index) {
  const holesailClient = holesailClients[index];
  if (!holesailClient) {
    return;
  }
  holesailClient.state = 'initializing';
  if (!holesailClient.enabled) {
    holesailClient.state = 'disabled';
    return;
  }
  try {
    const hs = new Holesail({
      client: true,
      key: holesailClient.key,
      port: holesailClient.port,
      ...(clientHost ? { host: clientHost } : {}),
    });
    await hs.ready();
    holesailClient.hs = hs;
    holesailClient.state = 'running';
    fastify.log.info(`Client ${index} started: connecting to ${
      holesailClient.key.substring(0, 8)
    }... on port ${holesailClient.port}.`);
  } catch (err) {
    holesailClient.state = 'failed';
    fastify.log.error(`Client ${index} failed to start:`, err);
  }
}

async function stopClient(index) {
  const holesailClient = holesailClients[index];
  if (holesailClient.hs) {
    try {
      await holesailClient.hs.close();
    } catch (err) {
      fastify.log.error(`Error stopping client ${index}:`, err);
    }
    delete holesailClient.hs;
  }
  holesailClient.state = 'stopped';
}

const mutationLimit = pLimit(1);

function getBearerTokenFromRequest(request) {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}

function signAccessToken(sessionId) {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + accessTokenExpirySeconds;
  const token = fastify.jwt.sign(
    { sid: sessionId },
    { expiresIn: accessTokenExpirySeconds, jwtid: nodeCrypto.randomUUID() }
  );
  return { token, expiresAt };
}

async function requireAuth(request, reply) {
  if (!passwordHash) return; // No auth needed if no password set

  const token = getBearerTokenFromRequest(request);
  if (!token) {
    return reply.code(401).send({ error: 'Authentication required' });
  }

  try {
    const payload = await fastify.jwt.verify(token);
    if (!payload || typeof payload !== 'object' || typeof payload.sid !== 'string') {
      return reply.code(401).send({ error: 'Invalid or expired token' });
    }
    if (!auth.isSessionActive(payload.sid)) {
      return reply.code(401).send({ error: 'Invalid or expired token' });
    }
    request.auth = { sessionId: payload.sid };
  } catch {
    return reply.code(401).send({ error: 'Invalid or expired token' });
  }
}

// Register JWT support (used for access tokens)
fastify.register(require('@fastify/jwt'), {
  secret: process.env.HSSB_JWT_SECRET || nodeCrypto.randomBytes(32).toString('hex'),
});

// Register static file serving
fastify.register(require('@fastify/static'), {
  root: path.join(__dirname, 'static'),
});

// Serve the main page
fastify.get('/', (_request, reply) => {
  reply.sendFile('index.html');
});

// API Routes

// POST /api/auth/login - Login with password
fastify.post('/api/auth/login', async (request, reply) => {
  try {
    if (!passwordHash) {
      return reply.code(400).send({ error: 'No password set' });
    }

    const { password } = request.body || {};
    if (!password || typeof password !== 'string') {
      return reply.code(400).send({ error: 'Password is required' });
    }

    const isValid = await auth.verifyPassword(password, passwordHash);
    if (!isValid) {
      return reply.code(401).send({ error: 'Invalid password' });
    }

    const session = auth.createSession();
    if (!session) {
      return reply.code(429).send({ error: 'Maximum sessions reached. Please logout from another device.' });
    }
    const access = signAccessToken(session.sessionId);

    reply.header('Cache-Control', 'no-store');
    return {
      success: true,
      token: access.token,
      expiresAt: access.expiresAt,
      refreshToken: session.refreshToken,
    };
  } catch (err) {
    fastify.log.error('POST /api/auth/login failed', err);
    return reply.code(500).send({ error: 'Login failed' });
  }
});

// POST /api/auth/logout - Logout (invalidate session)
fastify.post('/api/auth/logout', async (request, reply) => {
  try {
    const { refreshToken } = request.body || {};
    if (refreshToken && typeof refreshToken === 'string') {
      auth.invalidateSessionByRefreshToken(refreshToken);
    }

    reply.header('Cache-Control', 'no-store');
    return { success: true };
  } catch (err) {
    fastify.log.error('POST /api/auth/logout failed', err);
    return reply.code(500).send({ error: 'Logout failed' });
  }
});

// POST /api/auth/refresh - Refresh token
fastify.post('/api/auth/refresh', async (request, reply) => {
  try {
    const { refreshToken } = request.body || {};
    const session = auth.refreshSession(refreshToken);
    if (!session) {
      return reply.code(401).send({ error: 'Invalid session' });
    }

    const access = signAccessToken(session.sessionId);
    reply.header('Cache-Control', 'no-store');
    return {
      success: true,
      token: access.token,
      expiresAt: access.expiresAt,
      refreshToken: session.refreshToken,
    };
  } catch (err) {
    fastify.log.error('POST /api/auth/refresh failed', err);
    return reply.code(500).send({ error: 'Token refresh failed' });
  }
});

// POST /api/auth/set-password - Set or change password
fastify.post(
  '/api/auth/set-password',
  { preHandler: requireAuth },
  async (request, reply) => mutationLimit(async () => {
  try {
    const { currentPassword, newPassword } = request.body || {};

    // Validate new password
    if (typeof newPassword !== 'string') {
      return reply.code(400).send({ error: 'New password is required' });
    }

    // If password already exists, require authentication
    if (passwordHash) {
      // Verify current password
      if (!currentPassword || typeof currentPassword !== 'string') {
        return reply.code(400).send({ error: 'Current password is required' });
      }

      const isValid = await auth.verifyPassword(currentPassword, passwordHash);
      if (!isValid) {
        return reply.code(400).send({ error: 'Current password is incorrect' });
      }

      // Invalidate all other sessions on password change
      auth.invalidateAllSessions(request.auth.sessionId);
    }

    // Hash and store new password
    if (newPassword) {
      passwordHash = await auth.hashPassword(newPassword);
    } else {
      passwordHash = null;
    }
    await saveData();

    return {
      success: true,
    };
  } catch (err) {
    fastify.log.error(`POST /api/auth/set-password failed: ${err}`);
    return reply.code(500).send({ error: 'Failed to set password' });
  }
}));

fastify.get('/api/auth/required', async (_request, _reply) => {
  return {
    authRequired: Boolean(passwordHash),
  };
});

// GET /api/settings - Return all servers/clients with state
fastify.get('/api/settings', { preHandler: requireAuth }, async (_request, _reply) => {
  return {
    servers: holesailServers.map((server) => ({
      ...server,
      hs: undefined,
      ...server.hs ? { hsInfoUrl: server.hs.info.url } : {},
    })),
    clients: holesailClients.map((client) => ({
      ...client,
      hs: undefined,
    })),
    ...subtitle ? { subtitle } : {},
    ...clientHost ? { clientHost } : {},
    fixedClientPorts: Boolean(fixedClientPortsString),
    authRequired: Boolean(passwordHash),
  };
});

// POST /api/servers - Create new server
fastify.post('/api/servers', { preHandler: requireAuth }, async (request, reply) => mutationLimit(async () => {
  try {
    const { host, port, key, secure, enabled } = request.body || {};

    if (!isValidHost(host)) {
      return reply.code(400).send({ error: 'Invalid host' });
    }
    if (!isValidPort(port)) {
      return reply.code(400).send({ error: 'Invalid port' });
    }
    if (!isValidServerKey(key)) {
      return reply.code(400).send({ error: 'Key must be a string of at least 64 characters' });
    }
    if (typeof secure !== 'boolean') {
      return reply.code(400).send({ error: 'Secure must be a boolean' });
    }
    if (typeof enabled !== 'boolean') {
      return reply.code(400).send({ error: 'Enabled must be a boolean' });
    }
    if (enabled) {
      if (key === '') {
        return reply.code(400).send({ error: 'Key is required when server is enabled' });
      }
      if (host === '') {
        return reply.code(400).send({ error: 'Host is required when server is enabled' });
      }
      if (port === 0) {
        return reply.code(400).send({ error: 'Port is required when server is enabled' });
      }
    }

    holesailServers.push({ host, port, key, secure, enabled });
    const index = holesailServers.length - 1;
    await saveData();
    await startServer(index);
    return { success: true, index };
  } catch (err) {
    fastify.log.error('POST /api/servers failed', err);
    return reply.code(500).send({ error: 'Error creating server' });
  }
}));

// PATCH /api/servers/:index - Update server
fastify.patch('/api/servers/:index', { preHandler: requireAuth }, async (request, reply) => mutationLimit(async () => {
  try {
    const index = parseInt(request.params.index, 10);
    if (typeof index !== 'number' || Number.isNaN(index) || index < 0 || index >= holesailServers.length) {
      return reply.code(404).send({ error: 'Server not found' });
    }

    const { host, port, key, secure, enabled } = request.body;
    if (!isValidHost(host)) {
      return reply.code(400).send({ error: 'Invalid host' });
    }
    if (!isValidPort(port)) {
      return reply.code(400).send({ error: 'Invalid port' });
    }
    if (!isValidServerKey(key)) {
      return reply.code(400).send({ error: 'Key must be a string of at least 64 characters' });
    }
    if (typeof secure !== 'boolean') {
      return reply.code(400).send({ error: 'Secure must be a boolean' });
    }
    if (typeof enabled !== 'boolean') {
      return reply.code(400).send({ error: 'Enabled must be a boolean' });
    }
    if (enabled) {
      if (key === '') {
        return reply.code(400).send({ error: 'Key is required when server is enabled' });
      }
      if (host === '') {
        return reply.code(400).send({ error: 'Host is required when server is enabled' });
      }
      if (port === 0) {
        return reply.code(400).send({ error: 'Port is required when server is enabled' });
      }
    }

    await stopServer(index);
    holesailServers[index] = { host, port, key, secure, enabled };
    await startServer(index);
    await saveData();
    return { success: true };
  } catch (err) {
    fastify.log.error('PATCH /api/servers/:index failed', err);
    return reply.code(500).send({ error: 'Error updating server' });
  }
}));

// DELETE /api/servers/:index - Delete server
fastify.delete('/api/servers/:index', { preHandler: requireAuth }, async (request, reply) => mutationLimit(async () => {
  try {
    const index = parseInt(request.params.index, 10);
    if (typeof index !== 'number' || Number.isNaN(index) || index < 0 || index >= holesailServers.length) {
      return reply.code(404).send({ error: 'Server not found' });
    }

    // Stop the server
    await stopServer(index);

    // Remove from data
    holesailServers.splice(index, 1);
    await saveData();
    return { success: true };
  } catch (err) {
    fastify.log.error('DELETE /api/servers/:index failed', err);
    return reply.code(500).send({ error: 'Error deleting server' });
  }
}));

// POST /api/clients - Create new client
fastify.post('/api/clients', { preHandler: requireAuth }, async (request, reply) => mutationLimit(async () => {
  try {
    if (fixedClientPortsString) {
      return reply.code(403).send({ error: 'Unauthorized to create clients' });
    }
    const { key, port, enabled } = request.body;

    if (!isValidClientKey(key)) {
      return reply.code(400).send({ error: 'Key must be a valid HS URL' });
    }
    if (!isValidPort(port)) {
      return reply.code(400).send({ error: 'Invalid port' });
    }
    if (typeof enabled !== 'boolean') {
      return reply.code(400).send({ error: 'Enabled must be a boolean' });
    }
    if (enabled) {
      if (key === '') {
        return reply.code(400).send({ error: 'HS URL is required when client is enabled' });
      }
      if (port === 0) {
        return reply.code(400).send({ error: 'Port is required when client is enabled' });
      }
    }

    holesailClients.push({
      key,
      port,
      enabled,
    });
    const index = holesailClients.length - 1;
    await saveData();
    await startClient(index);
    return { success: true, index };
  } catch (err) {
    fastify.log.error('POST /api/clients failed', err);
    return reply.code(500).send({ error: 'Error creating client' });
  }
}));

// PATCH /api/clients/:index - Update client
fastify.patch('/api/clients/:index', { preHandler: requireAuth }, async (request, reply) => mutationLimit(async () => {
  try {
    const index = parseInt(request.params.index, 10);
    if (typeof index !== 'number' || Number.isNaN(index) || index < 0 || index >= holesailClients.length) {
      return reply.code(404).send({ error: 'Client not found' });
    }

    const { key, port, enabled } = request.body;

    if (!isValidClientKey(key)) {
      return reply.code(400).send({ error: 'Key must be a valid HS URL' });
    }
    if (!isValidPort(port)) {
      return reply.code(400).send({ error: 'Invalid port' });
    }
    if (typeof enabled !== 'boolean') {
      return reply.code(400).send({ error: 'Enabled must be a boolean' });
    }
    if (enabled) {
      if (key === '') {
        return reply.code(400).send({ error: 'HS URL is required when client is enabled' });
      }
      if (port === 0) {
        return reply.code(400).send({ error: 'Port is required when client is enabled' });
      }
    }
    if (fixedClientPortsString && port !== holesailClients[index].port) {
      return reply.code(403).send({ error: 'Unauthorized to change client port' });
    }

    await stopClient(index);
    holesailClients[index] = { key, port, enabled };
    await saveData();
    await startClient(index);
    return { success: true };
  } catch (err) {
    fastify.log.error('PATCH /api/clients/:index failed', err);
    return reply.code(500).send({ error: 'Error updating client' });
  }
}));

// DELETE /api/clients/:index - Delete client
fastify.delete('/api/clients/:index', { preHandler: requireAuth }, async (request, reply) => mutationLimit(async () => {
  try {
    if (fixedClientPortsString) {
      return reply.code(403).send({ error: 'Unauthorized to delete clients' });
    }
    const index = parseInt(request.params.index, 10);
    if (typeof index !== 'number' || Number.isNaN(index) || index < 0 || index >= holesailClients.length) {
      return reply.code(404).send({ error: 'Client not found' });
    }

    await stopClient(index);
    holesailClients.splice(index, 1);
    await saveData();
    return { success: true };
  } catch (err) {
    fastify.log.error('DELETE /api/clients/:index failed', err);
    return reply.code(500).send({ error: 'Error deleting client' });
  }
}));

// Start the server
async function start(openBrowser = false) {
  try {
    // Initialize authentication
    auth.initAuth();

    let fixedClientPorts = null;
    if (fixedClientPortsString) {
      fixedClientPorts = new Set();
      for (const fixedClientPortPart of fixedClientPortsString.split(',')) {
        if (fixedClientPortPart.length <= 5 && /^\d+$/.test(fixedClientPortPart)) {
          fixedClientPorts.add(parseInt(fixedClientPortPart, 10));
        } else if (fixedClientPortPart.length <= 11 && /^\d+-\d+$/.test(fixedClientPortPart)) {
          const [start, end] = fixedClientPortPart.split('-').map(port => parseInt(port, 10));
          if (end > start && end - start < 1000) {
            for (let port = start; port <= end; port++) {
              fixedClientPorts.add(port);
            }
          } else {
            throw new Error(`Invalid FIXED_CLIENT_PORTS port range: ${
              fixedClientPortPart
            } - expected <low>-<high> with <low> < <high> and <high> - <low> < 1000`);
          }
        } else {
          throw new Error('Invalid FIXED_CLIENT_PORTS environment variable format');
        }
      }
    }
    if (!await ensureDataFile(fixedClientPorts)) {
      throw new Error('Failed to initialize data file');
    }
    if (fixedClientPorts) {
      const usedPorts = new Set(holesailClients.map(client => client.port));
      const unusedPorts = [...fixedClientPorts].filter(port => !usedPorts.has(port)).sort((a, b) => a - b);
      for (const port of unusedPorts) {
        holesailClients.push({
          key: '',
          port,
          enabled: false,
        });
      }
      if (unusedPorts.length > 0) {
        console.info(`Created ${unusedPorts.length} unused clients for ports: ${unusedPorts.join(', ')}`);
        await saveData();
      }
    }

    for (let i = 0; i < holesailServers.length; i++) {
      await startServer(i);
    }

    for (let i = 0; i < holesailClients.length; i++) {
      await startClient(i);
    }

    await fastify.listen({ host: webServerHost, port: webServerPort });
    const url = `http://${webServerHost}:${webServerPort}`;
    await new Promise(resolve => setTimeout(resolve, 500));
    console.info(`Web dashboard UI running on: ${url}`);

    if (openBrowser) {
      const open = (await import('open')).default;
      await open(url).catch((error) => {
        console.warn('Failed to open browser', error);
        console.info(
          'If your environment does not have a browser, you can use the --no-open flag to avoid this error message.',
        );
      });
    }
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

if (require.main === module) {
  program
    .name('holesail-switchboard')
    .description('A web interface to manage multiple holesail servers and clients')
    .version(pkg.version)
    .option('-d, --data-file <path>', 'Path to data file (overrides HSSB_DATA_FILE)')
    .option('-p, --port <number>', 'Web dashboard UI port (overrides HSSB_PORT)')
    .option('-H, --host <address>', 'Web dashboard UI host (overrides HSSB_HOST)')
    .option('-c, --client-host <address>', 'Host for Holesail clients to bind to (overrides HSSB_CLIENT_HOST)')
    .option('--no-open', 'Don\'t open browser on startup')
    .parse();

  const cliOptions = program.opts();

  // Override globals with CLI flags (CLI takes precedence)
  if (cliOptions.dataFile) {
    dataFile = path.isAbsolute(cliOptions.dataFile)
      ? cliOptions.dataFile
      : path.join(process.cwd(), cliOptions.dataFile);
  }
  if (cliOptions.port) {
    webServerPort = cliOptions.port;
  }
  if (cliOptions.host) {
    webServerHost = cliOptions.host;
  }
  if (cliOptions.clientHost) {
    clientHost = cliOptions.clientHost;
  }

  const originalWebServerPort = webServerPort;
  webServerPort = Number(webServerPort);
  if (!Number.isSafeInteger(webServerPort) || webServerPort <= 0 || webServerPort > 65535) {
    console.error('Invalid web server port', originalWebServerPort);
    process.exit(1);
  }
  void start(cliOptions.open);
}
