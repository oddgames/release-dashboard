const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const config = require('../config');
const plasticApi = require('../plastic-api');
const log = require('../logger');
const { buildCache, RELEASE_NOTES_DIR } = require('../services/cache');
const { genAI, generateReleaseNotes, translateReleaseNotes, generateComparisonSummary } = require('../services/ai');
const { extractChangeset } = require('../utils/build-helpers');

// Get commits between changesets (without AI generation)
router.post('/get-commits', async (req, res) => {
  const { projectId, branch, fromChangeset, toChangeset } = req.body;

  log.info('server', 'Get commits request', { projectId, branch, fromChangeset, toChangeset });

  try {
    // Find project config
    const projectJobs = config.jobs.filter(job =>
      job.displayName.toLowerCase().replace(/\s+/g, '-') === projectId
    );

    if (projectJobs.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const projectName = projectJobs[0].displayName;
    const plasticRepo = config.projects?.[projectName]?.plasticRepo;

    // Filter commits between the two changesets
    const fromNum = extractChangeset(fromChangeset) || 0;
    const toNum = extractChangeset(toChangeset) || Infinity;

    log.info('server', 'Looking for commits in range', { fromNum, toNum, plasticRepo });

    let commits = [];

    // Try to get commits from Plastic directly
    if (plasticRepo && fromNum > 0 && toNum < Infinity) {
      try {
        const plasticCommits = await plasticApi.getChangesetRange(plasticRepo, fromNum, toNum, branch);
        commits = plasticCommits.map(c => ({
          version: c.changeset,
          message: c.message,
          author: c.author
        }));
        log.info('server', `Found ${commits.length} commits from Plastic`);
      } catch (e) {
        log.warn('server', 'Failed to fetch from Plastic, falling back to cache', { error: e.message });
      }
    }

    // Fall back to cached data if Plastic fetch failed
    if (commits.length === 0) {
      const project = buildCache.projects?.find(p => p.id === projectId);
      const branchData = project?.branches?.find(b => b.branch === branch);

      if (branchData) {
        commits = (branchData.allCommits || []).filter(c => {
          const commitChangeset = parseInt(c.version) || 0;
          return commitChangeset > fromNum && commitChangeset <= toNum;
        });
      }
    }

    res.json({
      success: true,
      projectName,
      fromChangeset,
      toChangeset,
      commits
    });
  } catch (error) {
    log.error('server', 'Get commits failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Generate release notes from commits between changesets
router.post('/generate-release-notes', async (req, res) => {
  const { projectId, branch, fromChangeset, toChangeset } = req.body;

  log.info('server', 'Generate release notes request', { projectId, branch, fromChangeset, toChangeset });

  try {
    // Find project config
    const projectJobs = config.jobs.filter(job =>
      job.displayName.toLowerCase().replace(/\s+/g, '-') === projectId
    );

    if (projectJobs.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const projectName = projectJobs[0].displayName;
    const projectConfig = config.projects?.[projectName] || { languages: ['en'] };

    // Get plastic repo config
    const plasticRepo = config.projects?.[projectName]?.plasticRepo;

    // Filter commits between the two changesets
    const fromNum = extractChangeset(fromChangeset) || 0;
    const toNum = extractChangeset(toChangeset) || Infinity;

    log.info('server', 'Looking for commits in range', { fromNum, toNum, plasticRepo });

    let commits = [];

    // Try to get commits from Plastic directly (more reliable than cache)
    if (plasticRepo && fromNum > 0 && toNum < Infinity) {
      try {
        const plasticCommits = await plasticApi.getChangesetRange(plasticRepo, fromNum, toNum, branch);
        commits = plasticCommits.map(c => ({
          version: c.changeset,
          message: c.message,
          author: c.author
        }));
        log.info('server', `Found ${commits.length} commits from Plastic`);
      } catch (e) {
        log.warn('server', 'Failed to fetch from Plastic, falling back to cache', { error: e.message });
      }
    }

    // Fall back to cached data if Plastic fetch failed or not configured
    if (commits.length === 0) {
      const project = buildCache.projects?.find(p => p.id === projectId);
      const branchData = project?.branches?.find(b => b.branch === branch);

      if (branchData) {
        log.debug('server', 'Using cached commits', { totalCommits: branchData.allCommits?.length });
        commits = (branchData.allCommits || []).filter(c => {
          const commitChangeset = parseInt(c.version) || 0;
          return commitChangeset > fromNum && commitChangeset <= toNum;
        });
      }
    }

    // If no commits found, return empty notes (user can write their own)
    if (commits.length === 0) {
      log.warn('server', 'No commits found between changesets', { fromNum, toNum });

      // Return empty release notes structure for all languages
      const emptyNotes = {};
      for (const lang of projectConfig.languages) {
        emptyNotes[lang] = '';
      }

      return res.json({
        success: true,
        projectName,
        fromChangeset,
        toChangeset,
        commitCount: 0,
        releaseNotes: emptyNotes
      });
    }

    // Generate release notes using AI (if configured)
    let releaseNotes;
    if (genAI) {
      const commitMessages = commits.map(c => `- ${c.message} (${c.author})`).join('\n');
      releaseNotes = await generateReleaseNotes(projectName, commitMessages, projectConfig.languages);
    } else {
      // No AI configured - return commit list as starting point
      log.info('server', 'AI not configured, returning commit list');
      const commitList = commits.map(c => `- ${c.message}`).join('\n');
      releaseNotes = {};
      for (const lang of projectConfig.languages) {
        releaseNotes[lang] = lang === 'en' ? commitList : '';
      }
    }

    res.json({
      success: true,
      projectName,
      fromChangeset,
      toChangeset,
      commitCount: commits.length,
      releaseNotes
    });
  } catch (error) {
    log.error('server', 'Generate release notes failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Translate release notes to additional languages
router.post('/translate-release-notes', async (req, res) => {
  const { englishNotes, projectId } = req.body;

  log.info('server', 'Translate release notes request', { projectId });

  try {
    if (!genAI) {
      return res.status(400).json({ error: 'AI API key not configured' });
    }

    // Find project config
    const projectJobs = config.jobs.filter(job =>
      job.displayName.toLowerCase().replace(/\s+/g, '-') === projectId
    );

    if (projectJobs.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const projectName = projectJobs[0].displayName;
    const projectConfig = config.projects?.[projectName] || { languages: ['en'] };

    // Translate to all configured languages
    const translations = await translateReleaseNotes(englishNotes, projectConfig.languages);

    res.json({
      success: true,
      translations
    });
  } catch (error) {
    log.error('server', 'Translate release notes failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Get saved release notes for a project/changeset
router.get('/release-notes/:projectId/:toChangeset', (req, res) => {
  const { projectId, toChangeset } = req.params;

  try {
    const filePath = path.join(RELEASE_NOTES_DIR, projectId, `${toChangeset}.json`);

    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      log.info('server', 'Loaded saved release notes', { projectId, toChangeset });
      res.json({ success: true, found: true, ...data });
    } else {
      res.json({ success: true, found: false });
    }
  } catch (error) {
    log.error('server', 'Failed to load release notes', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Save release notes to disk
router.post('/release-notes', (req, res) => {
  const { projectId, fromChangeset, toChangeset, translations, track, platforms } = req.body;

  log.info('server', 'Saving release notes', { projectId, fromChangeset, toChangeset });

  try {
    // Ensure directory exists
    const projectDir = path.join(RELEASE_NOTES_DIR, projectId);
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    const filePath = path.join(projectDir, `${toChangeset}.json`);
    const data = {
      projectId,
      fromChangeset,
      toChangeset,
      track,
      platforms,
      translations,
      savedAt: new Date().toISOString()
    };

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    log.info('server', 'Release notes saved', { projectId, toChangeset, filePath });

    res.json({ success: true, savedAt: data.savedAt });
  } catch (error) {
    log.error('server', 'Failed to save release notes', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Delete saved release notes (after successful distribution)
router.delete('/release-notes/:projectId/:toChangeset', (req, res) => {
  const { projectId, toChangeset } = req.params;

  try {
    const filePath = path.join(RELEASE_NOTES_DIR, projectId, `${toChangeset}.json`);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      log.info('server', 'Deleted release notes', { projectId, toChangeset });
    }

    res.json({ success: true });
  } catch (error) {
    log.error('server', 'Failed to delete release notes', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Test endpoint for release notes generation
router.post('/test-generate-notes', async (req, res) => {
  const { projectId, commitMessages } = req.body;

  log.info('server', 'Test generate notes', { projectId });

  try {
    if (!genAI) {
      return res.status(400).json({ error: 'AI API key not configured. Add your Gemini API key to config.json.' });
    }

    const projectJobs = config.jobs.filter(job =>
      job.displayName.toLowerCase().replace(/\s+/g, '-') === projectId
    );

    if (projectJobs.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const projectName = projectJobs[0].displayName;
    const projectConfig = config.projects?.[projectName] || { languages: ['en'] };

    const startTime = Date.now();
    const releaseNotes = await generateReleaseNotes(projectName, commitMessages, projectConfig.languages);
    const duration = Date.now() - startTime;

    res.json({
      success: true,
      projectName,
      duration,
      releaseNotes
    });
  } catch (error) {
    log.error('server', 'Test generate notes failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Get project languages
router.get('/project-languages/:projectId', (req, res) => {
  const { projectId } = req.params;

  const projectJobs = config.jobs.filter(job =>
    job.displayName.toLowerCase().replace(/\s+/g, '-') === projectId
  );

  if (projectJobs.length === 0) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const projectName = projectJobs[0].displayName;
  const projectConfig = config.projects?.[projectName] || { languages: ['en'] };

  res.json({
    projectName,
    languages: projectConfig.languages
  });
});

// Get changesets for a project/branch (for dropdown)
router.get('/changesets/:projectId/:branch', async (req, res) => {
  const { projectId, branch } = req.params;
  const limit = parseInt(req.query.limit) || 30;

  log.info('server', 'Get changesets request', { projectId, branch, limit });

  try {
    const projectJobs = config.jobs.filter(job =>
      job.displayName.toLowerCase().replace(/\s+/g, '-') === projectId
    );

    if (projectJobs.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const projectName = projectJobs[0].displayName;
    const projectConfig = config.projects?.[projectName];

    if (!projectConfig?.plasticRepo) {
      return res.status(400).json({ error: 'No Plastic repository configured for this project' });
    }

    const changesets = await plasticApi.getChangesetList(projectConfig.plasticRepo, branch, limit);

    res.json({
      success: true,
      projectName,
      branch,
      changesets
    });
  } catch (error) {
    log.error('server', 'Get changesets failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Compare changesets - get all changes including merges
router.post('/compare-changesets', async (req, res) => {
  const { projectId, fromChangeset, toChangeset, generateAiSummary = true } = req.body;

  log.info('server', 'Compare changesets request', { projectId, fromChangeset, toChangeset, generateAiSummary });

  try {
    const projectJobs = config.jobs.filter(job =>
      job.displayName.toLowerCase().replace(/\s+/g, '-') === projectId
    );

    if (projectJobs.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const projectName = projectJobs[0].displayName;
    const projectConfig = config.projects?.[projectName];

    if (!projectConfig?.plasticRepo) {
      return res.status(400).json({ error: 'No Plastic repository configured for this project' });
    }

    const repository = projectConfig.plasticRepo;

    // Fetch all data in parallel
    const [changesets, merges, fileDiff] = await Promise.all([
      plasticApi.getChangesetRange(repository, fromChangeset, toChangeset),
      plasticApi.getMergesInRange(repository, fromChangeset, toChangeset),
      plasticApi.getFileDiff(repository, fromChangeset, toChangeset)
    ]);

    // Generate AI summary if requested and API is configured
    let aiSummary = null;
    if (generateAiSummary && genAI && changesets.length > 0) {
      try {
        aiSummary = await generateComparisonSummary(projectName, changesets, merges, fileDiff);
      } catch (error) {
        log.warn('server', 'AI summary generation failed', { error: error.message });
        // Continue without AI summary
      }
    }

    res.json({
      success: true,
      projectName,
      fromChangeset,
      toChangeset,
      changesets,
      merges,
      fileDiff,
      aiSummary,
      stats: {
        changesetCount: changesets.length,
        mergeCount: merges.length,
        fileCount: fileDiff.length,
        addedFiles: fileDiff.filter(f => f.status === 'A').length,
        changedFiles: fileDiff.filter(f => f.status === 'C').length,
        deletedFiles: fileDiff.filter(f => f.status === 'D').length,
        movedFiles: fileDiff.filter(f => f.status === 'M').length
      }
    });
  } catch (error) {
    log.error('server', 'Compare changesets failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
