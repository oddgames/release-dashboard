let buildData = { projects: [], lastUpdated: null };
let analyticsData = {}; // { projectId: { ios: { activeUsers }, android: { activeUsers }, total: { activeUsers } } }
let versionDAUData = {}; // { projectName: { version: { ios: { dates, activeUsers, retentionCurve }, android: {...} } } }
let versionCharts = {}; // Store version retention chart instances
let showAllBranches = false;
let toastTimeout = null;

// Jenkins auth state (stored in sessionStorage for persistence during session)
let jenkinsAuth = JSON.parse(sessionStorage.getItem('jenkinsAuth') || 'null');

// Release notes state
let releaseNotesData = {
  projectId: null,
  branch: null,
  platforms: [],
  track: null,
  fromChangeset: null,
  toChangeset: null,
  translations: {},
  currentLang: 'en',
  languages: ['en'],
  savedAt: null,  // Track when notes were last saved
  isDirty: false, // Track unsaved changes
  commits: [],    // Raw commits for display
  projectName: null
};

// Debounced save for release notes
let saveNotesTimeout = null;
async function saveReleaseNotesToDisk() {
  if (!releaseNotesData.projectId || !releaseNotesData.toChangeset) return;

  // Save current textarea content first
  const textarea = document.getElementById('releaseNotesText');
  if (textarea && releaseNotesData.currentLang) {
    releaseNotesData.translations[releaseNotesData.currentLang] = textarea.value;
  }

  try {
    const response = await fetch('/api/release-notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: releaseNotesData.projectId,
        fromChangeset: releaseNotesData.fromChangeset,
        toChangeset: releaseNotesData.toChangeset,
        track: releaseNotesData.track,
        platforms: releaseNotesData.platforms,
        translations: releaseNotesData.translations
      })
    });

    const result = await response.json();
    if (result.success) {
      releaseNotesData.savedAt = result.savedAt;
      releaseNotesData.isDirty = false;
      updateSaveStatus();
    }
  } catch (error) {
    console.error('Failed to save release notes:', error);
  }
}

function debouncedSaveNotes() {
  releaseNotesData.isDirty = true;
  updateSaveStatus();

  if (saveNotesTimeout) clearTimeout(saveNotesTimeout);
  saveNotesTimeout = setTimeout(saveReleaseNotesToDisk, 1000);
}

function updateSaveStatus() {
  const statusEl = document.getElementById('releaseNotesSaveStatus');
  if (!statusEl) return;

  if (releaseNotesData.isDirty) {
    statusEl.textContent = 'Saving...';
    statusEl.className = 'save-status saving';
  } else if (releaseNotesData.savedAt) {
    const date = new Date(releaseNotesData.savedAt);
    statusEl.textContent = `Saved ${date.toLocaleTimeString()}`;
    statusEl.className = 'save-status saved';
  } else {
    statusEl.textContent = '';
    statusEl.className = 'save-status';
  }
}

const languageNames = {
  'en': 'English',
  'de': 'German',
  'fr': 'French',
  'es': 'Spanish',
  'it': 'Italian',
  'pt': 'Portuguese',
  'ru': 'Russian',
  'ja': 'Japanese',
  'ko': 'Korean',
  'zh-Hans': 'Chinese (Simplified)',
  'zh-Hant': 'Chinese (Traditional)'
};

// Extract changeset from version string
// Format is typically: "1.91.CHANGESET (BUILD)" e.g., "1.91.11965 (34120)"
// - Changeset is the third part of X.Y.Z
// - Build number in parentheses is App Store/Play Store build number (not changeset)
function extractChangeset(version) {
  if (!version) return null;

  // First, strip out the parentheses part if present (that's the build number, not changeset)
  const withoutParen = version.replace(/\s*\(\d+\)/, '').trim();

  // Handle format "X.Y.Z" - extract Z (changeset is last part before any parentheses)
  const parts = withoutParen.split('.');
  if (parts.length >= 3) {
    const last = parts[parts.length - 1];
    // Only if the last part is a number (changeset)
    if (/^\d+$/.test(last)) return last;
  }

  // If there's a parentheses and no X.Y.Z format, use the paren value as fallback
  const parenMatch = version.match(/\((\d+)\)/);
  if (parenMatch) return parenMatch[1];

  // If it's just a plain number, return it
  if (/^\d+$/.test(version)) return version;
  return version;
}

function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = 'toast ' + type;

  // Clear any existing timeout
  if (toastTimeout) clearTimeout(toastTimeout);

  // Show the toast
  setTimeout(() => toast.classList.add('show'), 10);

  // Hide after 3 seconds
  toastTimeout = setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

// Error suggestions based on common error patterns
const errorSuggestions = {
  'does not have permission': {
    title: 'Google Play Permission Issue',
    suggestions: [
      'The service account needs "Release to production" permission in Google Play Console',
      'Go to Google Play Console → Users and permissions → find the service account',
      'Grant "Release to production, exclude devices, and use Play App Signing" permission',
      'Changes may take a few minutes to propagate'
    ]
  },
  'rate limit': {
    title: 'API Rate Limit Exceeded',
    suggestions: [
      'Too many requests to the store API',
      'Wait a few minutes before trying again',
      'Daily rate limits reset at midnight UTC'
    ]
  },
  'No version found': {
    title: 'Missing Version on Track',
    suggestions: [
      'No build found on the source track to promote',
      'Ensure a build has been uploaded and processed on the source track',
      'Check App Store Connect / Google Play Console for build status'
    ]
  },
  'PREPARE_FOR_SUBMISSION': {
    title: 'App Store Version Not Ready',
    suggestions: [
      'Create a new app version in App Store Connect first',
      'The version must be in "Prepare for Submission" state',
      'Fill in all required metadata before submitting'
    ]
  },
  'Invalid Jenkins credentials': {
    title: 'Authentication Failed',
    suggestions: [
      'Check your Jenkins username and API token',
      'Ensure your API token has not expired',
      'Verify you have access to the required Jenkins jobs'
    ]
  },
  'timed out': {
    title: 'Request Timeout',
    suggestions: [
      'The operation took too long to complete',
      'Check network connectivity',
      'The external service may be experiencing issues',
      'Try again in a few moments'
    ]
  },
  'Failed to fetch': {
    title: 'Network Error',
    suggestions: [
      'Check your network connection',
      'Ensure the dashboard server is running',
      'Check if your VPN is connected (if required)'
    ]
  }
};

// Store current error for copy functionality
let currentErrorDetails = null;

function showError(title, message, details = null) {
  const modal = document.getElementById('errorModal');
  const titleEl = document.getElementById('errorModalTitle');
  const messageEl = document.getElementById('errorModalMessage');
  const detailsEl = document.getElementById('errorModalDetails');
  const suggestionEl = document.getElementById('errorModalSuggestion');

  titleEl.textContent = title;
  messageEl.textContent = message;
  detailsEl.textContent = details || '';

  // Find matching suggestion
  let suggestion = null;
  const errorText = `${message} ${details || ''}`.toLowerCase();
  for (const [pattern, info] of Object.entries(errorSuggestions)) {
    if (errorText.includes(pattern.toLowerCase())) {
      suggestion = info;
      break;
    }
  }

  if (suggestion) {
    suggestionEl.innerHTML = `
      <strong>${suggestion.title}</strong>
      <ul>
        ${suggestion.suggestions.map(s => `<li>${s}</li>`).join('')}
      </ul>
    `;
  } else {
    suggestionEl.innerHTML = '';
  }

  // Store for copy
  currentErrorDetails = {
    title,
    message,
    details,
    timestamp: new Date().toISOString()
  };

  modal.classList.add('show');
}

function closeErrorModal() {
  document.getElementById('errorModal').classList.remove('show');
}

function copyErrorDetails() {
  if (!currentErrorDetails) return;

  const text = `Error: ${currentErrorDetails.title}
Message: ${currentErrorDetails.message}
${currentErrorDetails.details ? `Details: ${currentErrorDetails.details}` : ''}
Time: ${currentErrorDetails.timestamp}`;

  navigator.clipboard.writeText(text).then(() => {
    showToast('Error details copied', 'success');
  }).catch(() => {
    showToast('Failed to copy', 'error');
  });
}

async function fetchBuilds() {
  try {
    const response = await fetch('/api/builds');
    buildData = await response.json();
    render();
  } catch (error) {
    console.error('Failed to fetch builds:', error);
  }
}

async function fetchAnalytics() {
  try {
    const response = await fetch('/api/analytics');
    const data = await response.json();
    if (data.success && data.projects) {
      analyticsData = data.projects;
      render(); // Re-render to show analytics
    }
  } catch (error) {
    console.error('Failed to fetch analytics:', error);
  }
}

function toggleAllBranches() {
  showAllBranches = document.getElementById('showAllBranches').checked;
  render();
}

function toggleBuildMenu(event) {
  event.stopPropagation();
  const wrapper = event.target.closest('.build-menu-wrapper');
  const menu = wrapper.querySelector('.build-menu');
  const isOpen = menu.classList.contains('show');

  // Close all other menus first
  document.querySelectorAll('.build-menu.show').forEach(m => m.classList.remove('show'));

  if (!isOpen) {
    menu.classList.add('show');
  }
}

function closeBuildMenu(event) {
  event.stopPropagation();
  document.querySelectorAll('.build-menu.show').forEach(m => m.classList.remove('show'));
}

// Close menus when clicking outside
document.addEventListener('click', () => {
  document.querySelectorAll('.build-menu.show').forEach(m => m.classList.remove('show'));
  document.querySelectorAll('.version-dropdown').forEach(d => {
    if (d.style.display !== 'none') {
      d.style.display = 'none';
    }
  });
});

// Version dropdown for prevRelease column
const versionHistoryCache = {};

async function toggleVersionDropdown(event, dropdownId, projectId, platform) {
  event.stopPropagation();
  const dropdown = document.getElementById(dropdownId);
  const trigger = event.target;
  if (!dropdown) return;

  // Close other version dropdowns
  document.querySelectorAll('.version-dropdown').forEach(d => {
    if (d.id !== dropdownId) d.style.display = 'none';
  });

  // Toggle this dropdown
  if (dropdown.style.display === 'none') {
    // Position dropdown relative to trigger (using fixed positioning)
    const rect = trigger.getBoundingClientRect();
    const dropdownHeight = 280; // max-height from CSS
    const spaceBelow = window.innerHeight - rect.bottom;

    // Show above if not enough space below
    if (spaceBelow < dropdownHeight && rect.top > dropdownHeight) {
      dropdown.style.top = 'auto';
      dropdown.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
    } else {
      dropdown.style.top = (rect.bottom + 4) + 'px';
      dropdown.style.bottom = 'auto';
    }
    dropdown.style.left = rect.left + 'px';
    dropdown.style.display = 'block';
    await loadVersionHistory(projectId, platform, dropdown);
  } else {
    dropdown.style.display = 'none';
  }
}

async function loadVersionHistory(projectId, platform, dropdown) {
  const cacheKey = `${projectId}-${platform}`;

  // Check cache first
  if (versionHistoryCache[cacheKey]) {
    renderVersionOptions(dropdown, versionHistoryCache[cacheKey], projectId, platform);
    return;
  }

  dropdown.innerHTML = '<div class="version-dropdown-loading">Loading...</div>';

  try {
    const response = await fetch(`/api/release-history/${projectId}?days=30`);
    const data = await response.json();

    const versions = platform === 'ios' ? data.ios : data.android;
    versionHistoryCache[cacheKey] = versions || [];

    renderVersionOptions(dropdown, versions || [], projectId, platform);
  } catch (error) {
    dropdown.innerHTML = `<div class="version-dropdown-error">Failed to load versions</div>`;
  }
}

function renderVersionOptions(dropdown, versions, projectId, platform) {
  if (!versions || versions.length === 0) {
    dropdown.innerHTML = '<div class="version-dropdown-empty">No version history available</div>';
    return;
  }

  const optionsHtml = versions.map((v, index) => {
    const version = v.version || '—';
    const changeset = v.changeset || '—';
    const users = v.activeUsers ? `${formatNumber(v.activeUsers)} users` : '—';
    const date = v.releaseDate ? formatRelativeDate(new Date(v.releaseDate)) : '';
    const isCurrent = index === 0;

    return `
      <div class="version-option ${isCurrent ? 'current' : ''}" onclick="selectPrevVersion('${projectId}', '${platform}', '${changeset}', '${version}')">
        <span class="version-name">${escapeHtml(changeset)}</span>
        <span class="version-meta">
          <span class="version-users">${users}</span>
          ${date ? `<span class="version-date">${date}</span>` : ''}
        </span>
      </div>
    `;
  }).join('');

  dropdown.innerHTML = optionsHtml;
}

function selectPrevVersion(projectId, platform, build, version) {
  // Close the dropdown
  document.querySelectorAll('.version-dropdown').forEach(d => d.style.display = 'none');

  // Update the trigger text to show selected build (changeset)
  const dropdownId = `version-dropdown-${projectId}-${platform}`;
  const wrapper = document.getElementById(dropdownId)?.closest('.version-selector-wrapper');
  if (wrapper) {
    const trigger = wrapper.querySelector('.version-dropdown-trigger');
    if (trigger) {
      trigger.innerHTML = `${escapeHtml(build)} ▾`;
    }
  }

  // Could trigger a comparison or other action here
  showToast(`Selected ${platform.toUpperCase()} build ${build}`, 'info');
}

function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
}

async function triggerBuild(projectId, branch, platforms, currentChangeset, buildType = 'Debug') {
  showToast(`Triggering ${buildType} build for ${platforms.join(', ')}...`, 'info');

  try {
    const response = await fetch('/api/trigger-build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, branch, platforms, currentChangeset, buildType })
    });

    const result = await response.json();
    if (result.success) {
      showToast(`${buildType} build triggered successfully`, 'success');
      setTimeout(refresh, 2000);
    } else {
      showToast(`Failed to trigger build: ${result.error}`, 'error');
    }
  } catch (error) {
    showToast(`Failed to trigger build: ${error.message}`, 'error');
  }
}

