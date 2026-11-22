import { startServer } from './server.js';

const port = Number(process.argv[2] || 8901);
await startServer(port);