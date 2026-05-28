FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* tsconfig.json /app/
RUN npm install

COPY src /app/src

RUN npm run build

ENV NODE_ENV=production
EXPOSE 8080

CMD ["npm", "run", "start"]
