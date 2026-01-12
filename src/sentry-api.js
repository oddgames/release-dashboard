const fetch = require('node-fetch');
const config = require('./config');
const log = require('./logger');

const { baseUrl, authToken, organization, statsPeriod } = config.sentry || {};

// Cache for Sentry issues - fetch once, filter locally
const issueCache = new Map();
const CACHE_TTL = 300000; // 5 minutes

/**
 * Make authenticated request to Sentry API
 */
async function sentryRequest(endpoint) {
  if (!authToken) {
    throw new Error('Sentry auth token not configured');
  }

  const url = `${baseUrl}/api/0${endpoint}`;
  log.debug('sentry-api', `GET ${endpoint.substring(0, 60)}...`);

  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      log.error('sentry-api', `HTTP ${response.status}`, { endpoint: endpoint.substring(0, 80) });
      throw new Error(`Sentry API error: ${response.status}`);
    }

    return response.json();
  } catch (error) {
    log.error('sentry-api', error.message, { endpoint: endpoint.substring(0, 80) });
    throw error;
  }
}

/**
 * Get project issues from Sentry for the last 7 days
 * @param {string} projectSlug - Sentry project slug
 * @returns {Promise<Array>} List of issues with full details
 */
async function getProjectIssues7d(projectSlug) {
  const cacheKey = `${projectSlug}:7d`;
  const cached = issueCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    log.debug('sentry-api', `Using cached 7d issues for ${projectSlug}`, { count: cached.issues.length });
    return cached.issues;
  }

  // Fetch unresolved errors from last 7 days
  const query = 'is:unresolved';
  const endpoint = `/projects/${organization}/${projectSlug}/issues/?query=${encodeURIComponent(query)}&statsPeriod=7d&sort=freq`;

  try {
    const issues = await sentryRequest(endpoint);
    log.info('sentry-api', `Fetched ${issues.length} issues for ${projectSlug} (7 days)`);

    issueCache.set(cacheKey, {
      issues,
      timestamp: Date.now()
    });

    return issues;
  } catch (error) {
    log.warn('sentry-api', `Failed to fetch issues for ${projectSlug}`, { error: error.message });
    return [];
  }
}

/**
 * Get ALL project issues from Sentry and cache them
 * Fetches ALL unhandled errors from the last 14 days without release filtering
 * @param {string} projectSlug - Sentry project slug
 * @returns {Promise<Array>} List of ALL issues with full details
 */
async function getAllProjectIssues(projectSlug) {
  // Check cache first
  const cached = issueCache.get(projectSlug);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    log.debug('sentry-api', `Using cached issues for ${projectSlug}`, { count: cached.issues.length });
    return cached.issues;
  }

  // Fetch all unhandled errors from last 14 days
  const query = 'is:unresolved error.unhandled:true environment:[release,production]';
  const endpoint = `/projects/${organization}/${projectSlug}/issues/?query=${encodeURIComponent(query)}&statsPeriod=14d`;

  try {
    const issues = await sentryRequest(endpoint);
    log.info('sentry-api', `Fetched ${issues.length} total issues for ${projectSlug} (14 days)`);

    // Cache the results
    issueCache.set(projectSlug, {
      issues,
      timestamp: Date.now()
    });

    return issues;
  } catch (error) {
    log.warn('sentry-api', `Failed to fetch issues for ${projectSlug}`, { error: error.message });
    return [];
  }
}

/**
 * Filter cached issues by release versions locally
 * @param {Array} allIssues - All issues for a project
 * @param {string[]} releaseVersions - Array of release version strings (e.g., ['TOR@1.92.9506', 'TOR@1.92.9511'])
 * @returns {Array} Filtered issues matching the specified releases
 */
