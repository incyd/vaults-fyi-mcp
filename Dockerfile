FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm install --save-dev typescript @types/node @types/express @types/pg && \
    npx tsc && \
    npm prune --production

EXPOSE 3000

CMD ["node", "dist/index.js"]
