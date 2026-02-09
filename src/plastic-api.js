const { exec } = require('child_process');
const log = require('./logger');

// Generic query-based cache for Plastic SCM commands
// Caches raw command output by exact command string - no business logic
const queryCache = {
  data: new Map(),
  ttl: 300000, // 5 minute TTL
  maxSize: 200, // Max entries to prevent memory bloat
  hits: 0,
  misses: 0
};

function getCacheKey(cmd) {
  // Use the exact command as the cache key
  return cmd;
}

function getCached(key) {
  const entry = queryCache.data.get(key);
  if (entry && Date.now() - entry.time < queryCache.ttl) {
    queryCache.hits++;
    return entry.value;
  }
  return null;
}

function setCache(key, value) {
  // Evict oldest entries if cache is full
  if (queryCache.data.size >= queryCache.maxSize) {
    // Remove oldest 20% of entries
    const entries = Array.from(queryCache.data.entries());
    entries.sort((a, b) => a[1].time - b[1].time);
    const toRemove = Math.ceil(queryCache.maxSize * 0.2);
    for (let i = 0; i < toRemove; i++) {
      queryCache.data.delete(entries[i][0]);
    }
    log.debug('plastic-api', `Evicted ${toRemove} old cache entries`);
  }
  queryCache.data.set(key, { value, time: Date.now() });
}

// Get cache stats for monitoring
function getCacheStats() {
  return {
    size: queryCache.data.size,
    maxSize: queryCache.maxSize,
    hits: queryCache.hits,
    misses: queryCache.misses,
    hitRate: queryCache.hits + queryCache.misses > 0
      ? (queryCache.hits / (queryCache.hits + queryCache.misses) * 100).toFixed(1) + '%'
      : '0%'
  };
}

