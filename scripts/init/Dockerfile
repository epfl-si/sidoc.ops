FROM node:22
WORKDIR /app
COPY sync.js /app/sync.js
COPY package.json /app/package.json
RUN npm i
CMD ["node", "sync.js"]
