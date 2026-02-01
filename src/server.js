require('dotenv').config();
const fastify = require('fastify')({ logger: true });
const path = require('path');
const fs = require('fs/promises');
const Holesail = require('holesail');
const { default: pLimit } = require('p-limit');

const dataFile = process.env.HSSB_DATA_FILE && (
  path.isAbsolute(process.env.HSSB_DATA_FILE)
    ? process.env.HSSB_DATA_FILE
    : path.join(__dirname, '..', process.env.HSSB_DATA_FILE)
);
const clientHost = process.env.HSSB_CLIENT_HOST;
const subtitle = process.env.HSSB_SUBTITLE;

const holesailServers = [];
const holesailClients = [];

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
  }, null, 2));
}

// Initialize data file
async function ensureDataFile() {
  try {
    if (!dataFile) {
      console.error('HSSB_DATA_FILE environment variable is not set, see .env.example file.');
      return false;
    }
    await fs.mkdir(path.dirname(dataFile), { recursive: true });
    try {
      await fs.access(dataFile);
      const fileContent = await fs.readFile(dataFile, 'utf-8');
      const data = JSON.parse(fileContent);
      if (Array.isArray(data.servers)) {
        holesailServers.push(...data.servers);
      }
      if (Array.isArray(data.clients)) {
        holesailClients.push(...data.clients);
      }
    } catch (error) {
      console.error('Error initializing data file - resetting', error);
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

// Register static file serving
fastify.register(require('@fastify/static'), {
  root: path.join(__dirname, 'static'),
});

// Serve the main page
fastify.get('/', (_request, reply) => {
  reply.sendFile('index.html');
});

// API Routes

// GET /api/settings - Return all servers/clients with state
fastify.get('/api/settings', async (_request, _reply) => {
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
  };
});

// POST /api/servers - Create new server
fastify.post('/api/servers', async (request, reply) => mutationLimit(async () => {
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
fastify.patch('/api/servers/:index', async (request, reply) => mutationLimit(async () => {
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
fastify.delete('/api/servers/:index', async (request, reply) => mutationLimit(async () => {
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
fastify.post('/api/clients', async (request, reply) => mutationLimit(async () => {
  try {
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
fastify.patch('/api/clients/:index', async (request, reply) => mutationLimit(async () => {
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
fastify.delete('/api/clients/:index', async (request, reply) => mutationLimit(async () => {
  try {
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
async function start() {
  try {
    if (!await ensureDataFile()) {
      throw new Error('Failed to initialize data file');
    }

    for (let i = 0; i < holesailServers.length; i++) {
      await startServer(i);
    }

    for (let i = 0; i < holesailClients.length; i++) {
      await startClient(i);
    }

    const host = process.env.HSSB_HOST || '0.0.0.0';
    const port = Number(process.env.HSSB_PORT) || 3000;
    await fastify.listen({ host, port });
    fastify.log.info(`Server running on host ${host}, port ${port}.`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

if (require.main === module) {
  void start();
}
