/**
 * Build Helper Utilities
 *
 * Collection of utility functions for processing and transforming build data.
 * Extracted from server.js for better modularity and reusability.
 */

const config = require('../config');

/**
 * Extract changeset number from version string.
 *
 * Handles multiple version formats:
 * - "X.Y.Z" format where Z is the changeset (e.g., "1.91.11965")
 * - "X.Y.Z (BUILD)" format where Z is the changeset (e.g., "1.91.11965 (34120)")
 * - "(BUILD)" format where BUILD is the changeset (e.g., "(34120)")
 * - Plain number (e.g., "11965")
 *
 * @param {string|number} version - Version string to parse
 * @returns {number|null} Extracted changeset number, or null if unable to parse
 *
 * @example
 * extractChangeset("1.91.11965 (34120)") // returns 11965
 * extractChangeset("1.91.11965") // returns 11965
 * extractChangeset("(34120)") // returns 34120
 * extractChangeset("11965") // returns 11965
 */
function extractChangeset(version) {
  if (!version) return null;

  // First, strip out the parentheses part if present
  const withoutParen = String(version).replace(/\s*\(\d+\)/, '').trim();

  // Handle format "X.Y.Z" - extract Z (changeset is last part)
  const parts = withoutParen.split('.');
  if (parts.length >= 3) {
    const last = parts[parts.length - 1];
    if (/^\d+$/.test(last)) return parseInt(last, 10);
  }

  // If there's parentheses and no X.Y.Z format, use the paren value
  const parenMatch = String(version).match(/\((\d+)\)/);
  if (parenMatch) return parseInt(parenMatch[1], 10);

  // If it's just a plain number, return it
  if (/^\d+$/.test(String(version))) return parseInt(version, 10);

  return null;
}

/**
 * Group builds by branch across iOS and Android platforms.
 *
 * Processes build arrays and groups them by branch name, tracking the latest builds
 * for each build type (Debug/Dev, Alpha, Release) per platform. Handles build
 * prioritization based on changeset version, success status, and timestamp.
 *
 * @param {Object} builds - Build data object with ios and android arrays
 * @param {Array} builds.ios - Array of iOS builds
 * @param {Array} builds.android - Array of Android builds
 * @param {Array} jobs - Job configuration array (not currently used in function body)
 * @returns {Array<Object>} Array of branch objects sorted with 'main' first, then by timestamp
 *
 * @example
 * const branches = getBranchBuilds({ ios: [...], android: [...] }, jobs);
 * // Returns: [
 * //   { branch: 'main', ios: {...}, android: {...}, iosAlpha: {...}, ... },
 * //   { branch: 'feature-x', ios: {...}, android: {...}, ... }
 * // ]
 */
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

/**
 * Build detailed track status object for a single branch.
 *
 * Creates a comprehensive status object tracking builds across multiple tracks
 * (dev, alpha, release, store tracks) for both iOS and Android platforms.
 * Includes build URLs, versions, timestamps, error analysis, and queued build detection.
 *
 * @param {Object} branchData - Branch data from getBranchBuilds containing platform-specific builds
 * @param {Object} storeStatus - Store status data with appStore and googlePlay properties
 * @param {Array} jobs - Job configuration array to construct Jenkins URLs
 * @param {Array} [queuedBuilds=[]] - Array of queued builds for detecting 'queued' status
 * @returns {Object} Track status object with dev, alpha, release, prevRelease, and store tracks
 *
 * @example
 * const tracks = buildBranchTrackStatus(branchData, storeStatus, jobs, queuedBuilds);
 * // Returns: {
 * //   dev: { ios: 'success', android: 'failure', iosVersion: '1.91.11965', ... },
 * //   alpha: { ios: 'success', android: null, ... },
 * //   release: { ... },
 * //   storeInternal: { ... },
 * //   storeAlpha: { ... },
 * //   storeRollout: { ... },
 * //   storeRelease: { ... }
 * // }
 */
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
    tracks.storeInternal.date = tracks.storeInternal.date || storeStatus.googlePlay.updatedAt;
    tracks.storeAlpha.date = tracks.storeAlpha.date || storeStatus.googlePlay.alphaUpdatedAt;
    tracks.storeRelease.date = tracks.storeRelease.date || storeStatus.googlePlay.releaseUpdatedAt;
  }

  return tracks;
}