async function triggerDistribute(projectId, branch, platforms, track, storeVersion, currentVersion, usePromote = false) {
  // Open the release notes modal
  // storeVersion is the current version in the store (fromChangeset)
  // currentVersion is the version we're distributing (toChangeset)
  // usePromote = true means promote existing build (no rebuild), false = trigger new build
  openReleaseNotesModal(projectId, branch, platforms, track, storeVersion || '0', currentVersion, usePromote);
}

async function refresh() {
  const btn = document.getElementById('refreshBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Refreshing...';
  }

  try {
    const response = await fetch('/api/refresh', { method: 'POST' });
    buildData = await response.json();
    render();
  } catch (error) {
    console.error('Failed to refresh:', error);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Refresh';
    }
  }
}

function render() {
  const tbody = document.getElementById('buildTableBody');

  if (!buildData.projects || buildData.projects.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No builds found</td></tr>';
    return;
  }

  let html = '';

  for (const project of buildData.projects) {
    // Get main branch data
    const mainBranch = (project.branches || []).find(b => b.branch === 'main');

    if (mainBranch) {
      // Single row with project info and main branch data
      html += `
        <tr class="row-project">
          <td>
            <div class="project-cell">
              <img src="${project.iconUrl || '/icons/default-game.png'}" alt="" class="game-icon">
              <div class="project-info">
                <span class="project-name">${escapeHtml(project.displayName)}</span>
              </div>
            </div>
          </td>
          ${renderPlasticCell(mainBranch, project.id, mainBranch.tracks)}
          ${renderTrackCells(mainBranch.tracks, mainBranch.plasticChangeset, project.id, 'main', project.sentry, mainBranch.allCommits)}
        </tr>
      `;
    } else {
      html += `
        <tr class="row-project">
          <td>
            <div class="project-cell">
              <img src="${project.iconUrl || '/icons/default-game.png'}" alt="" class="game-icon">
              <div class="project-info">
                <span class="project-name">${escapeHtml(project.displayName)}</span>
              </div>
            </div>
          </td>
          <td colspan="8"><span class="no-builds">No recent builds</span></td>
        </tr>
      `;
    }
  }

  tbody.innerHTML = html;

  // Update last updated time
  if (buildData.lastUpdated) {
    const date = new Date(buildData.lastUpdated);
    document.getElementById('lastUpdated').textContent = `Updated ${date.toLocaleTimeString()}`;
  }
}

function renderPlasticCell(branch, projectId, tracks = {}) {
  // Get the latest changeset from Plastic SCM (source of truth)
  const plasticChangeset = branch.plasticChangeset;

  // Show Plastic changeset
  const displayText = plasticChangeset ? String(plasticChangeset) : '—';

  // Check if any release build matches the plastic changeset
  const releaseTrack = tracks.release || {};
  const iosVersion = parseInt(extractChangeset(releaseTrack.iosVersion)) || 0;
  const androidVersion = parseInt(extractChangeset(releaseTrack.androidVersion)) || 0;
  const hasCurrent = plasticChangeset && (iosVersion >= plasticChangeset || androidVersion >= plasticChangeset);

  // Build tooltip with Jenkins build range and recent commits from Plastic
  const allCommits = branch.allCommits || [];
  let tooltipLines = [];

  // Show latest successful Jenkins build so user can see what's new since last build
  const latestBuilt = Math.max(
    branch.iosSuccess?.version || 0,
    branch.androidSuccess?.version || 0
  );

  if (latestBuilt > 0) {
    tooltipLines.push(`Last built: ${latestBuilt}`);
    tooltipLines.push('');
  }

  if (allCommits.length > 0) {
    const commitLines = allCommits.slice(0, 10).map(c =>
      `${c.version || ''}: ${c.message}${c.author ? ' (' + c.author + ')' : ''}`
    );
    tooltipLines.push(...commitLines);
    if (allCommits.length > 10) {
      tooltipLines.push(`... and ${allCommits.length - 10} more`);
    }
  }

  const tooltipContent = tooltipLines.join('\n');

  // Get time since latest commit
  const latestCommit = allCommits[0];
  const timeAgo = latestCommit?.timestamp ? formatRelativeDate(latestCommit.timestamp) : '';

  return `
    <td class="plastic-cell${hasCurrent ? ' current' : ''}">
      <div class="plastic-info" title="${escapeHtml(tooltipContent)}">
        <span class="changeset-number">${escapeHtml(displayText)}</span>
        ${timeAgo ? `<span class="changeset-age">${timeAgo}</span>` : ''}
      </div>
    </td>
  `;
}

function renderDownloadLink(branch) {
  if (branch.downloadUrl) {
    return `<a href="${branch.downloadUrl}" class="download-link" target="_blank" title="Download">📥</a>`;
  }
  if (branch.driveFolder) {
    return `<a href="${branch.driveFolder}" class="download-link" target="_blank" title="Google Drive">📁</a>`;
  }
  return '';
}

