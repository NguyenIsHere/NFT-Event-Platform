FROM node:20-alpine AS base
ENV NODE_ENV=production
WORKDIR /usr/src/app

COPY services/05-ticket-service/package*.json ./
RUN npm ci --omit=dev

COPY services/05-ticket-service/src ./src
COPY services/05-ticket-service/.env ./.env
COPY protos /usr/src/app/protos

EXPOSE ${PORT:-50055}
CMD [ "node", "src/server.js" ]