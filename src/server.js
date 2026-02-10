const express = require('express');
const path = require('path');
const config = require('./config');
const log = require('./logger');

// Import services
const { sseClients, loadCacheFromDisk, broadcastSSE, getCurrentRefreshStatus } = require('./services/cache');
const { refreshBuilds, fetchAppIcons } = require('./services/data-refresh');

// Import route modules
const buildsRouter = require('./routes/builds');
const distributionRouter = require('./routes/distribution');
const releaseNotesRouter = require('./routes/release-notes');
const analyticsRouter = require('./routes/analytics');
const discordRouter = require('./routes/discord');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy headers (needed for App Runner to get real client IP)
app.set('trust proxy', true);

app.use(express.json());

// Health check endpoint (before IP allowlist so App Runner can access it)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: Date.now() });
});

// Version endpoint (before IP allowlist for monitoring)
const pkg = require('../package.json');
app.get('/api/version', (req, res) => {
  res.json({
    version: pkg.version,
    startedAt: new Date().toISOString(),
    node: process.version
  });
});

app.use(express.static(path.join(__dirname, '../public')));

// SSE endpoint for real-time updates
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send initial connected event
  res.write('event: connected\ndata: {}\n\n');

  // Send current refresh status if a refresh is in progress
  const currentStatus = getCurrentRefreshStatus();
  if (currentStatus) {
    res.write(`event: refresh-status\ndata: ${JSON.stringify({ status: currentStatus })}\n\n`);
  }

  // Add client to set
  sseClients.add(res);
  log.debug('server', `SSE client connected (${sseClients.size} total)`);

  // Remove client on disconnect
  req.on('close', () => {
    sseClients.delete(res);
    log.debug('server', `SSE client disconnected (${sseClients.size} remaining)`);
  });
});

// Mount route modules
app.use('/api', buildsRouter);
app.use('/api', distributionRouter);
app.use('/api', releaseNotesRouter);
app.use('/api', analyticsRouter);
app.use('/api/discord', discordRouter);

// Server initialization
function init() {
  const startTime = Date.now();

  // Load cached data from disk first (instant)
  const hadCache = loadCacheFromDisk();

  // Start server immediately
  app.listen(PORT, () => {
    const elapsed = Date.now() - startTime;
    log.info('server', `Release Dashboard v${pkg.version} running at http://localhost:${PORT} (started in ${elapsed}ms)`);
    if (hadCache) {
      log.info('server', 'Serving cached data while refreshing in background...');
      // Broadcast cached data immediately so clients can render
      broadcastSSE('refresh', { timestamp: Date.now(), fromCache: true });
    }
  });

  // Fetch icons in background and start full refresh (Jenkins + Store + Plastic in parallel)
  fetchAppIcons().catch(err => log.warn('server', 'Icon fetch failed', { error: err.message }));
  refreshBuilds().catch(err => log.error('server', 'Initial refresh failed', { error: err.message }));

  // Periodic refresh
  setInterval(refreshBuilds, config.refreshInterval);
}

init();
