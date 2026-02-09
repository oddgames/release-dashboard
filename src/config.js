/**
 * Configuration loader
 *
 * Priority (highest to lowest):
 *   1. Individual environment variables (secrets)
 *   2. CONFIG_JSON env var (full config as JSON string, for Docker/Portainer)
 *   3. config.json file (local development)
 */

const fs = require('fs');
const path = require('path');

// Load .env file if present (for Docker/Portainer deployments)
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// Load base config - prefer CONFIG_JSON env var, fall back to config.json file
let baseConfig = {};

if (process.env.CONFIG_JSON) {
  try {
    baseConfig = JSON.parse(process.env.CONFIG_JSON);
    console.log('Config loaded from CONFIG_JSON environment variable');
  } catch (error) {
    console.error('Failed to parse CONFIG_JSON:', error.message);
  }
} else {
  const configPath = path.join(__dirname, '../config.json');
  if (fs.existsSync(configPath)) {
    try {
      baseConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      console.log('Config loaded from config.json');
    } catch (error) {
      console.error('Failed to load config.json:', error.message);
    }
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

// Environment variable overrides for secrets
// These take precedence over config.json values
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
    statsPeriod: baseConfig.sentry?.statsPeriod || '14d'
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
      // For production, the key content can be passed directly
      keyContent: process.env.ASC_KEY_CONTENT || ''
    },
    googlePlay: {
      jsonKeyPath: process.env.GOOGLE_PLAY_KEY_PATH || baseConfig.fastlane?.googlePlay?.jsonKeyPath || '',
      // For production, the JSON key can be passed directly
      jsonKeyContent: process.env.GOOGLE_PLAY_KEY_CONTENT || '',
      developerId: baseConfig.fastlane?.googlePlay?.developerId || ''
    }
  },

  // Non-secret config (env var JSON overrides or from base config)
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
