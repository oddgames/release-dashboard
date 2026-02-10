const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const config = require('../config');
const log = require('../logger');
const jenkinsApi = require('../jenkins-api');
const plasticApi = require('../plastic-api');
const storeApi = require('../store-api');
const sentryApi = require('../sentry-api');
const vitalsApi = require('../vitals-api');
const firebaseApi = require('../firebase-api');
const cache = require('./cache');

// Prevent overlapping refreshes
let isRefreshing = false;

// Check if cached data is in an invalid state (e.g., empty branches, builds with null versions)
function isCacheInvalid() {
  if (!cache.buildCache.projects || cache.buildCache.projects.length === 0) {
    return false; // No cache yet, not invalid
  }

  // Check if any project has empty branches (invalid state - should have been populated)
  for (const project of cache.buildCache.projects) {
    if (!project.branches || project.branches.length === 0) {
      log.warn('server', `Invalid cache detected: ${project.id} has empty branches`);
      return true;
    }

    for (const branch of project.branches) {
      // Check if any successful build has null version (invalid state)
      for (const key of ['ios', 'android', 'iosRelease', 'androidRelease']) {
        const build = branch[key];
        if (build && build.result === 'SUCCESS' && build.version === null) {
          log.warn('server', `Invalid cache detected: ${project.id}/${branch.branch}/${key} has SUCCESS but null version`);
          return true;
        }
      }
    }
  }
  return false;
}

// Fetch and cache app icons from App Store (parallel)
async function fetchAppIcons() {
  const iconsDir = path.join(__dirname, '../../public/icons/games');

  // Ensure directory exists
  if (!fs.existsSync(iconsDir)) {
    fs.mkdirSync(iconsDir, { recursive: true });
  }

  // Get unique bundle IDs
  const bundleIds = [...new Set(config.jobs.map(j => j.bundleId))];

  // Fetch all icons in parallel
  await Promise.all(bundleIds.map(async (bundleId) => {
    const iconPath = path.join(iconsDir, `${bundleId}.png`);

    // Skip if already cached
    if (fs.existsSync(iconPath) && fs.statSync(iconPath).size > 1000) {
      log.debug('server', `Icon cached: ${bundleId}`);
      return;
    }

    try {
      // Fetch from iTunes API
      const lookupUrl = `https://itunes.apple.com/lookup?bundleId=${bundleId}`;
      log.info('server', `Fetching icon: ${bundleId}`);

      const response = await fetch(lookupUrl);
      const data = await response.json();

      if (data.results && data.results.length > 0) {
        const iconUrl = data.results[0].artworkUrl512 || data.results[0].artworkUrl100;
        if (iconUrl) {
          const iconResponse = await fetch(iconUrl);
          const buffer = await iconResponse.buffer();
          fs.writeFileSync(iconPath, buffer);
          log.info('server', `Icon saved: ${bundleId}`);
        }
      } else {
        log.warn('server', `No icon found for: ${bundleId}`);
      }
    } catch (error) {
      log.error('server', `Failed to fetch icon: ${bundleId}`, { error: error.message });
    }
  }));
}

// Main refresh orchestration
async function refreshBuilds(fullRefresh = false) {
  // Skip if already refreshing
  if (isRefreshing) {
    log.debug('server', 'Refresh already in progress, skipping');
    return;
  }

  isRefreshing = true;
  const startTime = Date.now();
  const cachedJobBuildNumbers = cache.buildCache._meta?.jobBuildNumbers || {};
  const hasCache = Object.keys(cachedJobBuildNumbers).length > 0;

  try {
    const projectMap = new Map();

    // Group jobs by display name (project)
    for (const job of config.jobs) {
      if (!projectMap.has(job.displayName)) {
        projectMap.set(job.displayName, {
          id: job.displayName.toLowerCase().replace(/\s+/g, '-'),
          displayName: job.displayName,
          bundleId: job.bundleId,
          iconUrl: `/icons/games/${job.bundleId}.png`,
          jobs: []
        });
      }
      projectMap.get(job.displayName).jobs.push(job);
    }

    const allJobs = config.jobs.map(j => j.jenkinsJob);

    // For non-full refresh with cache, first check if any jobs have new builds
    // Also force full refresh if cache is in invalid state (e.g., null versions)
    let needsFullFetch = fullRefresh || !hasCache;
    let cacheWasInvalid = false;

    if (!needsFullFetch && isCacheInvalid()) {
      log.info('server', 'Cache invalid, forcing full refresh');
      needsFullFetch = true;
      cacheWasInvalid = true;
    }

    let currentBuildNumbers = {};

    if (!needsFullFetch) {
      log.info('server', 'Checking for new builds (lightweight)...');
      cache.broadcastSSE('refresh-status', { status: 'Checking for new builds...' });
      currentBuildNumbers = await jenkinsApi.getLastBuildNumbers(allJobs);

      // Check if any job has new builds
      for (const jobName of allJobs) {
        const current = currentBuildNumbers[jobName];
        const cached = cachedJobBuildNumbers[jobName];
        if (current && (!cached || current > cached)) {
          needsFullFetch = true;
          log.info('server', `New builds detected: ${jobName} (${cached || 'none'} -> ${current})`);
          break;
        }
      }

      if (!needsFullFetch) {
        log.info('server', `No new builds, checking in-progress builds...`);

        // Find all in-progress builds in the cache and refresh their status
        const inProgressBuilds = [];
        if (cache.buildCache.projects) {
          for (const project of cache.buildCache.projects) {
            for (const branch of project.branches || []) {
              // Check each build type for in-progress builds
              const buildKeys = ['ios', 'android', 'iosRelease', 'androidRelease', 'iosAlpha', 'androidAlpha'];
              for (const key of buildKeys) {
                const build = branch[key];
                if (build && build.result === null && build.jobName) {
                  const platform = key.startsWith('ios') ? 'ios' : 'android';
                  inProgressBuilds.push({ jobName: build.jobName, number: build.number, platform, buildKey: key, branch: branch.branch, project });
                }
              }
            }
          }
        }

        // Fetch queue and in-progress build statuses in parallel
        const [queuedBuilds, updatedStatuses] = await Promise.all([
          jenkinsApi.getQueuedBuilds(),
          inProgressBuilds.length > 0
            ? jenkinsApi.getBuildStatuses(inProgressBuilds.map(b => ({ jobName: b.jobName, number: b.number })))
            : Promise.resolve([])
        ]);

        // Update in-progress builds with their new status
        let statusChanges = 0;
        for (const updated of updatedStatuses) {
          if (updated.result !== null) {
            // Build completed! Update in cache
            const cached = inProgressBuilds.find(b => b.jobName === updated.jobName && b.number === updated.number);
            if (cached) {
              const branch = cached.project.branches?.find(b => b.branch === cached.branch);
              const build = branch?.[cached.buildKey];
              if (build && build.number === updated.number) {
                build.result = updated.result;
                build.duration = updated.duration;
                statusChanges++;
                log.info('server', `Build ${updated.jobName}#${updated.number} completed: ${updated.result}`);
              }
            }
          }
        }

        if (statusChanges > 0) {
          log.info('server', `${statusChanges} in-progress builds completed`);
        } else if (inProgressBuilds.length > 0) {
          log.debug('server', `${inProgressBuilds.length} builds still in progress`);
        }

        // Update queued status in existing cache
        if (cache.buildCache.projects) {
          for (const project of cache.buildCache.projects) {
            for (const branch of project.branches || []) {
              if (branch.tracks) {
                const projectJobs = config.jobs.filter(j =>
                  j.displayName.toLowerCase().replace(/\s+/g, '-') === project.id
                );
                branch.tracks = buildBranchTrackStatus(branch, {}, projectJobs, queuedBuilds);
              }
            }
          }
          cache.buildCache.lastUpdated = new Date().toISOString();
          cache.saveCacheToDisk();
          // Don't broadcast 'refresh' yet - keep showing existing data while fetching store/plastic

          // Fetch store/plastic data in parallel even when no new Jenkins builds
          cache.broadcastSSE('refresh-status', { status: 'Fetching store & Plastic data...' });
          const [storeData, plasticData] = await Promise.all([
            fetchStoreData().catch(e => { log.warn('server', 'Store fetch failed', { error: e.message }); return { ios: {}, android: {} }; }),
            fetchPlasticData().catch(e => { log.warn('server', 'Plastic fetch failed', { error: e.message }); return {}; })
          ]);

          // Apply the data
          applyPlasticData(cache.buildCache.projects, plasticData);
          await applyStoreDataAndFetchDependents(cache.buildCache.projects, storeData);

          cache.saveCacheToDisk();
          // Now broadcast refresh - all data is complete
          cache.broadcastSSE('refresh', { timestamp: Date.now() });
          cache.broadcastSSE('refresh-status', { status: null }); // Clear status
        }
        log.info('server', `Incremental refresh complete in ${Date.now() - startTime}ms`);
        return;
      }
    }

    // isIncremental only if we have cache AND it wasn't invalid
    const isIncremental = !fullRefresh && hasCache && !cacheWasInvalid;
    log.info('server', fullRefresh ? 'Starting FULL refresh' : (cacheWasInvalid ? 'Starting FULL refresh (cache invalid)' : (isIncremental ? 'Starting INCREMENTAL refresh' : 'Starting INITIAL refresh')));

    // Notify frontend that refresh is starting
    cache.broadcastSSE('refresh-status', { status: 'Fetching Jenkins builds...' });

    // Fetch queued builds and job builds in PARALLEL
    // For incremental refresh, only fetch builds newer than what we have cached
    const [queuedBuilds, ...jobBuilds] = await Promise.all([
      jenkinsApi.getQueuedBuilds(),
      ...allJobs.map(jobName => {
        const sinceNumber = isIncremental ? cachedJobBuildNumbers[jobName] : null;
        return jenkinsApi.getRecentBuilds(jobName, config.branchHistoryDays || 30, sinceNumber);
      })
    ]);

    // Map builds back to jobs and update job build numbers for next incremental fetch
    const buildsByJob = {};
    const newJobBuildNumbers = { ...cachedJobBuildNumbers };

    allJobs.forEach((jobName, i) => {
      const builds = jobBuilds[i] || [];
      buildsByJob[jobName] = builds;

      // Update highest build number for this job
      if (builds.length > 0) {
        const highestNew = Math.max(...builds.map(b => b.number));
        newJobBuildNumbers[jobName] = Math.max(highestNew, newJobBuildNumbers[jobName] || 0);
      }
    });

    const projects = [];

    for (const [displayName, project] of projectMap) {
      try {
        // Get builds for each platform from the parallel fetch
        const builds = {};
        for (const job of project.jobs) {
          builds[job.platform] = buildsByJob[job.jenkinsJob] || [];
        }

        // Get builds grouped by branch
        const branches = getBranchBuilds(builds, project.jobs);

        // Sort branches (main first, then by timestamp)
        branches.sort((a, b) => {
          if (a.branch === 'main') return -1;
          if (b.branch === 'main') return 1;
          return (b.timestamp || 0) - (a.timestamp || 0);
        });

        // Build track status (no Plastic fetch - do that in background)
        const projectConfig = config.projects?.[displayName];
        for (const branchData of branches) {
          const storeKey = `${project.jobs[0].name}:${branchData.branch}`;
          const storeStatus = cache.storeStatusCache[storeKey] || {};
          branchData.tracks = buildBranchTrackStatus(branchData, storeStatus, project.jobs, queuedBuilds);
        }

        projects.push({
          id: project.id,
          displayName: project.displayName,
          iconUrl: project.iconUrl,
          firebasePropertyId: projectConfig?.firebasePropertyId,
          branches
        });
      } catch (error) {
        log.error('server', `Error fetching ${displayName}`, { error: error.message });
        const errProjectConfig = config.projects?.[project.displayName];
        // Preserve cached branches if available, so a transient API error doesn't wipe data
        const cachedProject = cache.buildCache.projects?.find(p => p.id === project.id);
        projects.push({
          id: project.id,
          displayName: project.displayName,
          iconUrl: project.iconUrl,
          firebasePropertyId: errProjectConfig?.firebasePropertyId,
          branches: cachedProject?.branches || [],
          error: error.message
        });
      }
    }

    // Update cache properties directly to maintain reference
    cache.buildCache.lastUpdated = new Date().toISOString();
    cache.buildCache._meta = {
      jobBuildNumbers: newJobBuildNumbers,
      lastFullRefresh: fullRefresh ? new Date().toISOString() : (cache.buildCache._meta?.lastFullRefresh || new Date().toISOString())
    };
    cache.buildCache.projects = projects;

    const refreshTypeLog = fullRefresh ? 'FULL' : (isIncremental ? 'INCREMENTAL' : 'INITIAL');
    log.info('server', `${refreshTypeLog} Jenkins refresh complete in ${Date.now() - startTime}ms`);

    // Persist cache to disk (but don't broadcast yet - wait for all data)
    cache.saveCacheToDisk();

    // Notify frontend about what's being fetched (for loading indicators)
    // NOTE: Vitals and Sentry removed from main refresh - now fetched on-demand via rollout-details modal
    cache.broadcastSSE('fetch-started', { sources: ['store', 'plastic', 'analytics'] });

    // START ALL FETCHES IN PARALLEL - don't wait for dependencies
    const storePromise = fetchStoreData().catch(e => { log.warn('server', 'Store fetch failed', { error: e.message }); return { ios: {}, android: {} }; });
    const plasticPromise = fetchPlasticData().catch(e => { log.warn('server', 'Plastic fetch failed', { error: e.message }); return {}; });
    const pipelinePromise = fetchPipelineStagesInBackground(projects, buildsByJob);
    // DISABLED: Vitals and Sentry now fetched on-demand via /api/rollout-details/:projectId
    // const vitalsPromise = vitalsApi.getAllVitals().catch(e => { log.warn('server', 'Vitals API failed', { error: e.message }); return { ios: {}, android: {} }; });
    // const sentryPromise = fetchSentryDataRaw().catch(e => { log.warn('server', 'Sentry fetch failed', { error: e.message }); return {}; });
    const analyticsPromise = fetchAnalyticsDataRaw().catch(e => { log.warn('server', 'Analytics fetch failed', { error: e.message }); return {}; });

    // Apply data as it arrives - UI updates incrementally
    let storeApplied = false;

    // Helper to apply data when ready and broadcast updates
    const applyWhenReady = async (name, promise, applyFn, needsStore = false) => {
      try {
        const data = await promise;
        if (needsStore && !storeApplied) {
          // Wait for store if this data needs it
          const storeData = await storePromise;
          applyStoreData(projects, storeData);
          storeApplied = true;
          cache.broadcastSSE('store-updated', { timestamp: Date.now() });
        }
        await applyFn(data);
        cache.broadcastSSE('data-updated', { source: name, timestamp: Date.now() });
      } catch (e) {
        log.warn('server', `${name} apply failed`, { error: e.message });
      }
    };

    // Apply plastic immediately (no deps)
    await applyWhenReady('plastic', plasticPromise, (data) => applyPlasticData(projects, data));

    // Apply store data (no deps, but vitals/sentry/analytics need it)
    await applyWhenReady('store', storePromise, (data) => {
      applyStoreData(projects, data);
      storeApplied = true;
    });

    // Apply analytics in parallel (needs store data which is now applied)
    // DISABLED: Vitals and Sentry now fetched on-demand via /api/rollout-details/:projectId
    await Promise.all([
      // applyWhenReady('vitals', vitalsPromise, (data) => applyVitalsData(projects, data), true),
      // applyWhenReady('sentry', sentryPromise, (data) => applySentryData(projects, data), true),
      applyWhenReady('analytics', analyticsPromise, (data) => applyAnalyticsData(projects, data), true),
      pipelinePromise
    ]);

    cache.saveCacheToDisk();
    // Send single refresh event now that ALL data is complete
    cache.broadcastSSE('refresh', { timestamp: Date.now() });
    cache.broadcastSSE('refresh-status', { status: null });
    log.info('server', `Full refresh complete in ${Date.now() - startTime}ms`);

  } finally {
    isRefreshing = false;
  }
}

