const { exec } = require('child_process');
const log = require('./logger');

// Cache for Plastic data (reduces repeated calls)
const plasticCache = {
  data: new Map(),
  ttl: 300000 // 5 minute TTL (plastic data doesn't change that frequently)
};

function getCached(key) {
  const entry = plasticCache.data.get(key);
  if (entry && Date.now() - entry.time < plasticCache.ttl) {
    return entry.value;
  }
  return null;
}

function setCache(key, value) {
  plasticCache.data.set(key, { value, time: Date.now() });
}

// Parse date string like "28/10/2025 7:56:23 am" to timestamp
function parseDate(dateStr) {
  // Format: DD/MM/YYYY H:MM:SS am/pm
  const match = dateStr.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+):(\d+)\s+(am|pm)/i);
  if (!match) return 0;

  let [, day, month, year, hours, minutes, seconds, ampm] = match;
  hours = parseInt(hours);
  if (ampm.toLowerCase() === 'pm' && hours !== 12) hours += 12;
  if (ampm.toLowerCase() === 'am' && hours === 12) hours = 0;

  return new Date(year, month - 1, day, hours, minutes, seconds).getTime();
}

// Execute cm command and return output (with timeout)
function execCm(cmd, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const proc = exec(cmd, { maxBuffer: 10 * 1024 * 1024, timeout }, (error, stdout, stderr) => {
      if (error) {
        log.error('plastic-api', `Command failed: ${cmd.substring(0, 80)}`, { error: error.message });
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

// Get branches with recent changesets from a repository
async function getActiveBranches(repository, days = 30) {
  log.info('plastic-api', `Fetching active branches: ${repository}`, { days });

  try {
    // Query changesets from the last N days and extract branch info
    const cmd = `cm find changeset "where date >= '${days} days ago' on repository '${repository}'" --format="{branch}|{changesetid}|{date}|{comment}" --nototal`;
    const output = await execCm(cmd);

    // Parse output and group by branch
    const branchMap = new Map();
    const lines = output.trim().split('\n').filter(line => line.trim());

    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length < 4) continue;

      const [branchName, changesetId, dateStr, ...commentParts] = parts;
      const comment = commentParts.join('|'); // In case comment has pipes
      const timestamp = parseDate(dateStr);
      const changeset = parseInt(changesetId);

      if (!branchMap.has(branchName)) {
        branchMap.set(branchName, {
          name: branchName,
          latestChangeset: changeset,
          latestTimestamp: timestamp,
          commits: []
        });
      }

      const branch = branchMap.get(branchName);

      // Track latest changeset
      if (changeset > branch.latestChangeset) {
        branch.latestChangeset = changeset;
        branch.latestTimestamp = timestamp;
      }

      // Store commits (limit to most recent 10 per branch)
      if (branch.commits.length < 10) {
        branch.commits.push({
          changeset,
          message: comment?.split('\n')[0] || '',
          timestamp
        });
      }
    }

    // Convert to array and sort by latest activity
    const branches = Array.from(branchMap.values());
    branches.sort((a, b) => b.latestTimestamp - a.latestTimestamp);

    // Sort commits within each branch by changeset (newest first)
    for (const branch of branches) {
      branch.commits.sort((a, b) => b.changeset - a.changeset);
    }

    log.info('plastic-api', `Found ${branches.length} active branches: ${repository}`);
    return branches;
  } catch (error) {
    log.error('plastic-api', `Failed to fetch branches: ${repository}`, { error: error.message });
    return [];
  }
}

// Get the latest changeset number for a branch in a repository
async function getLatestChangeset(repository, branch = 'main') {
  const cacheKey = `latest:${repository}:${branch}`;
  const cached = getCached(cacheKey);
  if (cached !== null) return cached;

  try {
    // Convert Jenkins branch name to Plastic format
    const plasticBranch = branch === 'main' ? '/main' : `/main/${branch}`;
    // Use order by + limit for fast lookup (on repository must come LAST in query)
    const cmd = `cm find changeset "where branch='${plasticBranch}' order by changesetid desc limit 1 on repository '${repository}'" --format="{changesetid}" --nototal`;
    const output = await execCm(cmd);
    const changeset = parseInt(output.trim());
    const result = isNaN(changeset) ? null : changeset;
    setCache(cacheKey, result);
    return result;
  } catch (error) {
    log.error('plastic-api', `Failed to get latest changeset: ${repository}/${branch}`, { error: error.message });
    return null;
  }
}

// Get recent changesets with full details for a branch
async function getRecentChangesets(repository, branch = 'main', limit = 10) {
  const cacheKey = `recent:${repository}:${branch}:${limit}`;
  const cached = getCached(cacheKey);
  if (cached !== null) return cached;

  try {
    const plasticBranch = branch === 'main' ? '/main' : `/main/${branch}`;
    // Use order by + limit for fast lookup (on repository must come LAST in query)
    const cmd = `cm find changeset "where branch='${plasticBranch}' order by changesetid desc limit ${limit} on repository '${repository}'" --format="{changesetid}|{owner}|{date}|{comment}" --nototal`;
    const output = await execCm(cmd);
    const lines = output.trim().split('\n').filter(line => line.trim());

    const changesets = [];
    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length < 4) continue;

      const [changesetId, owner, dateStr, ...commentParts] = parts;
      const changeset = parseInt(changesetId);
      if (isNaN(changeset)) continue;

      changesets.push({
        version: changeset,
        author: owner?.trim() || '',
        timestamp: parseDate(dateStr),
        message: commentParts.join('|')?.split('\n')[0]?.trim() || ''
      });
    }

    setCache(cacheKey, changesets);
    return changesets;
  } catch (error) {
    log.error('plastic-api', `Failed to get recent changesets: ${repository}/${branch}`, { error: error.message });
    return [];
  }
}

