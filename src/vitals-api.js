/**
 * Fetch crash/ANR vitals data from Google Play and App Store Connect
 *
 * Google Play: Uses Play Developer Reporting API for Android Vitals
 * App Store: Uses App Store Connect API for perfPowerMetrics
 */

const { google } = require('googleapis');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./logger');

// Cache for vitals data (15 minute TTL - data updates ~daily anyway)
const vitalsCache = {
  ios: new Map(),
  android: new Map(),
  ttl: 15 * 60 * 1000
};

function getCached(platform, key) {
  const cache = vitalsCache[platform];
  const entry = cache.get(key);
  if (entry && Date.now() - entry.time < vitalsCache.ttl) {
    log.debug('vitals-api', `Cache hit: ${platform}/${key}`);
    return entry.value;
  }
  return null;
}

function setCache(platform, key, value) {
  vitalsCache[platform].set(key, { value, time: Date.now() });
}

// ============================================
// Google Play Developer Reporting API
// ============================================

/**
 * Get authenticated client for Play Developer Reporting API
 */
async function getReportingClient() {
  const gpConfig = config.fastlane.googlePlay;
  let authOptions;

  if (gpConfig.jsonKeyContent) {
    const credentials = JSON.parse(gpConfig.jsonKeyContent);
    authOptions = { credentials, scopes: ['https://www.googleapis.com/auth/playdeveloperreporting'] };
  } else {
    const keyPath = path.join(__dirname, '..', gpConfig.jsonKeyPath);
    authOptions = { keyFile: keyPath, scopes: ['https://www.googleapis.com/auth/playdeveloperreporting'] };
  }

  const auth = new google.auth.GoogleAuth(authOptions);
  const authClient = await auth.getClient();
  return google.playdeveloperreporting({ version: 'v1beta1', auth: authClient });
}

/**
 * Get Android crash and ANR rates from Play Developer Reporting API
 * Now fetches per-version data using dimensions: ["versionCode"]
 * @param {string} packageName - Android package name
 * @param {Object} options - Optional parameters
 * @param {Date} options.startDate - Start date for query (default: 7 days ago)
 * @param {Date} options.endDate - End date for query (default: yesterday)
 * @param {boolean} options.skipCache - Skip cache lookup (for historical queries)
 * @returns {object} - { crashRate, anrRate, byVersion: { [versionCode]: { crashRate, anrRate } } }
 */
