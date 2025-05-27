FROM node:20-alpine AS base
ENV NODE_ENV=production
WORKDIR /usr/src/app

COPY services/04-event-service/package*.json ./
RUN npm ci --omit=dev

COPY services/04-event-service/src ./src
COPY services/04-event-service/.env ./.env
COPY protos /usr/src/app/protos 

EXPOSE ${PORT:-50054}
CMD [ "node", "src/server.js" ]