/**
 * Build simplified track status from builds and store status.
 *
 * Simpler version of buildBranchTrackStatus that doesn't handle per-branch tracking.
 * Used for legacy/simplified status display without branch-level granularity.
 *
 * @param {Object} builds - Build data object with ios and android arrays
 * @param {Object} storeStatus - Store status data with appStore and googlePlay properties
 * @returns {Object} Simplified track status with dev, alpha, release, and store tracks
 *
 * @example
 * const tracks = buildTrackStatus({ ios: [...], android: [...] }, storeStatus);
 * // Returns: {
 * //   dev: { ios: 'success', android: 'failure', date: 1638360000000 },
 * //   alpha: { ios: null, android: null, date: null },
 * //   release: { ... },
 * //   storeInternal: { ... },
 * //   storeAlpha: { ... },
 * //   storeRelease: { ... }
 * // }
 */
function buildTrackStatus(builds, storeStatus) {
  const tracks = {
    dev: { ios: null, android: null, date: null },
    alpha: { ios: null, android: null, date: null },
    release: { ios: null, android: null, date: null },
    storeInternal: { ios: null, android: null, date: null },
    storeAlpha: { ios: null, android: null, date: null },
    storeRelease: { ios: null, android: null, date: null }
  };

  // Jenkins build status
  for (const platform of ['ios', 'android']) {
    const platformBuilds = builds[platform] || [];
    const latestBuild = platformBuilds[0]; // Most recent

    if (latestBuild) {
      const status = mapJenkinsStatus(latestBuild.result);
      tracks.dev[platform] = status;
      tracks.dev.date = tracks.dev.date || latestBuild.timestamp;

      // Check for alpha/release based on branch or build parameters
      if (latestBuild.branch?.includes('alpha')) {
        tracks.alpha[platform] = status;
        tracks.alpha.date = latestBuild.timestamp;
      }
      if (latestBuild.branch?.includes('release') || latestBuild.isRelease) {
        tracks.release[platform] = status;
        tracks.release.date = latestBuild.timestamp;
      }
    }
  }

  // Store status from webhooks
  if (storeStatus.appStore) {
    tracks.storeInternal.ios = mapStoreStatus(storeStatus.appStore, 'testflight');
    tracks.storeAlpha.ios = mapStoreStatus(storeStatus.appStore, 'testflight_alpha');
    tracks.storeRelease.ios = mapStoreStatus(storeStatus.appStore, 'appstore');
    tracks.storeInternal.date = storeStatus.appStore.updatedAt;
    tracks.storeAlpha.date = storeStatus.appStore.alphaUpdatedAt;
    tracks.storeRelease.date = storeStatus.appStore.releaseUpdatedAt;
  }

  if (storeStatus.googlePlay) {
    tracks.storeInternal.android = mapStoreStatus(storeStatus.googlePlay, 'internal');
    tracks.storeAlpha.android = mapStoreStatus(storeStatus.googlePlay, 'alpha');
    tracks.storeRelease.android = mapStoreStatus(storeStatus.googlePlay, 'production');
    tracks.storeInternal.date = storeStatus.googlePlay.updatedAt;
    tracks.storeAlpha.date = storeStatus.googlePlay.alphaUpdatedAt;
    tracks.storeRelease.date = storeStatus.googlePlay.releaseUpdatedAt;
  }

  return tracks;
}

/**
 * Map Jenkins build result to normalized status string.
 *
 * Converts Jenkins-specific result codes to simplified status values
 * used throughout the dashboard UI.
 *
 * @param {string|null} result - Jenkins build result code
 * @returns {string} Normalized status: 'success', 'failure', 'unstable', 'building', or 'none'
 *
 * @example
 * mapJenkinsStatus('SUCCESS') // returns 'success'
 * mapJenkinsStatus('FAILURE') // returns 'failure'
 * mapJenkinsStatus(null) // returns 'building'
 * mapJenkinsStatus('ABORTED') // returns 'none'
 */
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

/**
 * Map store status to normalized status string.
 *
 * Converts store-specific status information to dashboard status values.
 * Only returns a status if the storeInfo.track matches the requested track.
 *
 * @param {Object} storeInfo - Store information object containing track and status
 * @param {string} storeInfo.track - The store track (e.g., 'testflight', 'appstore', 'internal', 'production')
 * @param {string} storeInfo.status - The store status (e.g., 'uploaded', 'in_review', 'live', 'rejected')
 * @param {string} track - The track to check against storeInfo.track
 * @returns {string|null} Normalized status: 'success', 'review', 'failure', or null if track doesn't match
 *
 * @example
 * mapStoreStatus({ track: 'testflight', status: 'uploaded' }, 'testflight') // returns 'success'
 * mapStoreStatus({ track: 'appstore', status: 'in_review' }, 'appstore') // returns 'review'
 * mapStoreStatus({ track: 'testflight', status: 'uploaded' }, 'appstore') // returns null
 */
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

module.exports = {
  extractChangeset,
  getBranchBuilds,
  buildBranchTrackStatus,
  buildTrackStatus,
  mapJenkinsStatus,
  mapStoreStatus
};
