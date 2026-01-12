/**
 * Discord webhook integration for release notes
 *
 * Features:
 * - Post raw changesets to Discord with sanitization
 * - Edit existing messages to update status/age
 * - Track message IDs for updates
 */

const fs = require('fs');
const path = require('path');
const log = require('../logger');

// Store message IDs for editing (persisted to disk)
const MESSAGE_STORE_PATH = path.join(__dirname, '../../data/discord-messages.json');

// Profanity word list (common variations)
const PROFANITY_LIST = [
  'fuck', 'shit', 'ass', 'damn', 'bitch', 'crap', 'piss', 'dick', 'cock',
  'bastard', 'slut', 'whore', 'cunt', 'fag', 'retard', 'nigger', 'faggot'
];

// Build regex for profanity detection (handles l33t speak and partial matches)
const profanityRegex = new RegExp(
  PROFANITY_LIST.map(word => {
    // Convert to pattern that catches common substitutions
    return word
      .replace(/a/gi, '[a@4]')
      .replace(/e/gi, '[e3]')
      .replace(/i/gi, '[i1!]')
      .replace(/o/gi, '[o0]')
      .replace(/s/gi, '[s$5]')
      .replace(/t/gi, '[t7]');
  }).join('|'),
  'gi'
);

// PII patterns
const PII_PATTERNS = [
  // Email addresses
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  // Phone numbers (various formats)
  /\b(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  // IP addresses
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
  // Credit card numbers (basic pattern)
  /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
  // SSN pattern
  /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,
  // File paths with usernames (Windows)
  /[A-Z]:\\Users\\[^\\]+/gi,
  // File paths with usernames (Unix)
  /\/home\/[^\/]+/g,
  /\/Users\/[^\/]+/g
];

/**
 * Sanitize text by removing profanity and PII
 */
function sanitizeText(text) {
  if (!text) return '';

  let sanitized = text;

  // Remove profanity (replace with asterisks)
  sanitized = sanitized.replace(profanityRegex, match => '*'.repeat(match.length));

  // Remove PII
  for (const pattern of PII_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }

  return sanitized;
}

/**
 * Load stored message IDs
 */
function loadMessageStore() {
  try {
    if (fs.existsSync(MESSAGE_STORE_PATH)) {
      return JSON.parse(fs.readFileSync(MESSAGE_STORE_PATH, 'utf8'));
    }
  } catch (error) {
    log.warn('discord', 'Failed to load message store', { error: error.message });
  }
  return {};
}

/**
 * Save message store to disk
 */
function saveMessageStore(store) {
  try {
    const dir = path.dirname(MESSAGE_STORE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(MESSAGE_STORE_PATH, JSON.stringify(store, null, 2));
  } catch (error) {
    log.error('discord', 'Failed to save message store', { error: error.message });
  }
}

/**
 * Format relative time (e.g., "1 week ago", "3 weeks ago")
 */
function formatRelativeTime(timestamp) {
  const now = Date.now();
  const diff = now - new Date(timestamp).getTime();

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  const weeks = Math.floor(days / 7);

  if (weeks > 0) return `${weeks} week${weeks > 1 ? 's' : ''} ago`;
  if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  return 'just now';
}

/**
 * Get status emoji and color
 */
function getStatusStyle(status) {
  const styles = {
    'building': { emoji: '🔨', color: 0xf39c12, label: 'Building' },
    'testing': { emoji: '🧪', color: 0x9b59b6, label: 'Testing' },
    'internal': { emoji: '📦', color: 0x3498db, label: 'Internal Testing' },
    'alpha': { emoji: '🎮', color: 0x2ecc71, label: 'Alpha' },
    'beta': { emoji: '🎯', color: 0x1abc9c, label: 'Beta' },
    'released': { emoji: '🚀', color: 0x27ae60, label: 'Released' },
    'failed': { emoji: '❌', color: 0xe74c3c, label: 'Failed' }
  };
  return styles[status] || { emoji: '📋', color: 0x95a5a6, label: status };
}

/**
 * Format changesets for Discord embed - clean bullet list
 */
function formatChangesets(changesets, maxLength = 1800) {
  if (!changesets || changesets.length === 0) {
    return '_No changes_';
  }

  let result = '';
  let count = 0;

  for (const cs of changesets) {
    const sanitizedMsg = sanitizeText(cs.message || 'No message');
    // Clean, simple format - just the message
    const line = `• ${sanitizedMsg}\n`;

    if (result.length + line.length > maxLength) {
      const remaining = changesets.length - count;
      result += `_+${remaining} more_`;
      break;
    }
    result += line;
    count++;
  }

  return result.trim();
}

/**
 * Build Discord embed for release notes
 * Clean, scannable format for alpha testers
 */
function buildReleaseEmbed(options) {
  const {
    projectName,
    branch,
    fromChangeset,
    toChangeset,
    changesets,
    status = 'building',
    platforms = [],
    postedAt,
    releasedAt
  } = options;

  const style = getStatusStyle(status);
  const age = postedAt ? formatRelativeTime(postedAt) : null;

  // Simple title with project name
  const title = `${style.emoji}  ${projectName}`;

  // Build clean description with key info
  const lines = [];

  // Status and age on one line
  if (age) {
    const releaseStatus = releasedAt ? `Released to ${status}` : 'Not released';
    lines.push(`**${style.label}** — ${age} _(${releaseStatus})_`);
  } else {
    lines.push(`**${style.label}**`);
  }

  // Branch and changeset range
  lines.push(`\`${branch}\` cs${fromChangeset} → cs${toChangeset}`);

  // Add separator
  lines.push('');

  // Changes list
  lines.push(formatChangesets(changesets));

  const embed = {
    title,
    description: lines.join('\n'),
    color: style.color,
    footer: {
      text: platforms.length > 0
        ? platforms.map(p => p === 'ios' ? 'iOS' : 'Android').join(' • ')
        : ''
    }
  };

  return embed;
}

/**
 * Send a Discord webhook message
 */
async function sendWebhook(webhookUrl, content, embeds = []) {
  if (!webhookUrl) {
    throw new Error('Discord webhook URL not configured');
  }

  const payload = {
    content: content || null,
    embeds: embeds
  };

  const response = await fetch(webhookUrl + '?wait=true', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Discord webhook failed: ${response.status} - ${error}`);
  }

  const result = await response.json();
  log.info('discord', 'Webhook sent', { messageId: result.id });
  return result;
}

/**
 * Edit an existing Discord webhook message
 */
async function editWebhookMessage(webhookUrl, messageId, content, embeds = []) {
  if (!webhookUrl || !messageId) {
    throw new Error('Webhook URL and message ID required');
  }

  const payload = {
    content: content || null,
    embeds: embeds
  };

  const response = await fetch(`${webhookUrl}/messages/${messageId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Discord edit failed: ${response.status} - ${error}`);
  }

  const result = await response.json();
  log.info('discord', 'Message edited', { messageId });
  return result;
}

/**
 * Post or update release notes to Discord
 *
 * @param {Object} config - Discord config from config.json
 * @param {Object} options - Release info
 * @returns {Object} - Message result with ID
 */
async function postReleaseNotes(config, options) {
  const { webhookUrl } = config;
  const { projectId, branch, fromChangeset, toChangeset, changesets, status, platforms } = options;

  // Generate unique key for this release
  const releaseKey = `${projectId}:${branch}:${toChangeset}`;

  // Load existing messages
  const messageStore = loadMessageStore();
  const existing = messageStore[releaseKey];

  // Build embed
  const embed = buildReleaseEmbed({
    projectName: options.projectName || projectId,
    branch,
    fromChangeset,
    toChangeset,
    changesets,
    status,
    platforms,
    postedAt: existing?.postedAt || new Date().toISOString(),
    releasedAt: status === 'alpha' || status === 'released' ? new Date().toISOString() : null
  });

  let result;

  if (existing?.messageId) {
    // Update existing message
    try {
      result = await editWebhookMessage(webhookUrl, existing.messageId, null, [embed]);
      messageStore[releaseKey] = {
        ...existing,
        status,
        updatedAt: new Date().toISOString()
      };
    } catch (error) {
      // If edit fails (message deleted?), post new
      log.warn('discord', 'Edit failed, posting new message', { error: error.message });
      result = await sendWebhook(webhookUrl, null, [embed]);
      messageStore[releaseKey] = {
        messageId: result.id,
        postedAt: new Date().toISOString(),
        status
      };
    }
  } else {
    // Post new message
    result = await sendWebhook(webhookUrl, null, [embed]);
    messageStore[releaseKey] = {
      messageId: result.id,
      postedAt: new Date().toISOString(),
      status
    };
  }

  saveMessageStore(messageStore);

  return {
    success: true,
    messageId: result.id,
    isUpdate: !!existing?.messageId,
    releaseKey
  };
}

/**
 * Update status of an existing release message
 */
async function updateReleaseStatus(config, projectId, branch, toChangeset, newStatus) {
  const releaseKey = `${projectId}:${branch}:${toChangeset}`;
  const messageStore = loadMessageStore();
  const existing = messageStore[releaseKey];

  if (!existing?.messageId) {
    log.warn('discord', 'No existing message to update', { releaseKey });
    return { success: false, error: 'No existing message found' };
  }

  // We need the original data to rebuild the embed
  // For now, just update the store - the next full post will update the message
  messageStore[releaseKey] = {
    ...existing,
    status: newStatus,
    updatedAt: new Date().toISOString(),
    releasedAt: newStatus === 'alpha' || newStatus === 'released'
      ? new Date().toISOString()
      : existing.releasedAt
  };

  saveMessageStore(messageStore);

  return { success: true, releaseKey, newStatus };
}

/**
 * Get all tracked messages (for status display)
 */
function getTrackedMessages() {
  return loadMessageStore();
}

module.exports = {
  sanitizeText,
  formatRelativeTime,
  formatChangesets,
  buildReleaseEmbed,
  sendWebhook,
  editWebhookMessage,
  postReleaseNotes,
  updateReleaseStatus,
  getTrackedMessages
};
