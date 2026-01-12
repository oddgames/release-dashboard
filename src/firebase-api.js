/**
 * Firebase Analytics API client
 * Uses Google Analytics Data API v1 (GA4) to fetch app analytics
 *
 * Requires the service account to have "Viewer" role on the Firebase/GA4 property
 * Same service account used for Google Play can be granted Firebase Analytics access
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const log = require('./logger');

// Load config
const configPath = path.join(__dirname, '..', 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Cache for analytics data
const analyticsCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

let analyticsDataClient = null;
let authClient = null;

/**
 * Initialize the Google Analytics Data API client
 */
async function initClient() {
  if (analyticsDataClient) return analyticsDataClient;

  try {
    const keyPath = path.join(__dirname, '..', config.fastlane?.googlePlay?.jsonKeyPath || 'fastlane/google_play_key.json');

    if (!fs.existsSync(keyPath)) {
      log.warn('firebase-api', 'Service account key not found', { keyPath });
      return null;
    }

    const keyFile = JSON.parse(fs.readFileSync(keyPath, 'utf8'));

    authClient = new google.auth.GoogleAuth({
      credentials: keyFile,
      scopes: ['https://www.googleapis.com/auth/analytics.readonly']
    });

    analyticsDataClient = google.analyticsdata({
      version: 'v1beta',
      auth: authClient
    });

    log.info('firebase-api', 'Analytics Data API client initialized');
    return analyticsDataClient;
  } catch (error) {
    log.error('firebase-api', 'Failed to initialize Analytics client', { error: error.message });
    return null;
  }
}

/**
 * Get daily active users for a GA4 property
 * @param {string} propertyId - GA4 property ID (e.g., "properties/123456789")
 * @param {string} platform - 'ios' or 'android' (optional filter)
 * @param {string} appVersion - App version to filter by (optional)
 * @param {number} days - Number of days to look back (default 1)
 * @returns {Promise<Object>} Daily active users data
 */
async function getDailyActiveUsers(propertyId, platform = null, appVersion = null, days = 1) {
  const cacheKey = `dau:${propertyId}:${platform || 'all'}:${appVersion || 'all'}:${days}`;
  const cached = analyticsCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const client = await initClient();
  if (!client) {
    return null;
  }

  try {
    // Build dimension filters
    const dimensionFilters = [];

    if (platform) {
      dimensionFilters.push({
        filter: {
          fieldName: 'platform',
          stringFilter: {
            matchType: 'EXACT',
            value: platform === 'ios' ? 'iOS' : 'Android'
          }
        }
      });
    }

    if (appVersion) {
      dimensionFilters.push({
        filter: {
          fieldName: 'appVersion',
          stringFilter: {
            matchType: 'EXACT',
            value: appVersion
          }
        }
      });
    }

    const propertyPath = propertyId.startsWith('properties/') ? propertyId : `properties/${propertyId}`;

    const requestBody = {
      dateRanges: [{
        startDate: `${days}daysAgo`,
        endDate: 'today'
      }],
      metrics: [
        { name: 'activeUsers' },
        { name: 'newUsers' },
        { name: 'sessions' }
      ],
      dimensions: [
        { name: 'platform' }
      ]
    };

    if (dimensionFilters.length > 0) {
      requestBody.dimensionFilter = {
        andGroup: {
          expressions: dimensionFilters
        }
      };
    }

    log.debug('firebase-api', 'Running analytics report', { propertyId, platform, appVersion, days });

    const response = await client.properties.runReport({
      property: propertyPath,
      requestBody
    });

    const result = {
      ios: { activeUsers: 0, newUsers: 0, sessions: 0 },
      android: { activeUsers: 0, newUsers: 0, sessions: 0 },
      total: { activeUsers: 0, newUsers: 0, sessions: 0 }
    };

    if (response.data.rows) {
      for (const row of response.data.rows) {
        const plat = row.dimensionValues[0]?.value?.toLowerCase() || 'unknown';
        const activeUsers = parseInt(row.metricValues[0]?.value || '0');
        const newUsers = parseInt(row.metricValues[1]?.value || '0');
        const sessions = parseInt(row.metricValues[2]?.value || '0');

        if (plat === 'ios') {
          result.ios = { activeUsers, newUsers, sessions };
        } else if (plat === 'android') {
          result.android = { activeUsers, newUsers, sessions };
        }

        result.total.activeUsers += activeUsers;
        result.total.newUsers += newUsers;
        result.total.sessions += sessions;
      }
    }

    analyticsCache.set(cacheKey, { data: result, timestamp: Date.now() });
    log.info('firebase-api', 'Fetched daily active users', {
      propertyId,
      ios: result.ios.activeUsers,
      android: result.android.activeUsers
    });

    return result;
  } catch (error) {
    log.error('firebase-api', 'Failed to fetch analytics', {
      propertyId,
      error: error.message,
      code: error.code
    });
    return null;
  }
}

