/**
 * Direct API access to App Store Connect and Google Play
 * No Fastlane dependency required
 */

const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./logger');

// ============================================
// Rate Limiting & Caching
// ============================================

// Rate limit tracking
// Apple: ~300 req/min (undocumented), 3600 req/hour (documented)
// Google: 3000 req/min per bucket, 200000 req/day
const rateLimits = {
  apple: {
    requestsThisMinute: 0,
    minuteStart: Date.now(),
    maxPerMinute: 250, // Stay under the ~300 limit
    requestsThisHour: 0,
    hourStart: Date.now(),
    maxPerHour: 3000 // Stay under 3600 limit
  },
  google: {
    requestsThisMinute: 0,
    minuteStart: Date.now(),
    maxPerMinute: 2500, // Stay under 3000 limit
    requestsToday: 0,
    dayStart: Date.now(),
    maxPerDay: 180000 // Stay under 200000 limit
  }
};

// Cache for store data (5 minute TTL)
const storeCache = {
  ios: new Map(),
  android: new Map(),
  ttl: 5 * 60 * 1000 // 5 minutes
};

function getCached(platform, key) {
  const cache = storeCache[platform];
  const entry = cache.get(key);
  if (entry && Date.now() - entry.time < storeCache.ttl) {
    log.debug('store-api', `Cache hit: ${platform}/${key}`);
    return entry.value;
  }
  return null;
}

function setCache(platform, key, value) {
  storeCache[platform].set(key, { value, time: Date.now() });
}

// Check and update rate limits, returns delay in ms if throttling needed
function checkRateLimit(provider) {
  const limits = rateLimits[provider];
  const now = Date.now();

  // Reset minute counter if minute has passed
  if (now - limits.minuteStart >= 60000) {
    limits.requestsThisMinute = 0;
    limits.minuteStart = now;
  }

  // Reset hour/day counter
  if (provider === 'apple' && now - limits.hourStart >= 3600000) {
    limits.requestsThisHour = 0;
    limits.hourStart = now;
  }
  if (provider === 'google' && now - limits.dayStart >= 86400000) {
    limits.requestsToday = 0;
    limits.dayStart = now;
  }

  // Check if we're approaching limits
  if (limits.requestsThisMinute >= limits.maxPerMinute) {
    const waitTime = 60000 - (now - limits.minuteStart) + 100;
    log.warn('store-api', `${provider} rate limit approaching, waiting ${waitTime}ms`);
    return waitTime;
  }

  if (provider === 'apple' && limits.requestsThisHour >= limits.maxPerHour) {
    const waitTime = 3600000 - (now - limits.hourStart) + 100;
    log.warn('store-api', `${provider} hourly rate limit hit, waiting ${Math.round(waitTime/1000)}s`);
    return waitTime;
  }

  if (provider === 'google' && limits.requestsToday >= limits.maxPerDay) {
    log.error('store-api', `${provider} daily rate limit hit!`);
    return -1; // Signal to skip request entirely
  }

  return 0;
}

function recordRequest(provider) {
  const limits = rateLimits[provider];
  limits.requestsThisMinute++;
  if (provider === 'apple') limits.requestsThisHour++;
  if (provider === 'google') limits.requestsToday++;
}

// Sleep helper
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ============================================
// App Store Connect API
// ============================================

// Cached ASC token (reused until close to expiry)
let cachedASCToken = null;
let cachedASCTokenExpiry = 0;

/**
 * Generate JWT for App Store Connect API
 * Caches and reuses token until 2 minutes before expiry
 */
function generateASCToken() {
  // Return cached token if still valid (with 2 min buffer)
  const now = Math.floor(Date.now() / 1000);
  if (cachedASCToken && cachedASCTokenExpiry > now + 120) {
    return cachedASCToken;
  }

  const keyPath = path.join(__dirname, '..', config.fastlane.appStoreConnect.keyPath);
  const ascConfig = config.fastlane.appStoreConnect;

  let privateKey;
  let keyId;
  let issuerId;

  // Support both .p8 files and legacy JSON format
  if (keyPath.endsWith('.p8')) {
    // Read .p8 file directly, get keyId and issuerId from config
    privateKey = fs.readFileSync(keyPath, 'utf8');
    keyId = ascConfig.keyId;
    issuerId = ascConfig.issuerId;
  } else {
    // Legacy JSON format
    let keyData;
    try {
      keyData = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    } catch (e) {
      throw new Error(`Failed to read Apple API key: ${e.message}`);
    }
    privateKey = keyData.key.replace(/\\n/g, '\n');
    keyId = keyData.key_id;
    issuerId = keyData.issuer_id;
  }

  const expiry = now + (20 * 60); // 20 minutes
  const payload = {
    iss: issuerId,
    iat: now,
    exp: expiry,
    aud: 'appstoreconnect-v1'
  };

  const token = jwt.sign(payload, privateKey, {
    algorithm: 'ES256',
    header: {
      alg: 'ES256',
      kid: keyId,
      typ: 'JWT'
    }
  });

  // Cache the token
  cachedASCToken = token;
  cachedASCTokenExpiry = expiry;

  log.debug('store-api', 'Generated new ASC token', { expiresIn: '20 min' });

  return token;
}

/**
 * Make a request to App Store Connect API with rate limiting and retry
 */
