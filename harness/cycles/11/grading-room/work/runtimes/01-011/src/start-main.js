import { startServer } from './server.js';
import { BookingStore } from './domain.js';

const port = Number(process.env.LOYLY_PORT || 8901);
await startServer(port, new BookingStore());
console.log(`Löyly booking listening on http://127.0.0.1:${port}/`);