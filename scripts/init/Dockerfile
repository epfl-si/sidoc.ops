FROM node:22
WORKDIR /app
COPY init.mjs /app/init.mjs
RUN npm install axios dotenv pg @kubernetes/client-node
CMD ["node", "init.mjs"]
