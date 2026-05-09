// Ejecutar una sola vez para generar TG_SESSION:  node setup.js
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { createInterface } from 'node:readline/promises';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => rl.question(q);

const apiId = parseInt(await ask('API ID (my.telegram.org/apps): '), 10);
const apiHash = await ask('API Hash: ');

const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
  connectionRetries: 5,
});

await client.start({
  phoneNumber: () => ask('Teléfono (con código de país, ej. +34600000000): '),
  password: () => ask('Contraseña 2FA (o pulsa Enter si no tienes): '),
  phoneCode: () => ask('Código OTP recibido en Telegram: '),
  onError: (err) => console.error('[error]', err.message),
});

const session = client.session.save();
console.log('\n✅ Autenticación completada. Añade esto a tu .env:\n');
console.log(`TG_SESSION=${session}`);
console.log('\nLuego consigue el ID del canal ejecutando este snippet en el REPL de Node:');
console.log('  const msgs = await client.getMessages("@tu_canal", { limit: 1 })');
console.log('  console.log(msgs[0]?.peerId)');
await client.disconnect();
rl.close();
