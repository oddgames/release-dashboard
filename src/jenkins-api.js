const fetch = require('node-fetch');
const config = require('./config');
const log = require('./logger');

const { baseUrl, username, apiToken } = config.jenkins;

const auth = Buffer.from(`${username}:${apiToken}`).toString('base64');

async function jenkinsRequest(endpoint) {
  if (!baseUrl) {
    log.warn('jenkins-api', 'Jenkins baseUrl not configured, skipping request', { endpoint: endpoint.substring(0, 80) });
    throw new Error('Jenkins baseUrl not configured');
  }
  const url = `${baseUrl}${endpoint}`;
  log.debug('jenkins-api', `GET ${endpoint.substring(0, 60)}...`);

  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      log.error('jenkins-api', `HTTP ${response.status}`, { endpoint: endpoint.substring(0, 80) });
      throw new Error(`Jenkins API error: ${response.status}`);
    }

    return response.json();
  } catch (error) {
    log.error('jenkins-api', error.message, { endpoint: endpoint.substring(0, 80) });
    throw error;
  }
}

async function getRecentBuilds(jobName, historyDays = 30, sinceNumber = null) {
  if (sinceNumber) {
    log.info('jenkins-api', `Fetching builds: ${jobName} (since #${sinceNumber})`);
  } else {
    log.info('jenkins-api', `Fetching builds: ${jobName}`, { historyDays });
  }

  const cutoffTime = Date.now() - (historyDays * 24 * 60 * 60 * 1000);

  // Fetch builds with parameters, sidebar links, git info, badges, and display name (version)
  const endpoint = `/job/${jobName}/api/json?tree=builds[number,displayName,result,timestamp,duration,actions[id,text,parameters[name,value],lastBuiltRevision[branch[name]],urlName,iconFileName],changeSets[items[msg,author[fullName]]]]`;

  try {
    const data = await jenkinsRequest(endpoint);
    const builds = [];

    for (const build of data.builds || []) {
      // Stop early if we've reached builds we already have (incremental mode)
      if (sinceNumber && build.number <= sinceNumber) break;

      // Filter by date (full refresh mode)
      if (!sinceNumber && build.timestamp < cutoffTime) break;

      // Extract branch name, build type, changeset, and links from actions
      let branch = 'main';
      let buildType = 'Debug';
      let changeset = null;
      let version = null;
      let downloadUrl = null;
      let driveFolder = null;

      for (const action of build.actions || []) {
        // Git branch info
        if (action.lastBuiltRevision?.branch) {
          const branchRef = action.lastBuiltRevision.branch[0]?.name || '';
          branch = branchRef.replace(/^refs\/heads\//, '').replace(/^origin\//, '');
        }

        // Build parameters (BUILD_TYPE, BRANCH, CHANGESET, VERSION, etc.)
        if (action.parameters) {
          for (const param of action.parameters) {
            if (param.name === 'BUILD_TYPE') buildType = param.value;
            if (param.name === 'BRANCH' && !branch) branch = param.value;
            if (param.name === 'CHANGESET' || param.name === 'P4_CHANGELIST') changeset = param.value;
            if (param.name === 'VERSION' || param.name === 'BUILD_VERSION') version = param.value;
          }
        }

        // Badge actions - extract changeset from branch badge (format: /branch-changeset)
        if (action.id === 'branch' && action.text) {
          // Parse badge text like: <img src="...badge/%2Fmain-9495-blue..." />
          const match = action.text.match(/badge\/([^-]+)-(\d+)/);
          if (match) {
            changeset = match[2]; // The changeset number
          }
        }

        // Badge action for IPA/APK download link
        if ((action.id === 'ipa' || action.id === 'apk') && action.text) {
          const hrefMatch = action.text.match(/href="([^"]+)"/);
          if (hrefMatch) {
            downloadUrl = hrefMatch[1].replace(/&#61;/g, '=').replace(/&amp;/g, '&');
          }
        }

        // Sidebar links (Google Drive download) - legacy
        if (action.urlName && action.text) {
          if (action.text.includes('Download')) {
            downloadUrl = action.urlName;
          } else if (action.text.includes('Google Drive')) {
            driveFolder = action.urlName;
          }
        }
      }

      // Track builds that need env vars fetched (running builds only, for speed)
      const isRunning = !build.result;
      const needsEnvVars = isRunning && !changeset;

      // Version string - just the changeset number
      const versionString = changeset || version || null;

      // Parse changeset
      const changeSet = [];
      if (build.changeSets) {
        for (const cs of build.changeSets) {
          for (const item of cs.items || []) {
            changeSet.push({
              message: item.msg,
              author: item.author?.fullName || 'Unknown'
            });
          }
        }
      }

      // Debug: log Release builds
      if (buildType !== 'Debug') {
        log.debug('jenkins-api', `Found ${buildType} build: ${jobName}#${build.number} (${versionString})`);
      }

      builds.push({
        number: build.number,
        version: versionString,
        result: build.result,
        timestamp: build.timestamp,
        duration: build.duration,
        branch,
        buildType,
        changeSet,
        downloadUrl,
        driveFolder,
        isRelease: buildType === 'Release' || branch.includes('release'),
        jobName // Store job name for fetching error analysis later
      });
    }

    // Log buildType distribution
    const typeCount = builds.reduce((acc, b) => { acc[b.buildType] = (acc[b.buildType] || 0) + 1; return acc; }, {});
    log.info('jenkins-api', `${jobName}: fetched ${builds.length} builds`, typeCount);

    builds.sort((a, b) => b.timestamp - a.timestamp);

    // Fetch ERROR_ANALYSIS for failed/unstable builds (only latest per branch/buildType combo)
    const seenBranchTypes = new Set();
    const failedBuilds = builds.filter(b => {
      if (b.result !== 'FAILURE' && b.result !== 'UNSTABLE') return false;
      const key = `${b.branch}:${b.buildType}`;
      if (seenBranchTypes.has(key)) return false;
      seenBranchTypes.add(key);
      return true;
    });

    // Fetch error analysis in parallel (with limit to avoid overwhelming Jenkins)
    const errorPromises = failedBuilds.slice(0, 10).map(async (build) => {
      try {
        const env = await getBuildEnvVars(jobName, build.number);
        if (env?.ERROR_ANALYSIS) {
          build.errorAnalysis = env.ERROR_ANALYSIS;
        }
      } catch (e) {
        // Silently ignore - error analysis is optional
      }
    });
    await Promise.all(errorPromises);

    if (sinceNumber) {
      log.info('jenkins-api', `Found ${builds.length} new builds: ${jobName} (since #${sinceNumber})`);
    } else {
      log.info('jenkins-api', `Found ${builds.length} builds: ${jobName}`);
    }
    return builds;
  } catch (error) {
    log.error('jenkins-api', `Failed: ${jobName}`, { error: error.message });
    return [];
  }
}

// Fetch environment variables for a build (from EnvActionImpl in pipeline)
// Uses depth=2 to get the environment object from workflow actions
async function getBuildEnvVars(jobName, buildNumber) {
  const endpoint = `/job/${jobName}/${buildNumber}/api/json?depth=2`;
  const url = `${baseUrl}${endpoint}`;

  // Create abort controller with 5 second timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json'
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    // Look for EnvActionImpl action which contains pipeline environment variables
    for (const action of data.actions || []) {
      if (action._class === 'org.jenkinsci.plugins.workflow.cps.EnvActionImpl' && action.environment) {
        return action.environment;
      }
    }

    return null;
  } catch (error) {
    clearTimeout(timeoutId);
    // Network error, timeout, or parse error - silently return null
    return null;
  }
}

