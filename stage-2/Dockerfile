FROM node:22-alpine

WORKDIR /srv/tablekeeper
COPY package.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

USER node

CMD ["node", "src/index.js"]