function renderTrackCells(tracks, currentChangeset, projectId, branchName, sentryData, allCommits) {
  const trackOrder = ['dev', 'release', 'storeInternal', 'storeAlpha', 'storeRollout', 'storeRelease', 'prevRelease'];

  // Map track names to build types for Jenkins
  const trackToBuildType = {
    dev: 'Debug',
    release: 'Release'
  };

  // Get store version for smart compare (use the most "live" store version)
  const storeReleaseVersion = extractChangeset(tracks?.storeRelease?.iosVersion || tracks?.storeRelease?.androidVersion);
  const storeAlphaVersion = extractChangeset(tracks?.storeAlpha?.iosVersion || tracks?.storeAlpha?.androidVersion);
  const storeInternalVersion = extractChangeset(tracks?.storeInternal?.iosVersion || tracks?.storeInternal?.androidVersion);
  // Pick the best "from" reference for comparison (prefer most recent store release)
  const referenceStoreVersion = storeReleaseVersion || storeAlphaVersion || storeInternalVersion || null;

  return trackOrder.map(trackName => {
    const track = tracks?.[trackName] || {};

    // Check if platform needs a build:
    // - No version at all (never built)
    // - Version doesn't match current changeset (outdated)
    const iosNeedsBuild = !track.iosVersion || track.iosVersion !== currentChangeset;
    const androidNeedsBuild = !track.androidVersion || track.androidVersion !== currentChangeset;

    // Show build button for dev/release tracks (not store tracks)
    const canBuild = ['dev', 'release'].includes(trackName);
    const needsBuild = canBuild && currentChangeset && (iosNeedsBuild || androidNeedsBuild);

    // Check if storeInternal needs distribution to alpha
    let needsDistribute = false;
    let isInSync = false; // Both platforms match alpha
    let platformsToDistribute = [];
    let distributeTrack = '';
    let storeVersion = null;
    let internalVersion = null;

    if (trackName === 'storeInternal') {
      const storeAlphaTrack = tracks?.['storeAlpha'] || {};
      distributeTrack = 'alpha';

      // Check if internal has builds that aren't in alpha yet
      const iosNeedsDistribute = track.iosVersion &&
        (!storeAlphaTrack.iosVersion || track.iosVersion !== storeAlphaTrack.iosVersion);
      const androidNeedsDistribute = track.androidVersion &&
        (!storeAlphaTrack.androidVersion || track.androidVersion !== storeAlphaTrack.androidVersion);

      if (iosNeedsDistribute) platformsToDistribute.push('ios');
      if (androidNeedsDistribute) platformsToDistribute.push('android');
      needsDistribute = platformsToDistribute.length > 0;

      // Check if versions are in sync (internal matches alpha for both platforms that have versions)
      const iosInSync = track.iosVersion && storeAlphaTrack.iosVersion && track.iosVersion === storeAlphaTrack.iosVersion;
      const androidInSync = track.androidVersion && storeAlphaTrack.androidVersion && track.androidVersion === storeAlphaTrack.androidVersion;
      isInSync = !needsDistribute && (iosInSync || androidInSync);

      // Get versions for release notes - always compare against fully released store version
      const storeReleaseTrack = tracks?.['storeRelease'] || {};
      storeVersion = storeReleaseTrack.iosVersion || storeReleaseTrack.androidVersion || null;
      internalVersion = track.iosVersion || track.androidVersion;
    }

    // Determine which platforms need building (only those that are missing or outdated)
    const platformsToBuild = [];
    if (iosNeedsBuild) platformsToBuild.push('ios');
    if (androidNeedsBuild) platformsToBuild.push('android');

    const buildType = trackToBuildType[trackName] || 'Debug';
    // Use single quotes inside array to avoid breaking HTML attribute double quotes
    const platformsArrayStr = platformsToBuild.length > 0 ? "['" + platformsToBuild.join("','") + "']" : "[]";
    const distributeArrayStr = platformsToDistribute.length > 0 ? "['" + platformsToDistribute.join("','") + "']" : "[]";
    const buildClickHandler = needsBuild
      ? `onclick="triggerBuild('${projectId}', '${branchName}', ${platformsArrayStr}, '${currentChangeset || ''}', '${buildType}')"`
      : '';
    // Use promote (no rebuild) for storeInternal -> alpha, distribute (rebuild) for other tracks
    const usePromote = trackName === 'storeInternal';
    const distributeClickHandler = needsDistribute
      ? `onclick="triggerDistribute('${projectId}', '${branchName}', ${distributeArrayStr}, '${distributeTrack}', '${storeVersion || ''}', '${internalVersion || ''}', ${usePromote})"`
      : '';

    // Build dropdown menu items
    let buildMenuItems = '';
    if (canBuild && currentChangeset) {
      const hasMissing = platformsToBuild.length > 0;
      const missingLabel = platformsToBuild.length === 2 ? 'Both' : platformsToBuild.map(p => p === 'ios' ? 'Apple' : 'Google').join(', ');
      const hasDownloads = track.iosDownloadUrl || track.androidDownloadUrl;
      // Escape URLs for safe passing in onclick attributes
      const iosUrlEscaped = (track.iosDownloadUrl || '').replace(/'/g, "\\'");
      const androidUrlEscaped = (track.androidDownloadUrl || '').replace(/'/g, "\\'");

      buildMenuItems = `
        <div class="build-menu-item" onclick="triggerBuild('${projectId}', '${branchName}', ['ios','android'], '${currentChangeset}', '${buildType}'); closeBuildMenu(event)">Rebuild All</div>
        ${hasMissing ? `<div class="build-menu-item" onclick="triggerBuild('${projectId}', '${branchName}', ${platformsArrayStr}, '${currentChangeset}', '${buildType}'); closeBuildMenu(event)">Rebuild Missing (${missingLabel})</div>` : ''}
        <div class="build-menu-item" onclick="triggerBuild('${projectId}', '${branchName}', ['ios'], '${currentChangeset}', '${buildType}'); closeBuildMenu(event)">Rebuild Apple</div>
        <div class="build-menu-item" onclick="triggerBuild('${projectId}', '${branchName}', ['android'], '${currentChangeset}', '${buildType}'); closeBuildMenu(event)">Rebuild Google</div>
        ${hasDownloads ? `<div class="build-menu-item" onclick="openDownloadModal('${iosUrlEscaped}', '${androidUrlEscaped}'); closeBuildMenu(event)">Download Links</div>` : ''}
        <div class="build-menu-item" onclick="openBuildHistoryModal('${projectId}', '${branchName}', '${buildType}'); closeBuildMenu(event)">Build History</div>
      `;
    }

    // Add divider class for prevRelease column
    const dividerClass = trackName === 'prevRelease' ? ' col-divider-left' : '';

    return `
      <td class="track-cell${dividerClass}">
        <div class="track-cell-content">
          <div class="track-row-actions">
            ${canBuild && currentChangeset ? `
              <div class="build-menu-wrapper">
                <span class="build-menu-trigger ${needsBuild ? 'has-missing' : ''}" onclick="toggleBuildMenu(event)" title="${buildType} build options">⋯</span>
                <div class="build-menu">${buildMenuItems}</div>
              </div>
            ` : ''}
            ${needsDistribute ? `<span class="needs-distribute" title="${usePromote ? 'Promote' : 'Distribute'} ${platformsToDistribute.join(', ')} to ${distributeTrack}" ${distributeClickHandler}>⬆</span>` : ''}
            ${isInSync ? `<span class="in-sync" title="Already in Alpha">✓</span>` : ''}
            ${trackName === 'storeAlpha' && (track.iosVersion || track.androidVersion) ? `<span class="copy-discord" title="Copy for Discord" onclick="copyLastReleaseNotesForDiscord('${projectId}', '${track.iosVersion || track.androidVersion}')">📋</span>` : ''}
            ${trackName === 'storeAlpha' && track.androidVersion ? `
              <div class="rollout-menu-wrapper">
                <span class="rollout-menu-trigger" onclick="toggleRolloutMenu(event)" title="Promote to Production">🚀</span>
                <div class="rollout-menu">
                  <div class="rollout-menu-item" onclick="startAndroidRollout('${projectId}', 'mexico'); closeRolloutMenu(event)">🇲🇽 Mexico Only</div>
                  <div class="rollout-menu-item" onclick="startAndroidRollout('${projectId}', '20%'); closeRolloutMenu(event)">📊 20% Global</div>
                  <div class="rollout-menu-item" onclick="startAndroidRollout('${projectId}', '100%'); closeRolloutMenu(event)">🌍 100% Global</div>
                </div>
              </div>
            ` : ''}
            ${trackName === 'storeAlpha' && track.iosBuildId ? `
              <span class="ios-submit-trigger" onclick="submitIOSForReview('${projectId}', '${track.iosBuildId}')" title="Submit iOS to App Store">🍎</span>
            ` : ''}
            ${trackName === 'storeRollout' && track.androidVersion ? `
              <span class="rollout-details-btn" onclick="openRolloutDetailsModal('${projectId}')" title="View Rollout Health">📊</span>
            ` : ''}
            ${trackName === 'storeRollout' && track.androidUserFraction && track.androidUserFraction < 1 ? `
              <div class="rollout-menu-wrapper">
                <span class="rollout-menu-trigger" onclick="toggleRolloutMenu(event)" title="Update Rollout">📈</span>
                <div class="rollout-menu">
                  ${track.androidUserFraction < 0.20 ? `<div class="rollout-menu-item" onclick="updateAndroidRollout('${projectId}', 20); closeRolloutMenu(event)">📊 Expand to 20%</div>` : ''}
                  ${track.androidUserFraction < 1.0 ? `<div class="rollout-menu-item" onclick="updateAndroidRollout('${projectId}', 100); closeRolloutMenu(event)">🌍 Complete (100%)</div>` : ''}
                  <div class="rollout-menu-item rollout-halt" onclick="haltAndroidRollout('${projectId}'); closeRolloutMenu(event)">⏸️ Halt Rollout</div>
                </div>
              </div>
            ` : ''}
          </div>
          <div class="track-row-main">
            <div class="platform-status">
              ${renderPlatformStatus('ios', track.ios, track.iosVersion, track.iosUrl, track.iosDate, track.iosSuccessVersion, track.iosSuccessUrl, track.iosDownloadUrl, currentChangeset, track.iosBuildStartTime, track.iosEstimatedDuration, track.iosErrorAnalysis, track.iosStatusReason, projectId, branchName, trackName, referenceStoreVersion, track.iosVitals, allCommits, track.iosStageInfo)}
              ${renderPlatformStatus('android', track.android, track.androidVersion, track.androidUrl, track.androidDate, track.androidSuccessVersion, track.androidSuccessUrl, track.androidDownloadUrl, currentChangeset, track.androidBuildStartTime, track.androidEstimatedDuration, track.androidErrorAnalysis, track.androidStatusReason, projectId, branchName, trackName, referenceStoreVersion, track.androidVitals, allCommits, track.androidStageInfo)}
            </div>
          </div>
          <!-- Vitals removed from main table - now shown in Rollout Details modal -->
        </div>
      </td>
    `;
  }).join('');
}

function renderPlatformStatus(platform, status, version, jenkinsUrl, date, successVersion, successUrl, downloadUrl, currentChangeset, buildStartTime, estimatedDuration, errorAnalysis, statusReason, projectId, branchName, trackName, referenceStoreVersion, vitals, allCommits, stageInfo) {
  const statusClass = getStatusClass(status);
  const dateStr = date ? formatRelativeDate(date) : '';

  // Extract changeset for display, keep full version for tooltip
  const displayVersion = extractChangeset(version);
  const fullVersion = version;

  // Calculate missing commits from main
  const versionChangeset = parseInt(extractChangeset(version)) || 0;
  const latestChangeset = parseInt(currentChangeset) || 0;
  const missingCommits = (allCommits || []).filter(c => {
    const commitVersion = parseInt(c.version) || 0;
    return commitVersion > versionChangeset && commitVersion <= latestChangeset;
  });

  // Build tooltip - include full version and status reason
  let tooltip = fullVersion ? `${platform.toUpperCase()}: ${fullVersion}${dateStr ? ' (' + dateStr + ')' : ''}` : platform.toUpperCase();
  if (statusReason) {
    tooltip += `\nStatus: ${statusReason}`;
  }

  // Add build progress details for ongoing builds
  if (status === 'building' && buildStartTime) {
    const elapsed = Date.now() - buildStartTime;
    const elapsedMins = Math.floor(elapsed / 60000);
    const elapsedSecs = Math.floor((elapsed % 60000) / 1000);

    tooltip += `\n\n--- Build Progress ---`;
    tooltip += `\nElapsed: ${elapsedMins}m ${elapsedSecs}s`;

    if (estimatedDuration) {
      const remaining = estimatedDuration - elapsed;
      const totalMins = Math.floor(estimatedDuration / 60000);
      const progress = Math.min(100, Math.floor((elapsed / estimatedDuration) * 100));

      if (remaining > 0) {
        const remainingMins = Math.ceil(remaining / 60000);
        tooltip += `\nRemaining: ~${remainingMins}m`;
        tooltip += `\nProgress: ${progress}%`;
      } else {
        const overMins = Math.ceil(-remaining / 60000);
        tooltip += `\nOver estimate by: ${overMins}m`;
        tooltip += `\nEstimated: ${totalMins}m`;
      }
    }

    // Add pipeline stage details
    if (stageInfo && stageInfo.stages) {
      tooltip += `\n\n--- Pipeline Stages ---`;
      if (stageInfo.current) {
        tooltip += `\nCurrent: ${stageInfo.current}`;
      }
      if (stageInfo.totalStages > 0) {
        const stageProgress = Math.floor((stageInfo.completedCount / stageInfo.totalStages) * 100);
        tooltip += `\nStages: ${stageInfo.completedCount}/${stageInfo.totalStages} (${stageProgress}%)`;
      }

      // Show recent stages with status
      const recentStages = stageInfo.stages.slice(-5); // Last 5 stages
      if (recentStages.length > 0) {
        tooltip += `\n`;
        for (const stage of recentStages) {
          const statusIcon = stage.status === 'SUCCESS' ? '✓' :
                           stage.status === 'IN_PROGRESS' ? '▶' :
                           stage.status === 'FAILED' ? '✗' : '○';
          const duration = stage.durationMillis ? ` (${Math.floor(stage.durationMillis / 1000)}s)` : '';
          tooltip += `\n  ${statusIcon} ${stage.name}${duration}`;
        }
      }
    }
  }

  // Show missing commits from main
  if (versionChangeset > 0 && latestChangeset > 0 && versionChangeset < latestChangeset) {
    const commitsBehind = latestChangeset - versionChangeset;
    tooltip += `\n\n--- ${commitsBehind} changeset${commitsBehind === 1 ? '' : 's'} behind main ---`;
    if (missingCommits.length > 0) {
      const commitLines = missingCommits.slice(0, 8).map(c =>
        `${c.version}: ${(c.message || '').substring(0, 50)}${(c.message || '').length > 50 ? '...' : ''}`
      );
      tooltip += '\n' + commitLines.join('\n');
      if (missingCommits.length > 8) {
        tooltip += `\n... and ${missingCommits.length - 8} more`;
      }
    }
  } else if (versionChangeset > 0 && versionChangeset >= latestChangeset) {
    tooltip += '\n\n✓ Up to date with main';
  }

  if (errorAnalysis && (status === 'failure')) {
    tooltip += '\n\n--- Error Analysis ---\n' + errorAnalysis;
  }
  // Add click hint for comparison
  if (displayVersion && projectId) {
    tooltip += '\n\nClick version to compare changes';
  }

  // Check if this build is outdated and calculate age (reuse versionChangeset and latestChangeset from above)
  const isOutdated = versionChangeset > 0 && latestChangeset > 0 && versionChangeset < latestChangeset;
  const outdatedClass = isOutdated ? 'outdated' : '';
  const isCurrent = versionChangeset > 0 && latestChangeset > 0 && versionChangeset >= latestChangeset;

  // Calculate how far behind this build is (for progressive fading)
  const changesetsBehind = isOutdated ? latestChangeset - versionChangeset : 0;

  // Use colored SVG based on status
  // If build is outdated, fade progressively based on how old it is
  // Current builds (matching latest changeset) get full opacity
  const iconFile = platform === 'ios' ? 'apple' : 'android';
  const iconColor = getStatusColor(status, changesetsBehind);

  // Calculate time remaining for in-progress builds
  let timeRemainingHtml = '';
  if (status === 'building' && buildStartTime && estimatedDuration) {
    const elapsed = Date.now() - buildStartTime;
    const remaining = estimatedDuration - elapsed;
    if (remaining > 0) {
      const remainingMins = Math.ceil(remaining / 60000);
      timeRemainingHtml = `<span class="time-remaining">~${remainingMins}m left</span>`;
    } else {
      // Build is taking longer than expected
      const overMins = Math.ceil(-remaining / 60000);
      timeRemainingHtml = `<span class="time-remaining over">+${overMins}m</span>`;
    }
  }

  // Show success version below if latest is failing
  let successHtml = '';
  if (successVersion && status === 'failure') {
    successHtml = successUrl
      ? `<a href="${successUrl}" target="_blank" class="success-fallback" title="Last success: ${successVersion}">✓ ${escapeHtml(successVersion)}</a>`
      : `<span class="success-fallback" title="Last success: ${successVersion}">✓ ${escapeHtml(successVersion)}</span>`;
  }

  // Icon links to download (if available), otherwise to Jenkins
  // Only show checkmark for successful builds that match plastic
  // Green tick = current + success, Blue tick = current + building/queued (tentative)
  let badgeHtml = '';
  if (isCurrent && status === 'success') {
    badgeHtml = '<span class="current-badge">✓</span>';
  } else if (isCurrent && (status === 'building' || status === 'queued')) {
    badgeHtml = '<span class="tentative-badge">✓</span>';
  }
  const checkmarkBadge = badgeHtml;
  let iconHtml;
  if (downloadUrl) {
    iconHtml = `<a href="${downloadUrl}" target="_blank" title="Download ${platform.toUpperCase()}"><span class="icon-wrapper">${checkmarkBadge}<img src="/icons/${iconFile}.svg" alt="${platform}" class="platform-icon" style="filter: ${iconColor}"></span></a>`;
  } else if (jenkinsUrl) {
    iconHtml = `<a href="${jenkinsUrl}" target="_blank" title="View build in Jenkins"><span class="icon-wrapper">${checkmarkBadge}<img src="/icons/${iconFile}.svg" alt="${platform}" class="platform-icon" style="filter: ${iconColor}"></span></a>`;
  } else {
    iconHtml = `<span class="icon-wrapper">${checkmarkBadge}<img src="/icons/${iconFile}.svg" alt="${platform}" class="platform-icon" style="filter: ${iconColor}"></span>`;
  }

  // Version link - clickable for smart compare (don't link to Jenkins anymore, use for comparison)
  let versionHtml;
  if (trackName === 'prevRelease' && projectId) {
    // For prevRelease, add a dropdown to select from previous versions
    const dropdownId = `version-dropdown-${projectId}-${platform}`;
    versionHtml = `
      <div class="version-selector-wrapper">
        <span class="platform-version-link clickable version-dropdown-trigger" onclick="toggleVersionDropdown(event, '${dropdownId}', '${projectId}', '${platform}')">${escapeHtml(displayVersion || '—')} ▾</span>
        <div id="${dropdownId}" class="version-dropdown" style="display: none;" onclick="event.stopPropagation()">
          <div class="version-dropdown-loading">Loading...</div>
        </div>
      </div>`;
  } else if (displayVersion && projectId) {
    // Make version clickable for smart compare
    const clickHandler = `openSmartCompare('${projectId}', '${branchName}', '${trackName}', '${displayVersion}', '${referenceStoreVersion || ''}', '${currentChangeset || ''}')`;
    versionHtml = `<span class="platform-version-link clickable" onclick="${clickHandler}">${escapeHtml(displayVersion)}</span>`;
  } else {
    versionHtml = `<span class="platform-version">${escapeHtml(displayVersion || '—')}</span>`;
  }

  // Render vitals for store tracks only (including prevRelease)
  const isStoreTrack = ['storeInternal', 'storeAlpha', 'storeRollout', 'storeRelease', 'prevRelease'].includes(trackName);
  const vitalsHtml = isStoreTrack ? renderVitalsMetrics(platform, vitals) : '';

  return `
    <div class="platform-indicator ${outdatedClass}" title="${escapeHtml(tooltip)}">
      <div class="platform-build ${statusClass}">
        ${iconHtml}
        <div class="build-details">
          ${versionHtml}
          ${dateStr ? `<span class="platform-date">${dateStr}</span>` : ''}
          ${timeRemainingHtml}
          ${successHtml}
        </div>
      </div>
      ${vitalsHtml}
    </div>
  `;
}

function getStatusColor(status, changesetsBehind = 0) {
  // Base colors
  let filter;
  switch (status) {
    case 'success': filter = 'brightness(0) saturate(100%) invert(67%) sepia(52%) saturate(5765%) hue-rotate(89deg) brightness(92%) contrast(87%)'; break; // green
    case 'failure': filter = 'brightness(0) saturate(100%) invert(32%) sepia(98%) saturate(7467%) hue-rotate(355deg) brightness(102%) contrast(118%)'; break; // red
    case 'unstable': filter = 'brightness(0) saturate(100%) invert(73%) sepia(78%) saturate(1644%) hue-rotate(360deg) brightness(103%) contrast(106%)'; break; // yellow (built but upload failed)
    case 'building': filter = 'brightness(0) saturate(100%) invert(46%) sepia(99%) saturate(2074%) hue-rotate(196deg) brightness(105%) contrast(101%)'; break; // blue
    case 'queued': filter = 'brightness(0) saturate(100%) invert(70%) sepia(50%) saturate(500%) hue-rotate(220deg) brightness(100%) contrast(95%)'; break; // light purple
    case 'review': filter = 'brightness(0) saturate(100%) invert(73%) sepia(78%) saturate(1644%) hue-rotate(360deg) brightness(103%) contrast(106%)'; break; // yellow/orange
    default: filter = 'brightness(0) saturate(100%) invert(50%)'; // gray
  }
  // Apply progressive fading based on how many changesets behind
  // 0 behind = 1.0 opacity, 10 behind = 0.7, 50+ behind = 0.4 (minimum)
  if (changesetsBehind > 0) {
    const opacity = Math.max(0.4, 1.0 - (changesetsBehind * 0.03));
    filter += ` opacity(${opacity.toFixed(2)})`;
  }
  return filter;
}

function getStatusIcon(status) {
  switch (status) {
    case 'success': return '●';
    case 'failure': return '✗';
    case 'unstable': return '●'; // built successfully but upload failed
    case 'building': return '◐';
    case 'review': return '⏳';
    default: return '—';
  }
}

function getStatusClass(status) {
  switch (status) {
    case 'success': return 'success';
    case 'failure': return 'failure';
    case 'unstable': return 'unstable';
    case 'building': return 'building';
    case 'queued': return 'queued';
    case 'review': return 'review';
    default: return 'none';
  }
}

// Render vitals metrics - simple text display
function renderVitalsMetrics(platform, vitals) {
  return ''; // Moved to track-level vitals table
}

// Get CSS class based on metric value vs threshold
function getVitalsClass(value, threshold) {
  if (value === null || value === undefined) return 'neutral';
  if (value <= threshold * 0.5) return 'good';      // Well below threshold
  if (value <= threshold) return 'warning';          // Approaching threshold
  return 'bad';                                      // Above threshold
}

// Render vitals list with icons linking to consoles
function renderVitalsTable(track, sentryData, isStoreTrack, trackName) {
  const items = [];

  // Sentry errors
  if (sentryData) {
    const count = sentryData.count || 0;
    const link = sentryData.link || '#';
    const colorClass = count === 0 ? 'good' : 'bad';
    items.push(`
      <div class="vitals-item">
        <a href="${escapeHtml(link)}" target="_blank" title="Sentry"><img src="/icons/sentry.svg" alt="Sentry"></a>
        <span class="${colorClass}">${count} errors</span>
      </div>
    `);
  }

  // Active users per version (Firebase Analytics)
  if (isStoreTrack) {
    const iosUsers = track?.iosActiveUsers;
    const androidUsers = track?.androidActiveUsers;
    const hasIos = iosUsers !== null && iosUsers !== undefined;
    const hasAndroid = androidUsers !== null && androidUsers !== undefined;

    if (hasIos || hasAndroid) {
      const formatUsers = (n) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : n.toString();
      const iosVal = hasIos ? formatUsers(iosUsers) : '-';
      const androidVal = hasAndroid ? formatUsers(androidUsers) : '-';
      const total = (iosUsers || 0) + (androidUsers || 0);
      const tooltip = `Active users (7d)\niOS: ${hasIos ? iosUsers.toLocaleString() : 'N/A'}\nAndroid: ${hasAndroid ? androidUsers.toLocaleString() : 'N/A'}\nTotal: ${total.toLocaleString()}`;

      items.push(`
        <div class="vitals-item" title="${escapeHtml(tooltip)}">
          <img src="/icons/users.svg" alt="Users">
          <span class="neutral">${iosVal}</span>
          <span class="vitals-sep">/</span>
          <span class="neutral">${androidVal}</span>
        </div>
      `);
    }
  }

  // iOS crashes - display differently for TestFlight vs App Store
  if (isStoreTrack && track?.iosVitals) {
    const v = track.iosVitals;
    const isTestFlight = ['storeInternal', 'storeAlpha'].includes(trackName);
    const hasCrashCount = v.crashCount !== null && v.crashCount !== undefined;
    const hasCrashRate = v.crashRate !== null && v.crashRate !== undefined;

    if (isTestFlight) {
      // TestFlight builds - show crash count from diagnostics API
      const testflightLink = v.appId
        ? `https://appstoreconnect.apple.com/apps/${v.appId}/testflight/crashes?appPlatform=IOS`
        : null;

      if (hasCrashCount) {
        const colorClass = v.crashCount === 0 ? 'good' : (v.crashCount < 5 ? 'warning' : 'bad');
        const tooltipParts = [`Version: ${v.version || 'unknown'}`];
        if (v.signatureCount) tooltipParts.push(`${v.signatureCount} unique crash signatures`);
        const tooltip = tooltipParts.join('\n');

        items.push(`
          <div class="vitals-item" title="${escapeHtml(tooltip)}">
            ${testflightLink ? `<a href="${testflightLink}" target="_blank" title="TestFlight Crashes">` : ''}
            <img src="/icons/testflight.svg" alt="TestFlight">
            ${testflightLink ? '</a>' : ''}
            <span class="${colorClass}">${v.crashCount} crashes</span>
          </div>
        `);
      } else if (testflightLink) {
        // No crash count available, just show link
        items.push(`
          <div class="vitals-item">
            <a href="${testflightLink}" target="_blank" title="TestFlight Crashes">
              <img src="/icons/testflight.svg" alt="TestFlight">
            </a>
            <span class="neutral">crashes</span>
          </div>
        `);
      }
    } else if (hasCrashRate) {
      // App Store builds - show crash rate and hang rate from perfPowerMetrics
      // Crashes: count per day, Hangs: API returns seconds/hr, convert to seconds/day
      const crashClass = v.crashRate === 0 ? 'good' : (v.crashRate < 1 ? 'warning' : 'bad');
      const hasHangRate = v.hangRate !== null && v.hangRate !== undefined;
      const hangPerDay = hasHangRate ? v.hangRate * 24 : null;
      // Hang thresholds: <24s/day good, <240s/day warning (equivalent to <1s/hr, <10s/hr)
      const hangClass = hasHangRate ? (hangPerDay < 24 ? 'good' : (hangPerDay < 240 ? 'warning' : 'bad')) : 'neutral';
      const iosLink = v.appId ? `https://appstoreconnect.apple.com/analytics/app/d30/${v.appId}/metrics?measureKey=crashes` : null;

      const tooltipParts = [];
      if (v.version) tooltipParts.push(`Version: ${v.version}`);
      tooltipParts.push(`Crashes: ${v.crashRate.toFixed(1)}/day`);
      if (hasHangRate) tooltipParts.push(`Hangs: ${hangPerDay.toFixed(1)}s/day`);
      const tooltip = tooltipParts.join('\n');

      const crashVal = v.crashRate.toFixed(1);
      const hangVal = hasHangRate ? hangPerDay.toFixed(1) : '-';

      items.push(`
        <div class="vitals-item" title="${escapeHtml(tooltip)}">
          ${iosLink ? `<a href="${iosLink}" target="_blank" title="View in App Store Connect">` : ''}
          <img src="/icons/apple.svg" alt="iOS">
          ${iosLink ? '</a>' : ''}
          <span class="${crashClass}">${crashVal}</span>
          <span class="vitals-sep">/</span>
          <span class="${hangClass}">${hangVal}</span>
        </div>
      `);
    }
  }

  // Android crash rate + ANR combined
  if (isStoreTrack && track?.androidVitals) {
    const v = track.androidVitals;
    const hasCrash = v.crashRate !== null && v.crashRate !== undefined;
    const hasAnr = v.anrRate !== null && v.anrRate !== undefined;
    const playLink = (v.developerId && v.playAppId)
      ? `https://play.google.com/console/u/0/developers/${v.developerId}/app/${v.playAppId}/vitals/crashes?days=7`
      : (v.packageName ? `https://play.google.com/console` : null);

    if (v.isAggregate) {
      // No version-specific data - show "insufficient"
      items.push(`
        <div class="vitals-item" title="Insufficient user data for this version">
          ${playLink ? `<a href="${playLink}" target="_blank" title="View in Play Console">` : ''}
          <img src="/icons/android.svg" alt="Android">
          ${playLink ? '</a>' : ''}
          <span class="neutral">insufficient</span>
        </div>
      `);
    } else if (hasCrash || hasAnr) {
      const crashClass = hasCrash ? getVitalsClass(v.crashRate, 1.09) : 'neutral';
      const anrClass = hasAnr ? getVitalsClass(v.anrRate, 0.47) : 'neutral';
      const crashVal = hasCrash ? v.crashRate.toFixed(2) + '%' : '-';
      const anrVal = hasAnr ? v.anrRate.toFixed(2) + '%' : '-';

      // Build detailed tooltip
      const tooltipParts = [];
      if (v.versionCode) tooltipParts.push(`Version: ${v.versionCode}`);
      if (v.distinctUsers) tooltipParts.push(`Users: ${v.distinctUsers.toLocaleString()}`);
      if (hasCrash) tooltipParts.push(`Crash Rate: ${v.crashRate.toFixed(2)}%`);
      if (v.userPerceivedCrashRate != null) tooltipParts.push(`User Perceived: ${v.userPerceivedCrashRate.toFixed(2)}%`);
      if (hasAnr) tooltipParts.push(`ANR Rate: ${v.anrRate.toFixed(2)}%`);
      if (v.userPerceivedAnrRate != null) tooltipParts.push(`ANR Perceived: ${v.userPerceivedAnrRate.toFixed(2)}%`);
      const detailedTooltip = tooltipParts.join('\n');

      items.push(`
        <div class="vitals-item" title="${escapeHtml(detailedTooltip)}">
          ${playLink ? `<a href="${playLink}" target="_blank" title="View in Play Console">` : ''}
          <img src="/icons/android.svg" alt="Android">
          ${playLink ? '</a>' : ''}
          <span class="${crashClass}">${crashVal}</span>
          <span class="vitals-sep">/</span>
          <span class="${anrClass}">${anrVal}</span>
        </div>
      `);
    }
  }

  if (items.length === 0) return '';

  return `<div class="vitals-list">${items.join('')}</div>`;
}


function formatRelativeDate(dateStr) {
  if (!dateStr) return '';

  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffWeeks < 4) return `${diffWeeks}w ago`;
  if (diffMonths < 12) return `${diffMonths}mo ago`;

  return date.toLocaleDateString();
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Release Notes Modal Functions
async function openReleaseNotesModal(projectId, branch, platforms, track, fromChangeset, toChangeset, usePromote = false) {
  releaseNotesData = {
    projectId,
    branch,
    platforms,
    track,
    fromChangeset,
    toChangeset,
    translations: {},
    currentLang: 'en',
    languages: ['en'],
    savedAt: null,
    isDirty: false,
    commits: [],
    projectName: projectId,
    usePromote  // true = promote existing build, false = trigger new build
  };

  // Show modal with loading state
  const modal = document.getElementById('releaseNotesModal');
  const loading = document.getElementById('releaseNotesLoading');
  const editor = document.getElementById('releaseNotesEditor');
  const errorDiv = document.getElementById('releaseNotesError');

  loading.style.display = 'block';
  editor.style.display = 'none';
  errorDiv.style.display = 'none';
  modal.classList.add('show');

  try {
    // Fetch project languages and commits in parallel
    const [langResponse, commitsResponse, savedResponse] = await Promise.all([
      fetch(`/api/project-languages/${projectId}`),
      fetch('/api/get-commits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, branch, fromChangeset, toChangeset })
      }),
      fetch(`/api/release-notes/${projectId}/${toChangeset}`)
    ]);

    const langData = await langResponse.json();
    const commitsData = await commitsResponse.json();
    const savedData = await savedResponse.json();

    releaseNotesData.languages = langData.languages || ['en'];
    releaseNotesData.commits = commitsData.commits || [];
    releaseNotesData.projectName = commitsData.projectName || projectId;

    // Check for saved notes
    let hasSavedNotes = false;
    if (savedData.success && savedData.found) {
      releaseNotesData.translations = savedData.translations;
      releaseNotesData.savedAt = savedData.savedAt;
      hasSavedNotes = true;
      showToast('Loaded saved release notes', 'info');
    }

    // Update UI header
    document.getElementById('releaseNotesProject').textContent = releaseNotesData.projectName;
    document.getElementById('releaseNotesRange').textContent = `${extractChangeset(fromChangeset) || '0'} → ${extractChangeset(toChangeset)}`;
    document.getElementById('releaseNotesCommitCount').textContent = `${releaseNotesData.commits.length} commits`;

    // Render changes list
    renderChangesList(releaseNotesData.commits);

    // Render language tabs
    renderLanguageTabs();

    // Set up auto-save on textarea changes
    const textarea = document.getElementById('releaseNotesText');
    textarea.removeEventListener('input', debouncedSaveNotes);
    textarea.addEventListener('input', debouncedSaveNotes);

    loading.style.display = 'none';
    editor.style.display = 'block';

    // Update button text based on mode (rollout, promote, or distribute)
    const distributeBtn = document.getElementById('distributeBtn');
    const rolloutLabels = {
      'mexico': 'Start Rollout (Mexico)',
      '20%': 'Start Rollout (20%)',
      '100%': 'Start Rollout (100%)'
    };
    if (rolloutLabels[releaseNotesData.track]) {
      distributeBtn.textContent = rolloutLabels[releaseNotesData.track];
    } else {
      distributeBtn.textContent = releaseNotesData.usePromote ? 'Promote' : 'Distribute';
    }

    // If we have saved notes, switch to notes tab; otherwise show changes
    if (hasSavedNotes) {
      switchReleaseNotesTab('notes');
      selectLanguage('en');
      updateSaveStatus();
    } else {
      switchReleaseNotesTab('changes');
    }
  } catch (error) {
    loading.style.display = 'none';
    errorDiv.style.display = 'block';
    document.getElementById('errorMessage').textContent = error.message;
  }
}

function renderChangesList(commits) {
  const container = document.getElementById('releaseNotesChangesList');

  if (!commits || commits.length === 0) {
    container.innerHTML = '<div class="empty-message">No commits found in this range</div>';
    return;
  }

  const html = commits.map(c => {
    const mergeInfo = c.mergedFrom ? `<span class="merge-badge" title="Merged from ${c.mergedFrom} at changeset ${c.mergedAt}">🔀 ${c.mergedFrom.replace('/main/', '').replace('br:', '')}</span>` : '';
    return `
      <div class="change-item ${c.mergedFrom ? 'merged' : ''}">
        <span class="change-id">${c.version || c.changeset || ''}</span>
        <span class="change-message">${escapeHtml(c.message || '')} ${mergeInfo}</span>
        <span class="change-author">${escapeHtml(c.author || '')}</span>
      </div>
    `;
  }).join('');

  container.innerHTML = html;
}

function switchReleaseNotesTab(tabName) {
  // Update tab buttons
  document.querySelectorAll('.release-notes-tabs .tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  // Update tab content
  document.getElementById('releaseNotesChangesTab').classList.toggle('active', tabName === 'changes');
  document.getElementById('releaseNotesNotesTab').classList.toggle('active', tabName === 'notes');

  // If switching to notes tab and no translations yet, initialize with empty
  if (tabName === 'notes' && Object.keys(releaseNotesData.translations).length === 0) {
    for (const lang of releaseNotesData.languages) {
      releaseNotesData.translations[lang] = '';
    }
    selectLanguage('en');
  }
}

async function generateNotesFromChanges() {
  const btn = document.getElementById('generateNotesBtn');
  btn.disabled = true;
  btn.textContent = 'Generating...';

  // Switch to notes tab immediately and show streaming content
  switchReleaseNotesTab('notes');
  selectLanguage('en');

  const textarea = document.getElementById('releaseNotesText');
  textarea.value = '';
  releaseNotesData.translations = { en: '' };

  try {
    // Use streaming endpoint for real-time generation
    const response = await fetch('/api/stream-release-notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: releaseNotesData.projectId,
        commits: releaseNotesData.commits
      })
    });

    if (!response.ok) {
      throw new Error('Failed to start generation');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      // Parse SSE data lines
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.error) {
              throw new Error(data.error);
            }
            if (data.chunk) {
              fullText += data.chunk;
              textarea.value = fullText;
              releaseNotesData.translations.en = fullText;
              // Auto-scroll to bottom
              textarea.scrollTop = textarea.scrollHeight;
            }
            if (data.done) {
              // Generation complete
              await saveReleaseNotesToDisk();
              showToast('Release notes generated', 'success');
            }
          } catch (e) {
            if (e.message !== 'Unexpected end of JSON input') {
              console.error('Parse error:', e);
            }
          }
        }
      }
    }
  } catch (error) {
    showToast(`Failed to generate: ${error.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate Release Notes';
  }
}

function closeReleaseNotesModal() {
  document.getElementById('releaseNotesModal').classList.remove('show');
}

async function refreshChangesFromPlastic() {
  const btn = document.getElementById('refreshChangesBtn');
  btn.disabled = true;
  btn.textContent = '🔄 Refreshing...';

  try {
    // Force refresh from Plastic by using the generate endpoint (which always fetches fresh)
    const response = await fetch('/api/generate-release-notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: releaseNotesData.projectId,
        branch: releaseNotesData.branch,
        fromChangeset: releaseNotesData.fromChangeset,
        toChangeset: releaseNotesData.toChangeset
      })
    });

    const data = await response.json();

    if (!data.success) {
      showToast(data.error || 'Failed to fetch changes', 'error');
      return;
    }

    // Update commit count
    document.getElementById('releaseNotesCommitCount').textContent = `${data.commitCount} commits`;

    showToast(`Refreshed: found ${data.commitCount} commits (including merges)`, 'success');
  } catch (error) {
    showToast(`Failed to refresh: ${error.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 Refresh';
  }
}

function renderLanguageTabs() {
  const tabsContainer = document.getElementById('languageTabs');
  const tabs = releaseNotesData.languages.map(lang => {
    const isActive = lang === releaseNotesData.currentLang ? 'active' : '';
    const name = languageNames[lang] || lang;
    return `<button class="tab ${isActive}" onclick="selectLanguage('${lang}')">${name}</button>`;
  }).join('');
  tabsContainer.innerHTML = tabs;
}

function selectLanguage(lang) {
  // Save current text if we're switching from a language
  if (releaseNotesData.currentLang && releaseNotesData.currentLang !== lang) {
    const textarea = document.getElementById('releaseNotesText');
    releaseNotesData.translations[releaseNotesData.currentLang] = textarea.value;
    // Trigger save when switching tabs
    debouncedSaveNotes();
  }

  releaseNotesData.currentLang = lang;
  renderLanguageTabs();

  // Load the selected language's text
  const textarea = document.getElementById('releaseNotesText');
  textarea.value = releaseNotesData.translations[lang] || '';
}

async function retranslateNotes() {
  // Save current English text first
  if (releaseNotesData.currentLang === 'en') {
    const textarea = document.getElementById('releaseNotesText');
    releaseNotesData.translations.en = textarea.value;
  }

  const englishNotes = releaseNotesData.translations.en;
  if (!englishNotes) {
    showToast('No English text to translate', 'error');
    return;
  }

  const btn = document.getElementById('retranslateBtn');
  btn.disabled = true;
  btn.textContent = 'Translating...';
  showToast('Translating release notes...', 'info');

  try {
    const response = await fetch('/api/translate-release-notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        englishNotes,
        projectId: releaseNotesData.projectId
      })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Translation failed');
    }

    // Update translations (keeping modified English)
    releaseNotesData.translations = {
      ...result.translations,
      en: englishNotes
    };

    // Refresh current view
    selectLanguage(releaseNotesData.currentLang);

    // Save translations to disk
    await saveReleaseNotesToDisk();

    showToast('Translations updated', 'success');
  } catch (error) {
    showToast(`Translation failed: ${error.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Re-translate All';
  }
}

async function copyForDiscord() {
  // Get current English text
  const englishNotes = releaseNotesData.currentLang === 'en'
    ? document.getElementById('releaseNotesText').value
    : releaseNotesData.translations.en;

  if (!englishNotes) {
    showToast('No release notes to copy', 'error');
    return;
  }

  // Get version info - use full version string (e.g., "3.91.12441")
  const fullVersion = releaseNotesData.toChangeset;
  const projectName = releaseNotesData.projectName;

  // Format for Discord
  // Include full version and timing estimates (Apple: 4-8h, Google: 1-4h)
  const discordText = `**${projectName} ${fullVersion}**

${englishNotes}

_iOS: 4-8 hours | Android: 1-4 hours_`;

  try {
    await navigator.clipboard.writeText(discordText);
    showToast('Copied to clipboard for Discord', 'success');
  } catch (error) {
    // Fallback for older browsers
    const textarea = document.createElement('textarea');
    textarea.value = discordText;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    showToast('Copied to clipboard for Discord', 'success');
  }
}

// Copy last release notes for Discord (can be called from console or keyboard shortcut)
async function copyLastReleaseNotesForDiscord(projectId, toChangeset) {
  try {
    // Fetch saved release notes
    const response = await fetch(`/api/release-notes/${projectId}/${extractChangeset(toChangeset)}`);
    const data = await response.json();

    if (!data.success || !data.found) {
      showToast('No saved release notes - opening generator...', 'info');
      // Open release notes modal to generate notes
      // Get storeRelease version as the "from" changeset
      const project = buildData?.projects?.find(p => p.id === projectId);
      const mainBranch = project?.branches?.find(b => b.branch === 'main');
      const storeReleaseVersion = mainBranch?.tracks?.storeRelease?.iosVersion || mainBranch?.tracks?.storeRelease?.androidVersion || '0';
      openReleaseNotesModal(projectId, 'main', ['ios', 'android'], 'alpha', storeReleaseVersion, toChangeset, true);
      return;
    }

    const englishNotes = data.translations?.en;
    if (!englishNotes) {
      showToast('No English release notes found', 'error');
      return;
    }

    // Get project name from config
    const project = buildData?.projects?.find(p => p.id === projectId);
    const projectName = project?.displayName || projectId;

    // Format for Discord
    const discordText = `**${projectName} ${toChangeset}**

${englishNotes}

_iOS: 4-8 hours | Android: 1-4 hours_`;

    await navigator.clipboard.writeText(discordText);
    showToast('Copied to clipboard for Discord', 'success');
  } catch (error) {
    showToast(`Failed to copy: ${error.message}`, 'error');
  }
}

async function confirmDistribute() {
  // Save current text
  const textarea = document.getElementById('releaseNotesText');
  releaseNotesData.translations[releaseNotesData.currentLang] = textarea.value;

  // Save to disk before distributing (in case it fails)
  await saveReleaseNotesToDisk();

  const isPromote = releaseNotesData.usePromote;

  // For promote actions, require Jenkins auth
  if (isPromote && !jenkinsAuth) {
    openJenkinsLoginModal();
    return;
  }

  await executeDistribute();
}

async function executeDistribute() {
  const btn = document.getElementById('distributeBtn');
  btn.disabled = true;

  const isPromote = releaseNotesData.usePromote;
  const rolloutTypes = ['mexico', '20%', '100%'];
  const isRollout = rolloutTypes.includes(releaseNotesData.track);

  // Determine button text and action word
  const rolloutLabels = {
    'mexico': 'Rollout (Mexico)',
    '20%': 'Rollout (20%)',
    '100%': 'Rollout (100%)'
  };

  let actionWord, buttonText;
  if (isRollout) {
    actionWord = 'Starting rollout';
    buttonText = rolloutLabels[releaseNotesData.track];
  } else if (isPromote) {
    actionWord = 'Promoting';
    buttonText = 'Promote';
  } else {
    actionWord = 'Distributing';
    buttonText = 'Distribute';
  }

  btn.textContent = `${actionWord}...`;
  showToast(`${actionWord} to ${releaseNotesData.track}...`, 'info');

  try {
    let endpoint, body;

    if (isRollout) {
      // Use rollout API - send English notes only, server will translate
      endpoint = '/api/rollout/android/start';
      body = {
        projectId: releaseNotesData.projectId,
        rolloutType: releaseNotesData.track,
        releaseNotes: releaseNotesData.translations?.en || null,
        auth: jenkinsAuth
      };
    } else if (isPromote) {
      // Use promote API
      endpoint = '/api/promote';
      body = {
        projectId: releaseNotesData.projectId,
        platforms: releaseNotesData.platforms,
        fromTrack: 'storeInternal',
        toTrack: 'storeAlpha',
        releaseNotes: releaseNotesData.translations,
        auth: jenkinsAuth
      };
    } else {
      // Use distribute API
      endpoint = '/api/distribute';
      body = {
        projectId: releaseNotesData.projectId,
        branch: releaseNotesData.branch,
        platforms: releaseNotesData.platforms,
        track: releaseNotesData.track,
        releaseNotes: releaseNotesData.translations
      };
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const result = await response.json();

    // If auth is required, show login modal
    if (result.requiresAuth) {
      jenkinsAuth = null;
      sessionStorage.removeItem('jenkinsAuth');
      openJenkinsLoginModal();
      btn.disabled = false;
      btn.textContent = buttonText;
      return;
    }

    if (result.success) {
      // Delete saved notes after successful action
      try {
        await fetch(`/api/release-notes/${releaseNotesData.projectId}/${releaseNotesData.toChangeset}`, {
          method: 'DELETE'
        });
      } catch (e) {
        console.warn('Failed to delete saved notes:', e);
      }

      let successMsg;
      if (isRollout) {
        successMsg = `Rollout started: ${result.versionName} to ${rolloutLabels[releaseNotesData.track]}`;
      } else if (isPromote) {
        successMsg = `Promoted to ${releaseNotesData.track} successfully`;
      } else {
        successMsg = `Distribution to ${releaseNotesData.track} triggered successfully`;
      }
      showToast(successMsg, 'success');
      closeReleaseNotesModal();
      pendingRollout = { projectId: null, rolloutType: null, active: false };
      setTimeout(refresh, isPromote || isRollout ? 2000 : 5000);
    } else {
      const action = isRollout ? 'Rollout' : isPromote ? 'Promotion' : 'Distribution';
      showError(`${action} Failed`, result.error || 'Unknown error occurred');
    }
  } catch (error) {
    const action = isRollout ? 'Rollout' : isPromote ? 'Promotion' : 'Distribution';
    showError(`${action} Failed`, error.message, error.stack);
  } finally {
    btn.disabled = false;
    btn.textContent = buttonText;
  }
}

// Jenkins Login Modal functions
function openJenkinsLoginModal() {
  document.getElementById('jenkinsLoginModal').classList.add('show');
  document.getElementById('jenkinsUsername').value = '';
  document.getElementById('jenkinsPassword').value = '';
  document.getElementById('jenkinsLoginError').style.display = 'none';
  document.getElementById('jenkinsUsername').focus();
}

function closeJenkinsLoginModal() {
  document.getElementById('jenkinsLoginModal').classList.remove('show');
}

async function submitJenkinsLogin() {
  const username = document.getElementById('jenkinsUsername').value.trim();
  const password = document.getElementById('jenkinsPassword').value;
  const errorEl = document.getElementById('jenkinsLoginError');
  const btn = document.getElementById('jenkinsLoginBtn');

  if (!username || !password) {
    errorEl.textContent = 'Username and password are required';
    errorEl.style.display = 'block';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Verifying...';
  errorEl.style.display = 'none';

  try {
    const response = await fetch('/api/auth/jenkins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const result = await response.json();

    if (result.valid) {
      // Store credentials in session
      jenkinsAuth = { username, password };
      sessionStorage.setItem('jenkinsAuth', JSON.stringify(jenkinsAuth));

      showToast(`Logged in as ${result.fullName}`, 'success');
      closeJenkinsLoginModal();

      // Continue with the distribute action
      await executeDistribute();
    } else {
      errorEl.textContent = result.error || 'Invalid credentials';
      errorEl.style.display = 'block';
    }
  } catch (error) {
    errorEl.textContent = 'Failed to verify credentials: ' + error.message;
    errorEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Login & Promote';
  }
}

// Compare Modal State
let compareData = {
  projectId: null,
  branch: null,
  changesets: [],
  result: null
};

// Smart compare - opens compare modal with pre-filled values based on context
async function openSmartCompare(projectId, branch, trackName, clickedChangeset, storeVersion, plasticChangeset) {
  // Open modal and wait for changesets to load
  const changesets = await openCompareModal(projectId, branch);

  if (!changesets || changesets.length === 0) return;

  const fromSelect = document.getElementById('fromChangeset');
  const toSelect = document.getElementById('toChangeset');
  const latestChangeset = changesets[0]?.changeset;

  // Determine FROM and TO based on what was clicked
  // FROM = older version (store release), TO = newer version (clicked)
  const fromVal = storeVersion || null;
  const toVal = clickedChangeset || latestChangeset;

  // Helper to add missing changeset option if not in dropdown
  function ensureOptionExists(select, value) {
    if (!value) return false;
    // Check if option already exists
    const exists = Array.from(select.options).some(opt => opt.value === value);
    if (!exists) {
      // Add the missing option (older changeset not in recent list)
      const option = document.createElement('option');
      option.value = value;
      option.textContent = `${value} (store release)`;
      // Insert after the placeholder option
      select.insertBefore(option, select.options[1]);
    }
    return true;
  }

  if (fromVal && toVal) {
    const fromNum = parseInt(fromVal);
    const toNum = parseInt(toVal);

    if (fromNum < toNum) {
      ensureOptionExists(fromSelect, fromVal);
      ensureOptionExists(toSelect, toVal);
      fromSelect.value = fromVal;
      toSelect.value = toVal;
    } else if (fromNum > toNum) {
      // Swap if from is newer than to
      ensureOptionExists(fromSelect, toVal);
      ensureOptionExists(toSelect, fromVal);
      fromSelect.value = toVal;
      toSelect.value = fromVal;
    } else {
      // Same version
      ensureOptionExists(toSelect, toVal);
      toSelect.value = toVal;
    }
  } else if (toVal) {
    ensureOptionExists(toSelect, toVal);
    toSelect.value = toVal;
  }
}

// Open compare modal - returns changesets when loaded
async function openCompareModal(projectId, branch) {
  compareData = {
    projectId,
    branch,
    changesets: [],
    result: null
  };

  // Show modal
  const modal = document.getElementById('compareModal');
  const selector = document.getElementById('compareSelector');
  const loading = document.getElementById('compareLoading');
  const results = document.getElementById('compareResults');
  const errorDiv = document.getElementById('compareError');

  selector.style.display = 'block';
  loading.style.display = 'none';
  results.style.display = 'none';
  errorDiv.style.display = 'none';
  modal.classList.add('show');

  // Find project name
  const project = buildData.projects.find(p => p.id === projectId);
  document.getElementById('compareProject').textContent = project?.displayName || projectId;
  document.getElementById('compareBranch').textContent = branch;

  // Fetch changesets for dropdown
  try {
    const response = await fetch(`/api/changesets/${projectId}/${encodeURIComponent(branch)}?limit=30`);
    const data = await response.json();

    if (data.success) {
      compareData.changesets = data.changesets;
      populateChangesetDropdowns(data.changesets);
      return data.changesets;
    } else {
      throw new Error(data.error || 'Failed to fetch changesets');
    }
  } catch (error) {
    showToast(`Failed to load changesets: ${error.message}`, 'error');
    return [];
  }
}

function closeCompareModal() {
  document.getElementById('compareModal').classList.remove('show');
}

// Download Links Modal
function convertGDriveToDirectDownload(url) {
  if (!url || !url.includes('drive.google.com')) return url;
  const match = url.match(/\/file\/d\/([^\/]+)/);
  if (match && match[1]) {
    return `https://drive.usercontent.google.com/u/0/uc?id=${match[1]}&export=download`;
  }
  return url;
}