async function getBuildArtifacts(jobName, buildNumber) {
  try {
    const endpoint = `/job/${jobName}/${buildNumber}/api/json?tree=artifacts[fileName,relativePath]`;
    const data = await jenkinsRequest(endpoint);

    return (data.artifacts || [])
      .filter(a => /\.(ipa|apk|aab)$/i.test(a.fileName))
      .map(a => ({
        fileName: a.fileName,
        url: `${baseUrl}/job/${jobName}/${buildNumber}/artifact/${a.relativePath}`,
        type: a.fileName.split('.').pop().toUpperCase()
      }));
  } catch (error) {
    return [];
  }
}

async function triggerBuild(jobName, parameters = {}) {
  const endpoint = `/job/${jobName}/buildWithParameters`;
  const url = `${baseUrl}${endpoint}`;

  log.info('jenkins-api', `Triggering build: ${jobName}`, { parameters });

  try {
    // Build form data for parameters
    const formData = new URLSearchParams();
    for (const [key, value] of Object.entries(parameters)) {
      formData.append(key, value);
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: formData.toString()
    });

    // Jenkins returns 201 for successful build trigger
    if (response.status === 201 || response.ok) {
      log.info('jenkins-api', `Build triggered: ${jobName}`);
      return { success: true, jobName };
    }

    log.error('jenkins-api', `Failed to trigger build: ${jobName}`, { status: response.status });
    throw new Error(`Failed to trigger build: ${response.status}`);
  } catch (error) {
    log.error('jenkins-api', `Trigger build error: ${jobName}`, { error: error.message });
    throw error;
  }
}

