FROM oven/bun:latest

WORKDIR /app

# Copy package files first for better caching
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy the rest of the application
COPY . .

# Set environment variables
ENV PORT=3000
ENV DB_PATH="/app/data/documents.sqlite"

# Create the data directory
RUN mkdir -p /app/data

# Expose port
EXPOSE 3000

# Command to run the application
CMD ["bun", "run", "index.ts"]