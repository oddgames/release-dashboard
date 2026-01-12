# Build Dashboard - Design Document

## Overview

A standalone web dashboard for monitoring Jenkins CI/CD builds with Fastlane integration, focusing on mobile app releases for Google Play and Apple App Store.

## Goals

1. **Visibility** - Single view of all build statuses across projects and branches
2. **Changesets** - See what commits are included in each build
3. **Downloads** - Quick access to build artifacts (APK, IPA, AAB)
4. **Store Status** - Track upload status to Google Play and App Store
5. **Review Tracking** - Monitor app review status in both stores
6. **Branch Focus** - Prioritize main branch, show other branches secondary

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser (Dashboard UI)                   │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Node.js Express Server                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ REST API    │  │ Build Cache │  │ Store Status Endpoint   │  │
│  │ /api/builds │  │ (in-memory) │  │ POST /api/store-status  │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
        │                                       ▲
        ▼                                       │
┌───────────────────┐                 ┌─────────────────────┐
│   Jenkins REST    │                 │  Fastlane Webhook   │
│   API (polling)   │                 │  (from CI jobs)     │
└───────────────────┘                 └─────────────────────┘
```

## Data Flow

### 1. Build Information (Jenkins → Dashboard)

```
Jenkins API                         Dashboard Server
    │                                     │
    │  GET /job/{name}/job/{branch}/     │
    │      lastBuild/api/json            │
    │◄────────────────────────────────────│
    │                                     │
    │  { number, result, timestamp,      │
    │    duration, changeSets }          │
    │────────────────────────────────────►│
    │                                     │
```

**Polling interval:** 60 seconds (configurable)

### 2. Store Status (Fastlane → Dashboard)

```
Fastlane Lane                       Dashboard Server
    │                                     │
    │  POST /api/store-status            │
    │  { jobName, branch, store,         │
    │    status, track, reviewStatus }   │
    │────────────────────────────────────►│
    │                                     │
    │  { success: true }                 │
    │◄────────────────────────────────────│
```

## Data Models

### Build

```typescript
interface Build {
  jobName: string;           // "TrucksOffRoad-iOS"
  displayName: string;       // "Trucks Off Road"
  platform: "ios" | "android";
  branch: string;            // "main"
  isMainBranch: boolean;

  // From Jenkins
  buildNumber: number;
  status: "SUCCESS" | "FAILURE" | "IN_PROGRESS" | "UNSTABLE" | "ABORTED";
  timestamp: number;
  duration: number;
  changeSet: Commit[];
  artifacts: Artifact[];

  // From Fastlane webhooks
  store: {
    googlePlay?: StoreStatus;
    appStore?: StoreStatus;
  };
}

interface Commit {
  message: string;
  author: string;
  date: string;
}

interface Artifact {
  fileName: string;
  url: string;
}

interface StoreStatus {
  status: "uploaded" | "in_review" | "live" | "rejected";
  track: string;           // "production", "beta", "alpha", "internal", "testflight"
  reviewStatus?: "pending" | "in_review" | "approved" | "rejected";
}
```

### Configuration

```typescript
interface Config {
  jenkins: {
    baseUrl: string;
    username: string;
    apiToken: string;
  };
  jobs: Job[];
  refreshInterval: number;     // milliseconds
  branchHistoryDays: number;   // how far back to look for branches (default: 30)
}

interface Job {
  name: string;             // Unique identifier
  displayName: string;      // UI display name
  platform: "ios" | "android";
  bundleId: string;         // App bundle identifier
  jenkinsJob: string;       // Jenkins job/pipeline name
}
```

### Branch Discovery

Branches are discovered dynamically by querying Jenkins for builds from the last 30 days (configurable via `branchHistoryDays`).

```
GET /job/{jenkinsJob}/api/json?tree=builds[number,timestamp,result,actions[lastBuiltRevision[branch[name]]]]
```

- Filters builds where `timestamp > (now - branchHistoryDays)`
- Extracts unique branch names from build metadata
- `main` branch sorted first, other branches sorted by most recent build

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/builds` | Get all cached build data |
| POST | `/api/refresh` | Force refresh from Jenkins |
| POST | `/api/store-status` | Update store status (called by Fastlane) |

### POST /api/store-status

