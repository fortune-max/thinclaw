FROM node:20-slim

WORKDIR /app

# Install all dependencies (including dev for tsc)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# Remove dev dependencies
RUN npm prune --omit=dev

RUN chmod +x entrypoint.sh

ENV NODE_ENV=production
EXPOSE 8080

CMD ["./entrypoint.sh"]
