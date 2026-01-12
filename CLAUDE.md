# Release Dashboard

A release dashboard for monitoring mobile app releases across build pipelines and app stores. Focuses on the main branch release flow from build to store.

## Project Structure

```
release-dashboard/
├── config.json           # Jenkins credentials and job configuration
├── src/
│   ├── server.js         # Express server, API endpoints
│   ├── jenkins-api.js    # Jenkins REST API client
│   ├── plastic-api.js    # Plastic SCM CLI integration
│   └── logger.js         # Structured logging utility
├── public/
│   ├── index.html        # Dashboard HTML (table tree layout)
│   ├── styles.css        # Dark theme styling
│   ├── app.js            # Frontend JavaScript
│   └── icons/            # SVG icons for platforms/stores
└── fastlane/
    └── dashboard_helper.rb  # Fastlane webhook helpers
```

## Key Concepts

- **Projects**: Games grouped by display name, each with iOS and Android platforms
- **Tracks**: Pipeline stages (Dev → Alpha → Release → Store Alpha → Store Release)
- **Branches**: Discovered dynamically from last 30 days of Jenkins builds
- **Store Status**: Reported via Fastlane webhooks to `/api/store-status`

## Tech Stack

- **Backend**: Node.js, Express
- **Frontend**: Vanilla JS, CSS (no framework)
- **Jenkins API**: REST with Basic Auth
- **Icons**: SVG files served statically

## Logging Convention

Use the logger module with context:

```javascript
const log = require('./logger');
log.info('jenkins-api', 'Fetching builds', { job: jobName });
log.error('jenkins-api', 'API failed', { status: 500, error: err.message });
```

Log levels: `error`, `warn`, `info`, `debug`

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/builds` | Get all cached build data |
| POST | `/api/refresh` | Force refresh from Jenkins |
| POST | `/api/store-status` | Update store status (Fastlane webhook) |
| POST | `/api/trigger-build` | Trigger Jenkins build for a branch |
| POST | `/api/distribute` | Trigger store distribution |
| POST | `/api/generate-release-notes` | AI-generate release notes from commits |
| POST | `/api/translate-release-notes` | AI-translate release notes |
| GET | `/api/project-languages/:projectId` | Get configured languages for project |
| GET | `/api/changesets/:projectId/:branch` | Get recent changesets for dropdown |
| POST | `/api/compare-changesets` | Compare two changesets with AI summary |

## Development

```bash
npm install
node src/server.js
# Dashboard at http://localhost:3000
```

## Configuration

`config.json` contains:
- Jenkins credentials (`baseUrl`, `username`, `apiToken`)
- Job definitions (name, platform, bundleId, jenkinsJob)
- Refresh interval and branch history days

## Command Line Testing

When implementing features that use command line tools (like `cm` for Plastic SCM), always test the commands interactively first before writing them into code. This helps verify the correct syntax, output format, and any required parameters.

## Design Document

See `DESIGN.md` for full architecture, data models, and UI layout specifications.
