FROM oven/bun:latest
WORKDIR /app
COPY package.json .
COPY bun.lock .
RUN bun install --frozen-lockfile
COPY . .
EXPOSE 3000
CMD ["bun", "run", "index.ts"]