async function ascRequest(endpoint, retries = 3) {
  // Check rate limit before making request
  const delay = checkRateLimit('apple');
  if (delay > 0) {
    await sleep(delay);
  }

  const token = generateASCToken();
  const url = `https://api.appstoreconnect.apple.com${endpoint}`;

  log.debug('store-api', `ASC GET ${endpoint}`);
  recordRequest('apple');

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  // Handle rate limit errors with exponential backoff
  if (response.status === 429 && retries > 0) {
    const retryAfter = parseInt(response.headers.get('retry-after') || '60');
    const backoff = Math.min(retryAfter * 1000, 60000);
    log.warn('store-api', `ASC rate limited, retrying in ${backoff/1000}s (${retries} retries left)`);
    await sleep(backoff);
    return ascRequest(endpoint, retries - 1);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ASC API error ${response.status}: ${text}`);
  }

  return response.json();
}

/**
 * Get app info from App Store Connect by bundle ID
 */
async function getIOSAppInfo(bundleId) {
  // Check cache first
  const cached = getCached('ios', bundleId);
  if (cached) return cached;

  log.info('store-api', `Fetching iOS app info: ${bundleId}`);

  try {
    // Find app by bundle ID
    const appsResponse = await ascRequest(`/v1/apps?filter[bundleId]=${bundleId}`);

    if (!appsResponse.data || appsResponse.data.length === 0) {
      return { error: 'App not found', bundleId };
    }

    const app = appsResponse.data[0];
    const appId = app.id;

    // Get app store versions and builds in parallel
    const [versionsResponse, buildsResponse] = await Promise.all([
      // Get app store versions - include build, review detail, and phased release info
      ascRequest(`/v1/apps/${appId}/appStoreVersions?include=build,appStoreReviewDetail,appStoreVersionPhasedRelease&limit=10`),
      // Get builds (TestFlight) - include preReleaseVersion and buildBetaDetail for more info
      // Use limit=50 to ensure beta group builds (which may be older) can resolve their version strings
      ascRequest(`/v1/builds?filter[app]=${appId}&sort=-uploadedDate&limit=50&include=preReleaseVersion,buildBetaDetail`)
    ]);

    // Parse versions
    const versions = versionsResponse.data || [];
    const versionsIncluded = versionsResponse.included || [];
    const builds = buildsResponse.data || [];
    const included = buildsResponse.included || [];

    // Build a map of preReleaseVersion IDs to version strings
    const versionMap = {};
    for (const item of included) {
      if (item.type === 'preReleaseVersions') {
        versionMap[item.id] = item.attributes.version;
      }
    }

    // Build a map of build IDs to build numbers (from versionsResponse included)
    const buildMap = {};
    for (const item of versionsIncluded) {
      if (item.type === 'builds') {
        buildMap[item.id] = item.attributes.version;
      }
    }

    // Build a map of version IDs to phased release info
    const phasedReleaseMap = {};
    for (const item of versionsIncluded) {
      if (item.type === 'appStoreVersionPhasedReleases') {
        phasedReleaseMap[item.id] = {
          state: item.attributes.phasedReleaseState, // INACTIVE, ACTIVE, PAUSED, COMPLETE
          currentDayNumber: item.attributes.currentDayNumber, // 0-6
          startDate: item.attributes.startDate
        };
      }
    }

    // Apple's phased release percentages by day
    const phasedReleasePercent = [1, 2, 5, 10, 20, 50, 100];

    // Helper to get phased release info from appStoreVersion
    const getPhasedRelease = (appStoreVersion) => {
      const phasedReleaseId = appStoreVersion?.relationships?.appStoreVersionPhasedRelease?.data?.id;
      return phasedReleaseId ? phasedReleaseMap[phasedReleaseId] : null;
    };

    // Helper to get build number from appStoreVersion
    const getBuildNumber = (appStoreVersion) => {
      const buildId = appStoreVersion?.relationships?.build?.data?.id;
      return buildId ? buildMap[buildId] : null;
    };

    // Find all live versions (READY_FOR_SALE) - sorted by createdDate desc
    const liveVersions = versions
      .filter(v => v.attributes.appStoreState === 'READY_FOR_SALE')
      .sort((a, b) => new Date(b.attributes.createdDate) - new Date(a.attributes.createdDate));

    const liveVersion = liveVersions[0] || null;
    const prevLiveVersion = liveVersions[1] || null; // Previous store release

    const pendingVersion = versions.find(v =>
      ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_DEVELOPER_RELEASE', 'PREPARE_FOR_SUBMISSION']
        .includes(v.attributes.appStoreState)
    );

    const latestBuild = builds[0];
    // Get the version string from the preReleaseVersion relationship
    const getVersionString = (build) => {
      const preReleaseId = build?.relationships?.preReleaseVersion?.data?.id;
      return preReleaseId ? versionMap[preReleaseId] : null;
    };

    // Create a lookup from build number to version string for beta groups
    const buildNumberToVersion = {};
    for (const build of builds) {
      const buildNum = build.attributes.version;
      const versionStr = getVersionString(build);
      if (versionStr) {
        buildNumberToVersion[buildNum] = versionStr;
      }
    }

    // Build a map from build number to build ID (for diagnostics API)
    const buildNumberToBuildId = {};
    for (const build of builds) {
      buildNumberToBuildId[build.attributes.version] = build.id;
    }

    // Helper to get build ID from appStoreVersion
    const getBuildId = (appStoreVersion) => {
      const buildId = appStoreVersion?.relationships?.build?.data?.id;
      return buildId || null;
    };

    // Check if live version is in phased rollout (ACTIVE or PAUSED)
    let iosRollout = null;
    if (liveVersion) {
      const phasedRelease = getPhasedRelease(liveVersion);
      if (phasedRelease && (phasedRelease.state === 'ACTIVE' || phasedRelease.state === 'PAUSED')) {
        const dayNum = phasedRelease.currentDayNumber || 0;
        const userPercent = phasedReleasePercent[dayNum] || phasedReleasePercent[0];
        iosRollout = {
          version: liveVersion.attributes.versionString,
          build: getBuildNumber(liveVersion),
          buildId: getBuildId(liveVersion),
          state: phasedRelease.state,
          currentDayNumber: dayNum,
          userFraction: userPercent / 100, // Convert to fraction for consistency with Android
          startDate: phasedRelease.startDate,
          createdDate: liveVersion.attributes.createdDate
        };
        log.info('store-api', `Found iOS phased release: ${liveVersion.attributes.versionString} at ${userPercent}% (day ${dayNum + 1})`);
      }
    }

    const result = {
      bundleId,
      appId,
      name: app.attributes.name,
      rollout: iosRollout, // Phased release in progress
      live: liveVersion ? {
        version: liveVersion.attributes.versionString,
        build: getBuildNumber(liveVersion),
        buildId: getBuildId(liveVersion),
        state: liveVersion.attributes.appStoreState,
        releaseType: liveVersion.attributes.releaseType,
        createdDate: liveVersion.attributes.createdDate
      } : null,
      prevLive: prevLiveVersion ? {
        version: prevLiveVersion.attributes.versionString,
        build: getBuildNumber(prevLiveVersion),
        buildId: getBuildId(prevLiveVersion),
        state: prevLiveVersion.attributes.appStoreState,
        createdDate: prevLiveVersion.attributes.createdDate
      } : null,
      // All historical store releases (up to 10)
      releaseHistory: liveVersions.slice(0, 10).map(v => ({
        version: v.attributes.versionString,
        build: getBuildNumber(v),
        buildId: getBuildId(v),
        state: v.attributes.appStoreState,
        createdDate: v.attributes.createdDate
      })),
      pending: pendingVersion ? {
        version: pendingVersion.attributes.versionString,
        build: getBuildNumber(pendingVersion),
        buildId: getBuildId(pendingVersion),
        state: pendingVersion.attributes.appStoreState
      } : null,
      testflight: latestBuild ? {
        versionString: getVersionString(latestBuild),
        build: latestBuild.attributes.version,
        buildId: latestBuild.id,
        version: latestBuild.attributes.version,
        uploadedDate: latestBuild.attributes.uploadedDate,
        processingState: latestBuild.attributes.processingState,
        expired: latestBuild.attributes.expired
      } : null,
      recentBuilds: builds.slice(0, 5).map(b => ({
        versionString: getVersionString(b),
        build: b.attributes.version,
        buildId: b.id,
        version: b.attributes.version,
        uploadedDate: b.attributes.uploadedDate,
        processingState: b.attributes.processingState
      })),
      buildNumberToVersion, // Used for looking up beta group build versions
      buildNumberToBuildId, // Used for fetching diagnostics for specific builds
      betaGroups: {}
    };

    // Fetch beta groups and their latest builds (in parallel)
    log.info('store-api', `Fetching beta groups for ${bundleId}`);
    try {
      const betaGroupsResponse = await ascRequest(`/v1/apps/${appId}/betaGroups`);

      // Fetch all beta group builds in parallel
      await Promise.all((betaGroupsResponse.data || []).map(async (group) => {
        const groupName = group.attributes.name;

        // Get latest build for this group
        // Note: betaGroups/{id}/builds endpoint doesn't support 'include' parameter
        try {
          const groupBuildsResponse = await ascRequest(
            `/v1/betaGroups/${group.id}/builds?limit=1`
          );

          if (groupBuildsResponse.data && groupBuildsResponse.data.length > 0) {
            const latestGroupBuild = groupBuildsResponse.data[0];
            const buildNum = latestGroupBuild.attributes.version;

            // Look up version string and build ID from our pre-fetched builds data
            const versionStr = result.buildNumberToVersion[buildNum] || null;
            const buildId = result.buildNumberToBuildId[buildNum] || latestGroupBuild.id;

            result.betaGroups[groupName] = {
              versionString: versionStr,
              build: buildNum,
              buildId: buildId,
              uploadedDate: latestGroupBuild.attributes.uploadedDate,
              processingState: latestGroupBuild.attributes.processingState
            };
            log.info('store-api', `Found beta group ${groupName}: ${versionStr || buildNum}`);
          }
        } catch (e) {
          log.warn('store-api', `Failed to get builds for beta group ${groupName}`, { error: e.message });
        }
      }));
    } catch (e) {
      log.warn('store-api', `Failed to fetch beta groups for ${bundleId}`, { error: e.message });
    }

    // Cache successful result
    setCache('ios', bundleId, result);
    return result;
  } catch (error) {
    log.error('store-api', `Failed to fetch iOS app: ${bundleId}`, { error: error.message });
    return { error: error.message, bundleId };
  }
}

// ============================================
// Google Play API
// ============================================

/**
 * Get authenticated Google Play API client
 */
async function getPlayClient() {
  const keyPath = path.join(__dirname, '..', config.fastlane.googlePlay.jsonKeyPath);

  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/androidpublisher']
  });

  const authClient = await auth.getClient();
  return google.androidpublisher({ version: 'v3', auth: authClient });
}

/**
 * Get Android app info from Google Play
 */
async function getAndroidAppInfo(packageName) {
  // Check cache first
  const cached = getCached('android', packageName);
  if (cached) return cached;

  // Check rate limit
  const delay = checkRateLimit('google');
  if (delay === -1) {
    log.error('store-api', 'Google Play daily rate limit hit, skipping request');
    return { error: 'Rate limit exceeded', packageName };
  }
  if (delay > 0) {
    await sleep(delay);
  }

  log.info('store-api', `Fetching Android app info: ${packageName}`);

  try {
    const play = await getPlayClient();

    // Record the API calls we're about to make (insert, list, delete = 3 calls)
    recordRequest('google');
    recordRequest('google');
    recordRequest('google');

    // Create an edit to read track info
    const editResponse = await play.edits.insert({
      packageName
    });
    const editId = editResponse.data.id;

    // Get all tracks
    const tracksResponse = await play.edits.tracks.list({
      packageName,
      editId
    });

    const tracks = {};
    const rawTracks = []; // Log what tracks we're seeing
    let rolloutRelease = null; // Track staged rollout on production

    for (const track of tracksResponse.data.tracks || []) {
      const releases = track.releases || [];
      rawTracks.push(track.track);

      // Look for staged rollout (inProgress with userFraction, or country-targeted) or halted rollout
      if (track.track === 'production') {
        // First check for active in-progress rollout
        // Note: userFraction can be 1.0 for country-targeted rollouts (100% of Mexico)
        const inProgressRelease = releases.find(r =>
          r.status === 'inProgress' && (r.userFraction || r.countryTargeting)
        );
        if (inProgressRelease) {
          rolloutRelease = {
            status: inProgressRelease.status,
            versionCodes: inProgressRelease.versionCodes?.map(v => parseInt(v)) || [],
            versionName: inProgressRelease.name,
            userFraction: inProgressRelease.userFraction,
            releaseNotes: inProgressRelease.releaseNotes,
            countryTargeting: inProgressRelease.countryTargeting || null
          };
          const countryInfo = inProgressRelease.countryTargeting?.countries?.join(', ') || 'Global';
          log.info('store-api', `Found staged rollout: ${inProgressRelease.name} at ${(inProgressRelease.userFraction * 100).toFixed(0)}% (${countryInfo})`);
        } else {
          // If no in-progress, check for halted rollout
          const haltedRelease = releases.find(r => r.status === 'halted');
          if (haltedRelease) {
            rolloutRelease = {
              status: haltedRelease.status,
              versionCodes: haltedRelease.versionCodes?.map(v => parseInt(v)) || [],
              versionName: haltedRelease.name,
              userFraction: haltedRelease.userFraction || 0,
              releaseNotes: haltedRelease.releaseNotes,
              countryTargeting: haltedRelease.countryTargeting || null
            };
            log.info('store-api', `Found halted rollout: ${haltedRelease.name}`);
          }
        }
      }

      // Find the completed release (or latest if none completed)
      const latestRelease = releases.find(r => r.status === 'completed') || releases[0];

      if (latestRelease) {
        tracks[track.track] = {
          status: latestRelease.status,
          versionCodes: latestRelease.versionCodes?.map(v => parseInt(v)) || [],
          versionName: latestRelease.name,
          userFraction: latestRelease.userFraction,
          releaseNotes: latestRelease.releaseNotes
        };
      }
    }

    log.debug('store-api', `Found tracks for ${packageName}`, { tracks: rawTracks });

    // Delete the edit (we're just reading)
    await play.edits.delete({ packageName, editId });

    // Map track names - Google Play may use different names for testing tracks
    // New names: internal, closedTesting (alpha), openTesting (beta), production
    // Old names: internal, alpha, beta, production
    const alphaTrack = tracks.alpha || tracks.closedTesting || null;
    const betaTrack = tracks.beta || tracks.openTesting || null;

    const result = {
      packageName,
      tracks,
      production: tracks.production || null,
      rollout: rolloutRelease, // Staged rollout in progress (separate from completed production)
      beta: betaTrack,
      alpha: alphaTrack,
      internal: tracks.internal || null
    };

    // Cache successful result
    setCache('android', packageName, result);
    return result;
  } catch (error) {
    log.error('store-api', `Failed to fetch Android app: ${packageName}`, { error: error.message });
    return { error: error.message, packageName };
  }
}

/**
 * Get all store versions for configured apps
 */
async function getAllStoreVersions() {
  log.info('store-api', 'Fetching all store versions');

  const results = {
    timestamp: new Date().toISOString(),
    ios: {},
    android: {}
  };

  // Get unique bundle IDs per platform
  const iosBundleIds = [...new Set(
    config.jobs.filter(j => j.platform === 'ios').map(j => j.bundleId)
  )];
  const androidPackages = [...new Set(
    config.jobs.filter(j => j.platform === 'android').map(j => j.bundleId)
  )];

  // Fetch iOS versions in parallel
  const iosPromises = iosBundleIds.map(async bundleId => {
    const info = await getIOSAppInfo(bundleId);
    results.ios[bundleId] = info;
  });

  // Fetch Android versions in parallel
  const androidPromises = androidPackages.map(async packageName => {
    const info = await getAndroidAppInfo(packageName);
    results.android[packageName] = info;
  });

  await Promise.all([...iosPromises, ...androidPromises]);

  return results;
}

/**
 * Match store versions to build changesets
 */
function matchVersionsToChangesets(storeVersions, buildCache) {
  const result = {
    timestamp: storeVersions.timestamp,
    apps: {}
  };

  for (const job of config.jobs) {
    const projectId = job.displayName.toLowerCase().replace(/\s+/g, '-');

    if (!result.apps[projectId]) {
      result.apps[projectId] = {
        displayName: job.displayName,
        ios: null,
        android: null
      };
    }

    // Find project in build cache
    const project = buildCache.projects?.find(p => p.id === projectId);
    const mainBranch = project?.branches?.find(b => b.branch === 'main');

    if (job.platform === 'ios') {
      const iosData = storeVersions.ios[job.bundleId];
      if (iosData && !iosData.error) {
        result.apps[projectId].ios = {
          ...iosData,
          liveChangeset: findChangesetForBuild(iosData.live?.version, mainBranch),
          testflightChangeset: findChangesetForBuild(iosData.testflight?.build, mainBranch)
        };
      } else if (iosData?.error) {
        result.apps[projectId].ios = { error: iosData.error };
      }
    }

    if (job.platform === 'android') {
      const androidData = storeVersions.android[job.bundleId];
      if (androidData && !androidData.error) {
        const productionVersionCode = androidData.production?.versionCodes?.[0];
        const internalVersionCode = androidData.internal?.versionCodes?.[0];

        result.apps[projectId].android = {
          ...androidData,
          productionChangeset: findChangesetForVersionCode(productionVersionCode, mainBranch),
          internalChangeset: findChangesetForVersionCode(internalVersionCode, mainBranch)
        };
      } else if (androidData?.error) {
        result.apps[projectId].android = { error: androidData.error };
      }
    }
  }

  return result;
}

/**
 * Find changeset matching a build version
 */
function findChangesetForBuild(buildVersion, branchData) {
  if (!buildVersion || !branchData) return null;

  // Check release builds
  for (const platform of ['ios', 'android']) {
    const releaseSuccess = branchData[`${platform}ReleaseSuccess`];
    if (releaseSuccess?.version === buildVersion) {
      return {
        changeset: releaseSuccess.version,
        buildNumber: releaseSuccess.number,
        timestamp: releaseSuccess.timestamp,
        matched: true
      };
    }
  }

  // Check all commits
  const match = branchData.allCommits?.find(c => c.version === buildVersion);
  if (match) {
    return {
      changeset: match.version,
      timestamp: match.timestamp,
      matched: true
    };
  }

  return { version: buildVersion, matched: false };
}

/**
 * Find changeset matching an Android version code
 */
function findChangesetForVersionCode(versionCode, branchData) {
  if (!versionCode || !branchData) return null;

  const versionStr = versionCode.toString();

  // Check if it matches a changeset directly
  const match = branchData.allCommits?.find(c =>
    c.version === versionStr ||
    versionStr.endsWith(c.version)
  );

  if (match) {
    return {
      changeset: match.version,
      versionCode,
      timestamp: match.timestamp,
      matched: true
    };
  }

  return { versionCode, matched: false };
}

/**
 * Promote Android build from one track to another (e.g., internal -> alpha)
 */
async function promoteAndroidBuild(packageName, fromTrack, toTrack, releaseNotes = null) {
  log.info('store-api', `Promoting Android build: ${packageName} from ${fromTrack} to ${toTrack}`);

  // Check rate limit
  const delay = checkRateLimit('google');
  if (delay === -1) {
    throw new Error('Google Play daily rate limit exceeded');
  }
  if (delay > 0) {
    await sleep(delay);
  }

  try {
    const play = await getPlayClient();

    // Record API calls (insert, tracks.get, tracks.update, commit = 4 calls)
    recordRequest('google');
    recordRequest('google');
    recordRequest('google');
    recordRequest('google');

    // Create an edit
    const editResponse = await play.edits.insert({ packageName });
    const editId = editResponse.data.id;

    try {
      // Get the source track to find version codes
      const sourceTrack = await play.edits.tracks.get({
        packageName,
        editId,
        track: fromTrack
      });

      const releases = sourceTrack.data.releases || [];
      const latestRelease = releases.find(r => r.status === 'completed') || releases[0];

      if (!latestRelease || !latestRelease.versionCodes || latestRelease.versionCodes.length === 0) {
        throw new Error(`No version found on ${fromTrack} track`);
      }

      const versionCodes = latestRelease.versionCodes;
      const versionName = latestRelease.name;

      log.info('store-api', `Found version ${versionName} (${versionCodes.join(', ')}) on ${fromTrack}`);

      // Build the release object for the target track
      const newRelease = {
        versionCodes,
        status: 'completed',
        name: versionName
      };

      // Add release notes if provided (Google Play max is 500 chars per language)
      if (releaseNotes) {
        const MAX_NOTES_LENGTH = 500;
        newRelease.releaseNotes = Object.entries(releaseNotes).map(([lang, text]) => {
          let truncatedText = text;
          if (text && text.length > MAX_NOTES_LENGTH) {
            // Truncate at word boundary if possible
            truncatedText = text.substring(0, MAX_NOTES_LENGTH - 3);
            const lastSpace = truncatedText.lastIndexOf(' ');
            if (lastSpace > MAX_NOTES_LENGTH - 50) {
              truncatedText = truncatedText.substring(0, lastSpace);
            }
            truncatedText += '...';
            log.warn('store-api', `Truncated ${lang} release notes from ${text.length} to ${truncatedText.length} chars`);
          }
          return { language: lang, text: truncatedText };
        });
      }

      // Update the target track
      await play.edits.tracks.update({
        packageName,
        editId,
        track: toTrack,
        requestBody: {
          track: toTrack,
          releases: [newRelease]
        }
      });

      // Commit the edit
      await play.edits.commit({
        packageName,
        editId
      });

      log.info('store-api', `Successfully promoted ${versionName} to ${toTrack}`);

      // Invalidate cache for this package
      storeCache.android.delete(packageName);

      return {
        success: true,
        packageName,
        fromTrack,
        toTrack,
        versionCodes,
        versionName
      };
    } catch (error) {
      // Delete the edit on failure
      try {
        await play.edits.delete({ packageName, editId });
      } catch (e) {
        // Ignore delete errors
      }
      throw error;
    }
  } catch (error) {
    log.error('store-api', `Failed to promote Android build: ${packageName}`, { error: error.message });
    throw error;
  }
}

/**
 * Add iOS TestFlight build to a beta group (e.g., promote to alpha testers)
 * For external beta groups, also submits for Beta App Review
 */
async function promoteIOSBuild(bundleId, buildId, betaGroupName) {
  log.info('store-api', `Adding iOS build ${buildId} to beta group: ${betaGroupName}`);

  try {
    // First get the app ID
    const appsResponse = await ascRequest(`/v1/apps?filter[bundleId]=${bundleId}`);

    if (!appsResponse.data || appsResponse.data.length === 0) {
      throw new Error(`App not found: ${bundleId}`);
    }

    const appId = appsResponse.data[0].id;

    // Find the beta group
    const betaGroupsResponse = await ascRequest(`/v1/apps/${appId}/betaGroups`);
    const betaGroup = (betaGroupsResponse.data || []).find(
      g => g.attributes.name.toLowerCase() === betaGroupName.toLowerCase()
    );

    if (!betaGroup) {
      throw new Error(`Beta group not found: ${betaGroupName}`);
    }

    // Check if the beta group is external (isInternalGroup = false means external testers)
    const isExternalGroup = betaGroup.attributes.isInternalGroup === false;
    log.info('store-api', `Beta group ${betaGroupName} is ${isExternalGroup ? 'external' : 'internal'}`);

    // For external groups, we need to submit for Beta App Review first
    if (isExternalGroup) {
      // Check current beta review status
      const buildResponse = await ascRequest(`/v1/builds/${buildId}?include=betaAppReviewSubmission`);
      const existingSubmission = buildResponse.included?.find(i => i.type === 'betaAppReviewSubmissions');
      const submissionState = existingSubmission?.attributes?.betaReviewState;

      log.info('store-api', `Current beta review state: ${submissionState || 'none'}`);

      // Only submit for review if not already approved or in review
      if (!submissionState || submissionState === 'REJECTED') {
        log.info('store-api', `Submitting build ${buildId} for Beta App Review`);

        const token = generateASCToken();
        const reviewResponse = await fetch(
          'https://api.appstoreconnect.apple.com/v1/betaAppReviewSubmissions',
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              data: {
                type: 'betaAppReviewSubmissions',
                relationships: {
                  build: {
                    data: { type: 'builds', id: buildId }
                  }
                }
              }
            })
          }
        );

        recordRequest('apple');

        if (!reviewResponse.ok) {
          const text = await reviewResponse.text();
          // Check if already submitted (409 conflict)
          if (reviewResponse.status === 409) {
            log.info('store-api', `Build ${buildId} already submitted for review`);
          } else {
            throw new Error(`Failed to submit for Beta App Review: ${reviewResponse.status} ${text}`);
          }
        } else {
          log.info('store-api', `Build ${buildId} submitted for Beta App Review`);
        }
      } else if (submissionState === 'WAITING_FOR_REVIEW' || submissionState === 'IN_REVIEW') {
        log.info('store-api', `Build ${buildId} already in review (${submissionState})`);
      } else if (submissionState === 'APPROVED') {
        log.info('store-api', `Build ${buildId} already approved for external testing`);
      }
    }

    // Add the build to the beta group
    const token = generateASCToken();
    const response = await fetch(
      `https://api.appstoreconnect.apple.com/v1/betaGroups/${betaGroup.id}/relationships/builds`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          data: [{ type: 'builds', id: buildId }]
        })
      }
    );

    recordRequest('apple');

    if (!response.ok) {
      const text = await response.text();
      // 409 might mean build already in group - that's ok
      if (response.status === 409) {
        log.info('store-api', `Build ${buildId} already in beta group ${betaGroupName}`);
      } else {
        throw new Error(`Failed to add build to beta group: ${response.status} ${text}`);
      }
    } else {
      log.info('store-api', `Successfully added build ${buildId} to ${betaGroupName}`);
    }

    // Invalidate cache for this bundle
    storeCache.ios.delete(bundleId);

    return {
      success: true,
      bundleId,
      buildId,
      betaGroupName,
      submittedForReview: isExternalGroup
    };
  } catch (error) {
    log.error('store-api', `Failed to promote iOS build: ${bundleId}`, { error: error.message });
    throw error;
  }
}