function filterIssuesByRelease(allIssues, releaseVersions) {
  if (!releaseVersions || releaseVersions.length === 0) {
    log.debug('sentry-api', 'No release versions to filter by, returning all issues', { count: allIssues.length });
    return allIssues;
  }

  // Create a Set for faster lookups
  const releaseSet = new Set(releaseVersions);

  // Log sample issue structure for debugging
  if (allIssues.length > 0) {
    const sampleIssue = allIssues[0];
    log.debug('sentry-api', 'Sample issue tags structure', {
      tags: sampleIssue.tags,
      releaseTags: sampleIssue.tags?.filter(tag => tag.key === 'release')
    });
  }

  // Filter issues that have a matching release
  const filtered = allIssues.filter(issue => {
    // Issue can have multiple tags including 'release'
    const releaseTags = issue.tags?.filter(tag => tag.key === 'release') || [];

    // Check if any of the issue's release tags match our target releases
    const matches = releaseTags.some(tag => releaseSet.has(tag.value));

    if (!matches && releaseTags.length > 0) {
      log.debug('sentry-api', 'Issue release tags did not match', {
        issueId: issue.id,
        issueTags: releaseTags.map(t => t.value),
        searchingFor: releaseVersions
      });
    }

    return matches;
  });

  log.debug('sentry-api', 'Filter results', {
    totalIssues: allIssues.length,
    filteredIssues: filtered.length,
    targetVersions: releaseVersions
  });

  return filtered;
}

/**
 * Get issue counts for a project filtered by release versions
 * Uses cached data and local filtering for better performance
 * @param {string} projectSlug - Sentry project slug
 * @param {string} numericProjectId - Numeric Sentry project ID for links
 * @param {string[]} deployedVersions - Array of deployed version strings to filter by (e.g., ['TOR@1.92.9506'])
 * @returns {Promise<Object>} Issue counts and link
 */
async function getProjectIssueCounts(projectSlug, numericProjectId, deployedVersions = []) {
  // Fetch all issues from cache (or from API if not cached)
  const allIssues = await getAllProjectIssues(projectSlug);

  // Filter issues by release versions locally
  const filteredIssues = filterIssuesByRelease(allIssues, deployedVersions);

  log.debug('sentry-api', `Filtered ${projectSlug} issues`, {
    total: allIssues.length,
    filtered: filteredIssues.length,
    versions: deployedVersions
  });

  // Extract numeric project ID from first issue if not provided
  let projectId = numericProjectId;
  if (!projectId && allIssues.length > 0 && allIssues[0].project?.id) {
    projectId = allIssues[0].project.id;
  }

  // Build link with numeric project ID if available
  const projectParam = projectId || projectSlug;
  const linkQuery = 'is:unresolved error.unhandled:true';
  const link = `https://${organization}.sentry.io/issues/?project=${projectParam}&query=${encodeURIComponent(linkQuery)}&statsPeriod=14d`;

  return {
    count: filteredIssues.length,
    link,
    projectId,
    issues: filteredIssues.slice(0, 5).map(issue => ({
      id: issue.id,
      title: issue.title,
      level: issue.level,
      count: issue.count,
      userCount: issue.userCount,
      permalink: issue.permalink
    }))
  };
}

/**
 * Get issue counts for all configured projects
 * @param {Object} projectConfigs - Map of project name to config
 * @param {Object} deployedVersionsByProject - Map of project name to array of deployed version strings
 * @returns {Promise<Object>} Map of project name to issue data
 */
async function getAllProjectIssueCounts(projectConfigs, deployedVersionsByProject = {}) {
  if (!authToken || !organization) {
    log.debug('sentry-api', 'Sentry not configured, skipping');
    return {};
  }

  const results = {};

  // Collect all sentry projects
  const projectsToFetch = [];
  for (const [projectName, projectConfig] of Object.entries(projectConfigs)) {
    if (projectConfig.sentryProject) {
      projectsToFetch.push({
        name: projectName,
        slug: projectConfig.sentryProject,
        versions: deployedVersionsByProject[projectName] || []
      });
    }
  }

  if (projectsToFetch.length === 0) {
    return results;
  }

  log.info('sentry-api', `Fetching issues for ${projectsToFetch.length} projects`);

  // Fetch all projects in parallel
  const fetchPromises = projectsToFetch.map(async (project) => {
    try {
      log.debug('sentry-api', `Filtering ${project.name} by versions`, { versions: project.versions });
      const data = await getProjectIssueCounts(project.slug, null, project.versions);
      return { name: project.name, data };
    } catch (error) {
      log.warn('sentry-api', `Failed to fetch ${project.name}`, { error: error.message });
      return { name: project.name, data: null };
    }
  });

  const fetchResults = await Promise.all(fetchPromises);

  for (const result of fetchResults) {
    if (result.data) {
      results[result.name] = result.data;
    }
  }

  return results;
}

module.exports = {
  sentryRequest,
  getProjectIssues7d,
  getAllProjectIssues,
  getProjectIssueCounts,
  getAllProjectIssueCounts
};
