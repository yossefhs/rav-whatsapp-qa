require('dotenv').config();
const Redis = require('ioredis');

// Configuration Redis
// Fallback Hardcodé car Railway semble avoir du mal avec la variable d'env
const REDIS_URL = process.env.REDIS_URL || 'redis://default:nS9ovE7uWCYi7sh78ChdFQ6oLmg9amRk@redis-15829.c247.eu-west-1-1.ec2.cloud.redislabs.com:15829';

const redisClient = new Redis(REDIS_URL, {
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  enableOfflineQueue: true
});

// Événements de connexion
redisClient.on('connect', () => {
  console.log('✅ Redis: Connexion établie');
});

redisClient.on('ready', () => {
  console.log('✅ Redis: Prêt à recevoir des commandes');
});

redisClient.on('error', (err) => {
  console.error('❌ Redis erreur:', err);
});

redisClient.on('close', () => {
  console.log('⚠️  Redis: Connexion fermée');
});

redisClient.on('reconnecting', () => {
  console.log('🔄 Redis: Reconnexion en cours...');
});

// Fonctions utilitaires pour le cache
const redisCache = {
  // Définir une valeur avec expiration (TTL en secondes)
  async set(key, value, ttl = 3600) {
    try {
      const stringValue = JSON.stringify(value);
      if (ttl) {
        await redisClient.setex(key, ttl, stringValue);
      } else {
        await redisClient.set(key, stringValue);
      }
      return true;
    } catch (error) {
      console.error('Erreur Redis SET:', error);
      return false;
    }
  },

  // Récupérer une valeur
  async get(key) {
    try {
      const value = await redisClient.get(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      console.error('Erreur Redis GET:', error);
      return null;
    }
  },

  // Supprimer une clé
  async del(key) {
    try {
      await redisClient.del(key);
      return true;
    } catch (error) {
      console.error('Erreur Redis DEL:', error);
      return false;
    }
  },

  // Vérifier si une clé existe
  async exists(key) {
    try {
      const result = await redisClient.exists(key);
      return result === 1;
    } catch (error) {
      console.error('Erreur Redis EXISTS:', error);
      return false;
    }
  },

  // Définir le TTL d'une clé existante
  async expire(key, ttl) {
    try {
      await redisClient.expire(key, ttl);
      return true;
    } catch (error) {
      console.error('Erreur Redis EXPIRE:', error);
      return false;
    }
  },

  // Récupérer toutes les clés correspondant à un pattern
  async keys(pattern) {
    try {
      return await redisClient.keys(pattern);
    } catch (error) {
      console.error('Erreur Redis KEYS:', error);
      return [];
    }
  },

  // Vider toutes les clés (attention!)
  async flushAll() {
    try {
      await redisClient.flushall();
      return true;
    } catch (error) {
      console.error('Erreur Redis FLUSHALL:', error);
      return false;
    }
  }
};

// Fermeture propre de la connexion
process.on('SIGINT', async () => {
  console.log('\n🛑 Fermeture de la connexion Redis...');
  await redisClient.quit();
  process.exit(0);
});

module.exports = {
  redisClient,
  redisCache
};
