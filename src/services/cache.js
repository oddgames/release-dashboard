const fs = require('fs');
const path = require('path');
const log = require('../logger');

// Cache file path for persistence
const CACHE_FILE = path.join(__dirname, '../../.build-cache.json');

// Release notes storage directory
const RELEASE_NOTES_DIR = path.join(__dirname, '../../release-notes');

// Cache for build data
let buildCache = {
  lastUpdated: null,
  _meta: {
    jobBuildNumbers: {},    // Track highest build number per job for incremental fetch
    lastFullRefresh: null   // Timestamp of last full refresh
  },
  projects: []
};

// Store status cache (from Fastlane webhooks)
let storeStatusCache = {};

// Cache for average build durations per job/buildType
let avgDurationCache = {};

// SSE clients for real-time updates
const sseClients = new Set();

// Store versions cache
let storeVersionsCache = {
  lastUpdated: null,
  data: null
};

// Current refresh status (for new SSE clients)
let currentRefreshStatus = null;

// Load cache from disk on startup
function loadCacheFromDisk() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, 'utf8');
      const cached = JSON.parse(data);
      if (cached && cached.projects) {
        // Ensure _meta exists (for backwards compatibility with old cache files)
        if (!cached._meta) {
          cached._meta = { jobBuildNumbers: {}, lastFullRefresh: null };
        }
        // Update in place to maintain references in other modules
        buildCache.lastUpdated = cached.lastUpdated;
        buildCache._meta = cached._meta;
        buildCache.projects = cached.projects;
        log.info('server', `Loaded cache from disk: ${cached.projects.length} projects, last updated ${cached.lastUpdated}`);
        return true;
      }
    }
  } catch (error) {
    log.warn('server', 'Failed to load cache from disk', { error: error.message });
  }
  return false;
}

// Save cache to disk (debounced)
let saveCacheTimeout = null;
function saveCacheToDisk() {
  if (saveCacheTimeout) clearTimeout(saveCacheTimeout);
  saveCacheTimeout = setTimeout(() => {
    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(buildCache, null, 2));
      log.debug('server', 'Cache saved to disk');
    } catch (error) {
      log.warn('server', 'Failed to save cache to disk', { error: error.message });
    }
  }, 1000);
}

// Broadcast event to all connected SSE clients
function broadcastSSE(eventType, data = {}) {
  // Track refresh status for new clients
  if (eventType === 'refresh-status') {
    currentRefreshStatus = data.status;
  }

  const message = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(message);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

// Get current refresh status (for new SSE clients)
function getCurrentRefreshStatus() {
  return currentRefreshStatus;
}

module.exports = {
  CACHE_FILE,
  RELEASE_NOTES_DIR,
  buildCache,
  storeStatusCache,
  avgDurationCache,
  sseClients,
  storeVersionsCache,
  loadCacheFromDisk,
  saveCacheToDisk,
  broadcastSSE,
  getCurrentRefreshStatus
};
