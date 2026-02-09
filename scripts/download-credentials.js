#!/usr/bin/env node
/**
 * Download Fastlane credentials from Jenkins
 *
 * Usage: node scripts/download-credentials.js
 *
 * Downloads:
 * - apple_api_key -> fastlane/apple_api_key.json
 * - google_play_json -> fastlane/google_play_key.json
 */

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const config = require('../config.json');

const { baseUrl, username, apiToken } = config.jenkins;
const auth = Buffer.from(`${username}:${apiToken}`).toString('base64');

// Credentials to download
const CREDENTIALS = [
  { id: 'apple_api_key', outputFile: 'fastlane/apple_api_key.json', type: 'file' },
  { id: 'google_play_json', outputFile: 'fastlane/google_play_key.json', type: 'file' }
];

async function getSecretFileCredential(credentialId) {
  console.log(`Fetching: ${credentialId}...`);

  const groovyScript = `
import com.cloudbees.plugins.credentials.CredentialsProvider
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
    throw new Error(`Script console error: ${response.status} - ${response.statusText}`);
  }

  const text = await response.text();
  if (text.includes('CREDENTIAL_NOT_FOUND')) {
    throw new Error(`Credential not found: ${credentialId}`);
  }

  return text.trim();
}

async function getSecretTextCredential(credentialId) {
  console.log(`Fetching: ${credentialId}...`);

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
}

async function main() {
  console.log('Downloading credentials from Jenkins...');
  console.log(`Jenkins URL: ${baseUrl}`);
  console.log('');

  // Ensure fastlane directory exists
  const fastlaneDir = path.join(__dirname, '..', 'fastlane');
  if (!fs.existsSync(fastlaneDir)) {
    fs.mkdirSync(fastlaneDir, { recursive: true });
  }

  let successCount = 0;
  let errorCount = 0;

  for (const cred of CREDENTIALS) {
    try {
      let content;
      if (cred.type === 'file') {
        content = await getSecretFileCredential(cred.id);
      } else {
        content = await getSecretTextCredential(cred.id);
      }

      const outputPath = path.join(__dirname, '..', cred.outputFile);
      fs.writeFileSync(outputPath, content);
      console.log(`  ✓ Saved: ${cred.outputFile}`);
      successCount++;
    } catch (error) {
      console.error(`  ✗ Failed: ${cred.id} - ${error.message}`);
      errorCount++;
    }
  }

  console.log('');
  console.log(`Done! ${successCount} downloaded, ${errorCount} failed.`);

  if (successCount > 0) {
    console.log('');
    console.log('Next steps:');
    console.log('  1. Verify the downloaded files contain valid JSON');
    console.log('  2. Update config.json with the file paths');
    console.log('  3. Add these files to .gitignore (they contain secrets!)');
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
