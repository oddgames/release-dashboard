const express = require('express');
const router = express.Router();
const config = require('../config');
const firebaseApi = require('../firebase-api');
const sentryApi = require('../sentry-api');
const vitalsApi = require('../vitals-api');
const storeApi = require('../store-api');
const log = require('../logger');

// Test Sentry API access (for debugging)
router.get('/test-sentry', async (req, res) => {
  log.info('server', 'Testing Sentry API access');

  try {
    const sentryData = await sentryApi.getAllProjectIssueCounts(config.projects || {});
    res.json({
      success: true,
      config: {
        organization: config.sentry?.organization,
        statsPeriod: config.sentry?.statsPeriod,
        hasToken: !!config.sentry?.authToken
      },
      data: sentryData
    });
  } catch (e) {
    res.json({
      success: false,
      error: e.message,
      config: {
        organization: config.sentry?.organization,
        statsPeriod: config.sentry?.statsPeriod,
        hasToken: !!config.sentry?.authToken
      }
    });
  }
});

// Test vitals API access (for debugging)
router.get('/test-vitals', async (req, res) => {
  log.info('server', 'Testing vitals API access');

  const results = {
    ios: {},
    android: {},
    errors: []
  };

  // Test iOS (App Store Connect perfPowerMetrics)
  const iosBundleIds = [...new Set(config.jobs.filter(j => j.platform === 'ios').map(j => j.bundleId))];
  for (const bundleId of iosBundleIds) {
    try {
      const vitals = await vitalsApi.getIOSVitals(bundleId);
      results.ios[bundleId] = vitals;
    } catch (e) {
      results.ios[bundleId] = { error: e.message };
      results.errors.push(`iOS ${bundleId}: ${e.message}`);
    }
  }

  // Test Android (Play Developer Reporting API)
  const androidPackages = [...new Set(config.jobs.filter(j => j.platform === 'android').map(j => j.bundleId))];
  for (const packageName of androidPackages) {
    try {
      const vitals = await vitalsApi.getAndroidVitals(packageName);
      results.android[packageName] = vitals;
    } catch (e) {
      results.android[packageName] = { error: e.message };
      results.errors.push(`Android ${packageName}: ${e.message}`);
    }
  }

  res.json(results);
});