function openDownloadModal(iosDownloadUrl, androidDownloadUrl) {
  const modal = document.getElementById('downloadModal');
  const content = document.getElementById('downloadLinksContent');

  let html = '';

  if (iosDownloadUrl) {
    const convertedUrl = convertGDriveToDirectDownload(iosDownloadUrl);
    html += `
      <div class="download-link-item">
        <div class="download-link-label">
          <img src="/icons/ios.svg" alt="iOS">
          iOS Download
        </div>
        <div class="download-link-url">
          <input type="text" value="${escapeHtml(convertedUrl)}" readonly onclick="this.select()">
          <button onclick="copyToClipboard('${escapeHtml(convertedUrl)}')">Copy</button>
        </div>
      </div>
    `;
  }

  if (androidDownloadUrl) {
    const convertedUrl = convertGDriveToDirectDownload(androidDownloadUrl);
    html += `
      <div class="download-link-item">
        <div class="download-link-label">
          <img src="/icons/android.svg" alt="Android">
          Android Download
        </div>
        <div class="download-link-url">
          <input type="text" value="${escapeHtml(convertedUrl)}" readonly onclick="this.select()">
          <button onclick="copyToClipboard('${escapeHtml(convertedUrl)}')">Copy</button>
        </div>
      </div>
    `;
  }

  if (!html) {
    html = '<p style="text-align: center; color: #888;">No download links available</p>';
  }

  content.innerHTML = html;
  modal.classList.add('show');
}