/**
 * Start or update Android staged rollout on production track
 * @param {string} packageName - Android package name
 * @param {string} fromTrack - Source track (e.g., 'alpha')
 * @param {number} userFraction - Rollout percentage as decimal (0.0 to 1.0)
 * @param {object} releaseNotes - Optional release notes by language
 * @param {string} countryCode - Optional country code for geo-targeting (e.g., 'MX' for Mexico)
 */
async function startAndroidRollout(packageName, fromTrack, userFraction, releaseNotes = null, countryCode = null) {
  log.info('store-api', `Starting Android rollout: ${packageName} from ${fromTrack} at ${(userFraction * 100).toFixed(0)}%${countryCode ? ` (${countryCode})` : ''}`);

  const delay = checkRateLimit('google');
  if (delay === -1) {
    throw new Error('Google Play daily rate limit exceeded');
  }
  if (delay > 0) {
    await sleep(delay);
  }

  try {
    const play = await getPlayClient();

    recordRequest('google');
    recordRequest('google');
    recordRequest('google');
    recordRequest('google');

    const editResponse = await play.edits.insert({ packageName });
    const editId = editResponse.data.id;

    try {
      // Get the source track to find version codes
      const sourceTrack = await play.edits.tracks.get({
        packageName,
        editId,
        track: fromTrack
      });

      const releases = sourceTrack.data.releases || [];
      const latestRelease = releases.find(r => r.status === 'completed') || releases[0];

      if (!latestRelease || !latestRelease.versionCodes || latestRelease.versionCodes.length === 0) {
        throw new Error(`No version found on ${fromTrack} track`);
      }

      const versionCodes = latestRelease.versionCodes;
      const versionName = latestRelease.name;

      log.info('store-api', `Found version ${versionName} (${versionCodes.join(', ')}) on ${fromTrack}`);

      // Build the release object for production with staged rollout
      const newRelease = {
        versionCodes,
        name: versionName,
        status: 'inProgress',
        userFraction: userFraction
      };

      // Add country targeting if specified (Mexico = MX)
      if (countryCode) {
        newRelease.countryTargeting = {
          countries: [countryCode],
          includeRestOfWorld: false
        };
      }

      // Add release notes if provided
      if (releaseNotes) {
        const MAX_NOTES_LENGTH = 500;
        newRelease.releaseNotes = Object.entries(releaseNotes).map(([lang, text]) => {
          let truncatedText = text;
          if (text && text.length > MAX_NOTES_LENGTH) {
            truncatedText = text.substring(0, MAX_NOTES_LENGTH - 3);
            const lastSpace = truncatedText.lastIndexOf(' ');
            if (lastSpace > MAX_NOTES_LENGTH - 50) {
              truncatedText = truncatedText.substring(0, lastSpace);
            }
            truncatedText += '...';
          }
          return { language: lang, text: truncatedText };
        });
      }

      // Update production track with staged rollout
      await play.edits.tracks.update({
        packageName,
        editId,
        track: 'production',
        requestBody: {
          track: 'production',
          releases: [newRelease]
        }
      });

      await play.edits.commit({ packageName, editId });

      log.info('store-api', `Successfully started rollout for ${versionName} at ${(userFraction * 100).toFixed(0)}%`);

      storeCache.android.delete(packageName);

      return {
        success: true,
        packageName,
        fromTrack,
        toTrack: 'production',
        versionCodes,
        versionName,
        userFraction,
        countryCode
      };
    } catch (error) {
      try {
        await play.edits.delete({ packageName, editId });
      } catch (e) {
        // Ignore delete errors
      }
      throw error;
    }
  } catch (error) {
    log.error('store-api', `Failed to start Android rollout: ${packageName}`, { error: error.message });
    throw error;
  }
}

