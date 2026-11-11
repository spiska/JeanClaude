FROM node:22-slim

# The Claude Code CLI that JeanClaude drives. Pinned to the version it was tested with.
ARG CLAUDE_CODE_VERSION=2.1.321
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && npm cache clean --force \
    && claude --version

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js claude.js openai.js ./

# Empty directory claude runs in (see "Modes" in the README).
RUN mkdir /workspace && chown node:node /workspace

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    CLAUDE_CWD=/workspace

USER node
EXPOSE 3000
CMD ["node", "server.js"]
