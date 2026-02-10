const express = require('express');
const router = express.Router();
const config = require('../config');
const firebaseApi = require('../firebase-api');
const sentryApi = require('../sentry-api');
const vitalsApi = require('../vitals-api');
const storeApi = require('../store-api');
const log = require('../logger');
const { buildCache } = require('../services/cache');

/**
 * Helper to extract changeset/versionCode from a full version string
 * e.g., "3.92.12651" -> "12651"
 */
function extractChangeset(version) {
  if (!version) return null;
  const parts = version.split('.');
  return parts.length >= 3 ? parts[parts.length - 1] : version;
}

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

// Crashboard - Sentry issues per project (last 7 days)
router.get('/crashboard', async (req, res) => {
  try {
    const crashboard = {};

    for (const [projectName, projectConfig] of Object.entries(config.projects || {})) {
      if (!projectConfig.sentryProject) continue;

      try {
        const issues = await sentryApi.getProjectIssues7d(projectConfig.sentryProject);

        // Build Sentry link (use numeric project ID from first issue if available)
        const linkQuery = 'is:unresolved';
        const org = config.sentry?.organization;
        const numericId = issues[0]?.project?.id || projectConfig.sentryProject;
        const link = org
          ? `https://${org}.sentry.io/issues/?project=${numericId}&query=${encodeURIComponent(linkQuery)}&statsPeriod=7d&sort=freq`
          : '#';

        crashboard[projectName] = {
          issues: issues.slice(0, 20).map(issue => ({
            id: issue.id,
            title: issue.title,
            level: issue.level || 'error',
            count: parseInt(issue.count) || 0,
            userCount: parseInt(issue.userCount) || 0,
            link: issue.permalink || '#'
          })),
          totalIssues: issues.length,
          link
        };
      } catch (err) {
        log.warn('server', `Crashboard: failed to fetch ${projectName}`, { error: err.message });
      }
    }

    res.json({ success: true, crashboard });
  } catch (error) {
    log.error('server', 'Crashboard fetch failed', { error: error.message });
    res.json({ success: false, error: error.message, crashboard: {} });
  }
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

// Get rollout health details for a project
// Combines hourly vitals, Sentry issues, and comparison with previous releases
router.get('/rollout-details/:projectId', async (req, res) => {
  const { projectId } = req.params;

  log.info('server', 'Rollout details request', { projectId });

  try {
    // Find project in cache
    const project = buildCache.projects?.find(p =>
      p.id === projectId ||
      p.displayName?.toLowerCase().replace(/\s+/g, '-') === projectId
    );

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Get the project's Android package name
    const androidJob = config.jobs.find(j =>
      j.displayName === project.displayName && j.platform === 'android'
    );

    if (!androidJob?.bundleId) {
      return res.status(400).json({ error: 'No Android bundle ID configured for this project' });
    }

    const packageName = androidJob.bundleId;
    const projectConfig = config.projects?.[project.displayName];
    const sentryProject = projectConfig?.sentryProject;

    // Find the rollout track in the project's main branch
    const mainBranch = project.branches?.find(b => b.branch === 'main');
    const rolloutTrack = mainBranch?.tracks?.storeRollout;

    if (!rolloutTrack?.androidVersion) {
      return res.status(400).json({
        error: 'No active rollout found',
        hint: 'This endpoint requires an active Android rollout'
      });
    }

    // Keep full version string (e.g., "3.92.12651") and use the actual Android versionCode
    const fullVersion = rolloutTrack.androidVersion;
    // Use the actual androidVersionCode from store if available, otherwise extract from version string
    const versionCode = rolloutTrack.androidVersionCode?.toString() ||
                        fullVersion.split('.').pop();
    const userFraction = rolloutTrack.androidUserFraction || 0;

    log.debug('server', 'Rollout version info', {
      fullVersion,
      versionCode,
      androidVersionCode: rolloutTrack.androidVersionCode
    });

    // Calculate hours and days into rollout (use store date if available)
    let hoursIntoRollout = 0;
    let daysIntoRollout = 0;
    const rolloutStartDate = rolloutTrack.androidDate ? new Date(rolloutTrack.androidDate) : null;
    if (rolloutStartDate) {
      hoursIntoRollout = Math.floor((Date.now() - rolloutStartDate.getTime()) / (1000 * 60 * 60));
      daysIntoRollout = Math.floor(hoursIntoRollout / 24);
    }

    // Get Firebase property ID for this project
    const firebasePropertyId = projectConfig?.firebasePropertyId;

    // Fetch all data in parallel (with error handling for each)
    const [currentVitals, recentVersions, currentSentry, firebaseVersions, firebaseMetrics] = await Promise.all([
      // Hourly vitals from Google Play
      vitalsApi.getHourlyVersionVitals(packageName, versionCode)
        .catch(e => ({ error: e.message, hourly: [], summary: {} })),
      // Recent version codes from Google Play
      vitalsApi.getRecentVersions(packageName, 90)
        .catch(e => { log.warn('server', 'getRecentVersions failed', { error: e.message }); return []; }),
      // Sentry issues for this version
      sentryProject
        ? sentryApi.getIssuesForVersion(sentryProject, fullVersion)
            .catch(e => ({ error: e.message, totalCount: 0, criticalCount: 0, affectedUsers: 0, issues: [] }))
        : Promise.resolve({ totalCount: 0, criticalCount: 0, affectedUsers: 0, issues: [] }),
      // Firebase versions with user counts (for version mapping)
      firebasePropertyId
        ? firebaseApi.getUsersByVersion(firebasePropertyId, 'android', 30)
            .catch(e => { log.warn('server', 'getUsersByVersion failed', { error: e.message }); return { android: [] }; })
        : Promise.resolve({ android: [] }),
      // Firebase metrics for current version (users, sessions)
      firebasePropertyId
        ? firebaseApi.getVersionMetrics(firebasePropertyId, fullVersion, 'android', 7)
            .catch(e => { log.warn('server', 'getVersionMetrics failed', { error: e.message }); return null; })
        : Promise.resolve(null)
    ]);

    // Build a map from changeset to full version using Firebase data
    // Firebase has full versions like "3.92.12651", we extract "12651" as key
    const changesetToFullMap = {};
    const firebaseAndroidVersions = firebaseVersions?.android || [];

    for (const v of firebaseAndroidVersions) {
      const changeset = extractChangeset(v.version);
      if (changeset) {
        changesetToFullMap[changeset] = {
          fullVersion: v.version,
          activeUsers: v.activeUsers
        };
      }
    }

    // Also map by full versionCode (some apps use different formats)
    // Build a map from version code to full version from store tracks
    const storeRelease = mainBranch?.tracks?.storeRelease;
    const versionCodeToFullMap = {};

    // Map current rollout version
    versionCodeToFullMap[versionCode] = fullVersion;
    changesetToFullMap[extractChangeset(fullVersion)] = {
      fullVersion,
      activeUsers: firebaseMetrics?.activeUsers || 0
    };

    // Map production version if available
    if (storeRelease?.androidVersion) {
      const releaseParts = storeRelease.androidVersion.split('.');
      const releaseCode = releaseParts[releaseParts.length - 1];
      versionCodeToFullMap[releaseCode] = storeRelease.androidVersion;
    }

    // Get previous 2-3 versions for baseline comparison using Firebase data
    // Firebase gives us proper version strings like "3.90.11343" with active user counts
    const currentChangeset = extractChangeset(fullVersion);
    const previousFirebaseVersions = firebaseAndroidVersions
      .filter(v => {
        // Exclude current version and very low user count versions
        const changeset = extractChangeset(v.version);
        return changeset !== currentChangeset && v.activeUsers >= 100;
      })
      .slice(0, 3); // Top 3 by active users

    log.debug('server', 'Previous versions from Firebase', {
      count: previousFirebaseVersions.length,
      versions: previousFirebaseVersions.map(v => ({ version: v.version, users: v.activeUsers }))
    });

    // Build previous releases data from Firebase (no extra API calls needed)
    // Skip fetching Sentry for each previous version - it's slow and not that useful
    // since issues accumulate over time anyway
    const previousReleases = previousFirebaseVersions.map(fbVersion => ({
      version: fbVersion.version,
      firebaseUsers: fbVersion.activeUsers,
      atSameHour: {
        vitals: {
          crashRate: null,
          anrRate: null,
          users: fbVersion.activeUsers
        },
        sentry: {
          totalCount: 0,
          criticalCount: 0,
          affectedUsers: 0,
          eventCount: 0
        }
      }
    }));

    // Calculate baseline averages from previous versions
    const baselineVitals = { crashRate: 0, anrRate: 0, count: 0 };
    const baselineSentry = { totalCount: 0, criticalCount: 0, count: 0 };

    for (const prev of previousReleases) {
      if (prev.atSameHour.vitals.crashRate !== null) {
        baselineVitals.crashRate += prev.atSameHour.vitals.crashRate;
        baselineVitals.anrRate += prev.atSameHour.vitals.anrRate || 0;
        baselineVitals.count++;
      }
      baselineSentry.totalCount += prev.atSameHour.sentry.totalCount;
      baselineSentry.criticalCount += prev.atSameHour.sentry.criticalCount;
      baselineSentry.count++;
    }

    if (baselineVitals.count > 0) {
      baselineVitals.crashRate /= baselineVitals.count;
      baselineVitals.anrRate /= baselineVitals.count;
    }
    if (baselineSentry.count > 0) {
      baselineSentry.totalCount /= baselineSentry.count;
      baselineSentry.criticalCount /= baselineSentry.count;
    }

    // If no hourly data, try to get daily vitals as fallback
    let dailyVitals = null;
    if (!currentVitals.hourly || currentVitals.hourly.length === 0) {
      try {
        const dailyData = await vitalsApi.getAndroidVitals(packageName, {
          startDate: rolloutStartDate || new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
          skipCache: false
        });
        const versionDaily = dailyData.byVersion?.[versionCode];
        if (versionDaily) {
          dailyVitals = {
            crashRate: versionDaily.crashRate,
            anrRate: versionDaily.anrRate,
            users: versionDaily.distinctUsers || 0
          };
        }
      } catch (e) {
        log.warn('server', 'Failed to get daily vitals fallback', { error: e.message });
      }
    }

    // Calculate health scores - use daily vitals as fallback if no hourly
    const vitalsForAnalysis = currentVitals.summary?.crashRate !== null
      ? currentVitals.summary
      : (dailyVitals || { crashRate: null, anrRate: null, totalUsers: 0 });

    const analysis = calculateHealthAnalysis(
      vitalsForAnalysis,
      currentSentry,
      baselineVitals,
      baselineSentry,
      firebaseMetrics?.activeUsers || vitalsForAnalysis?.totalUsers || 0
    );

    res.json({
      projectId,
      projectName: project.displayName,
      version: fullVersion,
      versionCode,
      userFraction,
      rolloutStarted: rolloutTrack.androidDate,
      hoursIntoRollout,
      daysIntoRollout,

      // Firebase metrics for this version
      firebase: firebaseMetrics ? {
        activeUsers: firebaseMetrics.activeUsers,
        newUsers: firebaseMetrics.newUsers,
        sessions: firebaseMetrics.sessions,
        sessionsPerUser: firebaseMetrics.sessionsPerUser
      } : null,

      current: {
        sentry: currentSentry,
        vitals: {
          hourly: currentVitals.hourly || [],
          rolling24h: currentVitals.summary || {},
          // Fallback to daily if hourly not available
          daily: dailyVitals,
          // Include debug info about what was queried
          queryInfo: {
            versionCode,
            queryStart: currentVitals.queryStart,
            queryEnd: currentVitals.queryEnd,
            error: currentVitals.error
          }
        }
      },

      previousReleases,

      baseline: {
        vitals: baselineVitals,
        sentry: baselineSentry
      },

      analysis
    });

  } catch (error) {
    log.error('server', 'Rollout details request failed', { error: error.message, stack: error.stack });
    res.status(500).json({ error: error.message });
  }
});

/**
 * Calculate health analysis scores
 */
function calculateHealthAnalysis(currentVitals, currentSentry, baselineVitals, baselineSentry, distinctUsers) {
  const result = {
    status: 'healthy',
    recommendation: 'Safe to expand rollout',
    scores: {
      vitals: { score: 100, status: 'healthy' },
      sentry: { score: 100, status: 'healthy' }
    },
    reasons: []
  };

  // Check for insufficient data
  if (distinctUsers < 100) {
    result.status = 'insufficient_data';
    result.recommendation = 'Need more users for reliable analysis (~100+ required)';
    result.reasons.push(`Only ${distinctUsers} users - need 100+ for reliable data`);
    return result;
  }

  // Calculate vitals score
  let vitalsDeductions = 0;
  const currentCrash = currentVitals?.crashRate ?? null;
  const currentAnr = currentVitals?.anrRate ?? null;
  const baselineCrash = baselineVitals?.crashRate || 0;
  const baselineAnr = baselineVitals?.anrRate || 0;

  if (currentCrash !== null && typeof currentCrash === 'number' && baselineCrash > 0) {
    const crashDelta = ((currentCrash - baselineCrash) / baselineCrash) * 100;
    if (crashDelta > 50) {
      vitalsDeductions += 50;
      result.reasons.push(`Crash rate ${currentCrash.toFixed(2)}% is +${crashDelta.toFixed(0)}% vs baseline (${baselineCrash.toFixed(2)}%)`);
    } else if (crashDelta > 25) {
      vitalsDeductions += 25;
      result.reasons.push(`Crash rate ${currentCrash.toFixed(2)}% is elevated (+${crashDelta.toFixed(0)}% vs baseline ${baselineCrash.toFixed(2)}%)`);
    } else if (crashDelta > 10) {
      vitalsDeductions += 10;
      result.reasons.push(`Crash rate ${currentCrash.toFixed(2)}% slightly above baseline (${baselineCrash.toFixed(2)}%)`);
    } else {
      result.reasons.push(`Crash rate ${currentCrash.toFixed(2)}% within normal range (baseline ${baselineCrash.toFixed(2)}%)`);
    }
  } else if (currentCrash !== null && typeof currentCrash === 'number') {
    result.reasons.push(`Crash rate ${currentCrash.toFixed(2)}% (no baseline for comparison)`);
  }

  if (currentAnr !== null && typeof currentAnr === 'number' && baselineAnr > 0) {
    const anrDelta = ((currentAnr - baselineAnr) / baselineAnr) * 100;
    if (anrDelta > 50) {
      vitalsDeductions += 50;
      result.reasons.push(`ANR rate ${currentAnr.toFixed(2)}% is +${anrDelta.toFixed(0)}% vs baseline`);
    } else if (anrDelta > 25) {
      vitalsDeductions += 25;
      result.reasons.push(`ANR rate ${currentAnr.toFixed(2)}% is elevated (+${anrDelta.toFixed(0)}% vs baseline)`);
    } else if (anrDelta > 10) {
      vitalsDeductions += 10;
    }
  }

  // Check Google's bad behavior threshold
  if (typeof currentCrash === 'number' && currentCrash > 1.09) {
    vitalsDeductions = Math.max(vitalsDeductions, 25);
    result.reasons.push(`Crash rate ${currentCrash.toFixed(2)}% exceeds Google threshold (1.09%)`);
  }

  result.scores.vitals.score = Math.max(0, 100 - vitalsDeductions);
  result.scores.vitals.status = result.scores.vitals.score >= 80 ? 'healthy' :
                                 result.scores.vitals.score >= 50 ? 'warning' : 'critical';

  // Calculate sentry score
  let sentryDeductions = 0;
  const currentIssues = currentSentry?.totalCount || 0;
  const baselineIssues = baselineSentry?.totalCount || 0;
  const criticalCount = currentSentry?.criticalCount || 0;

  if (baselineIssues > 0) {
    const issueDelta = ((currentIssues - baselineIssues) / baselineIssues) * 100;
    if (issueDelta > 100) {
      sentryDeductions += 40;
      result.reasons.push(`Sentry: ${currentIssues} issues vs avg ${baselineIssues.toFixed(1)} at same stage (+${issueDelta.toFixed(0)}%)`);
    } else if (issueDelta > 50) {
      sentryDeductions += 25;
      result.reasons.push(`Sentry: ${currentIssues} issues vs avg ${baselineIssues.toFixed(1)} (+${issueDelta.toFixed(0)}%)`);
    } else if (issueDelta > 25) {
      sentryDeductions += 10;
    }
  } else {
    result.reasons.push(`Sentry: ${currentIssues} issues (no baseline for comparison)`);
  }

  // Deduct for critical issues
  if (criticalCount > 0) {
    sentryDeductions += criticalCount * 15;
    result.reasons.push(`${criticalCount} critical issue${criticalCount > 1 ? 's' : ''} detected`);
  }

  result.scores.sentry.score = Math.max(0, 100 - sentryDeductions);
  result.scores.sentry.status = result.scores.sentry.score >= 80 ? 'healthy' :
                                 result.scores.sentry.score >= 50 ? 'warning' : 'critical';

  // Overall status is the worse of the two
  if (result.scores.vitals.status === 'critical' || result.scores.sentry.status === 'critical') {
    result.status = 'critical';
    result.recommendation = 'Consider halting rollout - significant regression detected';
  } else if (result.scores.vitals.status === 'warning' || result.scores.sentry.status === 'warning') {
    result.status = 'warning';
    result.recommendation = 'Monitor closely - address issues before expanding';
  } else {
    result.status = 'healthy';
    result.recommendation = 'Safe to expand rollout';
  }

  // Add user count context
  result.reasons.push(`${distinctUsers.toLocaleString()} users provides ${distinctUsers > 10000 ? 'high' : distinctUsers > 1000 ? 'medium' : 'low'} confidence`);

  return result;
}

module.exports = router;