/**
 * Update Android staged rollout percentage
 * @param {string} packageName - Android package name
 * @param {number} userFraction - New rollout percentage as decimal (0.0 to 1.0), use 1.0 for 100%
 */
async function updateAndroidRollout(packageName, userFraction) {
  log.info('store-api', `Updating Android rollout: ${packageName} to ${(userFraction * 100).toFixed(0)}%`);

  const delay = checkRateLimit('google');
  if (delay === -1) {
    throw new Error('Google Play daily rate limit exceeded');
  }
  if (delay > 0) {
    await sleep(delay);
  }

  try {
    const play = await getPlayClient();

    recordRequest('google');
    recordRequest('google');
    recordRequest('google');
    recordRequest('google');

    const editResponse = await play.edits.insert({ packageName });
    const editId = editResponse.data.id;

    try {
      // Get current production track
      const prodTrack = await play.edits.tracks.get({
        packageName,
        editId,
        track: 'production'
      });

      const releases = prodTrack.data.releases || [];
      // Find the in-progress or halted rollout
      const rolloutRelease = releases.find(r => r.status === 'inProgress' || r.status === 'halted');

      if (!rolloutRelease) {
        throw new Error('No active rollout found on production track');
      }

      const versionCodes = rolloutRelease.versionCodes;
      const versionName = rolloutRelease.name;

      log.info('store-api', `Found rollout version ${versionName}, updating to ${(userFraction * 100).toFixed(0)}%`);

      // Build updated release - if 100%, mark as completed (full rollout)
      const updatedRelease = {
        versionCodes,
        name: versionName,
        releaseNotes: rolloutRelease.releaseNotes
      };

      if (userFraction >= 1.0) {
        // Full rollout - mark as completed
        updatedRelease.status = 'completed';
        // Remove country targeting for full release
        log.info('store-api', `Completing rollout for ${versionName} to 100%`);
      } else {
        // Partial rollout - keep inProgress status
        updatedRelease.status = 'inProgress';
        updatedRelease.userFraction = userFraction;
        // Preserve country targeting if present
        if (rolloutRelease.countryTargeting) {
          updatedRelease.countryTargeting = rolloutRelease.countryTargeting;
        }
      }

      await play.edits.tracks.update({
        packageName,
        editId,
        track: 'production',
        requestBody: {
          track: 'production',
          releases: [updatedRelease]
        }
      });

      await play.edits.commit({ packageName, editId });

      log.info('store-api', `Successfully updated rollout for ${versionName} to ${(userFraction * 100).toFixed(0)}%`);

      storeCache.android.delete(packageName);

      return {
        success: true,
        packageName,
        versionCodes,
        versionName,
        userFraction,
        status: userFraction >= 1.0 ? 'completed' : 'inProgress'
      };
    } catch (error) {
      try {
        await play.edits.delete({ packageName, editId });
      } catch (e) {
        // Ignore delete errors
      }
      throw error;
    }
  } catch (error) {
    log.error('store-api', `Failed to update Android rollout: ${packageName}`, { error: error.message });
    throw error;
  }
}

