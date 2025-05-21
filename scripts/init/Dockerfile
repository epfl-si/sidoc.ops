FROM node:22
WORKDIR /app
COPY init.js /app/init.js
COPY package.json /app/package.json
RUN npm i
CMD ["node", "init.js"]