function closeDownloadModal() {
  document.getElementById('downloadModal').classList.remove('show');
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast('Link copied to clipboard', 'success');
  }).catch(() => {
    showToast('Failed to copy link', 'error');
  });
}

// Build History Modal
async function openBuildHistoryModal(projectId, branchName, buildType) {
  console.log('openBuildHistoryModal called:', { projectId, branchName, buildType });

  const modal = document.getElementById('buildHistoryModal');
  const loading = document.getElementById('buildHistoryLoading');
  const content = document.getElementById('buildHistoryContent');
  const errorDiv = document.getElementById('buildHistoryError');

  if (!modal || !loading || !content || !errorDiv) {
    console.error('Build history modal elements not found!', { modal: !!modal, loading: !!loading, content: !!content, errorDiv: !!errorDiv });
    showToast('Modal elements not found', 'error');
    return;
  }

  // Show loading state
  loading.style.display = 'block';
  content.style.display = 'none';
  errorDiv.style.display = 'none';
  modal.classList.add('show');

  try {
    console.log('Fetching build history...');
    // Fetch build history from server
    const response = await fetch('/api/build-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, branch: branchName, buildType })
    });

    console.log('Response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('API error:', errorText);
      throw new Error(`Server error: ${response.status}`);
    }

    const data = await response.json();
    console.log('Received build history:', data);

    // Update header info
    document.getElementById('buildHistoryInfo').innerHTML = `
      <span><strong>Project:</strong> ${escapeHtml(projectId)}</span>
      <span><strong>Branch:</strong> ${escapeHtml(branchName)}</span>
      <span><strong>Type:</strong> ${escapeHtml(buildType)}</span>
      <span><strong>Builds:</strong> ${data.builds?.length || 0}</span>
    `;

    // Render build list
    renderBuildHistoryList(data.builds || []);

    loading.style.display = 'none';
    content.style.display = 'block';
    console.log('Build history modal rendered successfully');
  } catch (error) {
    console.error('Build history error:', error);
    loading.style.display = 'none';
    errorDiv.style.display = 'block';
    document.getElementById('buildHistoryErrorMessage').textContent = error.message || 'Unknown error occurred';
  }
}

