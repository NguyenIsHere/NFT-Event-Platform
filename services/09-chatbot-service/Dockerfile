FROM node:20-alpine AS base

ENV NODE_ENV=production

WORKDIR /usr/src/app

COPY services/09-chatbot-service/package*.json ./

RUN npm ci --omit=dev

COPY services/09-chatbot-service/. ./

COPY protos /usr/src/app/protos

RUN ls -R /usr/src/app

EXPOSE ${PORT:-50059}

CMD [ "node", "src/server.js" ]