/**
 * Get active users by app version
 * @param {string} propertyId - GA4 property ID
 * @param {string} platform - 'ios' or 'android'
 * @param {number} days - Number of days to look back
 * @returns {Promise<Object>} Users by version
 */
async function getUsersByVersion(propertyId, platform = null, days = 7) {
  const cacheKey = `users-by-version:${propertyId}:${platform || 'all'}:${days}`;
  const cached = analyticsCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const client = await initClient();
  if (!client) {
    return null;
  }

  try {
    const propertyPath = propertyId.startsWith('properties/') ? propertyId : `properties/${propertyId}`;

    const requestBody = {
      dateRanges: [{
        startDate: `${days}daysAgo`,
        endDate: 'today'
      }],
      metrics: [
        { name: 'activeUsers' }
      ],
      dimensions: [
        { name: 'platform' },
        { name: 'appVersion' }
      ],
      orderBys: [{
        metric: { metricName: 'activeUsers' },
        desc: true
      }],
      limit: 20
    };

    if (platform) {
      requestBody.dimensionFilter = {
        filter: {
          fieldName: 'platform',
          stringFilter: {
            matchType: 'EXACT',
            value: platform === 'ios' ? 'iOS' : 'Android'
          }
        }
      };
    }

    const response = await client.properties.runReport({
      property: propertyPath,
      requestBody
    });

    const result = {
      ios: [],
      android: []
    };

    if (response.data.rows) {
      for (const row of response.data.rows) {
        const plat = row.dimensionValues[0]?.value?.toLowerCase() || 'unknown';
        const version = row.dimensionValues[1]?.value || 'unknown';
        const activeUsers = parseInt(row.metricValues[0]?.value || '0');

        const entry = { version, activeUsers };

        if (plat === 'ios') {
          result.ios.push(entry);
        } else if (plat === 'android') {
          result.android.push(entry);
        }
      }
    }

    analyticsCache.set(cacheKey, { data: result, timestamp: Date.now() });
    return result;
  } catch (error) {
    log.error('firebase-api', 'Failed to fetch users by version', {
      propertyId,
      error: error.message
    });
    return null;
  }
}

/**
 * Get analytics for all configured projects
 * @returns {Promise<Object>} Analytics data keyed by project name
 */
async function getAllProjectAnalytics() {
  const results = {};
  const firebaseConfig = config.firebase || {};

  for (const [projectName, projectConfig] of Object.entries(config.projects || {})) {
    const propertyId = projectConfig.firebasePropertyId || firebaseConfig.properties?.[projectName];

    if (!propertyId) {
      log.debug('firebase-api', 'No Firebase property configured for project', { projectName });
      continue;
    }

    const analytics = await getDailyActiveUsers(propertyId, null, null, 1);
    if (analytics) {
      results[projectName] = analytics;
    }
  }

  return results;
}

/**
 * Get historical DAU data for sparkline graphs (day-by-day for last N days)
 * @param {string} propertyId - GA4 property ID
 * @param {number} days - Number of days to look back (default 14)
 * @returns {Promise<Object>} Historical DAU data by day
 */