function renderBuildHistoryList(builds) {
  const container = document.getElementById('buildHistoryList');

  if (!builds || builds.length === 0) {
    container.innerHTML = '<div class="empty-message" style="text-align:center;color:#888;padding:20px;">No build history available</div>';
    return;
  }

  const html = builds.map((build, index) => {
    const changeset = extractChangeset(build.version) || '-';
    const date = build.date ? formatRelativeDate(build.date) : '-';
    const message = build.commitMessage || 'No commit message';

    // Build download buttons (lazy-loaded)
    let downloadHtml = '';
    const hasIosDownload = build.iosResult === 'SUCCESS' || build.iosResult === 'UNSTABLE';
    const hasAndroidDownload = build.androidResult === 'SUCCESS' || build.androidResult === 'UNSTABLE';

    if (hasIosDownload || hasAndroidDownload) {
      downloadHtml = '<div class="build-history-download">';
      if (hasIosDownload) {
        downloadHtml += `<button class="download-btn" onclick="downloadBuild('${escapeHtml(build.iosJob)}', ${build.iosBuildNumber}, 'ios-${index}')">
          <span id="ios-${index}">iOS</span>
        </button>`;
      }
      if (hasAndroidDownload) {
        downloadHtml += `<button class="download-btn" onclick="downloadBuild('${escapeHtml(build.androidJob)}', ${build.androidBuildNumber}, 'android-${index}')">
          <span id="android-${index}">Android</span>
        </button>`;
      }
      downloadHtml += '</div>';
    }

    return `
      <div class="build-history-item">
        <div class="build-history-changeset">${escapeHtml(changeset)}</div>
        <div class="build-history-date">${escapeHtml(date)}</div>
        <div class="build-history-message" title="${escapeHtml(message)}">${escapeHtml(message)}</div>
        ${downloadHtml}
      </div>
    `;
  }).join('');

  container.innerHTML = html;
}

// Lazy-load download URL when user clicks download button
async function downloadBuild(jobName, buildNumber, elementId) {
  const element = document.getElementById(elementId);
  const originalText = element.textContent;
  element.textContent = '...';

  try {
    const response = await fetch('/api/build-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobName, buildNumber })
    });

    if (!response.ok) {
      throw new Error('Failed to fetch download URL');
    }

    const data = await response.json();
    if (data.url) {
      const directUrl = convertGDriveToDirectDownload(data.url);
      window.open(directUrl, '_blank');
      element.textContent = originalText;
    } else {
      throw new Error('No download URL found');
    }
  } catch (error) {
    console.error('Download failed:', error);
    showToast('Failed to get download link', 'error');
    element.textContent = originalText;
  }
}

function closeBuildHistoryModal() {
  document.getElementById('buildHistoryModal').classList.remove('show');
}

function populateChangesetDropdowns(changesets) {
  const fromSelect = document.getElementById('fromChangeset');
  const toSelect = document.getElementById('toChangeset');

  // Build options
  const options = changesets.map(cs => {
    const truncatedMsg = cs.message.length > 50 ? cs.message.substring(0, 50) + '...' : cs.message;
    return `<option value="${cs.changeset}">${cs.changeset} - ${escapeHtml(truncatedMsg)}</option>`;
  }).join('');

  fromSelect.innerHTML = '<option value="">Select start changeset...</option>' + options;
  toSelect.innerHTML = '<option value="">Select end changeset...</option>' + options;
  // Don't auto-set values here - let the caller handle it
}

async function runComparison() {
  const fromChangeset = document.getElementById('fromChangeset').value;
  const toChangeset = document.getElementById('toChangeset').value;

  if (!fromChangeset || !toChangeset) {
    showToast('Please select both From and To changesets', 'error');
    return;
  }

  if (parseInt(fromChangeset) >= parseInt(toChangeset)) {
    showToast('From changeset must be earlier than To changeset', 'error');
    return;
  }

  const selector = document.getElementById('compareSelector');
  const loading = document.getElementById('compareLoading');
  const results = document.getElementById('compareResults');
  const errorDiv = document.getElementById('compareError');

  loading.style.display = 'block';
  results.style.display = 'none';
  errorDiv.style.display = 'none';

  try {
    const response = await fetch('/api/compare-changesets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: compareData.projectId,
        fromChangeset: parseInt(fromChangeset),
        toChangeset: parseInt(toChangeset),
        generateAiSummary: true
      })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Comparison failed');
    }

    compareData.result = result;

    // Update stats
    document.getElementById('compareChangesetCount').innerHTML = `<strong>${result.stats.changesetCount}</strong> changesets`;
    document.getElementById('compareMergeCount').innerHTML = `<strong>${result.stats.mergeCount}</strong> merges`;
    document.getElementById('compareFileCount').innerHTML = `<strong>${result.stats.fileCount}</strong> files (${result.stats.addedFiles}A/${result.stats.changedFiles}C/${result.stats.deletedFiles}D)`;

    // Render content
    renderCompareSummary(result.aiSummary);
    renderCompareChangesets(result.changesets);
    renderCompareMerges(result.merges);
    renderCompareFiles(result.fileDiff);

    // Show results
    loading.style.display = 'none';
    results.style.display = 'block';

    // Reset to summary tab
    switchCompareTab('summary');
  } catch (error) {
    loading.style.display = 'none';
    errorDiv.style.display = 'block';
    document.getElementById('compareErrorMessage').textContent = error.message;
  }
}

