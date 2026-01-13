FROM node:18-slim

# Installation des dépendances pour Puppeteer (Chrome) et FFmpeg
RUN apt-get update && apt-get install -y \
    git \
    openssh-client \
    ca-certificates \
    python3 \
    build-essential \
    chromium \
    ffmpeg \
    curl \
    unzip \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Variables d'environnement pour Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copie des fichiers de dépendances
COPY package*.json ./

# Installation des dépendances Node.js
RUN npm install --production

# Installation de PM2 globalement
RUN npm install -g pm2

# Copie du reste de l'application
COPY . .

# Création des dossiers nécessaires
RUN mkdir -p uploads media .ravbot/chrome-profile

# Exposition du port
EXPOSE 3000

# Commande de démarrage via PM2
CMD ["npm", "start"]
