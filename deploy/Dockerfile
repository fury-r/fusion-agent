FROM node:20-slim

# Install kubectl
RUN apt-get update && apt-get install -y curl ca-certificates && \
    curl -LO "https://dl.k8s.io/release/$(curl -Ls https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" && \
    chmod +x kubectl && mv kubectl /usr/local/bin/ && \
    apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/

# Default rules config (can be overridden via volume mount)
COPY deploy/cluster-debug-rules.example.yaml /config/cluster-rules.yaml

ENV NODE_ENV=production

ENTRYPOINT ["node", "dist/cli.js", "cluster-debug"]
CMD ["--config", "/config/cluster-rules.yaml", "--mode", "human-in-loop"]