async function getHistoricalDAU(propertyId, days = 14) {
  const cacheKey = `historical-dau:${propertyId}:${days}`;
  const cached = analyticsCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const client = await initClient();
  if (!client) {
    return null;
  }

  try {
    const propertyPath = propertyId.startsWith('properties/') ? propertyId : `properties/${propertyId}`;

    const requestBody = {
      dateRanges: [{
        startDate: `${days}daysAgo`,
        endDate: 'yesterday'
      }],
      metrics: [
        { name: 'activeUsers' },
        { name: 'newUsers' }
      ],
      dimensions: [
        { name: 'date' },
        { name: 'platform' }
      ],
      orderBys: [{
        dimension: { dimensionName: 'date' }
      }]
    };

    const response = await client.properties.runReport({
      property: propertyPath,
      requestBody
    });

    // Organize data by date
    const result = {
      dates: [],
      ios: [],
      android: [],
      total: [],
      iosNew: [],
      androidNew: [],
      totalNew: []
    };

    // Build a map of date -> { ios, android }
    const dateMap = {};

    if (response.data.rows) {
      for (const row of response.data.rows) {
        const date = row.dimensionValues[0]?.value || '';
        const plat = row.dimensionValues[1]?.value?.toLowerCase() || 'unknown';
        const activeUsers = parseInt(row.metricValues[0]?.value || '0');
        const newUsers = parseInt(row.metricValues[1]?.value || '0');

        if (!dateMap[date]) {
          dateMap[date] = { ios: 0, android: 0, iosNew: 0, androidNew: 0 };
        }

        if (plat === 'ios') {
          dateMap[date].ios = activeUsers;
          dateMap[date].iosNew = newUsers;
        } else if (plat === 'android') {
          dateMap[date].android = activeUsers;
          dateMap[date].androidNew = newUsers;
        }
      }
    }

    // Convert to arrays, sorted by date
    const sortedDates = Object.keys(dateMap).sort();
    for (const date of sortedDates) {
      const d = dateMap[date];
      result.dates.push(date);
      result.ios.push(d.ios);
      result.android.push(d.android);
      result.total.push(d.ios + d.android);
      result.iosNew.push(d.iosNew);
      result.androidNew.push(d.androidNew);
      result.totalNew.push(d.iosNew + d.androidNew);
    }

    analyticsCache.set(cacheKey, { data: result, timestamp: Date.now() });
    log.info('firebase-api', 'Fetched historical DAU', {
      propertyId,
      days: result.dates.length
    });

    return result;
  } catch (error) {
    log.error('firebase-api', 'Failed to fetch historical DAU', {
      propertyId,
      error: error.message
    });
    return null;
  }
}

/**
 * Get historical DAU for all configured projects
 * @returns {Promise<Object>} Historical DAU keyed by project name
 */
async function getAllProjectHistoricalDAU() {
  const results = {};

  for (const [projectName, projectConfig] of Object.entries(config.projects || {})) {
    const propertyId = projectConfig.firebasePropertyId;

    if (!propertyId) {
      continue;
    }

    const historical = await getHistoricalDAU(propertyId, 14);
    if (historical) {
      results[projectName] = historical;
    }
  }

  return results;
}

/**
 * Get the first-seen date for each app version
 * This effectively gives us the "release date" - when users first started using the version
 * @param {string} propertyId - GA4 property ID
 * @param {string} platform - 'ios' or 'android' (optional)
 * @param {number} days - Number of days to look back (default 90)
 * @returns {Promise<Object>} Map of version -> first seen date
 */