// Fetch Plastic SCM data - returns raw data map
async function fetchPlasticData() {
  const startTime = Date.now();
  const plasticData = {};

  const plasticPromises = [];
  for (const [projectName, projectConfig] of Object.entries(config.projects || {})) {
    if (!projectConfig.plasticRepo) continue;
    plasticPromises.push(
      plasticApi.getRecentChangesets(projectConfig.plasticRepo, 'main', 10)
        .then(commits => { plasticData[projectName] = commits; })
        .catch(e => { log.warn('server', `Plastic fetch failed for ${projectName}`, { error: e.message }); })
    );
  }

  await Promise.all(plasticPromises);
  log.info('server', `Plastic data fetched in ${Date.now() - startTime}ms`);
  return plasticData;
}

// Apply plastic data to projects
function applyPlasticData(projects, plasticData) {
  for (const project of projects) {
    const commits = plasticData[project.displayName];
    if (!commits) continue;

    const mainBranch = project.branches?.find(b => b.branch === 'main');
    if (mainBranch) {
      mainBranch.allCommits = commits;
      mainBranch.plasticChangeset = commits[0]?.version || null;
    }
  }
}

// Fetch store data - returns { ios: {}, android: {} } maps
async function fetchStoreData() {
  const startTime = Date.now();
  const iosBundleIds = [...new Set(config.jobs.filter(j => j.platform === 'ios').map(j => j.bundleId))];
  const androidPackages = [...new Set(config.jobs.filter(j => j.platform === 'android').map(j => j.bundleId))];

  const [iosResults, androidResults] = await Promise.all([
    Promise.all(iosBundleIds.map(id => storeApi.getIOSAppInfo(id).catch(e => ({ bundleId: id, error: e.message })))),
    Promise.all(androidPackages.map(id => storeApi.getAndroidAppInfo(id).catch(e => ({ packageName: id, error: e.message }))))
  ]);

  const iosVersions = {};
  for (const result of iosResults) {
    if (result && !result.error) {
      iosVersions[result.bundleId] = result;
    }
  }

  const androidVersions = {};
  for (const result of androidResults) {
    if (result && !result.error) {
      androidVersions[result.packageName] = result;
    }
  }

  log.info('server', `Store data fetched in ${Date.now() - startTime}ms`);
  return { ios: iosVersions, android: androidVersions };
}

// Apply store data to projects (no dependent fetches - those happen in parallel now)
function applyStoreData(projects, storeData) {
  try {
    const { ios: iosVersions, android: androidVersions } = storeData;

    for (const project of projects) {
      const mainBranch = project.branches?.find(b => b.branch === 'main');
      if (!mainBranch || !mainBranch.tracks) continue;

      const projectJobs = config.jobs.filter(j =>
        j.displayName.toLowerCase().replace(/\s+/g, '-') === project.id
      );

      const iosJob = projectJobs.find(j => j.platform === 'ios');
      const androidJob = projectJobs.find(j => j.platform === 'android');

      // Apply iOS and Android store data (same logic as applyStoreDataAndFetchDependents)
      applyStoreDataToProject(mainBranch, iosJob, androidJob, iosVersions, androidVersions);
    }
    log.info('server', 'Store data applied');
  } catch (e) {
    log.warn('server', 'Store data apply failed', { error: e.message });
  }
}

