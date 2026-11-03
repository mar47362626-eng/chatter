FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js app.js country-codes.js favicon.svg index.html moderation.css moderation.html moderation.js styles.css ./

ENV HOST=0.0.0.0
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]
