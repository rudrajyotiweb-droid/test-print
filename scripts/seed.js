// Create a shop and print its credentials once.
// Usage: npm run seed -- [--id demo] [--name "Demo Print Shop"] [--password secret123] [--duplex] [--no-color]
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { createShop, getShop, shopUrl } from '../src/lib/shops.js';
import { config } from '../src/config.js';

const { values } = parseArgs({
  options: {
    id: { type: 'string' },
    name: { type: 'string', default: 'Demo Print Shop' },
    password: { type: 'string' },
    'bw-rate': { type: 'string', default: '2' },
    'color-rate': { type: 'string', default: '10' },
    duplex: { type: 'boolean', default: false },
    'no-color': { type: 'boolean', default: false },
  },
});

if (values.id && getShop(values.id)) {
  console.error(`Shop "${values.id}" already exists. Pick another --id, or log in to /admin and issue a new agent token.`);
  process.exit(1);
}

const password = values.password || crypto.randomBytes(6).toString('base64url');
const { shop, agentToken } = await createShop({
  id: values.id,
  name: values.name,
  password,
  bwRate: Number(values['bw-rate']),
  colorRate: Number(values['color-rate']),
  supportsColor: !values['no-color'],
  supportsDuplex: values.duplex,
});

const line = '─'.repeat(60);
console.log(`\n${line}\n  Shop created — save these now, the token is shown only once\n${line}`);
console.log(`  Shop name      : ${shop.name}`);
console.log(`  Shop ID        : ${shop.id}`);
console.log(`  Admin password : ${password}`);
console.log(`  Agent token    : ${agentToken}`);
console.log(`  Customer URL   : ${shopUrl(shop.id)}`);
console.log(`  Admin panel    : ${config.publicUrl}/admin`);
console.log(`${line}\n  Put the shop ID + token into agent/config.json\n${line}\n`);