async function getBuildInfo(jobName, branch) {
  const encodedBranch = encodeURIComponent(branch);
  const endpoint = `/job/${jobName}/job/${encodedBranch}/lastBuild/api/json?tree=number,result,timestamp,duration,changeSets[items[msg,author[fullName],date]]`;

  try {
    const build = await jenkinsRequest(endpoint);

    const changeSet = [];
    if (build.changeSets) {
      for (const cs of build.changeSets) {
        for (const item of cs.items || []) {
          changeSet.push({
            message: item.msg,
            author: item.author?.fullName || 'Unknown',
            date: item.date
          });
        }
      }
    }

    const artifacts = await getBuildArtifacts(`${jobName}/job/${encodedBranch}`, 'lastSuccessfulBuild');

    return {
      buildNumber: build.number,
      status: build.result || 'IN_PROGRESS',
      timestamp: build.timestamp,
      duration: build.duration,
      changeSet,
      artifacts
    };
  } catch (error) {
    throw error;
  }
}

async function getQueuedBuilds() {
  log.debug('jenkins-api', 'Fetching build queue');

  try {
    const endpoint = '/queue/api/json?tree=items[id,task[name],actions[parameters[name,value]]]';
    const data = await jenkinsRequest(endpoint);

    const queuedBuilds = [];
    for (const item of data.items || []) {
      const jobName = item.task?.name;
      let branch = 'main';
      let buildType = 'Debug';

      // Extract parameters from actions
      for (const action of item.actions || []) {
        if (action.parameters) {
          for (const param of action.parameters) {
            if (param.name === 'BRANCH') branch = param.value;
            if (param.name === 'BUILD_TYPE') buildType = param.value;
          }
        }
      }

      queuedBuilds.push({
        id: item.id,
        jobName,
        branch,
        buildType
      });
    }

    log.debug('jenkins-api', `Found ${queuedBuilds.length} queued builds`);
    return queuedBuilds;
  } catch (error) {
    log.error('jenkins-api', 'Failed to fetch queue', { error: error.message });
    return [];
  }
}

// List available credentials from Jenkins credential store
// Note: Jenkins API only exposes credential IDs and metadata, not actual secrets
async function getCredentials() {
  log.info('jenkins-api', 'Fetching credentials list');

  try {
    // Try system-level credentials first
    const endpoint = '/credentials/store/system/domain/_/api/json?tree=credentials[id,displayName,typeName,description]';
    const data = await jenkinsRequest(endpoint);

    const credentials = (data.credentials || []).map(cred => ({
      id: cred.id,
      displayName: cred.displayName || cred.id,
      type: cred.typeName,
      description: cred.description || ''
    }));

    log.info('jenkins-api', `Found ${credentials.length} credentials`);
    return credentials;
  } catch (error) {
    log.error('jenkins-api', 'Failed to fetch credentials', { error: error.message });
    return [];
  }
}

