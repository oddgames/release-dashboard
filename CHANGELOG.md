# Changelog

## v1.1.16 (2026-02-10)
- Fall back to latest Jenkins build changeset when Plastic SCM is unavailable (fixes missing build buttons in Docker)

## v1.1.15 (2026-02-10)
- Preserve cached build data when Jenkins API fails (prevents "No recent builds" on transient errors)

## v1.1.14 (2026-02-10)
- Remove image tag from docker-compose so Portainer builds from Dockerfile without attempting a pull

## v1.1.13 (2026-02-10)
- Switch docker-compose back to local build from Dockerfile (fixes GHCR pull denied errors in Portainer)

## v1.1.12 (2026-02-10)
- Remove IP allowlist authentication (server runs without access restrictions)

## v1.1.11 (2026-02-10)
- Revert docker-compose to use GHCR image for Portainer (requires registry credentials in Portainer)

## v1.1.10 (2026-02-10)
- Remove image tag from docker-compose so Portainer builds from source instead of attempting a pull

## v1.1.9 (2026-02-10)
- Switch docker-compose to local build instead of pulling from GHCR (fixes unauthorized pull errors)

## v1.1.8 (2026-02-10)
- Switch to pre-built Docker images via GitHub Container Registry (ghcr.io)
- Add GitHub Actions workflow for automated Docker image builds on tag push

## v1.1.7 (2026-02-10)
- Show version number in startup log

## v1.1.6 (2026-02-10)
- Auto-allow private/LAN IPs (localhost, Docker, 10.x, 192.168.x, 172.16-31.x)

## v1.1.5 (2026-02-10)
- Fix docker-compose.yml to use ${VAR} substitution from stack.env for Portainer

## v1.1.4 (2026-02-10)
- Add startup config logging with masked secrets for debugging

## v1.1.3 (2026-02-10)
- Add stack.env for Portainer repo-based deployment

## v1.1.2 (2026-02-10)
- Replace CONFIG_JSON with individual environment variables for Portainer compatibility

## v1.1.1 (2026-02-10)
- Add guard for missing Jenkins baseUrl with clear error message

## v1.1.0 (2026-02-09)
- Docker/Portainer deployment support with CONFIG_JSON env var
- Environment variable config for all secrets (no file mounts needed)
- dotenv loading for .env file support
- /api/version endpoint for deployment verification
- Plastic SCM generic query cache (5min TTL, 200 max entries)
- Sentry integration for crash/error tracking
- Firebase Analytics integration
- Google Play vitals (crash rate, ANR rate per version)
- App Store Connect vitals
- Store distribution, promotion, Android rollout (Mexico → 20% → 100%)
- iOS App Store review submission
- AI release notes with streaming (Gemini)
- Detailed error modals with context-aware suggestions
- Changeset comparison with AI summary