// Clear the cache (useful for forced refresh)
function clearCache() {
  queryCache.data.clear();
  queryCache.hits = 0;
  queryCache.misses = 0;
  log.info('plastic-api', 'Cache cleared');
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
// Caches results by exact command string for fast repeated queries
function execCm(cmd, timeout = 10000, skipCache = false) {
  // Check cache first (unless skipCache is true)
  if (!skipCache) {
    const cacheKey = getCacheKey(cmd);
    const cached = getCached(cacheKey);
    if (cached !== null) {
      log.debug('plastic-api', `Cache hit: ${cmd.substring(0, 60)}...`);
      return Promise.resolve(cached);
    }
    queryCache.misses++;
  }

  return new Promise((resolve, reject) => {
    const proc = exec(cmd, { maxBuffer: 10 * 1024 * 1024, timeout }, (error, stdout, stderr) => {
      if (error) {
        log.error('plastic-api', `Command failed: ${cmd.substring(0, 80)}`, { error: error.message });
        reject(error);
        return;
      }
      // Cache successful results
      if (!skipCache) {
        setCache(getCacheKey(cmd), stdout);
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
  try {
    // Convert Jenkins branch name to Plastic format
    const plasticBranch = branch === 'main' ? '/main' : `/main/${branch}`;
    // Use order by + limit for fast lookup (on repository must come LAST in query)
    const cmd = `cm find changeset "where branch='${plasticBranch}' order by changesetid desc limit 1 on repository '${repository}'" --format="{changesetid}" --nototal`;
    const output = await execCm(cmd);
    const changeset = parseInt(output.trim());
    return isNaN(changeset) ? null : changeset;
  } catch (error) {
    log.error('plastic-api', `Failed to get latest changeset: ${repository}/${branch}`, { error: error.message });
    return null;
  }
}

// Get recent changesets with full details for a branch
async function getRecentChangesets(repository, branch = 'main', limit = 10) {
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

// Get all changesets reachable from toChangeset but not from fromChangeset
// This properly follows merge history through the DAG by including all commits from merged branches
async function getChangesetsWithMergeHistory(repository, fromChangeset, toChangeset) {
  log.info('plastic-api', `Getting changesets with merge history: ${repository}`, { fromChangeset, toChangeset });

  try {
    const changesets = [];
    const seen = new Set();

    // Step 1: Get direct commits on main in the range
    const directCommits = await getChangesetRange(repository, fromChangeset, toChangeset, 'main');
    for (const commit of directCommits) {
      if (!seen.has(commit.changeset)) {
        seen.add(commit.changeset);
        changesets.push({
          changeset: commit.changeset,
          author: commit.author,
          message: commit.message
        });
      }
    }

    log.info('plastic-api', `Found ${directCommits.length} direct commits on main`);

    // Step 2: Get all merges and cherry-picks in the range FROM feature branches INTO /main
    const allMerges = await getMergesInRange(repository, fromChangeset, toChangeset);
    const featureMerges = allMerges.filter(m =>
      m.destBranch === 'br:/main' && m.sourceBranch !== 'br:/main'
    );
    const merges = featureMerges.filter(m => m.type === 'merge');
    const cherryPicks = featureMerges.filter(m => m.type === 'cherrypick');
    log.info('plastic-api', `Found ${merges.length} branch merges and ${cherryPicks.length} cherry-picks into br:/main`);

    // Step 3: Find previous merges to avoid including already-merged commits
    // Look back to find if any of these branches were previously merged INTO /main FROM feature branches (not cherry-picks)
    log.info('plastic-api', 'Finding previous merges to determine commit ranges');
    const allHistoricalMerges = await getMergesInRange(repository, Math.max(0, fromChangeset - 2000), fromChangeset);
    const historicalMerges = allHistoricalMerges.filter(m =>
      m.destBranch === 'br:/main' &&
      m.sourceBranch !== 'br:/main' &&
      m.type === 'merge'
    );
    const lastMergeByBranch = new Map();
    for (const historicalMerge of historicalMerges) {
      const existing = lastMergeByBranch.get(historicalMerge.sourceBranch);
      if (!existing || historicalMerge.sourceChangeset > existing) {
        lastMergeByBranch.set(historicalMerge.sourceBranch, historicalMerge.sourceChangeset);
      }
    }
    log.info('plastic-api', `Found ${lastMergeByBranch.size} branches with previous merges into /main`);

    // Step 4: Fetch commits from merged branches in parallel
    // For each branch, only fetch commits since the last merge point
    const branchFetches = merges.map(merge => {
      const branchName = merge.sourceBranch.replace('/main/', '').replace('br:', '').replace('br:/', '');
      // Start from the last merge point for this branch (or 0 if never merged before)
      const startChangeset = lastMergeByBranch.get(merge.sourceBranch) || 0;
      log.info('plastic-api', `Fetching commits from ${merge.sourceBranch} merged at cs:${merge.destChangeset} (${startChangeset} to ${merge.sourceChangeset})`);
      return getChangesetRange(repository, startChangeset, merge.sourceChangeset, branchName)
        .then(branchCommits => ({ merge, branchCommits }))
        .catch(e => {
          log.warn('plastic-api', `Failed to get commits from merged branch ${merge.sourceBranch}`, { error: e.message });
          return { merge, branchCommits: [] };
        });
    });

    const branchResults = await Promise.all(branchFetches);

    // Add commits from branches that were merged after the store build
    // Only include commits that weren't in the previous merge
    // Tag each commit with the branch it came from and when it was merged
    for (const { merge, branchCommits } of branchResults) {
      log.info('plastic-api', `Processing merge ${merge.sourceBranch}: got ${branchCommits.length} commits from query`);
      let addedCount = 0;
      for (const commit of branchCommits) {
        if (!seen.has(commit.changeset)) {
          seen.add(commit.changeset);
          changesets.push({
            changeset: commit.changeset,
            author: commit.author,
            message: commit.message,
            mergedFrom: merge.sourceBranch,
            mergedAt: merge.destChangeset
          });
          addedCount++;
        }
      }
      if (addedCount > 0) {
        log.info('plastic-api', `Added ${addedCount} commits from branch ${merge.sourceBranch} (merged at cs:${merge.destChangeset})`);
      } else {
        log.warn('plastic-api', `No commits added from branch ${merge.sourceBranch} - either got 0 from query or all were duplicates`);
      }
    }

    // Step 5: Fetch details for cherry-picked commits in parallel
    const cherryPickFetches = cherryPicks.map(cp => {
      const branchName = cp.sourceBranch.replace('/main/', '').replace('br:', '').replace('br:/', '');
      log.info('plastic-api', `Fetching cherry-pick cs:${cp.sourceChangeset} from ${cp.sourceBranch}`);
      return getChangesetRange(repository, cp.sourceChangeset - 1, cp.sourceChangeset, branchName)
        .then(commits => ({ cherryPick: cp, commit: commits[0] || null }))
        .catch(e => {
          log.warn('plastic-api', `Failed to fetch cherry-pick ${cp.sourceChangeset}`, { error: e.message });
          return { cherryPick: cp, commit: null };
        });
    });

    const cherryPickResults = await Promise.all(cherryPickFetches);

    // Add cherry-picked commits (just the single commit that was cherry-picked)
    for (const { cherryPick, commit } of cherryPickResults) {
      if (!seen.has(cherryPick.sourceChangeset)) {
        seen.add(cherryPick.sourceChangeset);
        changesets.push({
          changeset: cherryPick.sourceChangeset,
          author: commit?.author || '',
          message: commit?.message || `Cherry-pick from ${cherryPick.sourceBranch}`,
          mergedFrom: cherryPick.sourceBranch,
          mergedAt: cherryPick.destChangeset,
          isCherryPick: true
        });
        log.info('plastic-api', `Added cherry-pick cs:${cherryPick.sourceChangeset} from ${cherryPick.sourceBranch} at cs:${cherryPick.destChangeset}`);
      }
    }

    // Sort by changeset number descending
    changesets.sort((a, b) => b.changeset - a.changeset);

    log.info('plastic-api', `Total ${changesets.length} changesets including ${merges.length} branch merges and ${cherryPicks.length} cherry-picks`);
    return changesets;
  } catch (error) {
    log.error('plastic-api', `Failed to get changesets with merge history: ${repository}`, { error: error.message });
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
  getChangesetList,
  getChangesetsWithMergeHistory,
  // Cache utilities
  getCacheStats,
  clearCache
};
