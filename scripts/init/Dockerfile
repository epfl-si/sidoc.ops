FROM node:22
WORKDIR /app
COPY init.mjs /app/init.mjs
COPY package.json /app/package.json
RUN npm i
CMD ["node", "init.mjs"]
