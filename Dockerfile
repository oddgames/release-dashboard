FROM node:20-alpine

# Create app directory
WORKDIR /app

# Install dependencies first (better caching)
COPY package*.json ./
RUN npm ci --only=production

# Copy app source (excluding files in .dockerignore)
COPY . .

# Create data directory for persistent storage
RUN mkdir -p /app/data

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Run as non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001
RUN chown -R nodejs:nodejs /app
USER nodejs

CMD ["node", "src/server.js"]