// Get a secret file credential's content via Jenkins Script Console
// Requires admin permissions on Jenkins
async function getSecretFileCredential(credentialId) {
  log.info('jenkins-api', `Fetching secret file: ${credentialId}`);

  const groovyScript = `
import com.cloudbees.plugins.credentials.CredentialsProvider
import com.cloudbees.plugins.credentials.domains.Domain
import org.jenkinsci.plugins.plaincredentials.FileCredentials

def creds = CredentialsProvider.lookupCredentials(
    FileCredentials.class,
    Jenkins.instance,
    null,
    null
)

def target = creds.find { it.id == '${credentialId}' }
if (target) {
    println target.content.text
} else {
    println "CREDENTIAL_NOT_FOUND"
}
`;

  try {
    const url = `${baseUrl}/scriptText`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: `script=${encodeURIComponent(groovyScript)}`
    });

    if (!response.ok) {
      throw new Error(`Script console error: ${response.status}`);
    }

    const text = await response.text();
    if (text.includes('CREDENTIAL_NOT_FOUND')) {
      throw new Error(`Credential not found: ${credentialId}`);
    }

    return text.trim();
  } catch (error) {
    log.error('jenkins-api', `Failed to fetch secret file: ${credentialId}`, { error: error.message });
    throw error;
  }
}

// Get a secret text credential's value via Jenkins Script Console
async function getSecretTextCredential(credentialId) {
  log.info('jenkins-api', `Fetching secret text: ${credentialId}`);

  const groovyScript = `
import com.cloudbees.plugins.credentials.CredentialsProvider
import org.jenkinsci.plugins.plaincredentials.StringCredentials

def creds = CredentialsProvider.lookupCredentials(
    StringCredentials.class,
    Jenkins.instance,
    null,
    null
)

def target = creds.find { it.id == '${credentialId}' }
if (target) {
    println target.secret.plainText
} else {
    println "CREDENTIAL_NOT_FOUND"
}
`;

  try {
    const url = `${baseUrl}/scriptText`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: `script=${encodeURIComponent(groovyScript)}`
    });

    if (!response.ok) {
      throw new Error(`Script console error: ${response.status}`);
    }

    const text = await response.text();
    if (text.includes('CREDENTIAL_NOT_FOUND')) {
      throw new Error(`Credential not found: ${credentialId}`);
    }

    return text.trim();
  } catch (error) {
    log.error('jenkins-api', `Failed to fetch secret text: ${credentialId}`, { error: error.message });
    throw error;
  }
}

// Get current pipeline stage for in-progress builds
async function getPipelineStages(jobName, buildNumber) {
  const endpoint = `/job/${jobName}/${buildNumber}/wfapi/describe`;

  try {
    const data = await jenkinsRequest(endpoint);
    const stages = data.stages || [];

    // Find the current stage (IN_PROGRESS) or the last completed stage
    const currentStage = stages.find(s => s.status === 'IN_PROGRESS');
    const completedStages = stages.filter(s => s.status === 'SUCCESS');
    const lastCompletedStage = completedStages[completedStages.length - 1];

    return {
      status: data.status,
      currentStage: currentStage?.name || null,
      lastCompletedStage: lastCompletedStage?.name || null,
      totalStages: stages.length,
      completedCount: completedStages.length,
      stages: stages.map(s => ({
        name: s.name,
        status: s.status,
        durationMillis: s.durationMillis
      }))
    };
  } catch (error) {
    log.debug('jenkins-api', `Failed to get pipeline stages: ${jobName}/${buildNumber}`, { error: error.message });
    return null;
  }
}

// Optimized lightweight function for Build History (minimal data, fast)
async function getBuildHistory(jobName, limit = 20) {
  log.info('jenkins-api', `Fetching build history: ${jobName}`, { limit });

  // Minimal query - only fetch what we need, no deep nesting
  const endpoint = `/job/${jobName}/api/json?tree=builds[{0,${limit}}][number,displayName,result,timestamp,actions[parameters[name,value]]]`;

  try {
    const data = await jenkinsRequest(endpoint);
    const builds = [];

    for (const build of data.builds || []) {
      let branch = 'main';
      let buildType = 'Debug';
      let changeset = null;
      let version = null;

      // Extract build parameters only (lightweight)
      for (const action of build.actions || []) {
        if (action.parameters) {
          for (const param of action.parameters) {
            if (param.name === 'BUILD_TYPE') buildType = param.value;
            if (param.name === 'BRANCH') branch = param.value;
            if (param.name === 'CHANGESET' || param.name === 'P4_CHANGELIST') changeset = param.value;
            if (param.name === 'VERSION' || param.name === 'BUILD_VERSION') version = param.value;
          }
        }
      }

      if (!version) {
        version = build.displayName || changeset || `#${build.number}`;
      }

      builds.push({
        number: build.number,
        result: build.result,
        timestamp: build.timestamp,
        branch,
        buildType,
        version,
        jobName  // Store job name for lazy download fetching
      });
    }

    log.info('jenkins-api', `Found ${builds.length} builds: ${jobName}`);
    return builds;
  } catch (error) {
    log.error('jenkins-api', `Failed to fetch build history: ${jobName}`, { error: error.message });
    return [];
  }
}

