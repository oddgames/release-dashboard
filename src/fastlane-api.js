const { spawn } = require('child_process');
const path = require('path');
const log = require('./logger');
const config = require('./config');

const FASTLANE_DIR = path.join(__dirname, '..', 'fastlane');

/**
 * Run a Fastlane lane and parse JSON output
 * @param {string} lane - Lane name (e.g., 'ios get_version', 'android get_versions')
 * @param {object} options - Lane options
 * @returns {Promise<object>} Parsed JSON result
 */
async function runFastlane(lane, options = {}) {
  return new Promise((resolve, reject) => {
    const args = ['fastlane', lane];

    // Add options as key:value pairs
    for (const [key, value] of Object.entries(options)) {
      args.push(`${key}:${value}`);
    }

    log.info('fastlane-api', `Running: ${args.join(' ')}`);

    const proc = spawn('bundle', ['exec', ...args], {
      cwd: FASTLANE_DIR,
      shell: true,
      env: { ...process.env, FASTLANE_HIDE_CHANGELOG: 'true' }
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        log.error('fastlane-api', `Fastlane exited with code ${code}`, { stderr: stderr.slice(-500) });
        reject(new Error(`Fastlane failed: ${stderr.slice(-200)}`));
        return;
      }

      // Parse JSON from output (between markers)
      const jsonMatch = stdout.match(/---JSON_START---\s*([\s\S]*?)\s*---JSON_END---/);
      if (jsonMatch) {
        try {
          const result = JSON.parse(jsonMatch[1]);
          resolve(result);
        } catch (e) {
          log.error('fastlane-api', 'Failed to parse JSON output', { error: e.message });
          reject(new Error('Failed to parse Fastlane output'));
        }
      } else {
        log.warn('fastlane-api', 'No JSON output found in Fastlane response');
        resolve({ raw: stdout });
      }
    });

    proc.on('error', (err) => {
      log.error('fastlane-api', 'Failed to spawn Fastlane', { error: err.message });
      reject(err);
    });
  });
}

/**
 * Get all iOS app versions from App Store Connect
 */
async function getIOSVersions() {
  return runFastlane('ios', { lane: 'get_versions' });
}

/**
 * Get iOS version for a specific app
 * @param {string} bundleId - iOS bundle identifier
 */
async function getIOSVersion(bundleId) {
  return runFastlane('ios', { lane: 'get_version', bundle_id: bundleId });
}

/**
 * Get all Android app versions from Google Play
 */
async function getAndroidVersions() {
  return runFastlane('android', { lane: 'get_versions' });
}

/**
 * Get Android version for a specific app
 * @param {string} packageName - Android package name
 */
async function getAndroidVersion(packageName) {
  return runFastlane('android', { lane: 'get_version', package_name: packageName });
}

/**
 * Get all versions for all apps
 */
async function getAllVersions() {
  return runFastlane('get_all_versions');
}

/**
 * Match store versions to build changesets
 * @param {object} storeVersions - Store version data from Fastlane
 * @param {object} buildCache - Build data cache from Jenkins
 * @returns {object} Store versions with matched changeset info
 */
function matchVersionsToChangesets(storeVersions, buildCache) {
  const result = {
    timestamp: new Date().toISOString(),
    apps: {}
  };

  // Get project configs from main config
  for (const job of config.jobs) {
    const projectId = job.displayName.toLowerCase().replace(/\s+/g, '-');
    const appKey = job.displayName.toLowerCase().replace(/\s+/g, '_');

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
      const iosData = storeVersions.ios?.[appKey];
      if (iosData && !iosData.error) {
        result.apps[projectId].ios = {
          bundleId: job.bundleId,
          live: iosData.live,
          pending: iosData.pending,
          testflight: iosData.testflight,
          // Try to match build number to changeset
          liveChangeset: matchBuildToChangeset(iosData.live?.build, mainBranch, 'ios'),
          testflightChangeset: matchBuildToChangeset(iosData.testflight?.build, mainBranch, 'ios')
        };
      }
    }

    if (job.platform === 'android') {
      const androidData = storeVersions.android?.[appKey];
      if (androidData && !androidData.error) {
        const latestProduction = androidData.tracks?.production?.latest;
        const latestInternal = androidData.tracks?.internal?.latest;

        result.apps[projectId].android = {
          packageName: job.bundleId,
          tracks: androidData.tracks,
          // Try to match version codes to changesets
          productionChangeset: matchVersionCodeToChangeset(latestProduction, mainBranch, 'android'),
          internalChangeset: matchVersionCodeToChangeset(latestInternal, mainBranch, 'android')
        };
      }
    }
  }

  return result;
}

/**
 * Match a build number to a changeset from cached builds
 */
function matchBuildToChangeset(buildNumber, branchData, platform) {
  if (!buildNumber || !branchData) return null;

  // Look in release builds first
  const releaseKey = `${platform}ReleaseSuccess`;
  const releaseBuild = branchData[releaseKey];
  if (releaseBuild && releaseBuild.version === buildNumber) {
    return {
      changeset: releaseBuild.version,
      buildNumber: releaseBuild.number,
      timestamp: releaseBuild.timestamp
    };
  }

  // Look in all commits
  const matchingCommit = branchData.allCommits?.find(c => c.version === buildNumber);
  if (matchingCommit) {
    return {
      changeset: matchingCommit.version,
      timestamp: matchingCommit.timestamp
    };
  }

  return null;
}

/**
 * Match an Android version code to a changeset
 * (Version codes are often derived from changeset numbers)
 */
function matchVersionCodeToChangeset(versionCode, branchData, platform) {
  if (!versionCode || !branchData) return null;

  // Version code might be the changeset directly, or derived from it
  const versionStr = versionCode.toString();

  // Check if version code matches any known changeset
  const releaseKey = `${platform}ReleaseSuccess`;
  const releaseBuild = branchData[releaseKey];
  if (releaseBuild) {
    // Check if the version matches the build's changeset
    if (releaseBuild.version === versionStr) {
      return {
        changeset: releaseBuild.version,
        buildNumber: releaseBuild.number,
        timestamp: releaseBuild.timestamp
      };
    }
  }

  // Look through commits
  const matchingCommit = branchData.allCommits?.find(c =>
    c.version === versionStr ||
    versionStr.includes(c.version)
  );

  if (matchingCommit) {
    return {
      changeset: matchingCommit.version,
      timestamp: matchingCommit.timestamp
    };
  }

  return { versionCode };
}

module.exports = {
  runFastlane,
  getIOSVersions,
  getIOSVersion,
  getAndroidVersions,
  getAndroidVersion,
  getAllVersions,
  matchVersionsToChangesets
};
