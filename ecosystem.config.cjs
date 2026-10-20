// PM2: `pm2 startOrReload ecosystem.config.cjs`. A API lê o .env da pasta do projeto (cwd).
module.exports = {
  apps: [
    {
      name: 'acainfe-api',
      script: 'dist/main.js',
      cwd: __dirname,
      node_args: '--enable-source-maps',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '512M',
      kill_timeout: 10000,
      time: true,
    },
  ],
};
