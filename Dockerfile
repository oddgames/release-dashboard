FROM node:20-slim

# Install prerequisites for Plastic SCM installation at runtime
RUN apt-get update && \
    apt-get install -y --no-install-recommends apt-transport-https gnupg wget && \
    rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Install dependencies first (better caching)
COPY package*.json ./
RUN npm ci --only=production

# Copy app source (excluding files in .dockerignore)
COPY . .

# Create data directory for persistent storage
RUN mkdir -p /app/data

# Copy and make entrypoint executable
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Create non-root user (entrypoint runs as root for apt, then drops to nodejs)
RUN groupadd -g 1001 nodejs && \
    useradd -u 1001 -g nodejs -m -s /bin/sh nodejs
RUN chown -R nodejs:nodejs /app

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
