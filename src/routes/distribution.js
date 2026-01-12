/**
 * Distribution and store-related API routes
 */

const express = require('express');
const router = express.Router();
const config = require('../config');
const jenkinsApi = require('../jenkins-api');
const storeApi = require('../store-api');
const log = require('../logger');
const { buildCache, storeStatusCache, storeVersionsCache } = require('../services/cache');
const { translateReleaseNotes } = require('../services/ai');
const discord = require('../services/discord');

// Validate Jenkins credentials
router.post('/auth/jenkins', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ valid: false, error: 'Username and password required' });
  }

  try {
    const result = await jenkinsApi.validateCredentials(username, password);
    res.json(result);
  } catch (error) {
    log.error('server', 'Jenkins auth validation error', { error: error.message });
    res.status(500).json({ valid: false, error: error.message });
  }
});

// Trigger distribution to stores (TestFlight/Play Store)
router.post('/distribute', async (req, res) => {
  const { projectId, branch, platforms, track, releaseNotes } = req.body;

  log.info('server', 'Distribute request', { projectId, branch, platforms, track, hasReleaseNotes: !!releaseNotes });

  try {
    // Find jobs for this project
    const projectJobs = config.jobs.filter(job =>
      job.displayName.toLowerCase().replace(/\s+/g, '-') === projectId
    );

    if (projectJobs.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const results = [];

    for (const platform of platforms || ['ios', 'android']) {
      const job = projectJobs.find(j => j.platform === platform);
      if (!job) continue;

      try {
        // Trigger distribution build with DISTRIBUTE parameter
        const buildParams = {
          BRANCH: branch || 'main',
          BUILD_TYPE: track === 'alpha' ? 'Alpha' : 'Release',
          DISTRIBUTE: 'true',
          STORE_TRACK: track
        };

        // Add release notes if provided (JSON encoded for Jenkins)
        if (releaseNotes) {
          buildParams.RELEASE_NOTES = JSON.stringify(releaseNotes);
        }

        await jenkinsApi.triggerBuild(job.jenkinsJob, buildParams);
        results.push({ platform, job: job.jenkinsJob, track, success: true });
        log.info('server', `Distribution triggered: ${job.jenkinsJob}`, { branch, track });
      } catch (error) {
        results.push({ platform, job: job.jenkinsJob, success: false, error: error.message });
        log.error('server', `Failed to distribute: ${job.jenkinsJob}`, { error: error.message });
      }
    }

    res.json({ success: true, results });
  } catch (error) {
    log.error('server', 'Distribution failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Promote existing build from internal to alpha (no rebuild required)
// Requires Jenkins authentication
// releaseNotes should be English only - translations are done automatically
router.post('/promote', async (req, res) => {
  const { projectId, platforms, fromTrack, toTrack, releaseNotes, auth } = req.body;

  // Validate Jenkins credentials first
  if (!auth || !auth.username || !auth.password) {
    return res.status(401).json({ error: 'Jenkins authentication required', requiresAuth: true });
  }

  const authResult = await jenkinsApi.validateCredentials(auth.username, auth.password);
  if (!authResult.valid) {
    return res.status(401).json({ error: 'Invalid Jenkins credentials', requiresAuth: true });
  }

  log.info('server', 'Promote request', { projectId, platforms, fromTrack, toTrack, user: authResult.fullName });

  try {
    // Find jobs for this project
    const projectJobs = config.jobs.filter(job =>
      job.displayName.toLowerCase().replace(/\s+/g, '-') === projectId
    );

    if (projectJobs.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Get project config for languages
    const projectName = projectJobs[0].displayName;
    const projectConfig = config.projects?.[projectName] || { languages: ['en'] };

    // Auto-translate release notes if provided (accepts English string only)
    let translatedNotes = null;
    if (releaseNotes) {
      // If releaseNotes is already an object (legacy), use as-is; otherwise translate
      if (typeof releaseNotes === 'string') {
        log.info('server', 'Auto-translating release notes', { languages: projectConfig.languages });
        translatedNotes = await translateReleaseNotes(releaseNotes, projectConfig.languages);
      } else {
        // Already translated object - use as-is for backwards compatibility
        translatedNotes = releaseNotes;
      }
    }

    const results = [];

    for (const platform of platforms || ['ios', 'android']) {
      const job = projectJobs.find(j => j.platform === platform);
      if (!job) continue;

      try {
        if (platform === 'android') {
          // Map track names to Google Play track names
          const googleFromTrack = fromTrack === 'storeInternal' ? 'internal' : fromTrack;
          const googleToTrack = toTrack === 'storeAlpha' ? 'alpha' : toTrack;

          const result = await storeApi.promoteAndroidBuild(
            job.bundleId,
            googleFromTrack,
            googleToTrack,
            translatedNotes
          );
          results.push({ platform, ...result });
        } else if (platform === 'ios') {
          // For iOS, we need to get the latest TestFlight build and add it to the alpha beta group
          const iosInfo = await storeApi.getIOSAppInfo(job.bundleId);

          if (!iosInfo || iosInfo.error) {
            throw new Error(iosInfo?.error || 'Failed to get iOS app info');
          }

          // Get the build ID from the latest TestFlight build
          const buildId = iosInfo.testflight?.buildId;
          if (!buildId) {
            throw new Error('No TestFlight build found to promote');
          }

          // Find the alpha beta group name from config or use default
          const alphaBetaGroup = job.alphaBetaGroup || 'Alpha';

          const result = await storeApi.promoteIOSBuild(
            job.bundleId,
            buildId,
            alphaBetaGroup
          );
          results.push({ platform, ...result });
        }

        log.info('server', `Promotion completed: ${platform}`, { fromTrack, toTrack });
      } catch (error) {
        results.push({ platform, success: false, error: error.message });
        log.error('server', `Failed to promote: ${platform}`, { error: error.message });
      }
    }

    res.json({ success: true, results });
  } catch (error) {
    log.error('server', 'Promotion failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Update store status (called by Fastlane via webhook)
router.post('/store-status', async (req, res) => {
  const { jobName, branch, store, status, track, reviewStatus, downloadUrl, projectId, changeset } = req.body;

  const key = `${jobName}:${branch}`;
  storeStatusCache[key] = {
    ...storeStatusCache[key],
    [store]: { status, track, reviewStatus, downloadUrl, updatedAt: new Date().toISOString() }
  };

  // Auto-update Discord if configured and we have project/changeset info
  if (config.discord?.enabled && config.discord?.webhookUrl && projectId && changeset) {
    try {
      // Map store track to Discord status
      const discordStatus = track === 'alpha' ? 'alpha' :
                           track === 'internal' ? 'internal' :
                           track === 'production' ? 'released' : track;

      await discord.updateReleaseStatus(config.discord, projectId, branch, changeset, discordStatus);
      log.info('discord', 'Auto-updated Discord status from store webhook', { projectId, changeset, status: discordStatus });
    } catch (error) {
      log.warn('discord', 'Failed to auto-update Discord', { error: error.message });
    }
  }

  res.json({ success: true });
});

// Get store versions from App Store Connect and Google Play
router.get('/store-versions', async (req, res) => {
  const forceRefresh = req.query.refresh === 'true';

  try {
    // Return cached data if fresh (< 5 min old) and not forcing refresh
    const cacheAge = storeVersionsCache.lastUpdated
      ? Date.now() - new Date(storeVersionsCache.lastUpdated).getTime()
      : Infinity;

    if (!forceRefresh && storeVersionsCache.data && cacheAge < 5 * 60 * 1000) {
      log.debug('server', 'Returning cached store versions');
      return res.json(storeVersionsCache.data);
    }

    log.info('server', 'Fetching store versions');

    // Fetch versions from both stores
    const storeVersions = await storeApi.getAllStoreVersions();

    // Match to changesets from build cache
    const result = storeApi.matchVersionsToChangesets(storeVersions, buildCache);

    // Update cache
    storeVersionsCache.lastUpdated = new Date().toISOString();
    storeVersionsCache.data = result;

    res.json(result);
  } catch (error) {
    log.error('server', 'Failed to fetch store versions', { error: error.message });

    // Return cached data if available, even if stale
    if (storeVersionsCache.data) {
      return res.json({
        ...storeVersionsCache.data,
        stale: true,
        error: error.message
      });
    }

    res.status(500).json({ error: error.message });
  }
});

// Get store version for a specific app
router.get('/store-versions/:platform/:bundleId', async (req, res) => {
  const { platform, bundleId } = req.params;

  try {
    let result;
    if (platform === 'ios') {
      result = await storeApi.getIOSAppInfo(bundleId);
    } else if (platform === 'android') {
      result = await storeApi.getAndroidAppInfo(bundleId);
    } else {
      return res.status(400).json({ error: 'Invalid platform. Use ios or android.' });
    }

    res.json(result);
  } catch (error) {
    log.error('server', 'Failed to fetch store version', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