// Apply vitals data to projects
async function applyVitalsData(projects, vitalsData) {
  if (!vitalsData || (!vitalsData.ios && !vitalsData.android)) {
    log.debug('server', 'No vitals data to apply');
    return;
  }

  const projectsToProcess = [];
  for (const project of projects) {
    const mainBranch = project.branches?.find(b => b.branch === 'main');
    if (!mainBranch?.tracks) continue;

    const projectJobs = config.jobs.filter(j =>
      j.displayName.toLowerCase().replace(/\s+/g, '-') === project.id
    );

    const iosJob = projectJobs.find(j => j.platform === 'ios');
    const androidJob = projectJobs.find(j => j.platform === 'android');

    projectsToProcess.push({ project, mainBranch, iosJob, androidJob });
  }

  // Process all projects in parallel
  await Promise.all(projectsToProcess.map(({ project, mainBranch, iosJob, androidJob }) =>
    processProjectVitals(project, mainBranch, iosJob, androidJob, vitalsData)
  ));

  log.info('server', 'Vitals data applied');
}

// Apply analytics data to projects
async function applyAnalyticsData(projects, analyticsData) {
  if (!analyticsData || Object.keys(analyticsData).length === 0) {
    log.debug('server', 'No analytics data to apply');
    return;
  }

  for (const project of projects) {
    const usersByVersion = analyticsData[project.displayName];
    if (!usersByVersion) continue;

    const mainBranch = project.branches?.find(b => b.branch === 'main');
    if (!mainBranch?.tracks) continue;

    const iosVersions = usersByVersion.ios || [];
    const androidVersions = usersByVersion.android || [];

    // Calculate total DAU
    project.iosDau = iosVersions.reduce((sum, v) => sum + (v.activeUsers || 0), 0);
    project.androidDau = androidVersions.reduce((sum, v) => sum + (v.activeUsers || 0), 0);

    // Build lookup maps
    const iosUserMap = {};
    for (const entry of iosVersions) iosUserMap[entry.version] = entry.activeUsers;

    const androidUserMap = {};
    for (const entry of androidVersions) androidUserMap[entry.version] = entry.activeUsers;

    // Add active users to each store track
    for (const trackName of ['storeInternal', 'storeAlpha', 'storeRollout', 'storeRelease', 'prevRelease']) {
      const track = mainBranch.tracks[trackName];
      if (!track) continue;

      if (track.iosVersionString && iosUserMap[track.iosVersionString]) {
        track.iosActiveUsers = iosUserMap[track.iosVersionString];
      }

      const androidVersion = track.androidVersion;
      if (androidVersion && androidUserMap[androidVersion]) {
        track.androidActiveUsers = androidUserMap[androidVersion];
      }
    }
  }

  log.info('server', 'Analytics data applied');
}

// Helper to apply store data to a single project's tracks
function applyStoreDataToProject(mainBranch, iosJob, androidJob, iosVersions, androidVersions) {
  const iosStateMap = {
    'READY_FOR_SALE': 'Live on App Store',
    'WAITING_FOR_REVIEW': 'Waiting for Review',
    'IN_REVIEW': 'In Review',
    'PENDING_DEVELOPER_RELEASE': 'Pending Developer Release',
    'PREPARE_FOR_SUBMISSION': 'Preparing for Submission',
    'PROCESSING': 'Processing',
    'VALID': 'Ready for TestFlight'
  };

  const androidStatusMap = {
    'completed': 'Rolled out',
    'inProgress': 'Rolling out',
    'halted': 'Halted',
    'draft': 'Draft'
  };

  // iOS store data
  if (iosJob && iosVersions[iosJob.bundleId]) {
    const ios = iosVersions[iosJob.bundleId];

    if (ios.testflight) {
      mainBranch.tracks.storeInternal.ios = 'success';
      mainBranch.tracks.storeInternal.iosVersion = ios.testflight.versionString ? `${ios.testflight.versionString} (${ios.testflight.build})` : ios.testflight.build;
      mainBranch.tracks.storeInternal.iosBuildId = ios.testflight.buildId;
      mainBranch.tracks.storeInternal.iosVersionString = ios.testflight.versionString;
      mainBranch.tracks.storeInternal.iosDate = ios.testflight.uploadedDate;
      mainBranch.tracks.storeInternal.iosStatusReason = ios.testflight.processingState === 'VALID' ? 'TestFlight' : iosStateMap[ios.testflight.processingState] || ios.testflight.processingState;
    }

    if (ios.live) {
      mainBranch.tracks.storeRelease.ios = 'success';
      mainBranch.tracks.storeRelease.iosVersion = ios.live.build ? `${ios.live.version} (${ios.live.build})` : ios.live.version;
      mainBranch.tracks.storeRelease.iosBuildId = ios.live.buildId;
      mainBranch.tracks.storeRelease.iosVersionString = ios.live.version;
      mainBranch.tracks.storeRelease.iosDate = ios.live.createdDate;
      mainBranch.tracks.storeRelease.iosStatusReason = iosStateMap[ios.live.state] || 'App Store';
    }

    if (ios.prevLive) {
      mainBranch.tracks.prevRelease.ios = 'success';
      mainBranch.tracks.prevRelease.iosVersion = ios.prevLive.build ? `${ios.prevLive.version} (${ios.prevLive.build})` : ios.prevLive.version;
      mainBranch.tracks.prevRelease.iosBuildId = ios.prevLive.buildId;
      mainBranch.tracks.prevRelease.iosVersionString = ios.prevLive.version;
      mainBranch.tracks.prevRelease.iosDate = ios.prevLive.createdDate;
      mainBranch.tracks.prevRelease.iosStatusReason = 'Previous Release';
    }

    const alphaBetaGroupName = config.tracks?.find(t => t.id === 'storeAlpha')?.iosBetaGroupName || 'Alpha';
    const alphaBetaGroup = ios.betaGroups?.[alphaBetaGroupName];
    if (alphaBetaGroup) {
      mainBranch.tracks.storeAlpha.ios = 'success';
      mainBranch.tracks.storeAlpha.iosVersion = alphaBetaGroup.versionString || alphaBetaGroup.build;
      mainBranch.tracks.storeAlpha.iosBuildId = alphaBetaGroup.buildId;
      mainBranch.tracks.storeAlpha.iosVersionString = alphaBetaGroup.versionString;
      mainBranch.tracks.storeAlpha.iosDate = alphaBetaGroup.uploadedDate;
      mainBranch.tracks.storeAlpha.iosStatusReason = `TestFlight ${alphaBetaGroupName}`;
    } else if (ios.pending) {
      mainBranch.tracks.storeAlpha.ios = 'review';
      mainBranch.tracks.storeAlpha.iosVersion = ios.pending.build ? `${ios.pending.version} (${ios.pending.build})` : ios.pending.version;
      mainBranch.tracks.storeAlpha.iosBuildId = ios.pending.buildId;
      mainBranch.tracks.storeAlpha.iosVersionString = ios.pending.version;
      mainBranch.tracks.storeAlpha.iosStatusReason = iosStateMap[ios.pending.state] || ios.pending.state;
    }

    if (ios.rollout) {
      const userPercent = Math.round(ios.rollout.userFraction * 100);
      mainBranch.tracks.storeRollout.ios = ios.rollout.state === 'PAUSED' ? 'review' : 'success';
      mainBranch.tracks.storeRollout.iosVersion = ios.rollout.build ? `${ios.rollout.version} (${ios.rollout.build})` : ios.rollout.version;
      mainBranch.tracks.storeRollout.iosBuildId = ios.rollout.buildId;
      mainBranch.tracks.storeRollout.iosVersionString = ios.rollout.version;
      mainBranch.tracks.storeRollout.iosDate = ios.rollout.createdDate;
      mainBranch.tracks.storeRollout.iosUserFraction = ios.rollout.userFraction;
      mainBranch.tracks.storeRollout.iosStatusReason = ios.rollout.state === 'PAUSED' ? `Phased Release Paused (${userPercent}%)` : `Phased Release (${userPercent}%)`;
    } else {
      mainBranch.tracks.storeRollout.ios = 'none';
      mainBranch.tracks.storeRollout.iosVersion = 'N/A';
      mainBranch.tracks.storeRollout.iosStatusReason = 'No phased release';
    }
  }

  // Android store data
  if (androidJob && androidVersions[androidJob.bundleId]) {
    const android = androidVersions[androidJob.bundleId];

    if (android.internal) {
      mainBranch.tracks.storeInternal.android = 'success';
      mainBranch.tracks.storeInternal.androidVersion = android.internal.versionName;
      mainBranch.tracks.storeInternal.androidVersionCode = android.internal.versionCodes?.[0];
      mainBranch.tracks.storeInternal.androidStatusReason = 'Internal Testing';
    }

    if (android.alpha) {
      mainBranch.tracks.storeAlpha.android = 'success';
      mainBranch.tracks.storeAlpha.androidVersion = android.alpha.versionName;
      mainBranch.tracks.storeAlpha.androidVersionCode = android.alpha.versionCodes?.[0];
      mainBranch.tracks.storeAlpha.androidStatusReason = androidStatusMap[android.alpha.status] || 'Closed Testing';
    }

    if (android.rollout) {
      const userPercent = Math.round(android.rollout.userFraction * 100);
      const isHalted = android.rollout.status === 'halted';
      const countries = android.rollout.countryTargeting?.countries;
      const isMexicoOnly = countries && countries.length === 1 && countries[0] === 'MX';
      const regionLabel = isMexicoOnly ? 'Mexico' : 'Global';

      mainBranch.tracks.storeRollout.android = isHalted ? 'failure' : 'success';
      mainBranch.tracks.storeRollout.androidVersion = android.rollout.versionName;
      mainBranch.tracks.storeRollout.androidVersionCode = android.rollout.versionCodes?.[0];
      mainBranch.tracks.storeRollout.androidUserFraction = android.rollout.userFraction;
      mainBranch.tracks.storeRollout.androidCountryTargeting = countries || null;

      if (isHalted) {
        mainBranch.tracks.storeRollout.androidStatusReason = `Halted (was ${userPercent}% ${regionLabel})`;
      } else if (isMexicoOnly) {
        mainBranch.tracks.storeRollout.androidStatusReason = `🇲🇽 Mexico (${userPercent}%)`;
      } else {
        mainBranch.tracks.storeRollout.androidStatusReason = `🌍 ${userPercent}% Global`;
      }
    } else {
      mainBranch.tracks.storeRollout.android = 'none';
      mainBranch.tracks.storeRollout.androidVersion = 'N/A';
      mainBranch.tracks.storeRollout.androidStatusReason = 'No staged rollout';
    }

    if (android.production) {
      mainBranch.tracks.storeRelease.android = 'success';
      mainBranch.tracks.storeRelease.androidVersion = android.production.versionName;
      mainBranch.tracks.storeRelease.androidVersionCode = android.production.versionCodes?.[0];
      mainBranch.tracks.storeRelease.androidStatusReason = androidStatusMap[android.production.status] || 'Play Store';
    }
  }
}