/**
 * Halt Android staged rollout
 * @param {string} packageName - Android package name
 */
async function haltAndroidRollout(packageName) {
  log.info('store-api', `Halting Android rollout: ${packageName}`);

  const delay = checkRateLimit('google');
  if (delay === -1) {
    throw new Error('Google Play daily rate limit exceeded');
  }
  if (delay > 0) {
    await sleep(delay);
  }

  try {
    const play = await getPlayClient();

    recordRequest('google');
    recordRequest('google');
    recordRequest('google');
    recordRequest('google');

    const editResponse = await play.edits.insert({ packageName });
    const editId = editResponse.data.id;

    try {
      const prodTrack = await play.edits.tracks.get({
        packageName,
        editId,
        track: 'production'
      });

      const releases = prodTrack.data.releases || [];
      const rolloutRelease = releases.find(r => r.status === 'inProgress');

      if (!rolloutRelease) {
        throw new Error('No active rollout found to halt');
      }

      const versionCodes = rolloutRelease.versionCodes;
      const versionName = rolloutRelease.name;

      // Halt the rollout
      const haltedRelease = {
        versionCodes,
        name: versionName,
        status: 'halted',
        userFraction: rolloutRelease.userFraction,
        releaseNotes: rolloutRelease.releaseNotes
      };

      if (rolloutRelease.countryTargeting) {
        haltedRelease.countryTargeting = rolloutRelease.countryTargeting;
      }

      await play.edits.tracks.update({
        packageName,
        editId,
        track: 'production',
        requestBody: {
          track: 'production',
          releases: [haltedRelease]
        }
      });

      await play.edits.commit({ packageName, editId });

      log.info('store-api', `Successfully halted rollout for ${versionName}`);

      storeCache.android.delete(packageName);

      return {
        success: true,
        packageName,
        versionCodes,
        versionName,
        status: 'halted'
      };
    } catch (error) {
      try {
        await play.edits.delete({ packageName, editId });
      } catch (e) {
        // Ignore delete errors
      }
      throw error;
    }
  } catch (error) {
    log.error('store-api', `Failed to halt Android rollout: ${packageName}`, { error: error.message });
    throw error;
  }
}

