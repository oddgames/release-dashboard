# Release Dashboard

A release dashboard for monitoring mobile app releases across build pipelines and app stores. Focuses on the main branch release flow from build to store.

## Project Structure

```
release-dashboard/
├── config.json           # Jenkins credentials and job configuration
├── src/
│   ├── server.js         # Express server entry point
│   ├── config.js         # Configuration loader
│   ├── logger.js         # Structured logging utility
│   ├── jenkins-api.js    # Jenkins REST API client
│   ├── plastic-api.js    # Plastic SCM CLI integration (with query cache)
│   ├── store-api.js      # App Store Connect & Google Play APIs
│   ├── routes/
│   │   ├── builds.js     # Build data and Jenkins endpoints
│   │   ├── distribution.js # Store promotion and rollout endpoints
│   │   ├── release-notes.js # AI release notes generation
│   │   ├── analytics.js  # Google Play vitals and Sentry
│   │   └── discord.js    # Discord webhook notifications
│   ├── services/
│   │   ├── ai.js         # Gemini AI integration (streaming support)
│   │   ├── cache.js      # Build data cache and SSE clients
│   │   ├── data-refresh.js # Background data refresh logic
│   │   └── discord.js    # Discord message formatting
│   └── utils/
│       └── build-helpers.js # Version/changeset extraction
├── public/
│   ├── index.html        # Dashboard HTML (modals, tables)
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

### Builds & Data
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/builds` | Get all cached build data |
| POST | `/api/refresh` | Force refresh from Jenkins |
| POST | `/api/trigger-build` | Trigger Jenkins build for a branch |
| GET | `/api/plastic-cache/stats` | Get Plastic SCM cache statistics |
| POST | `/api/plastic-cache/clear` | Clear the Plastic SCM query cache |

### Release Notes
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/get-commits` | Get commits between changesets (with merge history) |
| POST | `/api/generate-release-notes` | AI-generate release notes from commits |
| POST | `/api/stream-release-notes` | SSE streaming AI generation |
| POST | `/api/translate-release-notes` | AI-translate release notes |
| GET | `/api/changesets/:projectId/:branch` | Get recent changesets for dropdown |
| POST | `/api/compare-changesets` | Compare two changesets with AI summary |

### Distribution & Store
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/distribute` | Trigger store distribution |
| POST | `/api/promote` | Promote build from internal to alpha |
| GET | `/api/store-versions` | Get versions from App Store & Play Store |
| POST | `/api/store-status` | Update store status (Fastlane webhook) |

### Android Rollout
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/rollout/android/start` | Start staged rollout (Mexico, 20%, 100%) |
| POST | `/api/rollout/android/update` | Update rollout percentage |
| POST | `/api/rollout/android/halt` | Halt active rollout |

### iOS Submission
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/submit-ios-review` | Submit iOS build for App Store review |

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

## Caching

### Plastic SCM Query Cache
- Generic query-based cache at the `cm` command level
- 5-minute TTL, max 200 entries with LRU eviction
- Monitor via `/api/plastic-cache/stats` (shows hits, misses, hit rate)
- Clear via `/api/plastic-cache/clear` for forced refresh

### Store API Cache
- Per-app cache for App Store Connect and Google Play data
- Automatically invalidated after store operations (promote, rollout, etc.)

## Frontend Error Handling

The dashboard shows detailed error modals for failures with:
- Error message and technical details
- Context-aware suggestions for common issues (permissions, rate limits, etc.)
- Copy button for sharing error details

## Deployment

Deploy via `/deploy` command. This will:
1. Move unreleased changes below into a versioned CHANGELOG entry
2. Bump version in package.json
3. Commit, tag, and push to GitHub
4. Portainer auto-deploys via webhook

### Unreleased Changes
(none)
