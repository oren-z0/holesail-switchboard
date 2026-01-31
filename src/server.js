require('dotenv').config();
const fastify = require('fastify')({ logger: true });
const path = require('path');
const fs = require('fs/promises');
const nodeCrypto = require('node:crypto');
const Holesail = require('holesail');

const dataFile = process.env.HSSB_DATA_FILE && (
  path.isAbsolute(process.env.HSSB_DATA_FILE)
    ? process.env.HSSB_DATA_FILE
    : path.join(__dirname, '..', process.env.HSSB_DATA_FILE)
);
const defaultClientHost = process.env.HSSB_CLIENT_HOST || '127.0.0.1';

// Runtime state maps
const serverStates = new Map();
const clientStates = new Map();

// Data storage
let data = {
  holesailServers: [],
  holesailClients: []
};

// Validation helpers
function isValidHexKey(key) {
  return typeof key === 'string' && key.length === 64 && /^[0-9a-fA-F]+$/.test(key);
}

function isValidPort(port) {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535;
}

function isValidHost(host) {
  return typeof host === 'string' && host.length > 0 && host.length <= 255;
}

// Save data to file
async function saveData() {
  await fs.writeFile(dataFile, JSON.stringify(data, null, 2));
}

// Server management
async function startServer(index) {
  const config = data.holesailServers[index];
  if (!config || !config.enabled) {
    return;
  }

  const state = serverStates.get(index) || { hs: null, state: 'disabled', error: null };
  serverStates.set(index, state);

  if (state.hs) {
    try {
      await state.hs.destroy();
    } catch (err) {
      fastify.log.error(`Error destroying server ${index}:`, err);
    }
    state.hs = null;
  }

  state.state = 'initializing';
  state.error = null;

  try {
    const hs = new Holesail();
    state.hs = hs;

    await new Promise((resolve, reject) => {
      hs.serve({
        port: config.port,
        address: config.host,
        buffSeed: config.key,
        secure: config.secure || false
      }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    state.state = 'running';
    fastify.log.info(`Server ${index} started: ${config.host}:${config.port}`);
  } catch (err) {
    state.state = 'failed';
    state.error = err.message;
    state.hs = null;
    fastify.log.error(`Server ${index} failed to start:`, err);
  }
}

async function stopServer(index) {
  const state = serverStates.get(index);
  if (state && state.hs) {
    try {
      await state.hs.destroy();
    } catch (err) {
      fastify.log.error(`Error stopping server ${index}:`, err);
    }
    state.hs = null;
  }
  serverStates.set(index, { hs: null, state: 'disabled', error: null });
}

// Client management
async function startClient(index) {
  const config = data.holesailClients[index];
  if (!config || !config.enabled) {
    return;
  }

  const state = clientStates.get(index) || { hs: null, state: 'disabled', error: null };
  clientStates.set(index, state);

  if (state.hs) {
    try {
      await state.hs.destroy();
    } catch (err) {
      fastify.log.error(`Error destroying client ${index}:`, err);
    }
    state.hs = null;
  }

  state.state = 'initializing';
  state.error = null;

  try {
    const hs = new Holesail();
    state.hs = hs;

    const host = config.host || defaultClientHost;

    await new Promise((resolve, reject) => {
      hs.connect({
        key: config.key,
        port: config.port,
        host: host
      }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    state.state = 'running';
    const keyPreview = config.key.substring(0, 8);
    fastify.log.info(`Client ${index} started: connecting to ${keyPreview}... on port ${config.port}`);
  } catch (err) {
    state.state = 'failed';
    state.error = err.message;
    state.hs = null;
    fastify.log.error(`Client ${index} failed to start:`, err);
  }
}

async function stopClient(index) {
  const state = clientStates.get(index);
  if (state && state.hs) {
    try {
      await state.hs.destroy();
    } catch (err) {
      fastify.log.error(`Error stopping client ${index}:`, err);
    }
    state.hs = null;
  }
  clientStates.set(index, { hs: null, state: 'disabled', error: null });
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
      data = JSON.parse(fileContent);
      if (!Array.isArray(data.holesailServers)) {
        data.holesailServers = [];
      }
      if (!Array.isArray(data.holesailClients)) {
        data.holesailClients = [];
      }
    } catch {
      data = { holesailServers: [], holesailClients: [] };
      await saveData();
    }
  } catch (err) {
    console.error('Error initializing data file', err);
    return false;
  }
  return true;
}

// Build response with runtime states
function buildSettingsResponse() {
  const servers = data.holesailServers.map((server, index) => {
    const state = serverStates.get(index) || { state: 'disabled', error: null };
    const response = {
      ...server,
      state: server.enabled ? state.state : 'disabled',
      error: state.error
    };
    if (state.state === 'running' && state.hs) {
      try {
        response.hsInfoUrl = state.hs.getPublicKey();
      } catch {
        // Key not available yet
      }
    }
    return response;
  });

  const clients = data.holesailClients.map((client, index) => {
    const state = clientStates.get(index) || { state: 'disabled', error: null };
    return {
      ...client,
      host: client.host || defaultClientHost,
      state: client.enabled ? state.state : 'disabled',
      error: state.error
    };
  });

  return { holesailServers: servers, holesailClients: clients };
}

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
  return buildSettingsResponse();
});

// POST /api/servers - Create new server
fastify.post('/api/servers', async (request, reply) => {
  try {
    const { host, port, key, secure, enabled } = request.body;

    if (!isValidHost(host)) {
      return reply.code(400).send({ error: 'Invalid host' });
    }
    if (!isValidPort(port)) {
      return reply.code(400).send({ error: 'Invalid port' });
    }
    if (key !== undefined && !isValidHexKey(key)) {
      return reply.code(400).send({ error: 'Key must be a 64 character hex string' });
    }

    const serverConfig = {
      host,
      port,
      key: key ? key.toLowerCase() : nodeCrypto.randomBytes(32).toString('hex'),
      secure: Boolean(secure),
      enabled: enabled !== false
    };

    data.holesailServers.push(serverConfig);
    const index = data.holesailServers.length - 1;
    await saveData();

    if (serverConfig.enabled) {
      await startServer(index);
    } else {
      serverStates.set(index, { hs: null, state: 'disabled', error: null });
    }

    return { success: true, index };
  } catch (err) {
    fastify.log.error('POST /api/servers failed', err);
    return reply.code(500).send({ error: 'Error creating server' });
  }
});

// PATCH /api/servers/:index - Update server
fastify.patch('/api/servers/:index', async (request, reply) => {
  try {
    const index = parseInt(request.params.index, 10);
    if (isNaN(index) || index < 0 || index >= data.holesailServers.length) {
      return reply.code(404).send({ error: 'Server not found' });
    }

    const { host, port, key, secure, enabled } = request.body;
    const server = data.holesailServers[index];

    if (host !== undefined) {
      if (!isValidHost(host)) {
        return reply.code(400).send({ error: 'Invalid host' });
      }
      server.host = host;
    }
    if (port !== undefined) {
      if (!isValidPort(port)) {
        return reply.code(400).send({ error: 'Invalid port' });
      }
      server.port = port;
    }
    if (key !== undefined) {
      if (!isValidHexKey(key)) {
        return reply.code(400).send({ error: 'Key must be a 64 character hex string' });
      }
      server.key = key.toLowerCase();
    }
    if (secure !== undefined) {
      server.secure = Boolean(secure);
    }
    if (enabled !== undefined) {
      server.enabled = Boolean(enabled);
    }

    await saveData();

    // Restart the server with new config
    await stopServer(index);
    if (server.enabled) {
      await startServer(index);
    }

    return { success: true };
  } catch (err) {
    fastify.log.error('PATCH /api/servers/:index failed', err);
    return reply.code(500).send({ error: 'Error updating server' });
  }
});

// DELETE /api/servers/:index - Delete server
fastify.delete('/api/servers/:index', async (request, reply) => {
  try {
    const index = parseInt(request.params.index, 10);
    if (isNaN(index) || index < 0 || index >= data.holesailServers.length) {
      return reply.code(404).send({ error: 'Server not found' });
    }

    // Stop the server
    await stopServer(index);

    // Remove from data
    data.holesailServers.splice(index, 1);
    await saveData();

    // Reindex states (shift indices down)
    const newServerStates = new Map();
    for (const [i, state] of serverStates.entries()) {
      if (i > index) {
        newServerStates.set(i - 1, state);
      } else if (i < index) {
        newServerStates.set(i, state);
      }
    }
    serverStates.clear();
    for (const [i, state] of newServerStates.entries()) {
      serverStates.set(i, state);
    }

    return { success: true };
  } catch (err) {
    fastify.log.error('DELETE /api/servers/:index failed', err);
    return reply.code(500).send({ error: 'Error deleting server' });
  }
});

// POST /api/clients - Create new client
fastify.post('/api/clients', async (request, reply) => {
  try {
    const { key, port, host, enabled } = request.body;

    if (!key || typeof key !== 'string' || key.length === 0) {
      return reply.code(400).send({ error: 'Key is required' });
    }
    if (!isValidPort(port)) {
      return reply.code(400).send({ error: 'Invalid port' });
    }
    if (host !== undefined && !isValidHost(host)) {
      return reply.code(400).send({ error: 'Invalid host' });
    }

    const clientConfig = {
      key,
      port,
      host: host || undefined,
      enabled: enabled !== false
    };

    data.holesailClients.push(clientConfig);
    const index = data.holesailClients.length - 1;
    await saveData();

    if (clientConfig.enabled) {
      await startClient(index);
    } else {
      clientStates.set(index, { hs: null, state: 'disabled', error: null });
    }

    return { success: true, index };
  } catch (err) {
    fastify.log.error('POST /api/clients failed', err);
    return reply.code(500).send({ error: 'Error creating client' });
  }
});

// PATCH /api/clients/:index - Update client
fastify.patch('/api/clients/:index', async (request, reply) => {
  try {
    const index = parseInt(request.params.index, 10);
    if (isNaN(index) || index < 0 || index >= data.holesailClients.length) {
      return reply.code(404).send({ error: 'Client not found' });
    }

    const { key, port, host, enabled } = request.body;
    const client = data.holesailClients[index];

    if (key !== undefined) {
      if (typeof key !== 'string' || key.length === 0) {
        return reply.code(400).send({ error: 'Invalid key' });
      }
      client.key = key;
    }
    if (port !== undefined) {
      if (!isValidPort(port)) {
        return reply.code(400).send({ error: 'Invalid port' });
      }
      client.port = port;
    }
    if (host !== undefined) {
      if (host === '' || host === null) {
        delete client.host;
      } else if (!isValidHost(host)) {
        return reply.code(400).send({ error: 'Invalid host' });
      } else {
        client.host = host;
      }
    }
    if (enabled !== undefined) {
      client.enabled = Boolean(enabled);
    }

    await saveData();

    // Restart the client with new config
    await stopClient(index);
    if (client.enabled) {
      await startClient(index);
    }

    return { success: true };
  } catch (err) {
    fastify.log.error('PATCH /api/clients/:index failed', err);
    return reply.code(500).send({ error: 'Error updating client' });
  }
});

// DELETE /api/clients/:index - Delete client
fastify.delete('/api/clients/:index', async (request, reply) => {
  try {
    const index = parseInt(request.params.index, 10);
    if (isNaN(index) || index < 0 || index >= data.holesailClients.length) {
      return reply.code(404).send({ error: 'Client not found' });
    }

    // Stop the client
    await stopClient(index);

    // Remove from data
    data.holesailClients.splice(index, 1);
    await saveData();

    // Reindex states (shift indices down)
    const newClientStates = new Map();
    for (const [i, state] of clientStates.entries()) {
      if (i > index) {
        newClientStates.set(i - 1, state);
      } else if (i < index) {
        newClientStates.set(i, state);
      }
    }
    clientStates.clear();
    for (const [i, state] of newClientStates.entries()) {
      clientStates.set(i, state);
    }

    return { success: true };
  } catch (err) {
    fastify.log.error('DELETE /api/clients/:index failed', err);
    return reply.code(500).send({ error: 'Error deleting client' });
  }
});

// Start the server
async function start() {
  try {
    if (!await ensureDataFile()) {
      throw new Error('Failed to initialize data file');
    }

    // Start all enabled servers
    for (let i = 0; i < data.holesailServers.length; i++) {
      if (data.holesailServers[i].enabled) {
        await startServer(i);
      } else {
        serverStates.set(i, { hs: null, state: 'disabled', error: null });
      }
    }

    // Start all enabled clients
    for (let i = 0; i < data.holesailClients.length; i++) {
      if (data.holesailClients[i].enabled) {
        await startClient(i);
      } else {
        clientStates.set(i, { hs: null, state: 'disabled', error: null });
      }
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