// Fetch download URL for a specific build (lazy-loaded when user clicks)
async function getBuildDownloadUrl(jobName, buildNumber) {
  log.info('jenkins-api', `Fetching download URL: ${jobName}/${buildNumber}`);

  // Fetch only the actions with badge links
  const endpoint = `/job/${jobName}/${buildNumber}/api/json?tree=actions[id,text]`;

  try {
    const data = await jenkinsRequest(endpoint);

    for (const action of data.actions || []) {
      // Badge action for IPA/APK download link
      if ((action.id === 'ipa' || action.id === 'apk') && action.text) {
        const hrefMatch = action.text.match(/href="([^"]+)"/);
        if (hrefMatch) {
          const url = hrefMatch[1].replace(/&#61;/g, '=').replace(/&amp;/g, '&');
          return { platform: action.id === 'ipa' ? 'ios' : 'android', url };
        }
      }
    }

    return null;
  } catch (error) {
    log.error('jenkins-api', `Failed to fetch download URL: ${jobName}/${buildNumber}`, { error: error.message });
    return null;
  }
}

// Get just the last build number for a job (lightweight check)
async function getLastBuildNumber(jobName) {
  const endpoint = `/job/${jobName}/api/json?tree=lastBuild[number]`;
  try {
    const data = await jenkinsRequest(endpoint);
    return data.lastBuild?.number || null;
  } catch (error) {
    log.warn('jenkins-api', `Failed to get last build number: ${jobName}`);
    return null;
  }
}

// Get last build numbers for multiple jobs in parallel
async function getLastBuildNumbers(jobNames) {
  const results = {};
  await Promise.all(jobNames.map(async (jobName) => {
    results[jobName] = await getLastBuildNumber(jobName);
  }));
  return results;
}

// Get updated status for specific builds (used for refreshing in-progress builds)
async function getBuildStatuses(builds) {
  // builds = [{ jobName, number }, ...]
  const results = [];

  await Promise.all(builds.map(async ({ jobName, number }) => {
    try {
      const endpoint = `/job/${jobName}/${number}/api/json?tree=number,result,timestamp,duration`;
      const data = await jenkinsRequest(endpoint);
      results.push({
        jobName,
        number: data.number,
        result: data.result, // null if still running, SUCCESS/FAILURE/etc if done
        timestamp: data.timestamp,
        duration: data.duration
      });
    } catch (e) {
      // Build may have been deleted or job renamed
      log.debug('jenkins-api', `Failed to get status for ${jobName}#${number}: ${e.message}`);
    }
  }));

  return results;
}

/**
 * Validate Jenkins credentials by attempting to access the user's API endpoint
 * Returns user info if valid, null if invalid
 */
async function validateCredentials(username, password) {
  const testAuth = Buffer.from(`${username}:${password}`).toString('base64');
  const url = `${baseUrl}/me/api/json`;

  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Basic ${testAuth}`,
        'Accept': 'application/json'
      }
    });

    if (response.ok) {
      const data = await response.json();
      log.info('jenkins-api', `Credentials validated for user: ${data.fullName || username}`);
      return {
        valid: true,
        username: data.id || username,
        fullName: data.fullName || username
      };
    }

    log.warn('jenkins-api', `Invalid credentials for user: ${username}`, { status: response.status });
    return { valid: false };
  } catch (error) {
    log.error('jenkins-api', `Credential validation error for user: ${username}`, { error: error.message });
    return { valid: false, error: error.message };
  }
}

module.exports = {
  getBuildEnvVars,
  getBuildInfo,
  getBuildStatuses,
  getCredentials,
  getPipelineStages,
  getSecretFileCredential,
  getSecretTextCredential,
  getRecentBuilds,
  getQueuedBuilds,
  jenkinsRequest,
  triggerBuild,
  getBuildHistory,
  getBuildDownloadUrl,
  getLastBuildNumber,
  getLastBuildNumbers,
  validateCredentials
};
