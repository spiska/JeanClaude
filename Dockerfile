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
COPY public ./public

# The folder claude runs in (see "Modes" in the README). Mount your own over it to
# give claude other files and instructions.
COPY --chown=node:node workspace /workspace
# claude's data directory, created here so a volume mounted on it is writable by node.
RUN mkdir /home/node/.claude && chown node:node /home/node/.claude

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    CLAUDE_CWD=/workspace

USER node
EXPOSE 3000
CMD ["node", "server.js"]
