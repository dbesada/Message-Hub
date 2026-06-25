const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const WebSocketImpl = globalThis.WebSocket;
if (!WebSocketImpl) {
  throw new Error('Global WebSocket is not available in this Node runtime.');
}

const REPO_ROOT = path.resolve(__dirname, '..');
const VERSION_PATH = path.join(REPO_ROOT, 'VERSION');
const DEPLOYMENT_PATH = path.join(REPO_ROOT, 'truenas-deployment.json');

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

function envValue(name, fallback = '') {
  const value = process.env[name];
  return value == null || value === '' ? fallback : value;
}

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function inferRegistryUri(image) {
  const trimmed = String(image || '').trim();
  if (!trimmed) return '';
  const firstSlash = trimmed.indexOf('/');
  if (firstSlash === -1) return 'https://index.docker.io/v1/';
  const registryHost = trimmed.slice(0, firstSlash);
  if (!registryHost.includes('.') && !registryHost.includes(':') && registryHost !== 'localhost') {
    return 'https://index.docker.io/v1/';
  }
  return `https://${registryHost}`;
}

function inferIconUrl(appUrl) {
  if (!appUrl) return '';
  try {
    const url = new URL(appUrl);
    return `${url.origin}/app-icon.svg`;
  } catch {
    return '';
  }
}

function rpc(socket, nextId, pending, method, params = []) {
  const id = nextId.value++;
  socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} timeout`));
      }
    }, 30000);
  });
}

async function connect(host, apiKey) {
  const socket = new WebSocketImpl(`wss://${host}/api/current`);
  const nextId = { value: 1 };
  const pending = new Map();

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  await rpc(socket, nextId, pending, 'auth.login_with_api_key', [apiKey]);
  return { socket, nextId, pending };
}

