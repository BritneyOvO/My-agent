FROM node:22-alpine

WORKDIR /app

COPY package.json /app/package.json
COPY src /app/src

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "--experimental-strip-types", "src/index.ts"]
