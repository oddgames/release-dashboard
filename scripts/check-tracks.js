#!/usr/bin/env node
/**
 * Check available Google Play tracks for configured apps
 * Run: node scripts/check-tracks.js
 */

const { google } = require('googleapis');
const path = require('path');
const config = require('../config.json');

async function getPlayClient() {
  const keyPath = path.join(__dirname, '..', config.fastlane.googlePlay.jsonKeyPath);

  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/androidpublisher']
  });

  return google.androidpublisher({ version: 'v3', auth });
}

async function checkTracks(packageName) {
  console.log(`\n=== ${packageName} ===`);

  try {
    const play = await getPlayClient();

    // Create an edit session
    const editResponse = await play.edits.insert({ packageName });
    const editId = editResponse.data.id;

    // Get all tracks
    const tracksResponse = await play.edits.tracks.list({
      packageName,
      editId
    });

    console.log('Available tracks:');
    for (const track of tracksResponse.data.tracks || []) {
      const releases = track.releases || [];
      const latestRelease = releases.find(r => r.status === 'completed') || releases[0];

      console.log(`  - ${track.track}`);
      if (latestRelease) {
        console.log(`      Version: ${latestRelease.name || 'N/A'}`);
        console.log(`      Status: ${latestRelease.status}`);
        console.log(`      Version codes: ${latestRelease.versionCodes?.join(', ') || 'N/A'}`);
      } else {
        console.log('      No releases');
      }
    }

    // Delete the edit
    await play.edits.delete({ packageName, editId });

  } catch (error) {
    console.error(`  Error: ${error.message}`);
  }
}

async function main() {
  console.log('Checking Google Play tracks for configured apps...');

  // Get unique Android bundle IDs from config
  const androidBundleIds = new Set();
  for (const job of config.jobs) {
    if (job.platform === 'android') {
      androidBundleIds.add(job.bundleId);
    }
  }

  for (const bundleId of androidBundleIds) {
    await checkTracks(bundleId);
  }
}

main().catch(console.error);
