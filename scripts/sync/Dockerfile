FROM node:24-slim
WORKDIR /app
COPY sync.js /app/sync.js
RUN npm i
#RUN echo test
CMD ["node", "sync.js"]
