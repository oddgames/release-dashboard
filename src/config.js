/**
 * Configuration loader
 *
 * Priority (highest to lowest):
 *   1. Environment variables (set individually or via .env file)
 *   2. config.json file (local development)
 */

const fs = require('fs');
const path = require('path');

// Load .env file if present (for Docker/Portainer deployments)
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// Load config.json as fallback for local development
let baseConfig = {};
const configPath = path.join(__dirname, '../config.json');
if (fs.existsSync(configPath)) {
  try {
    baseConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log('Config loaded from config.json');
  } catch (error) {
    console.error('Failed to load config.json:', error.message);
  }
}

// Helper to parse JSON from env vars
function parseJsonEnv(name) {
  if (!process.env[name]) return null;
  try {
    return JSON.parse(process.env[name]);
  } catch (e) {
    console.error(`Failed to parse ${name} env var as JSON:`, e.message);
    return null;
  }
}

// Environment variable overrides (all take precedence over config.json)
const config = {
  ...baseConfig,

  jenkins: {
    baseUrl: process.env.JENKINS_BASE_URL || baseConfig.jenkins?.baseUrl || '',
    username: process.env.JENKINS_USERNAME || baseConfig.jenkins?.username || '',
    apiToken: process.env.JENKINS_API_TOKEN || baseConfig.jenkins?.apiToken || ''
  },

  ai: {
    provider: process.env.AI_PROVIDER || baseConfig.ai?.provider || 'gemini',
    apiKey: process.env.AI_API_KEY || baseConfig.ai?.apiKey || '',
    model: process.env.AI_MODEL || baseConfig.ai?.model || 'gemini-2.5-flash'
  },

  sentry: {
    baseUrl: process.env.SENTRY_BASE_URL || baseConfig.sentry?.baseUrl || 'https://sentry.io',
    authToken: process.env.SENTRY_AUTH_TOKEN || baseConfig.sentry?.authToken || '',
    organization: process.env.SENTRY_ORG || baseConfig.sentry?.organization || '',
    statsPeriod: process.env.SENTRY_STATS_PERIOD || baseConfig.sentry?.statsPeriod || '14d'
  },

  discord: {
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || baseConfig.discord?.webhookUrl || '',
    enabled: process.env.DISCORD_ENABLED === 'true' || baseConfig.discord?.enabled || false
  },

  fastlane: {
    webhookSecret: process.env.FASTLANE_WEBHOOK_SECRET || baseConfig.fastlane?.webhookSecret || '',
    appStoreConnect: {
      keyId: process.env.ASC_KEY_ID || baseConfig.fastlane?.appStoreConnect?.keyId || '',
      issuerId: process.env.ASC_ISSUER_ID || baseConfig.fastlane?.appStoreConnect?.issuerId || '',
      keyPath: process.env.ASC_KEY_PATH || baseConfig.fastlane?.appStoreConnect?.keyPath || '',
      keyContent: process.env.ASC_KEY_CONTENT || ''
    },
    googlePlay: {
      jsonKeyPath: process.env.GOOGLE_PLAY_KEY_PATH || baseConfig.fastlane?.googlePlay?.jsonKeyPath || '',
      jsonKeyContent: process.env.GOOGLE_PLAY_KEY_CONTENT || '',
      developerId: process.env.GOOGLE_PLAY_DEVELOPER_ID || baseConfig.fastlane?.googlePlay?.developerId || ''
    }
  },

  // Structured config (JSON env vars or config.json)
  tracks: parseJsonEnv('TRACKS') || baseConfig.tracks || [],
  projects: parseJsonEnv('PROJECTS') || baseConfig.projects || {},
  jobs: parseJsonEnv('JOBS') || baseConfig.jobs || [],
  allowedIPs: parseJsonEnv('ALLOWED_IPS') || baseConfig.allowedIPs || [],
  refreshInterval: parseInt(process.env.REFRESH_INTERVAL) || baseConfig.refreshInterval || 60000,
  branchHistoryDays: parseInt(process.env.BRANCH_HISTORY_DAYS) || baseConfig.branchHistoryDays || 30
};

// Validation warnings
if (!config.jenkins.baseUrl) {
  console.warn('Warning: JENKINS_BASE_URL not configured');
}
if (!config.jenkins.apiToken) {
  console.warn('Warning: JENKINS_API_TOKEN not configured');
}

module.exports = config;
