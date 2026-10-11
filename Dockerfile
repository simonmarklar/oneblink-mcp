# OneBlink MCP server — HTTP transport image.
# Multi-stage: build with dev deps (tsc), ship a lean runtime.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
# Production deps only (no tsc/inspector/tsx in the runtime image).
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Run as the built-in non-root node user.
USER node
EXPOSE 3000
CMD ["node", "dist/http.js"]
