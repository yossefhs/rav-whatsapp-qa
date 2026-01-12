FROM node:18-slim

# DEBUG MODE - NUCLEAR OPTION
# Commenting out heavy dependencies to prove basic connectivity

# RUN apt-get update && apt-get install -y \
#     git \
#     openssh-client \
#     ca-certificates \
#     python3 \
#     build-essential \
#     chromium \
#     ffmpeg \
#     unzip \
#     fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
#     --no-install-recommends \
#     && rm -rf /var/lib/apt/lists/*

# ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
# ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# COPY package*.json ./
# RUN npm install --production
# RUN npm install -g pm2

COPY debug_server.js .

# RUN mkdir -p uploads media .ravbot/chrome-profile

EXPOSE 3000

CMD ["node", "debug_server.js"]