// Apply store data to projects and fetch dependent data (sentry, vitals, analytics) - LEGACY
async function applyStoreDataAndFetchDependents(projects, storeData) {
  try {
    const { ios: iosVersions, android: androidVersions } = storeData;

    // Update each project's main branch with store data
    for (const project of projects) {
      const mainBranch = project.branches?.find(b => b.branch === 'main');
      if (!mainBranch || !mainBranch.tracks) continue;

      // Find bundle IDs for this project
      const projectJobs = config.jobs.filter(j =>
        j.displayName.toLowerCase().replace(/\s+/g, '-') === project.id
      );

      const iosJob = projectJobs.find(j => j.platform === 'ios');
      const androidJob = projectJobs.find(j => j.platform === 'android');

      // iOS store data
      if (iosJob && iosVersions[iosJob.bundleId]) {
        const ios = iosVersions[iosJob.bundleId];

        // Map App Store states to human-readable status reasons
        const iosStateMap = {
          'READY_FOR_SALE': 'Live on App Store',
          'WAITING_FOR_REVIEW': 'Waiting for Review',
          'IN_REVIEW': 'In Review',
          'PENDING_DEVELOPER_RELEASE': 'Pending Developer Release',
          'PREPARE_FOR_SUBMISSION': 'Preparing for Submission',
          'PROCESSING': 'Processing',
          'VALID': 'Ready for TestFlight'
        };

        // TestFlight = storeInternal
        if (ios.testflight) {
          const buildNum = ios.testflight.build;
          const versionStr = ios.testflight.versionString;
          mainBranch.tracks.storeInternal.ios = 'success';
          mainBranch.tracks.storeInternal.iosVersion = versionStr ? `${versionStr} (${buildNum})` : buildNum;
          mainBranch.tracks.storeInternal.iosBuildId = ios.testflight.buildId; // For diagnostics API
          mainBranch.tracks.storeInternal.iosVersionString = versionStr; // For perfPowerMetrics lookup
          mainBranch.tracks.storeInternal.iosDate = ios.testflight.uploadedDate;
          mainBranch.tracks.storeInternal.iosStatusReason = ios.testflight.processingState === 'VALID'
            ? 'TestFlight'
            : iosStateMap[ios.testflight.processingState] || ios.testflight.processingState;
        }

        // Live = storeRelease
        if (ios.live) {
          mainBranch.tracks.storeRelease.ios = 'success';
          // Format: "version (build)" if build available, else just version
          mainBranch.tracks.storeRelease.iosVersion = ios.live.build
            ? `${ios.live.version} (${ios.live.build})`
            : ios.live.version;
          mainBranch.tracks.storeRelease.iosBuildId = ios.live.buildId; // For diagnostics API
          mainBranch.tracks.storeRelease.iosVersionString = ios.live.version; // For perfPowerMetrics lookup
          mainBranch.tracks.storeRelease.iosDate = ios.live.createdDate;
          mainBranch.tracks.storeRelease.iosStatusReason = iosStateMap[ios.live.state] || 'App Store';
        }

        // Previous live = prevRelease (previous App Store version)
        if (ios.prevLive) {
          mainBranch.tracks.prevRelease.ios = 'success';
          mainBranch.tracks.prevRelease.iosVersion = ios.prevLive.build
            ? `${ios.prevLive.version} (${ios.prevLive.build})`
            : ios.prevLive.version;
          mainBranch.tracks.prevRelease.iosBuildId = ios.prevLive.buildId; // For diagnostics API
          mainBranch.tracks.prevRelease.iosVersionString = ios.prevLive.version; // For perfPowerMetrics lookup
          mainBranch.tracks.prevRelease.iosDate = ios.prevLive.createdDate;
          mainBranch.tracks.prevRelease.iosStatusReason = 'Previous Release';
        }

        // Alpha beta group = storeAlpha (look up from config)
        const alphaBetaGroupName = config.tracks?.find(t => t.id === 'storeAlpha')?.iosBetaGroupName || 'Alpha';
        const alphaBetaGroup = ios.betaGroups?.[alphaBetaGroupName];
        if (alphaBetaGroup) {
          mainBranch.tracks.storeAlpha.ios = 'success';
          // Format: "versionString (build)" - versionString contains the changeset
          mainBranch.tracks.storeAlpha.iosVersion = alphaBetaGroup.versionString || alphaBetaGroup.build;
          mainBranch.tracks.storeAlpha.iosBuildId = alphaBetaGroup.buildId; // For diagnostics API
          mainBranch.tracks.storeAlpha.iosVersionString = alphaBetaGroup.versionString; // For perfPowerMetrics lookup
          mainBranch.tracks.storeAlpha.iosDate = alphaBetaGroup.uploadedDate;
          mainBranch.tracks.storeAlpha.iosStatusReason = `TestFlight ${alphaBetaGroupName}`;
        } else if (ios.pending) {
          // Fallback: Pending review = storeAlpha
          mainBranch.tracks.storeAlpha.ios = 'review';
          mainBranch.tracks.storeAlpha.iosVersion = ios.pending.build
            ? `${ios.pending.version} (${ios.pending.build})`
            : ios.pending.version;
          mainBranch.tracks.storeAlpha.iosBuildId = ios.pending.buildId; // For diagnostics API
          mainBranch.tracks.storeAlpha.iosVersionString = ios.pending.version; // For perfPowerMetrics lookup
          mainBranch.tracks.storeAlpha.iosStatusReason = iosStateMap[ios.pending.state] || ios.pending.state;
        }

        // iOS Rollout (phased release in progress)
        if (ios.rollout) {
          const userPercent = Math.round(ios.rollout.userFraction * 100);
          mainBranch.tracks.storeRollout.ios = ios.rollout.state === 'PAUSED' ? 'review' : 'success';
          mainBranch.tracks.storeRollout.iosVersion = ios.rollout.build
            ? `${ios.rollout.version} (${ios.rollout.build})`
            : ios.rollout.version;
          mainBranch.tracks.storeRollout.iosBuildId = ios.rollout.buildId;
          mainBranch.tracks.storeRollout.iosVersionString = ios.rollout.version;
          mainBranch.tracks.storeRollout.iosDate = ios.rollout.createdDate;
          mainBranch.tracks.storeRollout.iosUserFraction = ios.rollout.userFraction;
          mainBranch.tracks.storeRollout.iosStatusReason = ios.rollout.state === 'PAUSED'
            ? `Phased Release Paused (${userPercent}%)`
            : `Phased Release (${userPercent}%)`;
        } else {
          // No active iOS rollout - show N/A
          mainBranch.tracks.storeRollout.ios = 'none';
          mainBranch.tracks.storeRollout.iosVersion = 'N/A';
          mainBranch.tracks.storeRollout.iosStatusReason = 'No phased release';
        }
      }

      // Android store data
      if (androidJob && androidVersions[androidJob.bundleId]) {
        const android = androidVersions[androidJob.bundleId];

        // Map Google Play status to readable reasons
        const androidStatusMap = {
          'completed': 'Rolled out',
          'inProgress': 'Rolling out',
          'halted': 'Halted',
          'draft': 'Draft'
        };

        // Internal track = storeInternal
        if (android.internal) {
          mainBranch.tracks.storeInternal.android = 'success';
          mainBranch.tracks.storeInternal.androidVersion = android.internal.versionName;
          mainBranch.tracks.storeInternal.androidVersionCode = android.internal.versionCodes?.[0];
          mainBranch.tracks.storeInternal.androidStatusReason = 'Internal Testing';
        }

        // Alpha track = storeAlpha
        if (android.alpha) {
          mainBranch.tracks.storeAlpha.android = 'success';
          mainBranch.tracks.storeAlpha.androidVersion = android.alpha.versionName;
          mainBranch.tracks.storeAlpha.androidVersionCode = android.alpha.versionCodes?.[0];
          mainBranch.tracks.storeAlpha.androidStatusReason = androidStatusMap[android.alpha.status] || 'Closed Testing';
        }

        // Android Rollout (staged rollout in progress or halted)
        if (android.rollout) {
          const userPercent = Math.round(android.rollout.userFraction * 100);
          const isHalted = android.rollout.status === 'halted';
          const countries = android.rollout.countryTargeting?.countries;
          const isMexicoOnly = countries && countries.length === 1 && countries[0] === 'MX';
          const regionLabel = isMexicoOnly ? 'Mexico' : 'Global';

          mainBranch.tracks.storeRollout.android = isHalted ? 'failure' : 'success';
          mainBranch.tracks.storeRollout.androidVersion = android.rollout.versionName;
          mainBranch.tracks.storeRollout.androidVersionCode = android.rollout.versionCodes?.[0];
          mainBranch.tracks.storeRollout.androidUserFraction = android.rollout.userFraction;
          mainBranch.tracks.storeRollout.androidCountryTargeting = countries || null;

          if (isHalted) {
            mainBranch.tracks.storeRollout.androidStatusReason = `Halted (was ${userPercent}% ${regionLabel})`;
          } else if (isMexicoOnly) {
            mainBranch.tracks.storeRollout.androidStatusReason = `🇲🇽 Mexico (${userPercent}%)`;
          } else {
            mainBranch.tracks.storeRollout.androidStatusReason = `🌍 ${userPercent}% Global`;
          }
        } else {
          // No active Android rollout - show N/A
          mainBranch.tracks.storeRollout.android = 'none';
          mainBranch.tracks.storeRollout.androidVersion = 'N/A';
          mainBranch.tracks.storeRollout.androidStatusReason = 'No staged rollout';
        }

        // Production track = storeRelease
        if (android.production) {
          mainBranch.tracks.storeRelease.android = 'success';
          mainBranch.tracks.storeRelease.androidVersion = android.production.versionName;
          mainBranch.tracks.storeRelease.androidVersionCode = android.production.versionCodes?.[0];
          mainBranch.tracks.storeRelease.androidStatusReason = androidStatusMap[android.production.status] || 'Play Store';
        }
      }
    }

    log.info('server', 'Store data fetch complete');

    // Save progress and broadcast store data immediately (users see store tracks)
    cache.saveCacheToDisk();
    cache.broadcastSSE('store-updated', { timestamp: Date.now() });

    // Fetch Sentry, Vitals, and Analytics in PARALLEL (all need store data which is now applied)
    await Promise.all([
      fetchSentryDataInBackground(projects).catch(e => log.warn('server', 'Sentry fetch failed', { error: e.message })),
      fetchVitalsInBackground(projects).catch(e => log.warn('server', 'Vitals fetch failed', { error: e.message })),
      fetchAnalyticsInBackground(projects).catch(e => log.warn('server', 'Analytics fetch failed', { error: e.message }))
    ]);

    // Final save (refresh broadcast happens in caller after this returns)
    cache.saveCacheToDisk();
  } catch (e) {
    log.warn('server', 'Store data apply failed', { error: e.message });
  }
}

