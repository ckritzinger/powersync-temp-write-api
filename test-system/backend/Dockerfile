FROM node:24-bookworm-slim
RUN npm install --global pnpm@9.12.3
WORKDIR /app
COPY .generated/backend/package.json .generated/backend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY .generated/backend/ ./
RUN pnpm check
# Run with the container default user so owner-only host auth exports remain readable.
CMD ["pnpm", "start"]
