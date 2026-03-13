module.exports = {
  apps: [
    {
      name: 'openclaw-session-viewer',
      cwd: __dirname,
      script: 'npm',
      args: 'start',
      interpreter: 'none',
      env: {
        NODE_ENV: 'production',
        PORT: 3847,
      },
    },
  ],
};