// Fetch pipeline stage info for in-progress builds
async function fetchPipelineStagesInBackground(projects, buildsByJob) {
  try {
    // Find all in-progress builds from all jobs
    const inProgressBuilds = [];
    for (const job of config.jobs) {
      const jobBuilds = buildsByJob[job.jenkinsJob] || [];
      for (const build of jobBuilds) {
        if (build.result === null) { // null result means in-progress
          inProgressBuilds.push({
            platform: job.platform,
            jobName: job.jenkinsJob,
            buildNumber: build.number,
            branch: build.branch || 'main',
            buildType: build.buildType || 'Debug'
          });
        }
      }
    }

    if (inProgressBuilds.length === 0) return;

    // Fetch stage info for each in-progress build
    const stagePromises = inProgressBuilds.map(async (build) => {
      const stageInfo = await jenkinsApi.getPipelineStages(build.jobName, build.buildNumber);
      return { ...build, stageInfo };
    });

    const results = await Promise.all(stagePromises);

    // Update project tracks with stage info
    for (const result of results) {
      if (!result.stageInfo) continue;

      const { platform, branch, buildType, stageInfo } = result;
      const currentStage = stageInfo.currentStage || stageInfo.lastCompletedStage;
      if (!currentStage) continue;

      // Find the project and branch
      for (const project of projects) {
        const branchData = project.branches?.find(b => b.branch === branch);
        if (!branchData?.tracks) continue;

        // Determine which track to update
        const trackName = buildType === 'Release' ? 'release' : 'dev';
        const track = branchData.tracks[trackName];
        if (!track) continue;

        // Add status reason with current stage and progress
        if (track[platform] === 'building') {
          const progress = stageInfo.totalStages > 0
            ? `${stageInfo.completedCount}/${stageInfo.totalStages}`
            : '';
          track[`${platform}StatusReason`] = progress
            ? `Stage: ${currentStage} (${progress})`
            : `Stage: ${currentStage}`;
          // Store detailed stage info for tooltip
          track[`${platform}StageInfo`] = {
            current: currentStage,
            lastCompleted: stageInfo.lastCompletedStage,
            totalStages: stageInfo.totalStages,
            completedCount: stageInfo.completedCount,
            stages: stageInfo.stages
          };
        }
      }
    }

    log.info('server', `Pipeline stages fetched for ${results.length} in-progress builds`);
  } catch (e) {
    log.warn('server', 'Pipeline stages fetch failed', { error: e.message });
  }
}

// Fetch raw Sentry data (no project dependency)
async function fetchSentryDataRaw() {
  // Return raw issue data for all configured projects
  // Version filtering will happen in applySentryData when we have store data
  return sentryApi.getAllProjectIssueCounts(config.projects || {}, {});
}

// Apply Sentry data to projects
function applySentryData(projects, sentryData) {
  if (!sentryData || Object.keys(sentryData).length === 0) {
    log.debug('server', 'No Sentry data to apply');
    return;
  }

  for (const project of projects) {
    const projectSentry = sentryData[project.displayName];
    if (projectSentry) {
      project.sentry = projectSentry;
    }
  }
  log.info('server', `Sentry data applied for ${Object.keys(sentryData).length} projects`);
}

// Fetch raw analytics data (no project dependency)
async function fetchAnalyticsDataRaw() {
  const results = {};
  const projectsToFetch = [];

  for (const [projectName, projectConfig] of Object.entries(config.projects || {})) {
    if (projectConfig.firebasePropertyId) {
      projectsToFetch.push({ projectName, propertyId: projectConfig.firebasePropertyId });
    }
  }

  if (projectsToFetch.length === 0) return results;

  const fetchResults = await Promise.all(
    projectsToFetch.map(({ projectName, propertyId }) =>
      firebaseApi.getUsersByVersion(propertyId, null, 7)
        .then(data => ({ projectName, data }))
        .catch(e => { log.warn('server', `Analytics fetch failed for ${projectName}`, { error: e.message }); return { projectName, data: null }; })
    )
  );

  for (const { projectName, data } of fetchResults) {
    if (data) results[projectName] = data;
  }

  return results;
}

// Fetch Sentry issue data in background without blocking (legacy - kept for compatibility)
async function fetchSentryDataInBackground(projects) {
  try {
    // Extract deployed versions from projects for Sentry filtering
    // Filter to versions in: internal, alpha, store, and prev store tracks
    const deployedVersionsByProject = {};
    for (const project of projects || []) {
      const versions = new Set();
      const mainBranch = project.branches?.find(b => b.branch === 'main') || project.branches?.[0];

      // Determine Sentry release prefix from project name
      // TOR = Trucks Off Road, MTD = Monster Truck Destruction
      let sentryPrefix = '';
      if (project.displayName === 'Trucks Off Road') {
        sentryPrefix = 'TOR@';
      } else if (project.displayName === 'Monster Truck Destruction') {
        sentryPrefix = 'MTD@';
      }

      if (mainBranch?.tracks) {
        // Collect versions from store tracks (internal, alpha, store, prev store)
        for (const trackName of ['storeInternal', 'storeAlpha', 'storeRelease', 'prevRelease']) {
          const track = mainBranch.tracks[trackName];
          if (track) {
            // iOS version string (e.g., "1.90.4549") -> format as "TOR@1.90.4549"
            if (track.iosVersionString) {
              versions.add(sentryPrefix + track.iosVersionString);
            }
            // Android version (e.g., "1.90.4549" or versionName) -> format as "TOR@1.90.4549"
            if (track.androidVersion) {
              versions.add(sentryPrefix + track.androidVersion);
            }
          }
        }
      }
      if (versions.size > 0) {
        deployedVersionsByProject[project.displayName] = Array.from(versions);
        log.debug('server', `Deployed versions for ${project.displayName}`, { versions: Array.from(versions) });
      }
    }

    // Get issue counts for all configured Sentry projects
    const sentryData = await sentryApi.getAllProjectIssueCounts(config.projects || {}, deployedVersionsByProject);

    if (Object.keys(sentryData).length === 0) {
      log.debug('server', 'No Sentry data fetched');
      return;
    }

    // Add Sentry data to each project
    for (const project of projects) {
      const projectSentry = sentryData[project.displayName];
      if (projectSentry) {
        project.sentry = projectSentry;
      }
    }

    log.info('server', `Sentry data fetched for ${Object.keys(sentryData).length} projects`);
  } catch (e) {
    log.warn('server', 'Sentry data fetch failed', { error: e.message });
  }
}

// Fetch vitals data (crash/ANR rates) in background without blocking
async function fetchVitalsInBackground(projects) {
  try {
    const vitalsData = await vitalsApi.getAllVitals();

    if (!vitalsData.ios && !vitalsData.android) {
      log.debug('server', 'No vitals data fetched');
      return;
    }

    // Build list of projects to process
    const projectsToProcess = [];
    for (const project of projects) {
      const mainBranch = project.branches?.find(b => b.branch === 'main');
      if (!mainBranch?.tracks) continue;

      const projectJobs = config.jobs.filter(j =>
        j.displayName.toLowerCase().replace(/\s+/g, '-') === project.id
      );

      const iosJob = projectJobs.find(j => j.platform === 'ios');
      const androidJob = projectJobs.find(j => j.platform === 'android');

      projectsToProcess.push({ project, mainBranch, iosJob, androidJob });
    }

    // Process all projects in PARALLEL
    await Promise.all(projectsToProcess.map(({ project, mainBranch, iosJob, androidJob }) =>
      processProjectVitals(project, mainBranch, iosJob, androidJob, vitalsData)
    ));

    log.info('server', 'Vitals data fetched and applied');
  } catch (e) {
    log.warn('server', 'Vitals data fetch failed', { error: e.message });
  }
}