async function getAndroidVitals(packageName, options = {}) {
  const { startDate, endDate, skipCache = false } = options;

  // Build cache key including date range if specified
  const cacheKey = startDate
    ? `${packageName}:${startDate.toISOString()}:${endDate?.toISOString() || 'now'}`
    : packageName;

  // Check cache first (unless skipCache or custom date range)
  if (!skipCache) {
    const cached = getCached('android', cacheKey);
    if (cached) return cached;
  }

  log.info('vitals-api', `Fetching Android vitals: ${packageName}`, {
    startDate: startDate?.toISOString(),
    endDate: endDate?.toISOString()
  });

  try {
    const reporting = await getReportingClient();

    // Use provided dates or default to last 7 days
    // Use UTC dates - data freshness is usually 2 days behind
    let queryEnd, queryStart;

    if (endDate) {
      queryEnd = new Date(endDate);
    } else {
      queryEnd = new Date();
      queryEnd.setUTCDate(queryEnd.getUTCDate() - 2); // 2 days ago - Google Play data freshness is typically 2 days behind
    }

    if (startDate) {
      queryStart = new Date(startDate);
    } else {
      queryStart = new Date(queryEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
    }

    // Format dates as required by the API (using UTC)
    const formatDate = (d) => ({
      day: d.getUTCDate(),
      month: d.getUTCMonth() + 1,
      year: d.getUTCFullYear()
    });

    // Fetch crash rate and ANR rate in parallel - with versionCode dimension for per-version data
    const [crashResponse, anrResponse] = await Promise.all([
      reporting.vitals.crashrate.query({
        name: `apps/${packageName}/crashRateMetricSet`,
        requestBody: {
          timelineSpec: {
            aggregationPeriod: 'DAILY',
            startTime: formatDate(queryStart),
            endTime: formatDate(queryEnd)
          },
          dimensions: ['versionCode'],
          metrics: ['crashRate', 'userPerceivedCrashRate', 'crashRate7dUserWeighted', 'distinctUsers'],
          pageSize: 20
        }
      }).catch(e => ({ error: e.message })),

      reporting.vitals.anrrate.query({
        name: `apps/${packageName}/anrRateMetricSet`,
        requestBody: {
          timelineSpec: {
            aggregationPeriod: 'DAILY',
            startTime: formatDate(queryStart),
            endTime: formatDate(queryEnd)
          },
          dimensions: ['versionCode'],
          metrics: ['anrRate', 'userPerceivedAnrRate', 'anrRate7dUserWeighted', 'distinctUsers'],
          pageSize: 20
        }
      }).catch(e => ({ error: e.message }))
    ]);

    const result = {
      packageName,
      crashRate: null,
      anrRate: null,
      userPerceivedCrashRate: null,
      userPerceivedAnrRate: null,
      byVersion: {},
      fetchedAt: new Date().toISOString()
    };

    // Log response structure for debugging
    log.debug('vitals-api', `Android crash response for ${packageName}`, {
      hasError: !!crashResponse.error,
      error: crashResponse.error,
      hasData: !!crashResponse.data,
      rowCount: crashResponse.data?.rows?.length
    });

    // Helper to parse decimal value
    const parseDecimal = (metric) => {
      if (metric?.decimalValue?.value) {
        return parseFloat(metric.decimalValue.value) * 100;
      }
      return null;
    };

    // Parse crash rate response - per version
    if (!crashResponse.error && crashResponse.data?.rows?.length > 0) {
      // Log first row structure for debugging
      const firstRow = crashResponse.data.rows[0];
      log.debug('vitals-api', `Android crash row structure for ${packageName}`, {
        rowKeys: Object.keys(firstRow || {}),
        dimensions: firstRow?.dimensions,
        metricsKeys: Object.keys(firstRow?.metrics || {})
      });

      for (const row of crashResponse.data.rows) {
        // dimensions is an array like [{dimension: "versionCode", stringValue: "212126"}]
        const versionDim = (row.dimensions || []).find(d => d.dimension === 'versionCode');
        const versionCode = versionDim?.stringValue || versionDim?.int64Value;

        // metrics is indexed by position (0, 1, 2, 3) matching the order in the request
        // Order: crashRate, userPerceivedCrashRate, crashRate7dUserWeighted, distinctUsers
        const metricsArray = row.metrics || {};
        const crashRateMetric = metricsArray['2'] || metricsArray['0']; // crashRate7dUserWeighted or crashRate
        const userPerceivedMetric = metricsArray['1'];
        const distinctUsersMetric = metricsArray['3'];

        const crashRate = parseDecimal(crashRateMetric);
        const userPerceivedCrashRate = parseDecimal(userPerceivedMetric);
        const distinctUsers = parseInt(distinctUsersMetric?.decimalValue?.value || distinctUsersMetric?.value || '0');

        if (versionCode) {
          result.byVersion[versionCode] = result.byVersion[versionCode] || {};
          result.byVersion[versionCode].crashRate = crashRate;
          result.byVersion[versionCode].userPerceivedCrashRate = userPerceivedCrashRate;
          result.byVersion[versionCode].distinctUsers = distinctUsers;
        }

        // Use highest user count version as the "main" rate
        if (distinctUsers > (result._maxUsers || 0)) {
          result._maxUsers = distinctUsers;
          result.crashRate = crashRate;
          result.userPerceivedCrashRate = userPerceivedCrashRate;
        }
      }
    }

    // Parse ANR rate response - per version
    if (!anrResponse.error && anrResponse.data?.rows?.length > 0) {
      for (const row of anrResponse.data.rows) {
        // dimensions is an array like [{dimension: "versionCode", stringValue: "212126"}]
        const versionDim = (row.dimensions || []).find(d => d.dimension === 'versionCode');
        const versionCode = versionDim?.stringValue || versionDim?.int64Value;

        // metrics is indexed by position (0, 1, 2, 3) matching the order in the request
        // Order: anrRate, userPerceivedAnrRate, anrRate7dUserWeighted, distinctUsers
        const metricsArray = row.metrics || {};
        const anrRateMetric = metricsArray['2'] || metricsArray['0']; // anrRate7dUserWeighted or anrRate
        const userPerceivedMetric = metricsArray['1'];
        const distinctUsersMetric = metricsArray['3'];

        const anrRate = parseDecimal(anrRateMetric);
        const userPerceivedAnrRate = parseDecimal(userPerceivedMetric);
        const distinctUsers = parseInt(distinctUsersMetric?.decimalValue?.value || distinctUsersMetric?.value || '0');

        if (versionCode) {
          result.byVersion[versionCode] = result.byVersion[versionCode] || {};
          result.byVersion[versionCode].anrRate = anrRate;
          result.byVersion[versionCode].userPerceivedAnrRate = userPerceivedAnrRate;
          if (!result.byVersion[versionCode].distinctUsers) {
            result.byVersion[versionCode].distinctUsers = distinctUsers;
          }
        }

        // Use highest user count version as the "main" rate
        if (distinctUsers > (result._maxAnrUsers || 0)) {
          result._maxAnrUsers = distinctUsers;
          result.anrRate = anrRate;
          result.userPerceivedAnrRate = userPerceivedAnrRate;
        }
      }
    }

    // Clean up internal tracking fields
    delete result._maxUsers;
    delete result._maxAnrUsers;

    // Add query date range to result (useful for historical queries)
    result.queryStart = queryStart.toISOString();
    result.queryEnd = queryEnd.toISOString();

    // Cache the result
    setCache('android', cacheKey, result);

    log.info('vitals-api', `Android vitals for ${packageName}`, {
      crashRate: result.crashRate?.toFixed(2),
      anrRate: result.anrRate?.toFixed(2),
      versionCount: Object.keys(result.byVersion).length,
      dateRange: `${queryStart.toISOString().split('T')[0]} to ${queryEnd.toISOString().split('T')[0]}`
    });

    return result;
  } catch (error) {
    log.error('vitals-api', `Failed to fetch Android vitals: ${packageName}`, { error: error.message });
    return { error: error.message, packageName };
  }
}

/**
 * Get HOURLY Android crash and ANR rates for a specific version
 * Used for real-time rollout monitoring - fetches granular hourly data
 * @param {string} packageName - Android package name
 * @param {string} versionCode - Specific version code to query
 * @param {Date} startDate - Start date for query
 * @param {Date} endDate - End date for query (default: now - 2 days for freshness)
 * @returns {object} - { hourly: [{ timestamp, crashRate, anrRate, users }], summary: {...} }
 */
async function getHourlyVersionVitals(packageName, versionCode, startDate, endDate) {
  // Cache key includes version and date range
  const cacheKey = `hourly:${packageName}:${versionCode}:${startDate?.toISOString() || 'default'}`;

  // Shorter TTL for hourly data (30 min) since we want fresher data during rollout
  const cached = vitalsCache.android.get(cacheKey);
  if (cached && Date.now() - cached.time < 30 * 60 * 1000) {
    log.debug('vitals-api', `Hourly cache hit: ${cacheKey}`);
    return cached.value;
  }

  log.info('vitals-api', `Fetching hourly vitals: ${packageName} v${versionCode}`);

  try {
    const reporting = await getReportingClient();

    // Default end date is 2 days ago (Google Play freshness lag)
    let queryEnd = endDate ? new Date(endDate) : new Date();
    if (!endDate) {
      queryEnd.setUTCDate(queryEnd.getUTCDate() - 2);
    }

    // Default start is 7 days before end
    let queryStart = startDate ? new Date(startDate) : new Date(queryEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Format dates for hourly queries (uses full timestamp)
    const formatDateTime = (d) => ({
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hours: d.getUTCHours()
    });

    // Log the query parameters for debugging
    log.debug('vitals-api', `Hourly query params for ${packageName} v${versionCode}`, {
      startTime: formatDateTime(queryStart),
      endTime: formatDateTime(queryEnd),
      filter: `versionCode = ${versionCode}`
    });

    // Fetch crash and ANR rates with HOURLY aggregation
    // Note: Rolling averages (7d weighted) are NOT available in hourly mode
    const [crashResponse, anrResponse] = await Promise.all([
      reporting.vitals.crashrate.query({
        name: `apps/${packageName}/crashRateMetricSet`,
        requestBody: {
          timelineSpec: {
            aggregationPeriod: 'HOURLY',
            startTime: formatDateTime(queryStart),
            endTime: formatDateTime(queryEnd)
          },
          dimensions: ['versionCode'],
          metrics: ['crashRate', 'userPerceivedCrashRate', 'distinctUsers'],
          filter: `versionCode = ${versionCode}`,
          pageSize: 200 // Get up to 200 hourly data points (~8 days)
        }
      }).catch(e => {
        log.error('vitals-api', `Hourly crash query failed for ${packageName} v${versionCode}`, { error: e.message });
        return { error: e.message };
      }),

      reporting.vitals.anrrate.query({
        name: `apps/${packageName}/anrRateMetricSet`,
        requestBody: {
          timelineSpec: {
            aggregationPeriod: 'HOURLY',
            startTime: formatDateTime(queryStart),
            endTime: formatDateTime(queryEnd)
          },
          dimensions: ['versionCode'],
          metrics: ['anrRate', 'userPerceivedAnrRate', 'distinctUsers'],
          filter: `versionCode = ${versionCode}`,
          pageSize: 200
        }
      }).catch(e => {
        log.error('vitals-api', `Hourly ANR query failed for ${packageName} v${versionCode}`, { error: e.message });
        return { error: e.message };
      })
    ]);

    const result = {
      packageName,
      versionCode,
      hourly: [],
      summary: {
        crashRate: null,
        anrRate: null,
        totalUsers: 0
      },
      queryStart: queryStart.toISOString(),
      queryEnd: queryEnd.toISOString(),
      fetchedAt: new Date().toISOString()
    };

    // Helper to parse decimal value (convert to percentage)
    const parseDecimal = (metric) => {
      if (metric?.decimalValue?.value) {
        return parseFloat(metric.decimalValue.value) * 100;
      }
      return null;
    };

    // Log response structure for debugging
    log.debug('vitals-api', `Hourly crash response for ${packageName} v${versionCode}`, {
      hasError: !!crashResponse.error,
      error: crashResponse.error,
      hasData: !!crashResponse.data,
      rowCount: crashResponse.data?.rows?.length || 0
    });

    log.debug('vitals-api', `Hourly ANR response for ${packageName} v${versionCode}`, {
      hasError: !!anrResponse.error,
      error: anrResponse.error,
      hasData: !!anrResponse.data,
      rowCount: anrResponse.data?.rows?.length || 0
    });

    // Build hourly data map from crash response
    const hourlyMap = new Map();

    if (!crashResponse.error && crashResponse.data?.rows?.length > 0) {
      for (const row of crashResponse.data.rows) {
        // Extract timestamp from startTime
        const startTime = row.startTime;
        if (!startTime) continue;

        const timestamp = new Date(Date.UTC(
          startTime.year,
          startTime.month - 1,
          startTime.day,
          startTime.hours || 0
        )).toISOString();

        const metricsArray = row.metrics || {};
        const crashRate = parseDecimal(metricsArray['0']);
        const userPerceivedCrashRate = parseDecimal(metricsArray['1']);
        const distinctUsers = parseInt(metricsArray['2']?.decimalValue?.value || '0');

        hourlyMap.set(timestamp, {
          timestamp,
          crashRate,
          userPerceivedCrashRate,
          anrRate: null,
          userPerceivedAnrRate: null,
          users: distinctUsers
        });

        result.summary.totalUsers += distinctUsers;
      }
    }

    // Merge ANR data into hourly map
    if (!anrResponse.error && anrResponse.data?.rows?.length > 0) {
      for (const row of anrResponse.data.rows) {
        const startTime = row.startTime;
        if (!startTime) continue;

        const timestamp = new Date(Date.UTC(
          startTime.year,
          startTime.month - 1,
          startTime.day,
          startTime.hours || 0
        )).toISOString();

        const metricsArray = row.metrics || {};
        const anrRate = parseDecimal(metricsArray['0']);
        const userPerceivedAnrRate = parseDecimal(metricsArray['1']);

        if (hourlyMap.has(timestamp)) {
          const entry = hourlyMap.get(timestamp);
          entry.anrRate = anrRate;
          entry.userPerceivedAnrRate = userPerceivedAnrRate;
        } else {
          const distinctUsers = parseInt(metricsArray['2']?.decimalValue?.value || '0');
          hourlyMap.set(timestamp, {
            timestamp,
            crashRate: null,
            userPerceivedCrashRate: null,
            anrRate,
            userPerceivedAnrRate,
            users: distinctUsers
          });
        }
      }
    }

    // Convert map to sorted array
    result.hourly = Array.from(hourlyMap.values())
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    // Calculate summary (weighted average of last 24h)
    const last24h = result.hourly.slice(-24);
    if (last24h.length > 0) {
      let totalCrashWeighted = 0;
      let totalAnrWeighted = 0;
      let totalWeight = 0;

      for (const h of last24h) {
        if (h.crashRate !== null && h.users > 0) {
          totalCrashWeighted += h.crashRate * h.users;
          totalWeight += h.users;
        }
        if (h.anrRate !== null && h.users > 0) {
          totalAnrWeighted += h.anrRate * h.users;
        }
      }

      if (totalWeight > 0) {
        result.summary.crashRate = totalCrashWeighted / totalWeight;
        result.summary.anrRate = totalAnrWeighted / totalWeight;
      }
    }

    // Cache the result
    vitalsCache.android.set(cacheKey, { value: result, time: Date.now() });

    log.info('vitals-api', `Hourly vitals for ${packageName} v${versionCode}`, {
      hourlyPoints: result.hourly.length,
      summaryCrash: result.summary.crashRate?.toFixed(2),
      summaryAnr: result.summary.anrRate?.toFixed(2)
    });

    return result;
  } catch (error) {
    log.error('vitals-api', `Failed to fetch hourly vitals: ${packageName} v${versionCode}`, { error: error.message });
    return { error: error.message, packageName, versionCode };
  }
}

/**
 * Get list of recent version codes for a package with their first-seen dates
 * Used to establish baseline comparison for rollout health
 * @param {string} packageName - Android package name
 * @param {number} days - How many days of history to check (default 90)
 * @returns {object[]} - Array of { versionCode, firstSeen, lastSeen }
 */
async function getRecentVersions(packageName, days = 90) {
  const cacheKey = `versions:${packageName}`;
  const cached = vitalsCache.android.get(cacheKey);
  if (cached && Date.now() - cached.time < 60 * 60 * 1000) { // 1 hour TTL
    return cached.value;
  }

  log.info('vitals-api', `Fetching recent versions for ${packageName}`);

  try {
    const reporting = await getReportingClient();

    const endDate = new Date();
    endDate.setUTCDate(endDate.getUTCDate() - 2); // 2 day freshness lag
    const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

    const formatDate = (d) => ({
      day: d.getUTCDate(),
      month: d.getUTCMonth() + 1,
      year: d.getUTCFullYear()
    });

    // Query daily data with versionCode dimension to find all versions
    const response = await reporting.vitals.crashrate.query({
      name: `apps/${packageName}/crashRateMetricSet`,
      requestBody: {
        timelineSpec: {
          aggregationPeriod: 'DAILY',
          startTime: formatDate(startDate),
          endTime: formatDate(endDate)
        },
        dimensions: ['versionCode'],
        metrics: ['distinctUsers'],
        pageSize: 100
      }
    });

    // Build version info from response
    const versionMap = new Map();

    if (response.data?.rows) {
      for (const row of response.data.rows) {
        const versionDim = (row.dimensions || []).find(d => d.dimension === 'versionCode');
        const versionCode = versionDim?.stringValue || versionDim?.int64Value;
        if (!versionCode) continue;

        const startTime = row.startTime;
        if (!startTime) continue;

        const date = new Date(Date.UTC(startTime.year, startTime.month - 1, startTime.day));
        const users = parseInt(row.metrics?.['0']?.decimalValue?.value || '0');

        if (!versionMap.has(versionCode)) {
          versionMap.set(versionCode, {
            versionCode,
            firstSeen: date.toISOString(),
            lastSeen: date.toISOString(),
            totalUsers: users
          });
        } else {
          const entry = versionMap.get(versionCode);
          if (date < new Date(entry.firstSeen)) {
            entry.firstSeen = date.toISOString();
          }
          if (date > new Date(entry.lastSeen)) {
            entry.lastSeen = date.toISOString();
          }
          entry.totalUsers += users;
        }
      }
    }

    // Convert to array and sort by firstSeen descending (newest first)
    const versions = Array.from(versionMap.values())
      .sort((a, b) => new Date(b.firstSeen) - new Date(a.firstSeen));

    vitalsCache.android.set(cacheKey, { value: versions, time: Date.now() });

    log.info('vitals-api', `Found ${versions.length} versions for ${packageName}`);
    return versions;
  } catch (error) {
    log.error('vitals-api', `Failed to fetch versions: ${packageName}`, { error: error.message });
    return [];
  }
}

// ============================================
// App Store Connect Power & Performance API
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

  const ascConfig = config.fastlane.appStoreConnect;

  let privateKey;
  let keyId = ascConfig.keyId;
  let issuerId = ascConfig.issuerId;

  // Prefer key content from env var, fall back to file
  if (ascConfig.keyContent) {
    privateKey = ascConfig.keyContent.replace(/\\n/g, '\n');
  } else {
    const keyPath = path.join(__dirname, '..', ascConfig.keyPath);
    if (keyPath.endsWith('.p8')) {
      privateKey = fs.readFileSync(keyPath, 'utf8');
    } else {
      let keyData;
      try {
        keyData = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
      } catch (e) {
        throw new Error(`Failed to read Apple API key: ${e.message}`);
      }
      privateKey = keyData.key.replace(/\\n/g, '\n');
      keyId = keyData.key_id || keyId;
      issuerId = keyData.issuer_id || issuerId;
    }
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

  log.debug('vitals-api', 'Generated new ASC token', { expiresIn: '20 min' });

  return token;
}

/**
 * Get crash count for a specific iOS build using diagnosticSignatures API
 * This works for TestFlight builds which aren't in perfPowerMetrics
 * @param {string} buildId - App Store Connect build ID
 * @returns {object} - { crashCount, signatureCount }
 */
async function getIOSBuildDiagnostics(buildId) {
  if (!buildId) return { error: 'No build ID provided' };

  // Check cache first (buildId-based)
  const cacheKey = `diagnostics-${buildId}`;
  const cached = getCached('ios', cacheKey);
  if (cached) return cached;

  log.info('vitals-api', `Fetching iOS diagnostics for build: ${buildId}`);

  try {
    const token = generateASCToken();

    // Fetch diagnostic signatures for this specific build
    const response = await fetch(
      `https://api.appstoreconnect.apple.com/v1/builds/${buildId}/diagnosticSignatures?limit=100`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      if (response.status === 404) {
        // Build not found or no diagnostics - not an error
        log.debug('vitals-api', `No diagnostics available for build ${buildId}`);
        const result = { buildId, crashCount: 0, signatureCount: 0, fetchedAt: new Date().toISOString() };
        setCache('ios', cacheKey, result);
        return result;
      }
      const errorText = await response.text();
      throw new Error(`diagnosticSignatures failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const signatures = data.data || [];

    // Sum up all crash weights (each signature's weight = number of occurrences)
    let crashCount = 0;
    let signatureCount = 0;

    for (const sig of signatures) {
      // diagnosticCategory can be CRASH, HANG, DISK_WRITE, etc.
      if (sig.attributes?.diagnosticCategory === 'CRASH') {
        crashCount += sig.attributes.weight || 1;
        signatureCount++;
      }
    }

    log.info('vitals-api', `iOS diagnostics for build ${buildId}`, {
      signatureCount,
      crashCount
    });

    const result = {
      buildId,
      crashCount,
      signatureCount,
      fetchedAt: new Date().toISOString()
    };

    setCache('ios', cacheKey, result);
    return result;
  } catch (error) {
    log.error('vitals-api', `Failed to fetch iOS diagnostics: ${buildId}`, { error: error.message });
    return { error: error.message, buildId };
  }
}

/**
 * Get iOS crash/hang metrics from App Store Connect perfPowerMetrics API
 * Now parses per-version data from the productData array
 * @param {string} bundleId - iOS bundle ID
 * @returns {object} - { crashRate, hangRate, byVersion: { [version]: { crashRate, hangRate } } }
 */
async function getIOSVitals(bundleId) {
  // Check cache first
  const cached = getCached('ios', bundleId);
  if (cached) return cached;

  log.info('vitals-api', `Fetching iOS vitals: ${bundleId}`);

  try {
    const token = generateASCToken();

    // First, get the app ID from bundle ID
    const appsResponse = await fetch(
      `https://api.appstoreconnect.apple.com/v1/apps?filter[bundleId]=${bundleId}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!appsResponse.ok) {
      throw new Error(`Failed to find app: ${appsResponse.status}`);
    }

    const appsData = await appsResponse.json();
    if (!appsData.data || appsData.data.length === 0) {
      return { error: 'App not found', bundleId };
    }

    const appId = appsData.data[0].id;

    // Fetch perfPowerMetrics - requires special Accept header
    const metricsResponse = await fetch(
      `https://api.appstoreconnect.apple.com/v1/apps/${appId}/perfPowerMetrics`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.apple.xcode-metrics+json,application/json'
        }
      }
    );

    if (!metricsResponse.ok) {
      const errorText = await metricsResponse.text();
      throw new Error(`perfPowerMetrics failed: ${metricsResponse.status} - ${errorText}`);
    }

    const metricsData = await metricsResponse.json();

    const result = {
      bundleId,
      appId, // Include app ID for deep linking to App Store Connect
      crashRate: null,
      hangRate: null,
      byVersion: {},
      fetchedAt: new Date().toISOString()
    };

    // Log response structure for debugging
    log.debug('vitals-api', `iOS perfPowerMetrics response for ${bundleId}`, {
      hasProductData: !!metricsData.productData,
      productCount: metricsData.productData?.length,
      topLevelKeys: Object.keys(metricsData || {})
    });

    // Parse metrics from response - per version
    // The perfPowerMetrics response structure contains productData with metrics per version
    if (metricsData.productData) {
      for (const product of metricsData.productData) {
        // Log product structure for debugging
        log.debug('vitals-api', `iOS product structure for ${bundleId}`, {
          keys: Object.keys(product),
          metricVersion: product.metricVersion,
          appVersion: product.appVersion,
          version: product.version,
          platform: product.platform
        });

        // Try different version field names
        const version = product.metricVersion || product.appVersion || product.version;
        const platform = product.platform; // e.g., "iOS"

        let versionCrashRate = null;
        let versionHangRate = null;

        // Look for TERMINATION metrics (onScreen = foreground crashes)
        const terminationMetrics = product.metricCategories?.find(
          cat => cat.identifier === 'TERMINATION'
        );

        if (terminationMetrics) {
          const onScreenMetric = terminationMetrics.metrics?.find(m => m.identifier === 'onScreen');
          if (onScreenMetric?.datasets?.length > 0) {
            let totalCrashes = 0;
            for (const dataset of onScreenMetric.datasets) {
              const latestPoint = dataset.points?.[0];
              if (latestPoint && typeof latestPoint.value === 'number') {
                totalCrashes += latestPoint.value;
              }
            }
            versionCrashRate = totalCrashes;
          }
        }

        // Look for HANG metrics
        const hangMetrics = product.metricCategories?.find(
          cat => cat.identifier === 'HANG'
        );

        if (hangMetrics) {
          const hangMetric = hangMetrics.metrics?.[0];

          if (hangMetric?.datasets?.length > 0) {
            // Find "All iPhones" with 50th percentile for typical user experience
            // Unit is "seconds per hour" of hang time
            const typicalDataset = hangMetric.datasets.find(ds =>
              ds.filterCriteria?.device === 'all_iphones' &&
              ds.filterCriteria?.percentile === 'percentile.fifty'
            );

            if (typicalDataset?.points?.length > 0) {
              // Find the point matching this version, or use most recent
              const versionPoint = typicalDataset.points.find(p => p.version === version);
              const point = versionPoint || typicalDataset.points[0];
              if (point && typeof point.value === 'number') {
                versionHangRate = point.value;
              }
            }
          }
        }

        // Store per-version data
        if (version) {
          result.byVersion[version] = {
            crashRate: versionCrashRate,
            hangRate: versionHangRate,
            platform
          };
        }

        // Use first product (most recent version) as the main rate
        if (result.crashRate === null && versionCrashRate !== null) {
          result.crashRate = versionCrashRate;
        }
        if (result.hangRate === null && versionHangRate !== null) {
          result.hangRate = versionHangRate;
        }
      }
    }

    // Also check insights for any crash-related issues
    if (Array.isArray(metricsData.insights)) {
      for (const insight of metricsData.insights) {
        if (insight.metricCategory === 'TERMINATION') {
          log.debug('vitals-api', `iOS insight for ${bundleId}`, { insight: insight.summary });
        }
      }
    }

    // Cache the result
    setCache('ios', bundleId, result);

    log.info('vitals-api', `iOS vitals for ${bundleId}`, {
      crashRate: result.crashRate?.toFixed(2),
      hangRate: result.hangRate?.toFixed(2),
      versionCount: Object.keys(result.byVersion).length
    });

    return result;
  } catch (error) {
    log.error('vitals-api', `Failed to fetch iOS vitals: ${bundleId}`, { error: error.message });
    return { error: error.message, bundleId };
  }
}

/**
 * Get vitals for all configured apps
 */
async function getAllVitals() {
  log.info('vitals-api', 'Fetching vitals for all apps');

  const results = {
    ios: {},
    android: {},
    fetchedAt: new Date().toISOString()
  };

  // Get unique bundle IDs per platform
  const iosBundleIds = [...new Set(
    config.jobs.filter(j => j.platform === 'ios').map(j => j.bundleId)
  )];
  const androidPackages = [...new Set(
    config.jobs.filter(j => j.platform === 'android').map(j => j.bundleId)
  )];

  // Fetch all vitals in parallel
  const [iosResults, androidResults] = await Promise.all([
    Promise.all(iosBundleIds.map(id => getIOSVitals(id).catch(e => ({ bundleId: id, error: e.message })))),
    Promise.all(androidPackages.map(id => getAndroidVitals(id).catch(e => ({ packageName: id, error: e.message }))))
  ]);

  // Build lookup maps
  for (const result of iosResults) {
    if (result && !result.error) {
      results.ios[result.bundleId] = result;
    }
  }

  for (const result of androidResults) {
    if (result && !result.error) {
      results.android[result.packageName] = result;
    }
  }

  return results;
}

module.exports = {
  getAndroidVitals,
  getIOSVitals,
  getIOSBuildDiagnostics,
  getAllVitals,
  getHourlyVersionVitals,
  getRecentVersions
};