// Get historical DAU for all projects (for sparkline graphs)
// NOTE: This route MUST be before /:projectId to avoid matching "historical" as projectId
router.get('/historical', async (req, res) => {
  log.info('server', 'Fetching historical DAU for all projects');

  try {
    const historical = await firebaseApi.getAllProjectHistoricalDAU();
    res.json({
      success: true,
      projects: historical
    });
  } catch (error) {
    log.error('server', 'Failed to fetch historical analytics', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Get retention data for all projects (D1 and D7 retention)
// NOTE: This route MUST be before /:projectId to avoid matching "retention" as projectId
router.get('/retention', async (req, res) => {
  log.info('server', 'Fetching retention data for all projects');

  try {
    const retention = await firebaseApi.getAllProjectRetention();
    res.json({
      success: true,
      projects: retention
    });
  } catch (error) {
    log.error('server', 'Failed to fetch retention data', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Get version-specific DAU data (for version retention graphs)
// NOTE: This route MUST be before /:projectId to avoid matching "version-dau" as projectId
router.get('/version-dau', async (req, res) => {
  log.info('server', 'Fetching version DAU data for all projects');

  try {
    const versionDAU = await firebaseApi.getAllProjectVersionDAU();
    res.json({
      success: true,
      projects: versionDAU
    });
  } catch (error) {
    log.error('server', 'Failed to fetch version DAU data', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Get all project analytics (aggregated)
async function getAllAnalytics(req, res) {
  log.info('server', 'Fetching all project analytics');

  try {
    const analytics = await firebaseApi.getAllProjectAnalytics();
    res.json({
      success: true,
      projects: analytics
    });
  } catch (error) {
    log.error('server', 'Failed to fetch all analytics', { error: error.message });
    res.status(500).json({ error: error.message });
  }
}

router.get('/', getAllAnalytics);
router.get('/analytics', getAllAnalytics);

// Crashboard - DISABLED
router.get('/crashboard', (req, res) => {
  res.json({ success: true, crashboard: {}, disabled: true });
});

// Get analytics data for a project (daily active users)
router.get('/:projectId', async (req, res) => {
  const { projectId } = req.params;
  const days = parseInt(req.query.days) || 1;

  log.info('server', 'Analytics request', { projectId, days });

  try {
    // Find project config
    const projectJobs = config.jobs.filter(job =>
      job.displayName.toLowerCase().replace(/\s+/g, '-') === projectId
    );

    if (projectJobs.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const projectName = projectJobs[0].displayName;
    const projectConfig = config.projects?.[projectName];

    if (!projectConfig?.firebasePropertyId) {
      return res.status(400).json({
        error: 'No Firebase property configured for this project',
        hint: 'Add firebasePropertyId to config.json projects section'
      });
    }

    const analytics = await firebaseApi.getDailyActiveUsers(
      projectConfig.firebasePropertyId,
      null, // All platforms
      null, // All versions
      days
    );

    if (!analytics) {
      return res.status(500).json({ error: 'Failed to fetch analytics data' });
    }

    res.json({
      success: true,
      projectName,
      days,
      ...analytics
    });
  } catch (error) {
    log.error('server', 'Analytics request failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Get release history with user counts for version comparison
router.get('/release-history/:projectId', async (req, res) => {
  const { projectId } = req.params;
  const days = parseInt(req.query.days) || 30; // Look back 30 days for user counts

  log.info('server', 'Release history request', { projectId, days });

  try {
    // Find project config
    const projectJobs = config.jobs.filter(job =>
      job.displayName.toLowerCase().replace(/\s+/g, '-') === projectId
    );

    if (projectJobs.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const projectName = projectJobs[0].displayName;
    const projectConfig = config.projects?.[projectName];

    // Get users by version from Firebase Analytics
    let usersByVersion = null;
    if (projectConfig?.firebasePropertyId) {
      usersByVersion = await firebaseApi.getUsersByVersion(
        projectConfig.firebasePropertyId,
        null, // All platforms
        days
      );
    }

    // Get iOS and Android bundle IDs
    const iosJob = projectJobs.find(j => j.platform === 'ios');
    const androidJob = projectJobs.find(j => j.platform === 'android');

    // Get store release history
    let iosReleases = [];
    let androidReleases = [];

    // Helper to extract changeset from full version string (e.g., "1.90.8448" -> "8448")
    const extractChangeset = (version) => {
      if (!version) return null;
      const parts = version.split('.');
      // Prefer 3+ parts format (major.minor.changeset)
      if (parts.length >= 3) {
        return parts[parts.length - 1];
      }
      // If only 2 parts or fewer dots, check if last part looks like a changeset (numeric)
      if (parts.length === 2 && /^\d+$/.test(parts[1])) {
        return parts[1];
      }
      // Last resort: if version is purely numeric, it might be the changeset itself
      if (/^\d+$/.test(version)) {
        return version;
      }
      return null;
    };

    // Helper to find matching Firebase version for a store version prefix
    // Store might return "1.90" but Firebase has "1.90.8448"
    const findMatchingFirebaseVersion = (storeVersion, firebaseVersions) => {
      if (!storeVersion || !firebaseVersions) return null;
      // Look for Firebase version that starts with the store version
      const match = firebaseVersions.find(fv =>
        fv.version && fv.version.startsWith(storeVersion + '.')
      );
      return match?.version || null;
    };

    if (iosJob?.bundleId) {
      try {
        const iosInfo = await storeApi.getIOSAppInfo(iosJob.bundleId);
        if (iosInfo?.releaseHistory) {
          const firebaseIosVersions = usersByVersion?.ios || [];
          iosReleases = iosInfo.releaseHistory.map(r => {
            // Store might return "1.90", Firebase has "1.90.8448" - try to match
            const fullVersion = findMatchingFirebaseVersion(r.version, firebaseIosVersions) || r.version;
            const changeset = extractChangeset(fullVersion);
            return {
              version: fullVersion,
              changeset,
              build: r.build,
              releaseDate: r.createdDate,
              platform: 'ios'
            };
          });
        }
      } catch (e) {
        log.warn('server', 'Failed to fetch iOS release history', { error: e.message });
      }
    }

    if (androidJob?.bundleId) {
      try {
        const androidInfo = await storeApi.getAndroidAppInfo(androidJob.bundleId);
        // Android API only gives current production version, not history
        if (androidInfo?.production) {
          const versionName = androidInfo.production.versionName;
          const firebaseAndroidVersions = usersByVersion?.android || [];
          // Try to match with Firebase version for full version string
          const fullVersion = findMatchingFirebaseVersion(versionName, firebaseAndroidVersions) || versionName;
          const changeset = extractChangeset(fullVersion);
          androidReleases = [{
            version: fullVersion,
            changeset,
            versionCode: androidInfo.production.versionCodes?.[0],
            platform: 'android'
          }];
        }
      } catch (e) {
        log.warn('server', 'Failed to fetch Android release history', { error: e.message });
      }
    }

    // Merge user counts with version data
    const enrichVersions = (versions, platform) => {
      const platformUsers = usersByVersion?.[platform] || [];
      return versions.map(v => {
        const userEntry = platformUsers.find(u => u.version === v.version);
        return {
          ...v,
          activeUsers: userEntry?.activeUsers || 0
        };
      });
    };

    // Also include versions that have active users but weren't in store history
    const addMissingVersions = (releases, platformUsers, platform) => {
      const existingVersions = new Set(releases.map(r => r.version));
      for (const user of platformUsers || []) {
        if (!existingVersions.has(user.version)) {
          // Use same extraction helper for consistency
          const changeset = extractChangeset(user.version);
          releases.push({
            version: user.version,
            changeset,
            activeUsers: user.activeUsers,
            platform
          });
        }
      }
      // Sort by active users descending
      return releases.sort((a, b) => (b.activeUsers || 0) - (a.activeUsers || 0));
    };

    const enrichedIOS = addMissingVersions(
      enrichVersions(iosReleases, 'ios'),
      usersByVersion?.ios,
      'ios'
    );
    const enrichedAndroid = addMissingVersions(
      enrichVersions(androidReleases, 'android'),
      usersByVersion?.android,
      'android'
    );

    // Debug logging for version extraction
    log.debug('server', 'Release history versions', {
      iosCount: enrichedIOS.length,
      androidCount: enrichedAndroid.length,
      iosSample: enrichedIOS.slice(0, 3).map(v => ({ version: v.version, changeset: v.changeset })),
      androidSample: enrichedAndroid.slice(0, 3).map(v => ({ version: v.version, changeset: v.changeset })),
      firebaseIosSample: usersByVersion?.ios?.slice(0, 3),
      firebaseAndroidSample: usersByVersion?.android?.slice(0, 3)
    });

    res.json({
      success: true,
      projectName,
      days,
      ios: enrichedIOS,
      android: enrichedAndroid
    });
  } catch (error) {
    log.error('server', 'Release history request failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
