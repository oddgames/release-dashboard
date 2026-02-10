# Changelog

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