Request body:
```json
{
  "jobName": "TrucksOffRoad-iOS",
  "branch": "main",
  "store": "appStore",
  "status": "uploaded",
  "track": "testflight",
  "reviewStatus": "pending",
  "downloadUrl": "https://..."
}
```

## UI Layout

Table tree with one column per track. Icons indicate platform and source.

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  BUILD DASHBOARD                                                          Updated 10:30 AM    [Refresh]    │
├───────────────────────────────────────┬─────────────┬─────────────┬─────────────┬─────────────┬─────────────┤
│ Project                               │ 🔧 Dev      │ 🔧 Alpha    │ 🔧 Release  │ 🏪 Alpha    │ 🏪 Release  │
├───────────────────────────────────────┼─────────────┼─────────────┼─────────────┼─────────────┼─────────────┤
│ ▼ Trucks Off Road                     │             │             │             │             │             │
│   │  #142 (3) 📱💾 🤖💾               │  ●  ●     │  ●  ●     │  ●         │  ●  ●     │  ● ⏳  ●   │
│   ├─ Fix crash on level 5             │             │             │             │             │             │
│   ├─ Update vehicle physics           │             │             │             │             │             │
│   └─ Add new truck model              │             │             │             │             │             │
│                                       │             │             │             │             │             │
│ ▼ Monster Truck Dest.                 │             │             │             │             │             │
│   │  #201 (1) 📱💾 🤖💾               │  ●  ●     │  —   —      │  ●  ●     │  —   —      │  ●  ●     │
│   └─ New championship mode            │             │             │             │             │             │
│                                       │             │             │             │             │             │
│ ▶ Another Game  #45 (2) 📱💾          │  ◐  ●     │  ●  —      │  —   —      │  ●  ●     │  ●  ●     │
└───────────────────────────────────────┴─────────────┴─────────────┴─────────────┴─────────────┴─────────────┘
```

**Legend:** `#142` = build number, `(3)` = commit count

### Icons

All icons stored locally in `public/icons/`.

#### Store & Platform Icons (downloaded)

| File | Source | Usage |
|------|--------|-------|
| `icons/app-store.svg` | Apple | App Store column header, iOS store links |
| `icons/testflight.svg` | Apple | TestFlight status |
| `icons/play-store.svg` | Google | Play Store column header, Android store links |
| `icons/jenkins.svg` | Jenkins | Dev/Alpha/Release column headers |

#### Game Icons (fetched dynamically)

App icons fetched on server startup using bundle identifiers from config.

**iOS (App Store Lookup API):**
```
GET https://itunes.apple.com/lookup?bundleId={bundleId}
→ response.results[0].artworkUrl512
```

**Android (Google Play):**
```
Scrape or use unofficial API:
https://play.google.com/store/apps/details?id={bundleId}
→ Parse og:image meta tag or use google-play-scraper npm package
```

Icons cached locally in `public/icons/games/` after first fetch:
- `{bundleId}.png` (e.g., `au.com.oddgames.trucksoffroad.png`)

Game icons displayed in the Project column next to the game name.

#### Status Icons (simple SVG or CSS)

| Icon | Color | Meaning |
|------|-------|---------|
| ● (filled circle) | green | Available/Success |
| ◐ (half circle) | blue | Building/In Progress |
| ✗ (x mark) | red | Failed |
| ⏳ (clock) | orange | In Review / Pending |
| — (dash) | gray | Not available |

### Cell Metadata

Each cell displays:
- Platform status icons (iOS/Android)
- Timestamp (relative, e.g., "2h ago", "3d ago")

```
┌─────────────────┐
│  ●    ●       │  <- iOS success, Android success
│    2h ago       │  <- when this stage was reached
└─────────────────┘
```

### Tree Structure

```
Project (collapsible)
│  [game-icon] #142 (3 commits) [ios-download] [android-download]
├─ Fix crash on level 5
├─ Update vehicle physics
└─ Add new truck model
```

### Comparison View

The pipeline columns make it easy to see:
- **Pipeline progress**: Track builds from Dev → Alpha → Release → Store
- **Platform parity**: Quickly spot if iOS and Android are at different stages
- **Review status**: See at a glance what's pending store review

## Store Status States

### Google Play