async function getVersionFirstSeenDates(propertyId, platform = null, days = 90) {
  const cacheKey = `version-first-seen:${propertyId}:${platform || 'all'}:${days}`;
  const cached = analyticsCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const client = await initClient();
  if (!client) {
    return null;
  }

  try {
    const propertyPath = propertyId.startsWith('properties/') ? propertyId : `properties/${propertyId}`;

    const requestBody = {
      dateRanges: [{
        startDate: `${days}daysAgo`,
        endDate: 'today'
      }],
      metrics: [
        { name: 'activeUsers' } // Need at least one metric
      ],
      dimensions: [
        { name: 'platform' },
        { name: 'appVersion' },
        { name: 'date' }
      ],
      orderBys: [{
        dimension: { dimensionName: 'date' }
      }],
      limit: 1000 // Get enough data to find first occurrences
    };

    if (platform) {
      requestBody.dimensionFilter = {
        filter: {
          fieldName: 'platform',
          stringFilter: {
            matchType: 'EXACT',
            value: platform === 'ios' ? 'iOS' : 'Android'
          }
        }
      };
    }

    const response = await client.properties.runReport({
      property: propertyPath,
      requestBody
    });

    const result = {
      ios: {},      // version -> first seen date (YYYYMMDD)
      android: {}   // version -> first seen date (YYYYMMDD)
    };

    if (response.data.rows) {
      for (const row of response.data.rows) {
        const plat = row.dimensionValues[0]?.value?.toLowerCase() || 'unknown';
        const version = row.dimensionValues[1]?.value || 'unknown';
        const date = row.dimensionValues[2]?.value || '';

        // Only record the first (earliest) date for each version
        if (plat === 'ios' && !result.ios[version]) {
          result.ios[version] = date;
        } else if (plat === 'android' && !result.android[version]) {
          result.android[version] = date;
        }
      }
    }

    analyticsCache.set(cacheKey, { data: result, timestamp: Date.now() });
    log.info('firebase-api', 'Fetched version first-seen dates', {
      propertyId,
      iosVersions: Object.keys(result.ios).length,
      androidVersions: Object.keys(result.android).length
    });

    return result;
  } catch (error) {
    log.error('firebase-api', 'Failed to fetch version first-seen dates', {
      propertyId,
      error: error.message
    });
    return null;
  }
}

/**
 * Get user retention data (Day 1, 3, 7, 14, 30 retention)
 * Uses cohort analysis to measure how many users return after initial visit
 * @param {string} propertyId - GA4 property ID
 * @param {number} days - Number of cohort days to analyze (default 45 for D30 data)
 * @returns {Promise<Object>} Retention data with D1, D3, D7, D14, D30 rates
 */
