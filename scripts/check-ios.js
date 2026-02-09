#!/usr/bin/env node
/**
 * Check Apple App Store Connect data for configured apps
 * Run: node scripts/check-ios.js
 */

const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const config = require('../config.json');

const ASC_BASE_URL = 'https://api.appstoreconnect.apple.com';
let ascToken = null;
let ascTokenExpiry = 0;

function getASCToken() {
  if (ascToken && Date.now() < ascTokenExpiry - 60000) {
    return ascToken;
  }

  const { keyId, issuerId, keyPath } = config.fastlane.appStoreConnect;
  const keyFile = path.join(__dirname, '..', keyPath);
  const keyData = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  const privateKey = keyData.key;

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuerId,
    iat: now,
    exp: now + 1200, // 20 minutes
    aud: 'appstoreconnect-v1'
  };

  ascToken = jwt.sign(payload, privateKey, {
    algorithm: 'ES256',
    header: {
      alg: 'ES256',
      kid: keyId,
      typ: 'JWT'
    }
  });
  ascTokenExpiry = (now + 1200) * 1000;

  return ascToken;
}

async function ascRequest(endpoint) {
  const token = getASCToken();
  const response = await fetch(`${ASC_BASE_URL}${endpoint}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ASC API error: ${response.status} - ${text}`);
  }

  return response.json();
}

async function checkApp(bundleId) {
  console.log(`\n=== ${bundleId} ===`);

  try {
    // Find app by bundle ID
    const appsResponse = await ascRequest(`/v1/apps?filter[bundleId]=${bundleId}`);

    if (!appsResponse.data || appsResponse.data.length === 0) {
      console.log('  App not found');
      return;
    }

    const app = appsResponse.data[0];
    const appId = app.id;
    console.log(`App Name: ${app.attributes.name}`);
    console.log(`App ID: ${appId}`);

    // Get app store versions with builds included
    console.log('\nApp Store Versions:');
    const versionsResponse = await ascRequest(
      `/v1/apps/${appId}/appStoreVersions?include=build&limit=10`
    );

    const included = versionsResponse.included || [];
    const buildMap = {};
    for (const item of included) {
      if (item.type === 'builds') {
        buildMap[item.id] = item.attributes;
      }
    }

    for (const version of versionsResponse.data || []) {
      const buildId = version.relationships?.build?.data?.id;
      const build = buildId ? buildMap[buildId] : null;
      console.log(`  - Version: ${version.attributes.versionString}`);
      console.log(`    State: ${version.attributes.appStoreState}`);
      console.log(`    Platform: ${version.attributes.platform}`);
      if (build) {
        console.log(`    Build: ${build.version}`);
        console.log(`    Processing: ${build.processingState}`);
        console.log(`    Uploaded: ${build.uploadedDate}`);
      } else {
        console.log(`    Build: (no build attached)`);
      }
    }

    // Get TestFlight builds
    console.log('\nTestFlight Builds (latest 5):');
    const buildsResponse = await ascRequest(
      `/v1/builds?filter[app]=${appId}&sort=-uploadedDate&limit=5&include=preReleaseVersion`
    );

    const preReleaseVersions = {};
    for (const item of buildsResponse.included || []) {
      if (item.type === 'preReleaseVersions') {
        preReleaseVersions[item.id] = item.attributes.version;
      }
    }

    for (const build of buildsResponse.data || []) {
      const preReleaseId = build.relationships?.preReleaseVersion?.data?.id;
      const version = preReleaseId ? preReleaseVersions[preReleaseId] : 'N/A';
      console.log(`  - Build ${build.attributes.version}`);
      console.log(`    Version: ${version}`);
      console.log(`    Processing: ${build.attributes.processingState}`);
      console.log(`    Uploaded: ${build.attributes.uploadedDate}`);
    }

    // Check for beta groups (TestFlight groups)
    console.log('\nTestFlight Beta Groups:');
    try {
      const betaGroupsResponse = await ascRequest(
        `/v1/apps/${appId}/betaGroups`
      );

      for (const group of betaGroupsResponse.data || []) {
        console.log(`  - ${group.attributes.name} (ID: ${group.id})`);
        console.log(`    Type: ${group.attributes.isInternalGroup ? 'Internal' : 'External'}`);
        console.log(`    Access: ${group.attributes.hasAccessToAllBuilds ? 'All builds' : 'Specific builds'}`);

        // Get builds for this beta group
        try {
          const groupBuildsResponse = await ascRequest(
            `/v1/betaGroups/${group.id}/builds?limit=3`
          );
          if (groupBuildsResponse.data && groupBuildsResponse.data.length > 0) {
            console.log('    Latest builds:');
            for (const build of groupBuildsResponse.data) {
              console.log(`      - Build ${build.attributes.version} (${build.attributes.processingState})`);
            }
          } else {
            console.log('    No builds distributed');
          }
        } catch (e) {
          console.log(`    Builds: ${e.message}`);
        }
      }
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }

  } catch (error) {
    console.error(`  Error: ${error.message}`);
  }
}

async function main() {
  console.log('Checking Apple App Store Connect for configured apps...');

  // Get unique iOS bundle IDs from config
  const iosBundleIds = new Set();
  for (const job of config.jobs) {
    if (job.platform === 'ios') {
      iosBundleIds.add(job.bundleId);
    }
  }

  for (const bundleId of iosBundleIds) {
    await checkApp(bundleId);
  }
}

main().catch(console.error);
