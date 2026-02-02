FROM node:24.13-slim AS build

WORKDIR /app

# Install all deps (incl dev) for build
COPY package.json package-lock.json ./
RUN npm ci

# Copy only sources needed for build
COPY src ./src

# Build output into dist/
RUN npm run build

# Keep only production dependencies for runtime
RUN npm prune --omit=dev

FROM node:24.13-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

# Runtime needs production node_modules + published artifacts
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json
COPY LICENSE ./LICENSE

EXPOSE 3000

# Avoid requiring devDependency "dotenv" at runtime
CMD ["node", "dist/server.js", "--no-open"]