// Process vitals for a single project (called in parallel)
async function processProjectVitals(project, mainBranch, iosJob, androidJob, vitalsData) {
  // iOS vitals
  if (iosJob && vitalsData.ios[iosJob.bundleId]) {
    const iosVitals = vitalsData.ios[iosJob.bundleId];
    const byVersion = iosVitals.byVersion || {};

    // Add vitals to each store track
    for (const trackName of ['storeInternal', 'storeAlpha', 'storeRollout', 'storeRelease', 'prevRelease']) {
      const track = mainBranch.tracks[trackName];
      if (!track) continue;

      const versionString = track.iosVersionString;
      const versionData = versionString && byVersion[versionString];

      track.iosVitals = {
        crashRate: versionData?.crashRate ?? iosVitals.crashRate,
        hangRate: versionData?.hangRate ?? iosVitals.hangRate,
        bundleId: iosJob.bundleId,
        appId: iosVitals.appId,
        version: versionString || null
      };
    }

    // Fetch diagnostics for builds with buildId
    const buildIdsToFetch = [];
    for (const trackName of ['storeInternal', 'storeAlpha', 'storeRollout', 'storeRelease', 'prevRelease']) {
      const track = mainBranch.tracks[trackName];
      if (track?.iosBuildId) {
        buildIdsToFetch.push({ trackName, buildId: track.iosBuildId });
      }
    }

    if (buildIdsToFetch.length > 0) {
      const diagnosticsResults = await Promise.all(
        buildIdsToFetch.map(({ buildId }) =>
          vitalsApi.getIOSBuildDiagnostics(buildId).catch(e => ({ error: e.message, buildId }))
        )
      );

      for (let i = 0; i < buildIdsToFetch.length; i++) {
        const { trackName } = buildIdsToFetch[i];
        const diagnostics = diagnosticsResults[i];

        if (!diagnostics.error && mainBranch.tracks[trackName]) {
          if (!mainBranch.tracks[trackName].iosVitals) {
            mainBranch.tracks[trackName].iosVitals = { bundleId: iosJob.bundleId, appId: iosVitals.appId };
          }
          mainBranch.tracks[trackName].iosVitals.crashCount = diagnostics.crashCount;
          mainBranch.tracks[trackName].iosVitals.signatureCount = diagnostics.signatureCount;
        }
      }
    }
  }

  // Android vitals
  if (androidJob && vitalsData.android[androidJob.bundleId]) {
    const androidVitals = vitalsData.android[androidJob.bundleId];
    const byVersion = androidVitals.byVersion || {};
    const currentReleaseCode = mainBranch.tracks.storeRelease?.androidVersionCode?.toString();

    // Add vitals to each store track
    for (const trackName of ['storeInternal', 'storeAlpha', 'storeRollout', 'storeRelease']) {
      const track = mainBranch.tracks[trackName];
      if (!track) continue;

      const versionCode = track.androidVersionCode?.toString();
      const versionData = versionCode && byVersion[versionCode];
      const isVersionSpecific = !!versionData;

      track.androidVitals = {
        crashRate: versionData?.crashRate ?? androidVitals.crashRate ?? androidVitals.userPerceivedCrashRate,
        userPerceivedCrashRate: versionData?.userPerceivedCrashRate ?? androidVitals.userPerceivedCrashRate,
        anrRate: versionData?.anrRate ?? androidVitals.anrRate ?? androidVitals.userPerceivedAnrRate,
        userPerceivedAnrRate: versionData?.userPerceivedAnrRate ?? androidVitals.userPerceivedAnrRate,
        distinctUsers: versionData?.distinctUsers ?? null,
        packageName: androidJob.bundleId,
        playAppId: androidJob.playAppId,
        developerId: config.fastlane?.googlePlay?.developerId,
        versionCode: versionCode || null,
        isAggregate: !isVersionSpecific
      };
    }

    // Find prevRelease for Android
    const sortedVersions = Object.entries(byVersion)
      .map(([code, data]) => ({ versionCode: code, ...data }))
      .filter(v => v.distinctUsers > 0)
      .sort((a, b) => (b.distinctUsers || 0) - (a.distinctUsers || 0));

    let prevVersion = null;
    if (currentReleaseCode) {
      const filtered = sortedVersions.filter(v => v.versionCode !== currentReleaseCode);
      if (filtered.length > 0) prevVersion = filtered[0];
    } else if (sortedVersions.length > 1) {
      prevVersion = sortedVersions[1];
    }

    if (prevVersion && mainBranch.tracks.prevRelease) {
      mainBranch.tracks.prevRelease.android = 'success';
      // Don't set androidVersion here - it will be set by analytics with the correct versionName (contains changeset)
      // Only set androidVersionCode for vitals lookup
      mainBranch.tracks.prevRelease.androidVersionCode = parseInt(prevVersion.versionCode);
      mainBranch.tracks.prevRelease.androidStatusReason = `${prevVersion.distinctUsers?.toLocaleString()} users`;

      // Try to get historical vitals for prevRelease
      let historicalVitals = null;
      let prevReleaseDate = null;
      let dateSource = null;

      const projectConfig = config.projects?.[project.displayName];
      if (projectConfig?.firebasePropertyId) {
        try {
          const usersByVersion = await firebaseApi.getUsersByVersion(projectConfig.firebasePropertyId, 'android', 30);
          const currentVersionName = mainBranch.tracks.storeRelease?.androidVersion;
          const androidVersionsList = usersByVersion?.android || [];
          const prevVersionFromFirebase = androidVersionsList.find(v => v.version !== currentVersionName) || androidVersionsList[1];

          if (prevVersionFromFirebase) {
            const versionDates = await firebaseApi.getVersionFirstSeenDates(projectConfig.firebasePropertyId, 'android', 90);
            const firstSeenDate = versionDates?.android?.[prevVersionFromFirebase.version];
            if (firstSeenDate) {
              prevReleaseDate = firstSeenDate;
              dateSource = 'firebase';
            }
          }
        } catch (e) {
          log.debug('server', 'Firebase version dates fetch failed', { error: e.message });
        }
      }

      // Fall back to iOS release date
      if (!prevReleaseDate && mainBranch.tracks.prevRelease.iosDate) {
        prevReleaseDate = mainBranch.tracks.prevRelease.iosDate;
        dateSource = 'ios';
      }

      if (prevReleaseDate) {
        const startDate = dateSource === 'firebase'
          ? new Date(`${prevReleaseDate.slice(0,4)}-${prevReleaseDate.slice(4,6)}-${prevReleaseDate.slice(6,8)}`)
          : new Date(prevReleaseDate);
        const endDate = new Date(startDate.getTime() + 14 * 24 * 60 * 60 * 1000);

        try {
          historicalVitals = await vitalsApi.getAndroidVitals(androidJob.bundleId, { startDate, endDate, skipCache: false });
        } catch (e) {
          log.debug('server', 'Historical vitals fetch failed', { error: e.message });
        }
      }

      let historicalVersionData = null;
      let historicalVersionCode = null;

      if (historicalVitals?.byVersion) {
        const sorted = Object.entries(historicalVitals.byVersion)
          .map(([code, data]) => ({ versionCode: code, ...data }))
          .filter(v => v.distinctUsers > 0)
          .sort((a, b) => (b.distinctUsers || 0) - (a.distinctUsers || 0));

        if (sorted.length > 0) {
          historicalVersionData = sorted[0];
          historicalVersionCode = sorted[0].versionCode;
        }
      }

      const vitalsSource = historicalVersionData || prevVersion;
      const isHistorical = !!historicalVersionData;

      mainBranch.tracks.prevRelease.androidVitals = {
        crashRate: vitalsSource.crashRate,
        userPerceivedCrashRate: vitalsSource.userPerceivedCrashRate,
        anrRate: vitalsSource.anrRate,
        userPerceivedAnrRate: vitalsSource.userPerceivedAnrRate,
        distinctUsers: vitalsSource.distinctUsers ?? prevVersion.distinctUsers,
        packageName: androidJob.bundleId,
        playAppId: androidJob.playAppId,
        developerId: config.fastlane?.googlePlay?.developerId,
        versionCode: historicalVersionCode || prevVersion.versionCode,
        isHistorical,
        dateSource: isHistorical ? dateSource : null,
        queryDateRange: isHistorical ? { start: historicalVitals.queryStart, end: historicalVitals.queryEnd } : null
      };
    }
  }
}