// Normalize branch name (remove /main prefix for matching with Jenkins)
function normalizeBranchName(plasticBranch) {
  // Remove leading /main/ or /main prefix
  let name = plasticBranch.replace(/^\/main\//, '').replace(/^\/main$/, 'main');
  // If it's just /main, return 'main'
  if (name === '' || name === '/') name = 'main';
  return name;
}

// Get all changesets between two points on the main branch only
async function getChangesetRange(repository, fromChangeset, toChangeset, branch = 'main') {
  log.info('plastic-api', `Getting changeset range: ${repository}`, { fromChangeset, toChangeset, branch });

  try {
    // Only get changesets directly on the specified branch (not merged feature branches)
    const plasticBranch = branch === 'main' ? '/main' : `/main/${branch}`;
    const cmd = `cm find changeset "where changesetid > ${fromChangeset} and changesetid <= ${toChangeset} and branch='${plasticBranch}' on repository '${repository}'" --format="{changesetid}|{branch}|{owner}|{date}|{comment}" --nototal`;
    const output = await execCm(cmd, 30000);

    const lines = output.trim().split('\n').filter(line => line.trim());
    const changesets = [];

    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length < 5) continue;

      const [changesetId, branchName, owner, date, ...commentParts] = parts;
      const changeset = parseInt(changesetId);
      if (isNaN(changeset)) continue;

      changesets.push({
        changeset,
        branch: branchName?.trim() || '',
        author: owner?.trim() || '',
        date: date?.trim() || '',
        message: commentParts.join('|')?.trim() || ''
      });
    }

    // Sort by changeset descending (newest first)
    changesets.sort((a, b) => b.changeset - a.changeset);

    log.info('plastic-api', `Found ${changesets.length} changesets on ${branch} in range: ${repository}`);
    return changesets;
  } catch (error) {
    log.error('plastic-api', `Failed to get changeset range: ${repository}`, { error: error.message });
    return [];
  }
}