async function getRetentionData(propertyId, days = 45) {
  const cacheKey = `retention:${propertyId}:${days}`;
  const cached = analyticsCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const client = await initClient();
  if (!client) {
    return null;
  }

  try {
    const propertyPath = propertyId.startsWith('properties/') ? propertyId : `properties/${propertyId}`;

    // Calculate date range - we need at least 31 days of data for D30 retention
    const endDate = new Date();
    endDate.setDate(endDate.getDate() - 1); // Yesterday (to ensure complete data)
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - days - 30); // Go back further to get cohorts with D30 data

    const formatDate = (d) => d.toISOString().split('T')[0];

    const requestBody = {
      dimensions: [
        { name: 'cohort' },
        { name: 'cohortNthDay' },
        { name: 'platform' }
      ],
      metrics: [
        { name: 'cohortActiveUsers' },
        { name: 'cohortTotalUsers' }
      ],
      cohortSpec: {
        cohorts: [
          {
            name: 'cohort',
            dimension: 'firstSessionDate',
            dateRange: {
              startDate: formatDate(startDate),
              endDate: formatDate(endDate)
            }
          }
        ],
        cohortsRange: {
          endOffset: 30, // Track up to day 30
          granularity: 'DAILY'
        }
      }
    };

    log.debug('firebase-api', 'Fetching retention data', { propertyId, startDate: formatDate(startDate), endDate: formatDate(endDate) });

    const response = await client.properties.runReport({
      property: propertyPath,
      requestBody
    });

    // Process cohort data to calculate D1, D3, D7, D14, D30 retention
    const result = {
      ios: { d1: null, d3: null, d7: null, d14: null, d30: null, totalUsers: 0 },
      android: { d1: null, d3: null, d7: null, d14: null, d30: null, totalUsers: 0 },
      total: { d1: null, d3: null, d7: null, d14: null, d30: null, totalUsers: 0 }
    };

    // Track users by day and platform
    const platformData = {
      ios: { day0: 0, day1: 0, day3: 0, day7: 0, day14: 0, day30: 0 },
      android: { day0: 0, day1: 0, day3: 0, day7: 0, day14: 0, day30: 0 }
    };

    if (response.data.rows) {
      for (const row of response.data.rows) {
        const nthDay = parseInt(row.dimensionValues[1]?.value || '0');
        const platform = row.dimensionValues[2]?.value?.toLowerCase() || 'unknown';
        const activeUsers = parseInt(row.metricValues[0]?.value || '0');
        const totalUsers = parseInt(row.metricValues[1]?.value || '0');

        if (platform !== 'ios' && platform !== 'android') continue;

        if (nthDay === 0) {
          platformData[platform].day0 += totalUsers;
        } else if (nthDay === 1) {
          platformData[platform].day1 += activeUsers;
        } else if (nthDay === 3) {
          platformData[platform].day3 += activeUsers;
        } else if (nthDay === 7) {
          platformData[platform].day7 += activeUsers;
        } else if (nthDay === 14) {
          platformData[platform].day14 += activeUsers;
        } else if (nthDay === 30) {
          platformData[platform].day30 += activeUsers;
        }
      }
    }

    // Calculate retention rates
    for (const platform of ['ios', 'android']) {
      const data = platformData[platform];
      if (data.day0 > 0) {
        result[platform].d1 = Math.round((data.day1 / data.day0) * 100);
        result[platform].d3 = Math.round((data.day3 / data.day0) * 100);
        result[platform].d7 = Math.round((data.day7 / data.day0) * 100);
        result[platform].d14 = Math.round((data.day14 / data.day0) * 100);
        result[platform].d30 = Math.round((data.day30 / data.day0) * 100);
        result[platform].totalUsers = data.day0;
      }
    }

    // Calculate total retention
    const totalDay0 = platformData.ios.day0 + platformData.android.day0;
    const totalDay1 = platformData.ios.day1 + platformData.android.day1;
    const totalDay3 = platformData.ios.day3 + platformData.android.day3;
    const totalDay7 = platformData.ios.day7 + platformData.android.day7;
    const totalDay14 = platformData.ios.day14 + platformData.android.day14;
    const totalDay30 = platformData.ios.day30 + platformData.android.day30;

    if (totalDay0 > 0) {
      result.total.d1 = Math.round((totalDay1 / totalDay0) * 100);
      result.total.d3 = Math.round((totalDay3 / totalDay0) * 100);
      result.total.d7 = Math.round((totalDay7 / totalDay0) * 100);
      result.total.d14 = Math.round((totalDay14 / totalDay0) * 100);
      result.total.d30 = Math.round((totalDay30 / totalDay0) * 100);
      result.total.totalUsers = totalDay0;
    }

    analyticsCache.set(cacheKey, { data: result, timestamp: Date.now() });
    log.info('firebase-api', 'Fetched retention data', {
      propertyId,
      d1: result.total.d1,
      d3: result.total.d3,
      d7: result.total.d7,
      d14: result.total.d14,
      d30: result.total.d30
    });

    return result;
  } catch (error) {
    log.error('firebase-api', 'Failed to fetch retention data', {
      propertyId,
      error: error.message,
      code: error.code
    });
    return null;
  }
}

/**
 * Get retention data for all configured projects
 * @returns {Promise<Object>} Retention data keyed by project name
 */
async function getAllProjectRetention() {
  const results = {};

  for (const [projectName, projectConfig] of Object.entries(config.projects || {})) {
    const propertyId = projectConfig.firebasePropertyId;

    if (!propertyId) {
      continue;
    }

    const retention = await getRetentionData(propertyId, 14);
    if (retention) {
      results[projectName] = retention;
    }
  }

  return results;
}

/**
 * Get historical DAU data for specific app versions (for retention-like graphs)
 * Shows how active users change over time since the version was released
 * @param {string} propertyId - GA4 property ID
 * @param {string[]} versions - Array of version strings to track
 * @param {number} days - Number of days to look back (default 14)
 * @returns {Promise<Object>} Historical DAU data by version and date
 */
