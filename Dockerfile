FROM node:20.19.0-alpine AS builder
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json webpack.config.js ./
COPY src ./src
COPY configs ./configs
COPY scripts ./scripts
COPY assets ./assets
RUN npm run build

FROM node:20.19.0-alpine
RUN apk add --no-cache tzdata
WORKDIR /app
COPY --from=builder /build/dist/ /app/
RUN mkdir -p /app/logs && chmod +x /app/startup.sh /app/assets/CloudflareST
ENTRYPOINT ["./startup.sh"]
