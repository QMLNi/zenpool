FROM node:20-alpine
WORKDIR /app

# 时区：默认 UTC，装 tzdata 并设北京时间（重建后不丢）
RUN apk add --no-cache tzdata \
    && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone
ENV TZ=Asia/Shanghai

# 先装依赖（利用缓存层）
COPY package.json ./
RUN npm install --omit=dev

# 再拷代码（含 pool/ 模块：URI 解析 + mihomo 配置生成 + 节点池）
COPY server.mjs ./
COPY pool/ ./pool/

ENV PROXY_PORT=7446
ENV KEYS_FILE=/app/data/api-keys.json

EXPOSE 7446
CMD ["node", "server.mjs"]
