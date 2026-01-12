/**
 * Discord notification API routes
 */

const express = require('express');
const router = express.Router();
const config = require('../config');
const plasticApi = require('../plastic-api');
const log = require('../logger');
const discord = require('../services/discord');
const { buildCache } = require('../services/cache');

/**
 * POST /api/discord/post-release
 *
 * Post raw changesets to Discord for a release.
 * Sanitizes content (removes profanity and PII).
 *
 * Body: {
 *   projectId: string,
 *   branch: string,
 *   fromChangeset: number,
 *   toChangeset: number,
 *   status: 'building' | 'testing' | 'internal' | 'alpha' | 'released',
 *   platforms: ['ios', 'android']
 * }
 */
router.post('/post-release', async (req, res) => {
  const { projectId, branch, fromChangeset, toChangeset, status, platforms } = req.body;

  log.info('discord', 'Post release request', { projectId, branch, fromChangeset, toChangeset, status });

  // Check if Discord is enabled
  if (!config.discord?.enabled || !config.discord?.webhookUrl) {
    return res.status(400).json({
      error: 'Discord not configured',
      hint: 'Set discord.enabled=true and discord.webhookUrl in config.json'
    });
  }

  try {
    // Find project config
    const projectJobs = config.jobs.filter(job =>
      job.displayName.toLowerCase().replace(/\s+/g, '-') === projectId
    );

    if (projectJobs.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const projectName = projectJobs[0].displayName;
    const projectConfig = config.projects?.[projectName];
    const plasticRepo = projectConfig?.plasticRepo;

    // Fetch changesets from Plastic
    let changesets = [];
    if (plasticRepo && fromChangeset && toChangeset) {
      try {
        changesets = await plasticApi.getChangesetRange(plasticRepo, fromChangeset, toChangeset, branch);
        log.info('discord', `Fetched ${changesets.length} changesets from Plastic`);
      } catch (error) {
        log.warn('discord', 'Failed to fetch from Plastic', { error: error.message });
      }
    }

    // Fall back to cached data if Plastic fetch failed
    if (changesets.length === 0) {
      const project = buildCache.projects?.find(p => p.id === projectId);
      const branchData = project?.branches?.find(b => b.branch === branch);
      if (branchData?.allCommits) {
        changesets = branchData.allCommits.filter(c => {
          const cs = parseInt(c.version) || 0;
          return cs > fromChangeset && cs <= toChangeset;
        }).map(c => ({
          changeset: c.version,
          message: c.message,
          author: c.author
        }));
      }
    }

    // Post to Discord
    const result = await discord.postReleaseNotes(config.discord, {
      projectId,
      projectName,
      branch,
      fromChangeset,
      toChangeset,
      changesets,
      status: status || 'building',
      platforms: platforms || []
    });

    res.json({
      success: true,
      ...result,
      changesetCount: changesets.length
    });
  } catch (error) {
    log.error('discord', 'Failed to post release', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /api/discord/update-status
 *
 * Update the status of a previously posted release.
 *
 * Body: {
 *   projectId: string,
 *   branch: string,
 *   toChangeset: number,
 *   status: 'building' | 'testing' | 'internal' | 'alpha' | 'released'
 * }
 */
router.patch('/update-status', async (req, res) => {
  const { projectId, branch, toChangeset, status } = req.body;

  log.info('discord', 'Update status request', { projectId, branch, toChangeset, status });

  if (!config.discord?.enabled || !config.discord?.webhookUrl) {
    return res.status(400).json({ error: 'Discord not configured' });
  }

  try {
    const result = await discord.updateReleaseStatus(
      config.discord,
      projectId,
      branch,
      toChangeset,
      status
    );

    res.json(result);
  } catch (error) {
    log.error('discord', 'Failed to update status', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/discord/messages
 *
 * Get all tracked Discord messages (for status display).
 */
router.get('/messages', (req, res) => {
  const messages = discord.getTrackedMessages();
  res.json({ success: true, messages });
});

/**
 * POST /api/discord/test
 *
 * Send a test message to verify webhook configuration.
 */
router.post('/test', async (req, res) => {
  log.info('discord', 'Test webhook request');

  if (!config.discord?.webhookUrl) {
    return res.status(400).json({
      error: 'Discord webhook URL not configured',
      hint: 'Add discord.webhookUrl to config.json'
    });
  }

  try {
    const embed = {
      title: 'Release Dashboard Test',
      description: 'Discord integration is working correctly!',
      color: 0x2ecc71,
      fields: [
        {
          name: 'Status',
          value: 'Connected',
          inline: true
        },
        {
          name: 'Timestamp',
          value: new Date().toISOString(),
          inline: true
        }
      ],
      footer: {
        text: 'Release Dashboard'
      }
    };

    const result = await discord.sendWebhook(config.discord.webhookUrl, null, [embed]);

    res.json({
      success: true,
      messageId: result.id,
      message: 'Test message sent successfully'
    });
  } catch (error) {
    log.error('discord', 'Test webhook failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