// Fetch analytics data (active users per version) in background
async function fetchAnalyticsInBackground(projects) {
  try {
    // Build list of projects that need analytics
    const projectsToFetch = [];
    for (const project of projects) {
      const mainBranch = project.branches?.find(b => b.branch === 'main');
      if (!mainBranch?.tracks) continue;
      const projectConfig = config.projects?.[project.displayName];
      if (!projectConfig?.firebasePropertyId) continue;
      projectsToFetch.push({ project, mainBranch, projectConfig });
    }

    if (projectsToFetch.length === 0) return;

    // Fetch all analytics in PARALLEL
    const analyticsResults = await Promise.all(
      projectsToFetch.map(({ projectConfig }) =>
        firebaseApi.getUsersByVersion(projectConfig.firebasePropertyId, null, 7)
          .catch(e => { log.warn('server', 'Analytics fetch failed', { error: e.message }); return null; })
      )
    );

    // Apply results to projects
    for (let i = 0; i < projectsToFetch.length; i++) {
      const { project, mainBranch, projectConfig } = projectsToFetch[i];
      const usersByVersion = analyticsResults[i];
      if (!usersByVersion) continue;

      // Store raw analytics data sorted by users (for project-level DAU)
      const iosVersions = usersByVersion.ios || [];
      const androidVersions = usersByVersion.android || [];

      // Calculate total DAU per platform (sum of all versions)
      const iosDau = iosVersions.reduce((sum, v) => sum + (v.activeUsers || 0), 0);
      const androidDau = androidVersions.reduce((sum, v) => sum + (v.activeUsers || 0), 0);

      // Store at project level for display in grouping
      project.iosDau = iosDau;
      project.androidDau = androidDau;

      // Build lookup maps from version -> activeUsers
      const iosUserMap = {};
      for (const entry of iosVersions) {
        iosUserMap[entry.version] = entry.activeUsers;
      }

      const androidUserMap = {};
      for (const entry of androidVersions) {
        androidUserMap[entry.version] = entry.activeUsers;
      }

      // Add active users to each store track
      for (const trackName of ['storeInternal', 'storeAlpha', 'storeRollout', 'storeRelease', 'prevRelease']) {
        const track = mainBranch.tracks[trackName];
        if (!track) continue;

        // iOS: match by version string (e.g., "1.2.3")
        const iosVersion = track.iosVersionString;
        if (iosVersion && iosUserMap[iosVersion] !== undefined) {
          track.iosActiveUsers = iosUserMap[iosVersion];
        }

        // Android: match by version name (from store data)
        const androidVersion = track.androidVersion;
        if (androidVersion && androidUserMap[androidVersion] !== undefined) {
          track.androidActiveUsers = androidUserMap[androidVersion];
        }
      }

      // Special handling for prevRelease: use 2nd most popular version from analytics if not already set
      const prevRelease = mainBranch.tracks.prevRelease;
      if (prevRelease) {
        // iOS: if no active users matched, try to find 2nd most popular iOS version
        if (prevRelease.iosActiveUsers === undefined && iosVersions.length > 1) {
          // Skip the current release version (1st entry) and take 2nd
          const currentIosVersion = mainBranch.tracks.storeRelease?.iosVersionString;
          const prevIosEntry = iosVersions.find(v => v.version !== currentIosVersion) || iosVersions[1];
          if (prevIosEntry) {
            prevRelease.iosActiveUsers = prevIosEntry.activeUsers;
            if (!prevRelease.iosVersionString) {
              prevRelease.iosVersionString = prevIosEntry.version;
            }
          }
        }

        // Android: Get 2nd most popular version from Firebase for user counts
        // Vitals only sets androidVersionCode (for lookup), we set androidVersion here with proper versionName
        // versionName contains the changeset (e.g., "1.90.4549") for display
        if (androidVersions.length > 1) {
          // Skip the current store release and take next most popular
          // storeRelease.androidVersion is already the versionName (e.g., "1.90.8466")
          const currentStoreVersionName = mainBranch.tracks.storeRelease?.androidVersion;
          const prevAndroidEntry = androidVersions.find(v => v.version !== currentStoreVersionName) || androidVersions[1];
          if (prevAndroidEntry) {
            // Store Firebase data
            prevRelease.androidVersionName = prevAndroidEntry.version;
            prevRelease.androidActiveUsers = prevAndroidEntry.activeUsers;

            // ALWAYS use Firebase versionName for display (contains changeset like "1.90.4549")
            // Keep versionCode separately for vitals lookup
            prevRelease.androidVersion = prevAndroidEntry.version;
            if (!prevRelease.android) {
              prevRelease.android = 'success';
            }
            prevRelease.androidStatusReason = `${prevAndroidEntry.activeUsers?.toLocaleString()} users`;

            log.info('server', 'PrevRelease Android from Firebase', {
              versionName: prevAndroidEntry.version,
              activeUsers: prevAndroidEntry.activeUsers,
              versionCodeFromVitals: prevRelease.androidVersionCode
            });
          }
        }

        // Fallback: if androidVersion still not set but we have androidVersionCode from vitals, use that
        if (!prevRelease.androidVersion && prevRelease.androidVersionCode) {
          prevRelease.androidVersion = prevRelease.androidVersionCode.toString();
          log.debug('server', 'PrevRelease Android fallback to versionCode', {
            versionCode: prevRelease.androidVersionCode
          });
        }
      }
    }

    log.info('server', 'Analytics data fetched and applied');
  } catch (e) {
    log.warn('server', 'Analytics data fetch failed', { error: e.message });
  }
}

