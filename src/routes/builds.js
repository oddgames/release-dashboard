const express = require('express');
const router = express.Router();
const config = require('../config');
const jenkinsApi = require('../jenkins-api');
const plasticApi = require('../plastic-api');
const log = require('../logger');
const { buildCache } = require('../services/cache');
const { refreshBuilds } = require('../services/data-refresh');

// Get all builds
router.get('/builds', async (req, res) => {
  try {
    res.json(buildCache);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get tracks configuration
router.get('/tracks', (req, res) => {
  const tracks = config.tracks || [
    { id: 'dev', displayName: 'Dev', source: 'jenkins', buildType: 'Debug', order: 1 },
    { id: 'release', displayName: 'Release', source: 'jenkins', buildType: 'Release', order: 2 },
    { id: 'storeInternal', displayName: 'Internal', source: 'store', iosSource: 'testflight', androidSource: 'internal', order: 3 },
    { id: 'storeAlpha', displayName: 'Alpha', source: 'store', iosSource: 'pending', androidSource: 'alpha', order: 4 },
    { id: 'storeRelease', displayName: 'Release', source: 'store', iosSource: 'live', androidSource: 'production', order: 5 }
  ];
  res.json({ tracks });
});

// Force refresh - use ?full=true for full 30-day refresh, otherwise incremental
router.post('/refresh', async (req, res) => {
  try {
    const fullRefresh = req.query.full === 'true';
    await refreshBuilds(fullRefresh);
    res.json(buildCache);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Trigger builds for out-of-date platforms
router.post('/trigger-build', async (req, res) => {
  const { projectId, branch, platforms, currentChangeset, buildType } = req.body;

  log.info('server', 'Trigger build request', { projectId, branch, platforms, buildType });

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
        // Trigger build with branch and build type parameters
        const buildParams = {
          BRANCH: branch || 'main',
          BUILD_TYPE: buildType || 'Debug'
        };

        await jenkinsApi.triggerBuild(job.jenkinsJob, buildParams);
        results.push({ platform, job: job.jenkinsJob, buildType, success: true });
        log.info('server', `Build triggered: ${job.jenkinsJob}`, { branch, buildType });
      } catch (error) {
        results.push({ platform, job: job.jenkinsJob, success: false, error: error.message });
        log.error('server', `Failed to trigger: ${job.jenkinsJob}`, { error: error.message });
      }
    }

    res.json({ success: true, results });
  } catch (error) {
    log.error('server', 'Trigger build failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Get build history for a project/branch/buildType
router.post('/build-history', async (req, res) => {
  const { projectId, branch, buildType } = req.body;

  log.info('server', 'Build history request', { projectId, branch, buildType });

  try {
    // Find jobs for this project
    const projectJobs = config.jobs.filter(job =>
      job.displayName.toLowerCase().replace(/\s+/g, '-') === projectId
    );

    if (projectJobs.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Fetch builds from both iOS and Android jobs in parallel (LIGHTWEIGHT query)
    const buildPromises = projectJobs.map(async job => {
      try {
        const builds = await jenkinsApi.getBuildHistory(job.jenkinsJob, 20);

        log.debug('server', `Fetched ${builds.length} builds from ${job.jenkinsJob}`);

        // Log first few builds to debug filtering
        if (builds.length > 0) {
          log.debug('server', `Sample builds from ${job.jenkinsJob}:`, {
            sample: builds.slice(0, 3).map(b => ({
              version: b.version,
              branch: b.branch,
              buildType: b.buildType,
              result: b.result
            }))
          });
        }

        // Filter by branch and buildType
        const filteredBuilds = builds.filter(b =>
          b.branch === branch && b.buildType === buildType
        );

        log.debug('server', `After filtering ${job.jenkinsJob}: ${filteredBuilds.length} builds match (branch=${branch}, buildType=${buildType})`);

        // Tag each build with platform and job name
        for (const build of filteredBuilds) {
          build.platform = job.platform;
          build.jenkinsJob = job.jenkinsJob;
        }
        return filteredBuilds;
      } catch (error) {
        log.error('server', `Failed to fetch builds: ${job.jenkinsJob}`, { error: error.message });
        return [];
      }
    });

    const buildArrays = await Promise.all(buildPromises);
    const allBuilds = buildArrays.flat();

    // Group builds by version and track which platforms have successful builds
    const buildMap = new Map();
    for (const build of allBuilds) {
      const version = build.version;
      if (!version) continue;

      if (!buildMap.has(version)) {
        buildMap.set(version, {
          version,
          date: build.timestamp,
          commitMessage: '',  // We'll get this from Plastic
          iosJob: null,
          iosBuildNumber: null,
          iosResult: null,
          androidJob: null,
          androidBuildNumber: null,
          androidResult: null
        });
      }

      const merged = buildMap.get(version);

      // Update with newer timestamp
      if (build.timestamp > merged.date) {
        merged.date = build.timestamp;
      }

      // Track job + build number for each platform (for lazy download fetching)
      if (build.platform === 'ios') {
        merged.iosJob = build.jenkinsJob;
        merged.iosBuildNumber = build.number;
        merged.iosResult = build.result;
      } else if (build.platform === 'android') {
        merged.androidJob = build.jenkinsJob;
        merged.androidBuildNumber = build.number;
        merged.androidResult = build.result;
      }
    }

    // Convert to array and sort by date (newest first), limit to 15
    const builds = Array.from(buildMap.values())
      .sort((a, b) => b.date - a.date)
      .slice(0, 15);

    log.info('server', `Returning ${builds.length} builds for ${projectId}/${branch}/${buildType}`);
    res.json({ builds });
  } catch (error) {
    log.error('server', 'Build history failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Get download URL for a specific build (lazy-loaded)
router.post('/build-download', async (req, res) => {
  const { jobName, buildNumber } = req.body;

  log.info('server', 'Build download request', { jobName, buildNumber });

  try {
    const downloadInfo = await jenkinsApi.getBuildDownloadUrl(jobName, buildNumber);

    if (!downloadInfo) {
      return res.status(404).json({ error: 'Download link not found' });
    }

    res.json(downloadInfo);
  } catch (error) {
    log.error('server', 'Build download failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint to inspect a build's actions
router.get('/debug/build-actions/:jobName/:buildNumber', async (req, res) => {
  const { jobName, buildNumber } = req.params;

  try {
    const endpoint = `/job/${jobName}/${buildNumber}/api/json?tree=actions[id,text,urlName,iconFileName,parameters[name,value]]`;
    const data = await jenkinsApi.jenkinsRequest(endpoint);
    res.json(data.actions || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List Jenkins credentials (IDs and metadata only, no secrets)
router.get('/credentials', async (req, res) => {
  try {
    const credentials = await jenkinsApi.getCredentials();
    res.json({ credentials });
  } catch (error) {
    log.error('server', 'Failed to fetch credentials', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Get Plastic SCM query cache stats
router.get('/plastic-cache/stats', (req, res) => {
  const stats = plasticApi.getCacheStats();
  log.debug('server', 'Plastic cache stats requested', stats);
  res.json(stats);
});

// Clear Plastic SCM query cache
router.post('/plastic-cache/clear', (req, res) => {
  plasticApi.clearCache();
  log.info('server', 'Plastic cache cleared by user');
  res.json({ success: true, message: 'Plastic SCM cache cleared' });
});

module.exports = router;
