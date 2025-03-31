FROM node:22
WORKDIR /app
COPY sync.js /app/sync.js
RUN npm install axios dotenv
CMD ["node", "sync.js"]