function switchCompareTab(tabName) {
  // Update tab buttons
  document.querySelectorAll('.compare-tabs .tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  // Update tab content
  document.querySelectorAll('#compareResults .tab-content').forEach(content => {
    content.classList.toggle('active', content.id === `compare${tabName.charAt(0).toUpperCase() + tabName.slice(1)}Tab`);
  });
}

function renderCompareSummary(summary) {
  const container = document.getElementById('compareSummaryContent');
  if (summary) {
    // Use marked library to convert markdown to HTML
    container.innerHTML = marked.parse(summary);
  } else {
    container.innerHTML = '<p class="list-empty">AI summary not available. Check your API key configuration.</p>';
  }
}

function renderCompareChangesets(changesets) {
  const container = document.getElementById('compareChangesetsContent');

  if (!changesets || changesets.length === 0) {
    container.innerHTML = '<p class="list-empty">No changesets found</p>';
    return;
  }

  const html = changesets.map(cs => `
    <div class="list-item">
      <span class="changeset-id">cs:${cs.changeset}</span>
      <span class="changeset-branch">${escapeHtml(cs.branch)}</span>
      <span class="changeset-message">${escapeHtml(cs.message)}</span>
      <span class="changeset-author">${escapeHtml(cs.author)}</span>
    </div>
  `).join('');

  container.innerHTML = html;
}

function renderCompareMerges(merges) {
  const container = document.getElementById('compareMergesContent');

  if (!merges || merges.length === 0) {
    container.innerHTML = '<p class="list-empty">No merges in this range</p>';
    return;
  }

  const html = merges.map(m => `
    <div class="list-item">
      <span class="merge-type ${m.type}">${escapeHtml(m.type)}</span>
      <span class="merge-info-text">
        <span class="merge-source">${escapeHtml(m.sourceBranch)}</span> (cs:${m.sourceChangeset})
        merged into
        <span class="merge-dest">${escapeHtml(m.destBranch)}</span> at cs:${m.destChangeset}
      </span>
      <span class="changeset-author">${escapeHtml(m.author)}</span>
    </div>
  `).join('');

  container.innerHTML = html;
}

function renderCompareFiles(files) {
  const container = document.getElementById('compareFilesContent');

  if (!files || files.length === 0) {
    container.innerHTML = '<p class="list-empty">No file changes found</p>';
    return;
  }

  const html = files.map(f => `
    <div class="list-item">
      <span class="file-status ${f.status}" title="${f.statusName}">${f.status}</span>
      <span class="file-path">${escapeHtml(f.path)}</span>
    </div>
  `).join('');

  container.innerHTML = html;
}

// Initial load - trigger server refresh on page load (F5)
async function initialLoad() {
  // First, show cached data immediately for fast initial render
  await fetchBuilds();

  // Fetch analytics in background (non-blocking)
  fetchAnalytics();

  // Then trigger a server-side refresh in the background
  try {
    const response = await fetch('/api/refresh', { method: 'POST' });
    buildData = await response.json();
    render();
  } catch (error) {
    console.error('Background refresh failed:', error);
  }
}

initialLoad();

// Track which data sources are currently loading
const loadingState = {
  store: false,
  vitals: false,
  sentry: false,
  analytics: false,
  plastic: false
};

function updateLoadingUI() {
  const dashboard = document.getElementById('dashboard');
  if (!dashboard) return;

  // Update body classes for CSS animations
  Object.keys(loadingState).forEach(key => {
    if (loadingState[key]) {
      dashboard.classList.add(`loading-${key}`);
    } else {
      dashboard.classList.remove(`loading-${key}`);
    }
  });

  // Update loading badges in header
  let badges = document.getElementById('loadingBadges');
  if (!badges) {
    const headerActions = document.querySelector('.header-actions');
    if (headerActions) {
      badges = document.createElement('div');
      badges.id = 'loadingBadges';
      badges.className = 'loading-badges';
      headerActions.insertBefore(badges, headerActions.firstChild);
    }
  }

  if (badges) {
    const active = Object.entries(loadingState).filter(([_, v]) => v).map(([k]) => k);
    if (active.length > 0) {
      badges.innerHTML = active.map(k => `<span class="badge">${k}</span>`).join('');
    } else {
      badges.innerHTML = '';
    }
  }
}

// Set up SSE for real-time updates from server
function setupSSE() {
  const eventSource = new EventSource('/api/events');

  eventSource.addEventListener('connected', () => {
    console.log('SSE connected');
  });

  eventSource.addEventListener('refresh', async () => {
    console.log('Data updated, refreshing...');
    // Clear all loading states
    Object.keys(loadingState).forEach(k => loadingState[k] = false);
    updateLoadingUI();
    await fetchBuilds();
  });

  eventSource.addEventListener('refresh-status', (e) => {
    const data = JSON.parse(e.data);
    const statusEl = document.getElementById('refreshStatus');
    if (statusEl) {
      statusEl.textContent = data.status || '';
    }

    // Set loading states when refresh starts
    if (data.status && data.status.includes('Fetching')) {
      Object.keys(loadingState).forEach(k => loadingState[k] = true);
      updateLoadingUI();
    } else if (!data.status) {
      Object.keys(loadingState).forEach(k => loadingState[k] = false);
      updateLoadingUI();
    }
  });

  // Handle incremental data updates
  eventSource.addEventListener('data-updated', async (e) => {
    const data = JSON.parse(e.data);
    console.log(`Data updated: ${data.source}`);

    // Mark this source as done loading
    if (loadingState[data.source] !== undefined) {
      loadingState[data.source] = false;
      updateLoadingUI();
    }

    // Refresh UI with latest data
    await fetchBuilds();
  });

  eventSource.addEventListener('store-updated', async () => {
    console.log('Store data updated');
    loadingState.store = false;
    updateLoadingUI();
    await fetchBuilds();
  });

  eventSource.onerror = (e) => {
    console.warn('SSE connection error, will reconnect...');
    // Clear status and loading states on disconnect
    const statusEl = document.getElementById('refreshStatus');
    if (statusEl) statusEl.textContent = '';
    Object.keys(loadingState).forEach(k => loadingState[k] = false);
    updateLoadingUI();
  };
}

setupSSE();

// Auto-refresh every 60 seconds (just fetches cached data)
// setInterval(fetchBuilds, 60000);

// Refresh analytics every 5 minutes (less frequently than builds)
// setInterval(fetchAnalytics, 300000);

// ============================================
// Crashboard - Unified crash/error tracking
// ============================================

let crashboardData = null;
let crashboardSearchTerm = '';

async function fetchCrashboard() {
  const content = document.getElementById('crashboardContent');

  try {
    content.innerHTML = '<div class="crashboard-loading">Loading crash data...</div>';

    const response = await fetch('/api/crashboard');
    const data = await response.json();

    if (data.success) {
      crashboardData = data.crashboard;
      renderCrashboard();
    } else {
      content.innerHTML = `<div class="crashboard-error">Failed to load: ${data.error}</div>`;
    }
  } catch (error) {
    console.error('Failed to fetch crashboard:', error);
    content.innerHTML = `<div class="crashboard-error">Failed to load crashboard</div>`;
  }
}

function renderCrashboard() {
  const content = document.getElementById('crashboardContent');
  const searchTerm = crashboardSearchTerm.toLowerCase();

  if (!crashboardData || Object.keys(crashboardData).length === 0) {
    content.innerHTML = '<div class="crashboard-empty">No crash data available</div>';
    return;
  }

  let html = '';

  for (const [projectName, projectData] of Object.entries(crashboardData)) {
    const { issues, totalIssues, link } = projectData;

    // Filter issues by search term
    const filteredIssues = searchTerm
      ? issues.filter(i => i.title.toLowerCase().includes(searchTerm))
      : issues;

    // Skip project if no matching issues and search is active
    if (searchTerm && filteredIssues.length === 0) continue;

    html += `
      <div class="crashboard-project">
        <div class="crashboard-project-header">
          <span class="crashboard-project-name">${escapeHtml(projectName)}</span>
          <div class="crashboard-summary">
            <a href="${escapeHtml(link)}" target="_blank" class="crashboard-link" title="View all ${totalIssues} issues in Sentry">
              <img src="/icons/sentry.svg" alt="Sentry"><span>${totalIssues} issues</span>
            </a>
          </div>
        </div>
        <table class="crashboard-table">
          <thead>
            <tr>
              <th class="cb-level">Level</th>
              <th class="cb-title">Issue</th>
              <th class="cb-users">Users</th>
              <th class="cb-count">Events</th>
            </tr>
          </thead>
          <tbody>
            ${filteredIssues.length > 0 ? filteredIssues.map(issue => `
              <tr class="crashboard-issue">
                <td class="cb-level"><span class="cb-level-${issue.level}">${issue.level}</span></td>
                <td class="cb-title">
                  <a href="${escapeHtml(issue.link || '#')}" target="_blank" class="cb-title-link">
                    ${escapeHtml(issue.title)}
                  </a>
                </td>
                <td class="cb-users">${formatCount(issue.userCount)}</td>
                <td class="cb-count">${formatCount(issue.count)}</td>
              </tr>
            `).join('') : `
              <tr><td colspan="4" class="cb-empty">No issues found</td></tr>
            `}
          </tbody>
        </table>
      </div>
    `;
  }

  if (!html) {
    html = '<div class="crashboard-empty">No matching issues found</div>';
  }

  content.innerHTML = html;
}

function formatCount(n) {
  if (n === null || n === undefined) return '-';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toLocaleString();
}

// Search filter with debounce
let searchDebounce = null;
document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.getElementById('crashboardSearch');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      if (searchDebounce) clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        crashboardSearchTerm = e.target.value;
        renderCrashboard();
      }, 300);
    });
  }

  // Initial fetch after page load
  setTimeout(fetchCrashboard, 500);
});

// Refresh crashboard every 5 minutes
// setInterval(fetchCrashboard, 300000);

// ============================================
// Android Rollout Functions
// ============================================

// Pending rollout action (used when auth is needed)
let pendingRolloutAction = null;

function toggleRolloutMenu(event) {
  event.stopPropagation();
  const wrapper = event.target.closest('.rollout-menu-wrapper');
  const menu = wrapper.querySelector('.rollout-menu');
  const isOpen = menu.classList.contains('show');

  // Close all other menus first
  document.querySelectorAll('.rollout-menu.show').forEach(m => m.classList.remove('show'));
  document.querySelectorAll('.build-menu.show').forEach(m => m.classList.remove('show'));

  if (!isOpen) {
    menu.classList.add('show');
  }
}

function closeRolloutMenu(event) {
  event.stopPropagation();
  document.querySelectorAll('.rollout-menu.show').forEach(m => m.classList.remove('show'));
}

// Close rollout menus when clicking outside
document.addEventListener('click', () => {
  document.querySelectorAll('.rollout-menu.show').forEach(m => m.classList.remove('show'));
});

// Rollout state - tracks pending rollout when using release notes modal
let pendingRollout = {
  projectId: null,
  rolloutType: null,
  active: false
};

async function startAndroidRollout(projectId, rolloutType) {
  // Require Jenkins auth first
  if (!jenkinsAuth) {
    pendingRolloutAction = { type: 'startAndroidRollout', projectId, rolloutType };
    openJenkinsLoginForRollout();
    return;
  }

  // Store rollout info and open the full release notes modal
  pendingRollout = { projectId, rolloutType, active: true };

  // Find the project to get changeset info
  const project = buildData.projects?.find(p => p.id === projectId);
  const mainBranch = project?.branches?.find(b => b.branch === 'main' || b.branch === 'master');

  // Get storeAlpha version as the "to" changeset, and storeRelease as "from"
  const toVersion = mainBranch?.tracks?.storeAlpha?.androidVersion;
  const fromVersion = mainBranch?.tracks?.storeRelease?.androidVersion;

  const toChangeset = extractChangeset(toVersion) || '0';
  const fromChangeset = extractChangeset(fromVersion) || '0';

  // Open the full release notes modal with rollout mode
  await openReleaseNotesModal(
    projectId,
    'main',
    ['android'],
    rolloutType,  // Pass rollout type as track (mexico, 20%, 100%)
    fromChangeset,
    toChangeset,
    true  // usePromote flag - will show rollout button
  );
}

async function executeStartAndroidRollout(projectId, rolloutType, releaseNotes = null) {
  const rolloutLabels = {
    'mexico': 'Mexico only',
    '20%': '20% global',
    '100%': '100% global'
  };

  showToast(`Starting Android rollout (${rolloutLabels[rolloutType]})...`, 'info');

  try {
    const response = await fetch('/api/rollout/android/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        rolloutType,
        releaseNotes,
        auth: jenkinsAuth
      })
    });

    const result = await response.json();

    if (result.requiresAuth) {
      jenkinsAuth = null;
      sessionStorage.removeItem('jenkinsAuth');
      pendingRolloutAction = { type: 'startAndroidRollout', projectId, rolloutType };
      openJenkinsLoginForRollout();
      return;
    }

    if (result.success) {
      showToast(`Android rollout started: ${result.versionName} to ${rolloutLabels[rolloutType]}`, 'success');
      setTimeout(refresh, 3000);
    } else {
      throw new Error(result.error || 'Failed to start rollout');
    }
  } catch (error) {
    throw error;
  }
}

async function updateAndroidRollout(projectId, percentage) {
  if (!jenkinsAuth) {
    pendingRolloutAction = { type: 'updateAndroidRollout', projectId, percentage };
    openJenkinsLoginForRollout();
    return;
  }

  await executeUpdateAndroidRollout(projectId, percentage);
}

async function executeUpdateAndroidRollout(projectId, percentage) {
  showToast(`Updating Android rollout to ${percentage}%...`, 'info');

  try {
    const response = await fetch('/api/rollout/android/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        percentage,
        auth: jenkinsAuth
      })
    });

    const result = await response.json();

    if (result.requiresAuth) {
      jenkinsAuth = null;
      sessionStorage.removeItem('jenkinsAuth');
      pendingRolloutAction = { type: 'updateAndroidRollout', projectId, percentage };
      openJenkinsLoginForRollout();
      return;
    }

    if (result.success) {
      const statusMsg = result.status === 'completed' ? 'Rollout complete!' : `Rollout updated to ${percentage}%`;
      showToast(statusMsg, 'success');
      setTimeout(refresh, 3000);
    } else {
      showError('Rollout Update Failed', result.error || 'Unknown error occurred');
    }
  } catch (error) {
    showError('Rollout Update Failed', error.message, error.stack);
  }
}

async function haltAndroidRollout(projectId) {
  if (!jenkinsAuth) {
    pendingRolloutAction = { type: 'haltAndroidRollout', projectId };
    openJenkinsLoginForRollout();
    return;
  }

  await executeHaltAndroidRollout(projectId);
}

async function executeHaltAndroidRollout(projectId) {
  showToast('Halting Android rollout...', 'info');

  try {
    const response = await fetch('/api/rollout/android/halt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        auth: jenkinsAuth
      })
    });

    const result = await response.json();

    if (result.requiresAuth) {
      jenkinsAuth = null;
      sessionStorage.removeItem('jenkinsAuth');
      pendingRolloutAction = { type: 'haltAndroidRollout', projectId };
      openJenkinsLoginForRollout();
      return;
    }

    if (result.success) {
      showToast('Android rollout halted', 'success');
      setTimeout(refresh, 3000);
    } else {
      showError('Halt Rollout Failed', result.error || 'Unknown error occurred');
    }
  } catch (error) {
    showError('Halt Rollout Failed', error.message, error.stack);
  }
}

// ============================================
// iOS App Store Submission
// ============================================

async function submitIOSForReview(projectId, buildId) {
  if (!jenkinsAuth) {
    pendingRolloutAction = { type: 'submitIOSForReview', projectId, buildId };
    openJenkinsLoginForRollout();
    return;
  }

  await executeSubmitIOSForReview(projectId, buildId);
}

