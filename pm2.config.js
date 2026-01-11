module.exports = {
    apps: [
        {
            name: 'rav-server',
            script: './server_v2.js',
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: '1G',
            env: {
                NODE_ENV: 'production'
            }
        },
        {
            name: 'rav-bot',
            script: './bot.js',
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: '1G',
            exp_backoff_restart_delay: 1000,
            env: {
                NODE_ENV: 'production'
            }
        }
    ]
};