// Get merges that contributed to a changeset range
async function getMergesInRange(repository, fromChangeset, toChangeset) {
  log.info('plastic-api', `Getting merges in range: ${repository}`, { fromChangeset, toChangeset });

  try {
    // Find merges where destination is in our range
    const cmd = `cm find merge "where dstchangeset >= ${fromChangeset} and dstchangeset <= ${toChangeset}" on repository '${repository}' --format="{srcbranch}|{srcchangeset}|{dstbranch}|{dstchangeset}|{owner}|{type}" --nototal`;
    const output = await execCm(cmd);

    const lines = output.trim().split('\n').filter(line => line.trim());
    const merges = [];

    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length < 6) continue;

      const [srcBranch, srcChangeset, dstBranch, dstChangeset, owner, mergeType] = parts;

      merges.push({
        sourceBranch: srcBranch?.trim() || '',
        sourceChangeset: parseInt(srcChangeset) || 0,
        destBranch: dstBranch?.trim() || '',
        destChangeset: parseInt(dstChangeset) || 0,
        author: owner?.trim() || '',
        type: mergeType?.trim() || 'merge'
      });
    }

    // Sort by destination changeset descending
    merges.sort((a, b) => b.destChangeset - a.destChangeset);

    log.info('plastic-api', `Found ${merges.length} merges in range: ${repository}`);
    return merges;
  } catch (error) {
    log.error('plastic-api', `Failed to get merges in range: ${repository}`, { error: error.message });
    return [];
  }
}

// Get file differences between two changesets
async function getFileDiff(repository, fromChangeset, toChangeset) {
  log.info('plastic-api', `Getting file diff: ${repository}`, { fromChangeset, toChangeset });

  try {
    // Get files that changed between the two changesets
    const cmd = `cm diff cs:${fromChangeset}@rep:${repository} cs:${toChangeset}@rep:${repository} --format="{status}|{path}" --repositorypaths`;
    const output = await execCm(cmd);

    const lines = output.trim().split('\n').filter(line => line.trim());
    const files = [];

    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length < 2) continue;

      const [status, ...pathParts] = parts;
      const path = pathParts.join('|')?.trim();

      // Map short status to full name
      const statusMap = {
        'A': 'Added',
        'C': 'Changed',
        'D': 'Deleted',
        'M': 'Moved'
      };

      files.push({
        status: status?.trim() || '',
        statusName: statusMap[status?.trim()] || status?.trim() || '',
        path: path || ''
      });
    }

    // Sort by status then path
    files.sort((a, b) => {
      if (a.status !== b.status) return a.status.localeCompare(b.status);
      return a.path.localeCompare(b.path);
    });

    log.info('plastic-api', `Found ${files.length} changed files: ${repository}`);
    return files;
  } catch (error) {
    log.error('plastic-api', `Failed to get file diff: ${repository}`, { error: error.message });
    return [];
  }
}

// Get more changesets for a branch (for dropdown population)
async function getChangesetList(repository, branch = 'main', limit = 30) {
  try {
    const plasticBranch = branch === 'main' ? '/main' : `/main/${branch}`;
    // Use order by + limit for fast lookup (on repository must come LAST in query)
    const cmd = `cm find changeset "where branch='${plasticBranch}' order by changesetid desc limit ${limit} on repository '${repository}'" --format="{changesetid}|{owner}|{date}|{comment}" --nototal`;
    const output = await execCm(cmd);
    const lines = output.trim().split('\n').filter(line => line.trim());

    const changesets = [];
    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length < 4) continue;

      const [changesetId, owner, date, ...commentParts] = parts;
      const changeset = parseInt(changesetId);
      if (isNaN(changeset)) continue;

      changesets.push({
        changeset,
        author: owner?.trim() || '',
        date: date?.trim() || '',
        message: commentParts.join('|')?.split('\n')[0]?.trim() || ''
      });
    }

    return changesets;
  } catch (error) {
    log.error('plastic-api', `Failed to get changeset list: ${repository}/${branch}`, { error: error.message });
    return [];
  }
}

module.exports = {
  getActiveBranches,
  getLatestChangeset,
  getRecentChangesets,
  normalizeBranchName,
  getChangesetRange,
  getMergesInRange,
  getFileDiff,
  getChangesetList
};