async function executeSubmitIOSForReview(projectId, buildId) {
  showToast('Submitting iOS build for App Store review...', 'info');

  try {
    const response = await fetch('/api/submit-ios-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        buildId,
        auth: jenkinsAuth
      })
    });

    const result = await response.json();

    if (result.requiresAuth) {
      jenkinsAuth = null;
      sessionStorage.removeItem('jenkinsAuth');
      pendingRolloutAction = { type: 'submitIOSForReview', projectId, buildId };
      openJenkinsLoginForRollout();
      return;
    }

    if (result.success) {
      showToast('iOS build submitted for App Store review', 'success');
      setTimeout(refresh, 3000);
    } else {
      showError('iOS Submission Failed', result.error || 'Unknown error occurred');
    }
  } catch (error) {
    showError('iOS Submission Failed', error.message, error.stack);
  }
}

// ============================================
// Jenkins Auth for Rollout Actions
// ============================================

function openJenkinsLoginForRollout() {
  document.getElementById('jenkinsLoginModal').classList.add('show');
  document.getElementById('jenkinsUsername').value = '';
  document.getElementById('jenkinsPassword').value = '';
  document.getElementById('jenkinsLoginError').style.display = 'none';
  document.getElementById('jenkinsUsername').focus();

  // Update button text based on pending action
  const btn = document.getElementById('jenkinsLoginBtn');
  btn.textContent = 'Login & Continue';
}

// Override the Jenkins login submit to handle rollout actions
const originalSubmitJenkinsLogin = submitJenkinsLogin;
submitJenkinsLogin = async function() {
  const username = document.getElementById('jenkinsUsername').value.trim();
  const password = document.getElementById('jenkinsPassword').value;
  const errorEl = document.getElementById('jenkinsLoginError');
  const btn = document.getElementById('jenkinsLoginBtn');

  if (!username || !password) {
    errorEl.textContent = 'Username and password are required';
    errorEl.style.display = 'block';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Verifying...';
  errorEl.style.display = 'none';

  try {
    const response = await fetch('/api/auth/jenkins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const result = await response.json();

    if (result.valid) {
      jenkinsAuth = { username, password };
      sessionStorage.setItem('jenkinsAuth', JSON.stringify(jenkinsAuth));

      showToast(`Logged in as ${result.fullName}`, 'success');
      closeJenkinsLoginModal();

      // Check if there's a pending rollout action
      if (pendingRolloutAction) {
        const action = pendingRolloutAction;
        pendingRolloutAction = null;

        switch (action.type) {
          case 'startAndroidRollout':
            // Open full release notes modal for rollout
            await startAndroidRollout(action.projectId, action.rolloutType);
            break;
          case 'updateAndroidRollout':
            await executeUpdateAndroidRollout(action.projectId, action.percentage);
            break;
          case 'haltAndroidRollout':
            await executeHaltAndroidRollout(action.projectId);
            break;
          case 'submitIOSForReview':
            await executeSubmitIOSForReview(action.projectId, action.buildId);
            break;
          default:
            // Fall back to distribute action
            await executeDistribute();
        }
      } else {
        // Continue with the distribute action (original behavior)
        await executeDistribute();
      }
    } else {
      errorEl.textContent = result.error || 'Invalid credentials';
      errorEl.style.display = 'block';
    }
  } catch (error) {
    errorEl.textContent = 'Failed to verify credentials: ' + error.message;
    errorEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Login & Continue';
  }
};

// ============================================
// Rollout Details Modal
// ============================================

let rolloutDetailsChart = null;

async function openRolloutDetailsModal(projectId) {
  const modal = document.getElementById('rolloutDetailsModal');
  const loading = document.getElementById('rolloutDetailsLoading');
  const error = document.getElementById('rolloutDetailsError');
  const content = document.getElementById('rolloutDetailsContent');

  // Show modal with loading state
  modal.classList.add('show');
  loading.style.display = 'flex';
  error.style.display = 'none';
  content.style.display = 'none';

  try {
    const response = await fetch(`/api/rollout-details/${projectId}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to fetch rollout details');
    }

    // Update header badges
    const daysText = data.daysIntoRollout === 0 ? 'today' :
                     data.daysIntoRollout === 1 ? '1 day' : `${data.daysIntoRollout} days`;
    document.getElementById('rolloutVersionBadge').textContent =
      `v${data.version} (${Math.round(data.userFraction * 100)}% - ${daysText})`;

    const healthBadge = document.getElementById('rolloutHealthBadge');
    healthBadge.textContent = data.analysis.status.toUpperCase().replace('_', ' ');
    healthBadge.className = `health-badge ${data.analysis.status}`;

    // Render health summary
    renderRolloutHealthSummary(data.analysis);

    // Render comparison table
    renderRolloutComparison(data);

    // Render chart
    renderRolloutChart(data.current.vitals.hourly, data.baseline.vitals);

    // Render Sentry issues
    renderRolloutSentryIssues(data.current.sentry);

    // Update freshness with better debug info
    let freshness;
    const queryInfo = data.current.vitals.queryInfo;
    if (data.current.vitals.hourly?.length > 0) {
      const lastPoint = data.current.vitals.hourly[data.current.vitals.hourly.length - 1];
      freshness = `Last data: ${formatRelativeDate(lastPoint?.timestamp)} - ${data.current.vitals.hourly.length} hourly points`;
    } else if (queryInfo?.error) {
      freshness = `Error: ${queryInfo.error}`;
    } else {
      freshness = `No hourly data yet (queried versionCode: ${queryInfo?.versionCode || 'unknown'})`;
    }
    document.getElementById('rolloutDataFreshness').textContent =
      `${freshness} - Google Play data has ~48h delay`;

    // Show content
    loading.style.display = 'none';
    content.style.display = 'block';

  } catch (err) {
    loading.style.display = 'none';
    error.style.display = 'block';
    error.innerHTML = `<div class="error-message">${escapeHtml(err.message)}</div>`;
  }
}

function closeRolloutDetailsModal() {
  document.getElementById('rolloutDetailsModal').classList.remove('show');
  if (rolloutDetailsChart) {
    rolloutDetailsChart.destroy();
    rolloutDetailsChart = null;
  }
}

// Close rollout modal on escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('rolloutDetailsModal').classList.contains('show')) {
    closeRolloutDetailsModal();
  }
});

function renderRolloutHealthSummary(analysis) {
  const container = document.getElementById('rolloutHealthSummary');

  const scoresHtml = `
    <div class="scores">
      <div class="score-item">
        <span class="score-label">Vitals Score:</span>
        <span class="score-value ${analysis.scores.vitals.status}">${analysis.scores.vitals.score}/100</span>
      </div>
      <div class="score-item">
        <span class="score-label">Sentry Score:</span>
        <span class="score-value ${analysis.scores.sentry.status}">${analysis.scores.sentry.score}/100</span>
      </div>
    </div>
  `;

  const reasonsHtml = analysis.reasons?.length > 0
    ? `<ul class="reasons">${analysis.reasons.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>`
    : '';

  container.innerHTML = `
    <div class="recommendation ${analysis.status}">${escapeHtml(analysis.recommendation)}</div>
    ${scoresHtml}
    ${reasonsHtml}
  `;
}

function renderRolloutComparison(data) {
  const tbody = document.getElementById('rolloutComparisonBody');

  const formatRate = (rate, baseline) => {
    if (rate === null || rate === undefined) return '<span class="rate-neutral">-</span>';
    const rateClass = baseline && rate > baseline * 1.25 ? 'rate-bad' :
                      baseline && rate > baseline * 1.1 ? 'rate-warning' : 'rate-good';
    return `<span class="${rateClass}">${rate.toFixed(2)}%</span>`;
  };

  // Format Sentry issues: show "X issues (Y users)"
  // Note: event counts from Sentry API are totals across all versions, not per-release
  // User counts are more accurate for per-release impact
  const formatSentry = (sentry) => {
    if (!sentry || !sentry.totalCount) return '<span class="rate-neutral">-</span>';
    const issues = sentry.totalCount || 0;
    const users = sentry.affectedUsers || 0;
    const critical = sentry.criticalCount || 0;

    let text = `${issues} issues`;
    if (users > 0) text += ` (${users} users)`;
    if (critical > 0) text = `<span class="rate-warning">${text}</span>`;
    return text;
  };

  const formatDays = (days) => {
    if (days === 0) return 'today';
    if (days === 1) return '1 day';
    return `${days} days`;
  };

  // Get crash/ANR rate - prefer hourly rolling, fall back to daily
  const getCrashRate = (vitals) => {
    if (vitals?.rolling24h?.crashRate !== null && vitals?.rolling24h?.crashRate !== undefined) {
      return vitals.rolling24h.crashRate;
    }
    if (vitals?.daily?.crashRate !== null && vitals?.daily?.crashRate !== undefined) {
      return vitals.daily.crashRate;
    }
    return null;
  };

  const getAnrRate = (vitals) => {
    if (vitals?.rolling24h?.anrRate !== null && vitals?.rolling24h?.anrRate !== undefined) {
      return vitals.rolling24h.anrRate;
    }
    if (vitals?.daily?.anrRate !== null && vitals?.daily?.anrRate !== undefined) {
      return vitals.daily.anrRate;
    }
    return null;
  };

  // Current version row
  const current = data.current;
  const currentDays = data.daysIntoRollout || 0;
  const currentCrash = getCrashRate(current.vitals);
  const currentAnr = getAnrRate(current.vitals);

  // User count: prefer Firebase, then vitals
  const currentUsers = data.firebase?.activeUsers ||
                       current.vitals.rolling24h?.totalUsers ||
                       current.vitals.daily?.users || 0;
  const currentSessions = data.firebase?.sessions || 0;

  let html = `
    <tr class="current-version-row">
      <td>
        <span class="current-marker"></span>
        <span class="version-full">${escapeHtml(data.version)}</span>
        <span class="version-age">${formatDays(currentDays)} in rollout</span>
      </td>
      <td>${formatRate(currentCrash, data.baseline.vitals.crashRate)}</td>
      <td>${formatRate(currentAnr, data.baseline.vitals.anrRate)}</td>
      <td>${formatSentry(current.sentry)}</td>
      <td>
        <span class="user-count">${currentUsers.toLocaleString()}</span>
        ${currentSessions > 0 ? `<span class="session-count">${currentSessions.toLocaleString()} sess</span>` : ''}
      </td>
    </tr>
  `;

  // Previous versions
  for (const prev of data.previousReleases || []) {
    const prevUsers = prev.firebaseUsers || prev.atSameHour?.vitals?.users || 0;
    html += `
      <tr>
        <td>
          <span class="version-full">${escapeHtml(prev.version)}</span>
        </td>
        <td>${formatRate(prev.atSameHour?.vitals?.crashRate, null)}</td>
        <td>${formatRate(prev.atSameHour?.vitals?.anrRate, null)}</td>
        <td>${formatSentry(prev.atSameHour?.sentry)}</td>
        <td>${prevUsers.toLocaleString()}</td>
      </tr>
    `;
  }

  tbody.innerHTML = html;
}

function renderRolloutChart(hourlyData, baseline) {
  const canvas = document.getElementById('rolloutVitalsChart');
  if (!canvas) {
    console.warn('rolloutVitalsChart canvas not found');
    return;
  }
  const ctx = canvas.getContext('2d');

  if (rolloutDetailsChart) {
    rolloutDetailsChart.destroy();
  }

  if (!hourlyData || hourlyData.length === 0) {
    ctx.canvas.parentElement.innerHTML = '<div class="rollout-no-issues">No hourly data available yet (data typically appears 48+ hours after rollout start)</div>';
    return;
  }

  const labels = hourlyData.map(h => {
    const d = new Date(h.timestamp);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:00`;
  });

  const datasets = [
    {
      label: 'Crash Rate',
      data: hourlyData.map(h => h.crashRate),
      borderColor: '#f87171',
      backgroundColor: 'rgba(248, 113, 113, 0.1)',
      fill: false,
      tension: 0.3,
      pointRadius: 2
    },
    {
      label: 'ANR Rate',
      data: hourlyData.map(h => h.anrRate),
      borderColor: '#fbbf24',
      backgroundColor: 'rgba(251, 191, 36, 0.1)',
      fill: false,
      tension: 0.3,
      pointRadius: 2
    }
  ];

  // Add baseline reference line if available
  if (baseline?.crashRate) {
    datasets.push({
      label: 'Baseline Crash',
      data: hourlyData.map(() => baseline.crashRate),
      borderColor: 'rgba(248, 113, 113, 0.4)',
      borderDash: [5, 5],
      fill: false,
      pointRadius: 0
    });
  }

  rolloutDetailsChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: { color: '#888', boxWidth: 12 }
        }
      },
      scales: {
        x: {
          ticks: { color: '#666', maxTicksLimit: 12 },
          grid: { color: '#333' }
        },
        y: {
          ticks: { color: '#666', callback: v => v.toFixed(2) + '%' },
          grid: { color: '#333' },
          beginAtZero: true
        }
      }
    }
  });
}

function renderRolloutSentryIssues(sentry) {
  const container = document.getElementById('rolloutSentryIssues');
  const link = document.getElementById('rolloutSentryLink');

  if (sentry?.link) {
    link.href = sentry.link;
    link.style.display = 'inline';
  } else {
    link.style.display = 'none';
  }

  if (!sentry?.issues || sentry.issues.length === 0) {
    container.innerHTML = '<div class="rollout-no-issues">No issues found for this version</div>';
    return;
  }

  const getLevelIcon = (level) => {
    if (level === 'fatal') return '<span class="rollout-issue-level fatal">F</span>';
    if (level === 'error') return '<span class="rollout-issue-level error">E</span>';
    return '<span class="rollout-issue-level warning">W</span>';
  };

  container.innerHTML = sentry.issues.map(issue => `
    <div class="rollout-issue-item">
      ${getLevelIcon(issue.level)}
      <div class="rollout-issue-title">
        <a href="${issue.permalink}" target="_blank">${escapeHtml(issue.title)}</a>
      </div>
      <div class="rollout-issue-users">${issue.userCount || 0} users</div>
    </div>
  `).join('');
}
