# AWS Deployment Guide

This guide covers deploying the Release Dashboard to AWS App Runner with GitHub integration for automatic deployments.

## Prerequisites

- AWS Account
- GitHub repository with this code
- AWS CLI installed (optional, for CLI setup)

## Security Features

AWS App Runner provides:
- **Automatic HTTPS** with AWS-managed certificates
- **IAM-based access control**
- **Private VPC connectivity** (optional)
- **Automatic security patching**
- **DDoS protection** via AWS Shield

## Step 1: Push to GitHub

First, create a GitHub repository and push your code:

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/release-dashboard.git
git push -u origin main
```

**Important**: Never commit `config.json` with real secrets. Use the `.gitignore` to exclude it.

## Step 2: Create AWS App Runner Service

### Option A: AWS Console (Recommended for first-time setup)

1. Go to [AWS App Runner Console](https://console.aws.amazon.com/apprunner)
2. Click **Create service**
3. Select **Source code repository**
4. Click **Add new** to connect your GitHub account
5. Select your repository and branch (`main`)
6. Configure build settings:
   - **Runtime**: Node.js 18
   - **Build command**: `npm ci --only=production`
   - **Start command**: `node src/server.js`
   - **Port**: `3000`
7. Configure service settings:
   - **Service name**: `release-dashboard`
   - **CPU**: 0.25 vCPU (sufficient for 4 users)
   - **Memory**: 0.5 GB
8. Add environment variables (see Step 3)
9. Click **Create & deploy**

### Option B: AWS CLI

```bash
aws apprunner create-service \
  --service-name release-dashboard \
  --source-configuration '{
    "CodeRepository": {
      "RepositoryUrl": "https://github.com/YOUR_USERNAME/release-dashboard",
      "SourceCodeVersion": {"Type": "BRANCH", "Value": "main"},
      "CodeConfiguration": {
        "ConfigurationSource": "API",
        "CodeConfigurationValues": {
          "Runtime": "NODEJS_18",
          "BuildCommand": "npm ci --only=production",
          "StartCommand": "node src/server.js",
          "Port": "3000"
        }
      }
    },
    "AutoDeploymentsEnabled": true
  }'
```

## Step 3: Configure Secrets

### Using AWS Secrets Manager (Recommended)

1. Go to [AWS Secrets Manager](https://console.aws.amazon.com/secretsmanager)
2. Create a new secret with key/value pairs:

```json
{
  "JENKINS_BASE_URL": "https://your-jenkins.example.com",
  "JENKINS_USERNAME": "your-username",
  "JENKINS_API_TOKEN": "your-api-token",
  "AI_API_KEY": "your-gemini-api-key",
  "SENTRY_AUTH_TOKEN": "your-sentry-token",
  "DISCORD_WEBHOOK_URL": "https://discord.com/api/webhooks/...",
  "ASC_KEY_CONTENT": "-----BEGIN PRIVATE KEY-----\n...",
  "GOOGLE_PLAY_KEY_CONTENT": "{\"type\":\"service_account\",...}"
}
```

3. In App Runner, reference the secret:
   - Go to your service > Configuration > Environment variables
   - Add variables that reference the secret ARN

### Using Environment Variables Directly

In App Runner Console:
1. Go to your service
2. Click **Configuration** tab
3. Under **Environment variables**, add each variable
4. Click **Save changes**

Required variables:
| Variable | Description |
|----------|-------------|
| `JENKINS_BASE_URL` | Your Jenkins server URL |
| `JENKINS_USERNAME` | Jenkins username |
| `JENKINS_API_TOKEN` | Jenkins API token |
| `AI_API_KEY` | Google Gemini API key |
| `DISCORD_ENABLED` | Set to `true` to enable |
| `DISCORD_WEBHOOK_URL` | Discord webhook URL |

## Step 4: Configure Auto-Deploy

App Runner automatically deploys when you push to the connected branch:

```bash
git add .
git commit -m "Update feature"
git push origin main
# App Runner automatically detects and deploys
```

## Step 5: Access Control (Optional)

### Option A: AWS IAM + Cognito

For AWS-level authentication:
1. Create a Cognito User Pool
2. Configure App Runner with IAM authorization
3. Users authenticate via Cognito

### Option B: Simple Password Protection

Add basic auth middleware to `server.js`:

```javascript
// Add before routes
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
if (DASHBOARD_PASSWORD) {
  app.use((req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${DASHBOARD_PASSWORD}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });
}
```

### Option C: VPC + VPN (Most Secure)

1. Create a VPC connector in App Runner
2. Configure the service to use the VPC
3. Access only via VPN connected to that VPC

## Step 6: Custom Domain (Optional)

1. In App Runner Console, go to your service
2. Click **Custom domains** tab
3. Add your domain (e.g., `releases.yourcompany.com`)
4. Add the provided CNAME record to your DNS
5. AWS automatically provisions an SSL certificate

## Monitoring

- **Logs**: Available in CloudWatch Logs
- **Metrics**: CPU, Memory, Request count in App Runner console
- **Health checks**: Automatic via the `/api/builds` endpoint

## Costs

For 4 users with light usage:
- **App Runner**: ~$5-15/month (pay for compute time)
- **Secrets Manager**: ~$0.40/month per secret
- **Data transfer**: Usually under $1/month

## Troubleshooting

### Service won't start
- Check CloudWatch logs for errors
- Verify all required environment variables are set
- Ensure `config.json` has valid JSON (for non-secret config)

### Auto-deploy not working
- Verify GitHub connection in App Runner
- Check that `AutoDeploymentsEnabled` is true
- Review GitHub webhook delivery status

### Discord not posting
- Verify `DISCORD_ENABLED=true`
- Check webhook URL is correct
- Review application logs for errors

## Local Development

For local testing:

```bash
# Copy example env file
cp .env.example .env

# Edit with your values
nano .env

# Run locally
npm start
```

The app will use `config.json` values, with `.env` overriding secrets.