// Helper function: Group builds by branch across platforms
function getBranchBuilds(builds, jobs) {
  // Group builds by branch across platforms
  const branchMap = new Map();

  for (const platform of ['ios', 'android']) {
    const platformBuilds = builds[platform] || [];
    for (const build of platformBuilds) {
      const branch = build.branch || 'main';
      if (!branchMap.has(branch)) {
        branchMap.set(branch, {
          branch,
          // Dev builds (default/Debug buildType)
          ios: null,
          android: null,
          iosSuccess: null,
          androidSuccess: null,
          iosOldestSuccess: null,
          androidOldestSuccess: null,
          // Alpha builds
          iosAlpha: null,
          androidAlpha: null,
          iosAlphaSuccess: null,
          androidAlphaSuccess: null,
          // Release builds
          iosRelease: null,
          androidRelease: null,
          iosReleaseSuccess: null,
          androidReleaseSuccess: null,
          allCommits: [],
          timestamp: 0,
          commits: [],
          downloadUrl: null,
          driveFolder: null
        });
      }

      const branchData = branchMap.get(branch);
      const buildType = build.buildType || 'Debug';

      // Determine which keys to use based on build type
      let platformKey = platform;
      let successKey = `${platform}Success`;
      let oldestSuccessKey = `${platform}OldestSuccess`;

      if (buildType.toLowerCase().includes('alpha')) {
        platformKey = `${platform}Alpha`;
        successKey = `${platform}AlphaSuccess`;
      } else if (buildType.toLowerCase().includes('release')) {
        platformKey = `${platform}Release`;
        successKey = `${platform}ReleaseSuccess`;
      }

      // Determine if this build should replace the current one
      // Priority: 1) Higher changeset, 2) SUCCESS over FAILURE for same changeset, 3) Newer timestamp
      const current = branchData[platformKey];
      const currentVersion = parseInt(current?.version) || 0;
      const newVersion = parseInt(build.version) || 0;

      let shouldReplace = false;
      if (!current) {
        shouldReplace = true;
      } else if (newVersion > currentVersion) {
        // Higher changeset always wins
        shouldReplace = true;
      } else if (newVersion === currentVersion) {
        // Same changeset: SUCCESS trumps FAILURE
        if (build.result === 'SUCCESS' && current.result !== 'SUCCESS') {
          shouldReplace = true;
        } else if (build.result === 'SUCCESS' && current.result === 'SUCCESS') {
          // Both success on same changeset: prefer newer
          shouldReplace = build.timestamp > current.timestamp;
        } else if (build.result !== 'SUCCESS' && current.result !== 'SUCCESS') {
          // Both failure on same changeset: prefer newer
          shouldReplace = build.timestamp > current.timestamp;
        }
        // If new is failure and current is success, don't replace
      }

      if (shouldReplace) {
        branchData[platformKey] = {
          number: build.number,
          jobName: build.jobName,
          version: build.version,
          result: build.result,
          timestamp: build.timestamp,
          duration: build.duration,
          downloadUrl: build.downloadUrl,
          driveFolder: build.driveFolder,
          errorAnalysis: build.errorAnalysis
        };

        // Update branch-level timestamp to most recent (only for dev builds)
        if (platformKey === platform && build.timestamp > branchData.timestamp) {
          branchData.timestamp = build.timestamp;
          branchData.version = build.version;
          branchData.commits = (build.changeSet || []).slice(0, 5).map(c => ({
            message: c.message?.split('\n')[0] || '',
            author: c.author || ''
          }));
          branchData.downloadUrl = build.downloadUrl;
          branchData.driveFolder = build.driveFolder;
        }
      }

      // Track latest successful build separately
      if (build.result === 'SUCCESS') {
        if (!branchData[successKey] || build.timestamp > branchData[successKey].timestamp) {
          branchData[successKey] = {
            number: build.number,
            jobName: build.jobName,
            version: build.version,
            result: build.result,
            timestamp: build.timestamp,
            duration: build.duration,
            downloadUrl: build.downloadUrl,
            driveFolder: build.driveFolder
          };
        }
        // Track oldest success for dev builds only (for plastic range)
        if (platformKey === platform) {
          if (!branchData[oldestSuccessKey] || build.timestamp < branchData[oldestSuccessKey].timestamp) {
            branchData[oldestSuccessKey] = {
              number: build.number,
              version: build.version,
              timestamp: build.timestamp
            };
          }
        }
      }

      // Collect all commits from all builds for this branch
      if (build.changeSet && build.changeSet.length > 0) {
        for (const commit of build.changeSet) {
          branchData.allCommits.push({
            message: commit.message?.split('\n')[0] || '',
            author: commit.author || '',
            version: build.version,
            timestamp: build.timestamp
          });
        }
      }
    }
  }

  // Dedupe and sort commits by timestamp (newest first)
  for (const branchData of branchMap.values()) {
    const seen = new Set();
    branchData.allCommits = branchData.allCommits
      .filter(c => {
        const key = `${c.message}:${c.author}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  // Convert to array and sort (main first, then by timestamp)
  const branches = Array.from(branchMap.values());
  branches.sort((a, b) => {
    if (a.branch === 'main') return -1;
    if (b.branch === 'main') return 1;
    return b.timestamp - a.timestamp;
  });

  return branches;
}

// Helper function: Build track status for a branch
function buildBranchTrackStatus(branchData, storeStatus, jobs, queuedBuilds = []) {
  const createTrack = () => ({
    ios: null, android: null,
    iosVersion: null, androidVersion: null,
    iosUrl: null, androidUrl: null,
    iosDate: null, androidDate: null,
    iosSuccessVersion: null, androidSuccessVersion: null,
    iosSuccessUrl: null, androidSuccessUrl: null,
    iosDownloadUrl: null, androidDownloadUrl: null,
    iosBuildStartTime: null, androidBuildStartTime: null,
    iosEstimatedDuration: null, androidEstimatedDuration: null,
    iosErrorAnalysis: null, androidErrorAnalysis: null
  });

  const tracks = {
    dev: createTrack(),
    alpha: createTrack(),
    release: createTrack(),
    prevRelease: createTrack(),
    storeInternal: createTrack(),
    storeAlpha: createTrack(),
    storeRollout: createTrack(), // Staged rollout in progress
    storeRelease: createTrack()
  };

  // Check if any builds are queued for this branch
  const isQueued = (platform, buildType) => {
    const job = jobs?.find(j => j.platform === platform);
    if (!job) return false;
    return queuedBuilds.some(q =>
      q.jobName === job.jenkinsJob &&
      q.branch === branchData.branch &&
      q.buildType.toLowerCase() === buildType.toLowerCase()
    );
  };

  // Jenkins build status per platform - use platform-specific version
  for (const platform of ['ios', 'android']) {
    const build = branchData[platform];
    const successBuild = branchData[`${platform}Success`];

    if (build) {
      let status = mapJenkinsStatus(build.result);
      const versionKey = `${platform}Version`;
      const urlKey = `${platform}Url`;
      const dateKey = `${platform}Date`;
      const successVersionKey = `${platform}SuccessVersion`;
      const successUrlKey = `${platform}SuccessUrl`;
      const downloadUrlKey = `${platform}DownloadUrl`;

      // Find the job for this platform to build the URL
      const job = jobs?.find(j => j.platform === platform);
      const buildUrl = job ? `${config.jenkins.baseUrl}/job/${job.jenkinsJob}/${build.number}/pipeline-overview/` : null;

      // Check if there's a queued build for this platform (Debug builds go to dev track)
      if (isQueued(platform, 'Debug') && status !== 'building') {
        status = 'queued';
      }

      tracks.dev[platform] = status;
      tracks.dev[versionKey] = build.version;
      tracks.dev[urlKey] = buildUrl;
      tracks.dev[dateKey] = build.timestamp;
      tracks.dev[downloadUrlKey] = build.downloadUrl;
      if (build.errorAnalysis) {
        tracks.dev[`${platform}ErrorAnalysis`] = build.errorAnalysis;
      }

      // Add build timing info for in-progress builds
      if (status === 'building') {
        tracks.dev[`${platform}BuildStartTime`] = build.timestamp;
        // Use the last successful build's duration as estimate
        if (successBuild && successBuild.duration) {
          tracks.dev[`${platform}EstimatedDuration`] = successBuild.duration;
        }
      }

      // Add latest success info if different from latest
      if (successBuild && successBuild.number !== build.number) {
        const successUrl = job ? `${config.jenkins.baseUrl}/job/${job.jenkinsJob}/${successBuild.number}/pipeline-overview/` : null;
        tracks.dev[successVersionKey] = successBuild.version;
        tracks.dev[successUrlKey] = successUrl;
      }

    } else if (isQueued(platform, 'Debug')) {
      // No build yet but there's one in queue
      tracks.dev[platform] = 'queued';
    }

    // Alpha builds
    const alphaBuild = branchData[`${platform}Alpha`];
    const alphaSuccessBuild = branchData[`${platform}AlphaSuccess`];
    if (alphaBuild) {
      const status = mapJenkinsStatus(alphaBuild.result);
      const job = jobs?.find(j => j.platform === platform);
      const buildUrl = job ? `${config.jenkins.baseUrl}/job/${job.jenkinsJob}/${alphaBuild.number}/pipeline-overview/` : null;

      tracks.alpha[platform] = status;
      tracks.alpha[`${platform}Version`] = alphaBuild.version;
      tracks.alpha[`${platform}Url`] = buildUrl;
      tracks.alpha[`${platform}Date`] = alphaBuild.timestamp;
      tracks.alpha[`${platform}DownloadUrl`] = alphaBuild.downloadUrl;

      if (alphaSuccessBuild && alphaSuccessBuild.number !== alphaBuild.number) {
        const successUrl = job ? `${config.jenkins.baseUrl}/job/${job.jenkinsJob}/${alphaSuccessBuild.number}/pipeline-overview/` : null;
        tracks.alpha[`${platform}SuccessVersion`] = alphaSuccessBuild.version;
        tracks.alpha[`${platform}SuccessUrl`] = successUrl;
      }
    }

    // Release builds
    const releaseBuild = branchData[`${platform}Release`];
    const releaseSuccessBuild = branchData[`${platform}ReleaseSuccess`];
    if (releaseBuild) {
      let status = mapJenkinsStatus(releaseBuild.result);
      const job = jobs?.find(j => j.platform === platform);
      const buildUrl = job ? `${config.jenkins.baseUrl}/job/${job.jenkinsJob}/${releaseBuild.number}/pipeline-overview/` : null;

      // Check if there's a queued Release build for this platform
      if (isQueued(platform, 'Release') && status !== 'building') {
        status = 'queued';
      }

      tracks.release[platform] = status;
      tracks.release[`${platform}Version`] = releaseBuild.version;
      tracks.release[`${platform}Url`] = buildUrl;
      tracks.release[`${platform}Date`] = releaseBuild.timestamp;
      tracks.release[`${platform}DownloadUrl`] = releaseBuild.downloadUrl;
      if (releaseBuild.errorAnalysis) {
        tracks.release[`${platform}ErrorAnalysis`] = releaseBuild.errorAnalysis;
      }

      // Add build timing info for in-progress builds
      if (status === 'building') {
        tracks.release[`${platform}BuildStartTime`] = releaseBuild.timestamp;
        if (releaseSuccessBuild && releaseSuccessBuild.duration) {
          tracks.release[`${platform}EstimatedDuration`] = releaseSuccessBuild.duration;
        }
      }

      if (releaseSuccessBuild && releaseSuccessBuild.number !== releaseBuild.number) {
        const successUrl = job ? `${config.jenkins.baseUrl}/job/${job.jenkinsJob}/${releaseSuccessBuild.number}/pipeline-overview/` : null;
        tracks.release[`${platform}SuccessVersion`] = releaseSuccessBuild.version;
        tracks.release[`${platform}SuccessUrl`] = successUrl;
      }
    } else if (isQueued(platform, 'Release')) {
      // No release build yet but there's one in queue
      tracks.release[platform] = 'queued';
    }
    // Note: prevRelease data is populated from store API in applyStoreDataAndFetchDependents
  }

  // Store status from webhooks
  // iOS: internal = TestFlight internal, alpha = TestFlight external (Alpha group), release = App Store
  if (storeStatus.appStore) {
    tracks.storeInternal.ios = mapStoreStatus(storeStatus.appStore, 'testflight');
    tracks.storeAlpha.ios = mapStoreStatus(storeStatus.appStore, 'testflight_alpha');
    tracks.storeRelease.ios = mapStoreStatus(storeStatus.appStore, 'appstore');
    tracks.storeInternal.iosVersion = storeStatus.appStore.version;
    tracks.storeAlpha.iosVersion = storeStatus.appStore.alphaVersion;
    tracks.storeRelease.iosVersion = storeStatus.appStore.releaseVersion;
    tracks.storeInternal.date = storeStatus.appStore.updatedAt;
    tracks.storeAlpha.date = storeStatus.appStore.alphaUpdatedAt;
    tracks.storeRelease.date = storeStatus.appStore.releaseUpdatedAt;
  }

  // Android: internal = Play internal track, alpha = Play alpha track, release = Play production track
  if (storeStatus.googlePlay) {
    tracks.storeInternal.android = mapStoreStatus(storeStatus.googlePlay, 'internal');
    tracks.storeAlpha.android = mapStoreStatus(storeStatus.googlePlay, 'alpha');
    tracks.storeRelease.android = mapStoreStatus(storeStatus.googlePlay, 'production');
    tracks.storeInternal.androidVersion = storeStatus.googlePlay.version;
    tracks.storeAlpha.androidVersion = storeStatus.googlePlay.alphaVersion;
    tracks.storeRelease.androidVersion = storeStatus.googlePlay.releaseVersion;
    tracks.storeInternal.date = storeStatus.googlePlay.updatedAt;
    tracks.storeAlpha.date = storeStatus.googlePlay.alphaUpdatedAt;
    tracks.storeRelease.date = storeStatus.googlePlay.releaseUpdatedAt;
  }

  return tracks;
}

// Helper function: Map Jenkins build result to status
function mapJenkinsStatus(result) {
  switch (result) {
    case 'SUCCESS': return 'success';
    case 'FAILURE': return 'failure';
    case 'UNSTABLE': return 'unstable';
    case 'ABORTED': return 'none';
    case null: return 'building';
    default: return 'none';
  }
}

// Helper function: Map store status to readable status
function mapStoreStatus(storeInfo, track) {
  if (storeInfo.track !== track) return null;

  switch (storeInfo.status) {
    case 'uploaded': return 'success';
    case 'in_review': return 'review';
    case 'live': return 'success';
    case 'rejected': return 'failure';
    default: return null;
  }
}

// Exports
module.exports = {
  refreshBuilds,
  fetchAppIcons,
  getIsRefreshing: () => isRefreshing
};