async function waitForJob(socket, nextId, pending, jobId) {
  if (jobId == null || typeof jobId !== 'number') return jobId;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const job = await rpc(socket, nextId, pending, 'core.get_jobs', [
      [['id', '=', jobId]],
      { get: true, extra: { raw_result: true } },
    ]);
    if (job && job.state && !['WAITING', 'RUNNING'].includes(job.state)) {
      if (job.state !== 'SUCCESS') {
        throw new Error(`TrueNAS job ${jobId} failed with state ${job.state}: ${JSON.stringify(job)}`);
      }
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Job ${jobId} did not finish in time`);
}

async function queryApp(socket, nextId, pending, appId) {
  const result = await rpc(socket, nextId, pending, 'app.query', [
    [['name', '=', appId]],
    { extra: { retrieve_resources: false } },
  ]);
  return Array.isArray(result) ? result[0] || null : result;
}

async function getAppConfig(socket, nextId, pending, appId) {
  try {
    return await rpc(socket, nextId, pending, 'app.config', [appId]);
  } catch (error) {
    if (/not found/i.test(String(error.message || error))) return null;
    throw error;
  }
}

async function ensureRegistry(socket, nextId, pending, options) {
  const {
    registryName,
    registryUri,
    registryUsername,
    registryPassword,
    description,
  } = options;

  if (!registryUsername || !registryPassword || !registryUri) {
    return { action: 'skipped' };
  }

  const registries = await rpc(socket, nextId, pending, 'app.registry.query', [[], {}]);
  const normalizedUri = stripTrailingSlash(registryUri);
  const existing = (registries || []).find((entry) => {
    const sameName = entry.name === registryName;
    const sameUri = stripTrailingSlash(entry.uri) === normalizedUri;
    return sameName || sameUri;
  });

  const payload = {
    name: registryName,
    description,
    username: registryUsername,
    password: registryPassword,
    uri: registryUri,
  };

  if (!existing) {
    await rpc(socket, nextId, pending, 'app.registry.create', [payload]);
    return { action: 'created', name: registryName, uri: registryUri };
  }

  const needsUpdate =
    existing.name !== payload.name ||
    stripTrailingSlash(existing.uri) !== normalizedUri ||
    existing.username !== payload.username ||
    existing.password !== payload.password ||
    (existing.description || '') !== payload.description;

  if (!needsUpdate) {
    return { action: 'reused', name: existing.name, uri: existing.uri };
  }

  await rpc(socket, nextId, pending, 'app.registry.update', [existing.id, payload]);
  return { action: 'updated', name: payload.name, uri: payload.uri };
}

async function pullImage(socket, nextId, pending, image, registryUri, registryUsername, registryPassword) {
  if (!registryUsername || !registryPassword || !registryUri) {
    return { action: 'skipped' };
  }
  const jobId = await rpc(socket, nextId, pending, 'app.image.pull', [{
    image,
    auth_config: {
      username: registryUsername,
      password: registryPassword,
      registry_uri: registryUri,
    },
  }]);
  await waitForJob(socket, nextId, pending, jobId);
  return { action: 'pulled', image };
}

function buildService(existingService, config) {
  const iconUrl = inferIconUrl(config.publicUrl);
  const environment = {
    ...(existingService.environment || {}),
    DB_PATH: '/app/data/quo_manager.db',
    HOST: '0.0.0.0',
    PORT: '3000',
    RATE_BURST: String(config.rateBurst),
    RATE_LIMIT_RPS: String(config.rateLimitRps),
    SYNC_WORKERS: String(config.syncWorkers),
    VERIFY_WORKERS: String(config.verifyWorkers),
  };

  let volumes = Array.isArray(existingService.volumes) ? [...existingService.volumes] : [];
  if (config.hostPath) {
    volumes = [`${config.hostPath}:/app/data`];
  } else if (!config.preserveDataPath && config.defaultHostPath) {
    volumes = [`${config.defaultHostPath}:/app/data`];
  } else if (!volumes.length && config.defaultHostPath) {
    volumes = [`${config.defaultHostPath}:/app/data`];
  }

  const labels = {
    ...(existingService.labels || {}),
    'org.opencontainers.image.description': config.imageDescription,
    'org.opencontainers.image.title': config.displayName,
  };
  if (iconUrl) {
    labels['org.opencontainers.image.icon'] = iconUrl;
  }

  const ports = Array.isArray(existingService.ports) && existingService.ports.length
    ? [...existingService.ports]
    : [`0.0.0.0:${config.nodePort}:3000/tcp`];

  return {
    ...existingService,
    container_name: existingService.container_name || `ix-${config.appId}-${config.serviceName}`,
    environment,
    image: config.image,
    labels,
    ports,
    restart: existingService.restart || 'unless-stopped',
    volumes,
  };
}

async function upsertApp(socket, nextId, pending, existingApp, existingConfig, config) {
  const existingServices =
    existingConfig?.custom_compose_config?.services ||
    existingConfig?.services ||
    {};
  const detectedServiceName = Object.keys(existingServices)[0] || config.serviceName;
  const existingService = existingServices[detectedServiceName] || {};
  config.serviceName = detectedServiceName;

  const service = buildService(existingService, config);
  const compose = { services: { [detectedServiceName]: service } };

  if (existingApp) {
    const jobId = await rpc(socket, nextId, pending, 'app.update', [config.appId, {
      custom_compose_config: compose,
    }]);
    await waitForJob(socket, nextId, pending, jobId);
    return { action: 'updated', compose };
  }

  const jobId = await rpc(socket, nextId, pending, 'app.create', [{
    app_name: config.appId,
    custom_app: true,
    custom_compose_config: compose,
  }]);
  await waitForJob(socket, nextId, pending, jobId);
  return { action: 'created', compose };
}

async function redeployIfNeeded(socket, nextId, pending, appId, image) {
  let state = await queryApp(socket, nextId, pending, appId);
  const containerImage = state?.active_workloads?.container_details?.[0]?.image;
  const images = state?.active_workloads?.images || [];

  if (containerImage === image || images.includes(image)) {
    return { action: 'not_needed', state };
  }

  const jobId = await rpc(socket, nextId, pending, 'app.redeploy', [appId]);
  await waitForJob(socket, nextId, pending, jobId);
  state = await queryApp(socket, nextId, pending, appId);
  return { action: 'redeployed', state };
}

async function main() {
  const version = readText(VERSION_PATH).trim();
  const deployment = readJson(DEPLOYMENT_PATH);
  const image = envValue('TRUENAS_IMAGE', deployment.image);
  const registryUri = envValue('TRUENAS_REGISTRY_URI', inferRegistryUri(image));
  const publicUrl = envValue('TRUENAS_PUBLIC_URL', deployment.url || '');

  const config = {
    version,
    appId: envValue('TRUENAS_APP_ID', 'quo-manager'),
    serviceName: envValue('TRUENAS_SERVICE_NAME', 'quo-manager'),
    displayName: envValue('TRUENAS_DISPLAY_NAME', 'Message Hub'),
    image,
    imageDescription: envValue(
      'TRUENAS_IMAGE_DESCRIPTION',
      'Self-hosted message aggregation and booking triage hub with modular connectors.',
    ),
    nodePort: envValue('TRUENAS_NODE_PORT', String(deployment.node_port || 3000)),
    rateLimitRps: envValue('TRUENAS_RATE_LIMIT_RPS', String(deployment.rate_limit_rps || 4)),
    rateBurst: envValue('TRUENAS_RATE_BURST', String(deployment.rate_burst || 1)),
    syncWorkers: envValue('TRUENAS_SYNC_WORKERS', String(deployment.sync_workers || 8)),
    verifyWorkers: envValue('TRUENAS_VERIFY_WORKERS', String(deployment.verify_workers || 8)),
    publicUrl,
    hostPath: envValue('TRUENAS_HOST_PATH', ''),
    defaultHostPath: deployment.host_path || '',
    preserveDataPath: envFlag('TRUENAS_PRESERVE_DATA_PATH', true),
  };

  const host = envValue('TRUENAS_HOST', deployment.host || '');
  const apiKey = envValue('TRUENAS_API_KEY', '');
  if (!host) throw new Error('TRUENAS_HOST is required.');
  if (!apiKey) throw new Error('TRUENAS_API_KEY is required.');

  const registryName = envValue('TRUENAS_REGISTRY_NAME', 'GitHub Container Registry');
  const registryUsername = envValue('TRUENAS_REGISTRY_USERNAME', '');
  const registryPassword = envValue('TRUENAS_REGISTRY_PASSWORD', '');

  const { socket, nextId, pending } = await connect(host, apiKey);
  try {
    const existingApp = await queryApp(socket, nextId, pending, config.appId);
    const existingConfig = await getAppConfig(socket, nextId, pending, config.appId);

    const registry = await ensureRegistry(socket, nextId, pending, {
      registryName,
      registryUri,
      registryUsername,
      registryPassword,
      description: `Registry credential for ${config.displayName} deployments`,
    });

    const pull = await pullImage(
      socket,
      nextId,
      pending,
      config.image,
      registryUri,
      registryUsername,
      registryPassword,
    );

    const appUpdate = await upsertApp(socket, nextId, pending, existingApp, existingConfig, config);
    const redeploy = await redeployIfNeeded(socket, nextId, pending, config.appId, config.image);
    const finalState = redeploy.state || await queryApp(socket, nextId, pending, config.appId);

    console.log(JSON.stringify({
      version,
      target: {
        host,
        app_id: config.appId,
        service_name: config.serviceName,
        image: config.image,
        public_url: config.publicUrl,
      },
      registry,
      pull,
      app: {
        action: appUpdate.action,
        state: finalState?.state,
        version: finalState?.version,
        human_version: finalState?.human_version,
        image: finalState?.active_workloads?.container_details?.[0]?.image,
        images: finalState?.active_workloads?.images || [],
        volumes: appUpdate.compose.services[config.serviceName].volumes || [],
      },
      redeploy: {
        action: redeploy.action,
      },
    }, null, 2));
  } finally {
    socket.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