/**
 * Submit iOS app version for App Store review
 * @param {string} bundleId - iOS bundle ID
 * @param {string} buildId - Build ID to submit
 */
async function submitIOSForReview(bundleId, buildId) {
  log.info('store-api', `Submitting iOS build ${buildId} for App Store review: ${bundleId}`);

  try {
    // Get app info to find the app ID
    const appsResponse = await ascRequest(`/v1/apps?filter[bundleId]=${bundleId}`);

    if (!appsResponse.data || appsResponse.data.length === 0) {
      throw new Error(`App not found: ${bundleId}`);
    }

    const appId = appsResponse.data[0].id;

    // Get the app store version that's in PREPARE_FOR_SUBMISSION or DEVELOPER_REJECTED state
    const versionsResponse = await ascRequest(`/v1/apps/${appId}/appStoreVersions?filter[appStoreState]=PREPARE_FOR_SUBMISSION,DEVELOPER_REJECTED&limit=1`);

    let appStoreVersionId;

    if (versionsResponse.data && versionsResponse.data.length > 0) {
      appStoreVersionId = versionsResponse.data[0].id;
      log.info('store-api', `Found existing app store version: ${appStoreVersionId}`);
    } else {
      throw new Error('No app store version found in PREPARE_FOR_SUBMISSION state. Please create a new version in App Store Connect first.');
    }

    // Associate the build with the app store version
    const token = generateASCToken();

    // Update the build relationship
    const buildResponse = await fetch(
      `https://api.appstoreconnect.apple.com/v1/appStoreVersions/${appStoreVersionId}/relationships/build`,
      {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          data: { type: 'builds', id: buildId }
        })
      }
    );

    recordRequest('apple');

    if (!buildResponse.ok) {
      const text = await buildResponse.text();
      throw new Error(`Failed to associate build: ${buildResponse.status} ${text}`);
    }

    log.info('store-api', `Associated build ${buildId} with app store version`);

    // Submit for review
    const submitResponse = await fetch(
      'https://api.appstoreconnect.apple.com/v1/appStoreVersionSubmissions',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          data: {
            type: 'appStoreVersionSubmissions',
            relationships: {
              appStoreVersion: {
                data: { type: 'appStoreVersions', id: appStoreVersionId }
              }
            }
          }
        })
      }
    );

    recordRequest('apple');

    if (!submitResponse.ok) {
      const text = await submitResponse.text();
      // Check for common errors
      if (submitResponse.status === 409) {
        log.info('store-api', `Version already submitted for review`);
      } else {
        throw new Error(`Failed to submit for review: ${submitResponse.status} ${text}`);
      }
    } else {
      log.info('store-api', `Successfully submitted build ${buildId} for App Store review`);
    }

    storeCache.ios.delete(bundleId);

    return {
      success: true,
      bundleId,
      buildId,
      appStoreVersionId,
      status: 'submitted'
    };
  } catch (error) {
    log.error('store-api', `Failed to submit iOS for review: ${bundleId}`, { error: error.message });
    throw error;
  }
}

module.exports = {
  getIOSAppInfo,
  getAndroidAppInfo,
  getAllStoreVersions,
  matchVersionsToChangesets,
  promoteAndroidBuild,
  promoteIOSBuild,
  startAndroidRollout,
  updateAndroidRollout,
  haltAndroidRollout,
  submitIOSForReview
};