| Status | Track | Description |
|--------|-------|-------------|
| `uploaded` | `internal` | Uploaded to internal testing |
| `uploaded` | `alpha` | Uploaded to closed testing |
| `uploaded` | `beta` | Uploaded to open testing |
| `in_review` | `production` | Submitted, pending review |
| `live` | `production` | Live in Play Store |

### App Store

| Status | Track | Description |
|--------|-------|-------------|
| `uploaded` | `testflight` | Uploaded to TestFlight |
| `in_review` | `testflight` | TestFlight beta review |
| `in_review` | `appstore` | App Store review |
| `live` | `appstore` | Live in App Store |

## Fastlane Integration

### Setup

1. Copy `fastlane/dashboard_helper.rb` to your project's `fastlane/` directory
2. Add `import "./dashboard_helper.rb"` to your `Fastfile`
3. Set `DASHBOARD_URL` environment variable (or defaults to `http://localhost:3000`)

### Usage in Fastfile

```ruby
# After uploading to TestFlight
dashboard_uploaded_to_app_store(
  job_name: "TrucksOffRoad-iOS",
  branch: ENV['GIT_BRANCH'],
  track: "testflight"
)

# After uploading to Play Store
dashboard_uploaded_to_play_store(
  job_name: "TrucksOffRoad-Android",
  branch: ENV['GIT_BRANCH'],
  track: "internal"
)

# When app is in review
dashboard_in_review(
  job_name: "TrucksOffRoad-iOS",
  branch: ENV['GIT_BRANCH'],
  store: "appStore"
)

# When app goes live
dashboard_live(
  job_name: "TrucksOffRoad-Android",
  branch: ENV['GIT_BRANCH'],
  store: "googlePlay",
  track: "production"
)
```

## Projects

| Project | Platform | Bundle ID |
|---------|----------|-----------|
| Trucks Off Road | iOS | `au.com.oddgames.trucksoffroad` |
| Trucks Off Road | Android | `au.com.oddgames.trucksoffroad` |
| Monster Truck Destruction | iOS | `com.chillingo.monstertruckdestruction` |
| Monster Truck Destruction | Android | `au.com.oddgames.monstertruckdestruction` |

## File Structure

```
jenkins-dashboard/
├── config.json              # Configuration (Jenkins URL, jobs, credentials)
├── package.json
├── src/
│   ├── server.js            # Express server, API endpoints
│   └── jenkins-api.js       # Jenkins REST API client
├── public/
│   ├── index.html           # Dashboard HTML
│   ├── styles.css           # Styling
│   └── app.js               # Frontend JavaScript
└── fastlane/
    ├── dashboard_helper.rb  # Ruby helper for Fastlane integration
    └── Fastfile.example     # Example Fastlane usage
```

## Logging

Structured logging using a simple logger with levels and context.

### Log Levels

| Level | Usage |
|-------|-------|
| `error` | Failures that need attention (API errors, crashes) |
| `warn` | Recoverable issues (missing data, retries) |
| `info` | Key events (server start, refresh complete, webhook received) |
| `debug` | Detailed debugging (API requests, data transformations) |

### Log Format

```
[TIMESTAMP] [LEVEL] [CONTEXT] message {metadata}
```

Example:
```
[2024-01-15T10:30:00Z] [INFO] [jenkins-api] Fetching builds for game_trucks_off_road_ios
[2024-01-15T10:30:01Z] [DEBUG] [jenkins-api] Found 12 builds in last 30 days
[2024-01-15T10:30:02Z] [ERROR] [jenkins-api] Failed to fetch artifacts {"status": 404, "job": "game_trucks_off_road_ios"}
```

### Log Categories

| Context | Description |
|---------|-------------|
| `server` | Express server events |
| `jenkins-api` | Jenkins API calls and responses |
| `store-status` | Fastlane webhook updates |
| `icon-fetch` | Game icon fetching |
| `cache` | Build cache operations |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | Minimum log level to output |
| `LOG_FORMAT` | `text` | Output format: `text` or `json` |

## Future Enhancements

1. **Persistent storage** - SQLite or file-based storage for store status history
2. **Notifications** - Slack/email alerts for build failures or review status changes
3. **Build triggers** - Trigger Jenkins builds from dashboard
4. **Historical data** - Charts showing build times, success rates over time
5. **Multi-user** - Authentication and user-specific views
6. **App Store Connect API** - Auto-fetch review status from Apple
7. **Google Play Developer API** - Auto-fetch release status from Google