async function getVersionHistoricalDAU(propertyId, versions = [], days = 14) {
  const cacheKey = `version-historical-dau:${propertyId}:${versions.join(',')}:${days}`;
  const cached = analyticsCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const client = await initClient();
  if (!client) {
    return null;
  }

  try {
    const propertyPath = propertyId.startsWith('properties/') ? propertyId : `properties/${propertyId}`;

    const requestBody = {
      dateRanges: [{
        startDate: `${days}daysAgo`,
        endDate: 'yesterday'
      }],
      metrics: [
        { name: 'activeUsers' },
        { name: 'newUsers' }
      ],
      dimensions: [
        { name: 'date' },
        { name: 'platform' },
        { name: 'appVersion' }
      ],
      orderBys: [{
        dimension: { dimensionName: 'date' }
      }],
      limit: 5000
    };

    // Only filter by version if specific versions are requested
    if (versions.length > 0) {
      requestBody.dimensionFilter = {
        filter: {
          fieldName: 'appVersion',
          inListFilter: {
            values: versions
          }
        }
      };
    }

    const response = await client.properties.runReport({
      property: propertyPath,
      requestBody
    });

    // Organize data by version -> platform -> date series
    const result = {};

    if (response.data.rows) {
      for (const row of response.data.rows) {
        const date = row.dimensionValues[0]?.value || '';
        const platform = row.dimensionValues[1]?.value?.toLowerCase() || 'unknown';
        const version = row.dimensionValues[2]?.value || 'unknown';
        const activeUsers = parseInt(row.metricValues[0]?.value || '0');
        const newUsers = parseInt(row.metricValues[1]?.value || '0');

        if (!result[version]) {
          result[version] = {
            ios: { dates: [], activeUsers: [], newUsers: [] },
            android: { dates: [], activeUsers: [], newUsers: [] }
          };
        }

        if (platform === 'ios' || platform === 'android') {
          const platData = result[version][platform];
          const dateIdx = platData.dates.indexOf(date);
          if (dateIdx === -1) {
            platData.dates.push(date);
            platData.activeUsers.push(activeUsers);
            platData.newUsers.push(newUsers);
          } else {
            platData.activeUsers[dateIdx] += activeUsers;
            platData.newUsers[dateIdx] += newUsers;
          }
        }
      }
    }

    // Sort dates and calculate retention curve (relative to peak)
    for (const version of Object.keys(result)) {
      for (const platform of ['ios', 'android']) {
        const platData = result[version][platform];
        if (platData.dates.length > 0) {
          // Sort by date
          const sortedIndices = platData.dates
            .map((d, i) => ({ d, i }))
            .sort((a, b) => a.d.localeCompare(b.d))
            .map(x => x.i);

          platData.dates = sortedIndices.map(i => platData.dates[i]);
          platData.activeUsers = sortedIndices.map(i => platData.activeUsers[i]);
          platData.newUsers = sortedIndices.map(i => platData.newUsers[i]);

          // Calculate relative retention (DAU on each day vs peak DAU)
          const peakDAU = Math.max(...platData.activeUsers);
          platData.retentionCurve = platData.activeUsers.map(dau =>
            peakDAU > 0 ? Math.round((dau / peakDAU) * 100) : 0
          );
          platData.peakDAU = peakDAU;
        }
      }
    }

    analyticsCache.set(cacheKey, { data: result, timestamp: Date.now() });
    log.info('firebase-api', 'Fetched version historical DAU', {
      propertyId,
      versions: Object.keys(result).length
    });

    return result;
  } catch (error) {
    log.error('firebase-api', 'Failed to fetch version historical DAU', {
      propertyId,
      error: error.message
    });
    return null;
  }
}

/**
 * Get version adoption and retention data for all configured projects
 * @returns {Promise<Object>} Version DAU data keyed by project name
 */
async function getAllProjectVersionDAU() {
  const results = {};

  for (const [projectName, projectConfig] of Object.entries(config.projects || {})) {
    const propertyId = projectConfig.firebasePropertyId;

    if (!propertyId) {
      continue;
    }

    // Get top versions and their historical data
    const versionData = await getVersionHistoricalDAU(propertyId, [], 14);
    if (versionData) {
      results[projectName] = versionData;
    }
  }

  return results;
}

/**
 * Clear the analytics cache
 */
function clearCache() {
  analyticsCache.clear();
  log.info('firebase-api', 'Analytics cache cleared');
}

module.exports = {
  initClient,
  getDailyActiveUsers,
  getUsersByVersion,
  getAllProjectAnalytics,
  getHistoricalDAU,
  getAllProjectHistoricalDAU,
  getVersionFirstSeenDates,
  getRetentionData,
  getAllProjectRetention,
  getVersionHistoricalDAU,
  getAllProjectVersionDAU,
  clearCache
};
