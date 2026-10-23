const express = require('express');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { plugin: toolPlugin } = require('mineflayer-tool');

const PASS = process.env.ADMIN_PASSWORD;
if (!PASS) { console.error('ADMIN_PASSWORD env variable set karo!'); process.exit(1); }

let bot = null, wantOnline = true, mining = false, attackTimer = null;
const logs = [], clients = new Set();

function log(type, text) {
  const e = { t: Date.now(), type, text };
  logs.push(e); if (logs.length > 300) logs.shift();
  for (const r of clients) r.write(`data: ${JSON.stringify(e)}\n\n`);
}

function startBot() {
  if (bot) return;
  if (!process.env.MC_HOST) return log('sys', 'MC_HOST set nahi hai');
  const opts = {
    host: process.env.MC_HOST,
    port: +(process.env.MC_PORT || 25565),
    username: process.env.MC_USERNAME || 'RailBot',
    auth: process.env.MC_AUTH || 'offline',
  };
  if (process.env.MC_VERSION) opts.version = process.env.MC_VERSION;
  log('sys', `Connecting to ${opts.host}:${opts.port} as ${opts.username}`);
  const b = bot = mineflayer.createBot(opts);
  b.loadPlugin(pathfinder);
  b.loadPlugin(toolPlugin);
  b.once('spawn', () => {
    b.pathfinder.setMovements(new Movements(b));
    log('sys', 'Server me join ho gaya');
  });
  b.on('message', m => log('chat', m.toString()));
  b.on('death', () => log('sys', 'Bot mar gaya, respawn ho raha hai'));
  b.on('kicked', r => log('sys', 'Kicked: ' + (typeof r === 'string' ? r : JSON.stringify(r))));
  b.on('error', e => log('sys', 'Error: ' + e.message));
  b.on('end', () => {
    bot = null; mining = false; clearInterval(attackTimer); attackTimer = null;
    log('sys', 'Disconnected');
    if (wantOnline) setTimeout(startBot, 10000);
  });
}

const need = () => { if (!bot || !bot.entity) throw new Error('Bot online nahi hai'); return bot; };

async function mine(name, count) {
  const b = need();
  const def = b.registry.blocksByName[name];
  if (!def) throw new Error('Unknown block: ' + name);
  mining = true; let n = 0;
  log('sys', `Mining ${count} x ${name}`);
  while (mining && n < count && bot === b) {
    const blk = b.findBlock({ matching: def.id, maxDistance: 64 });
    if (!blk) { log('sys', `Paas me ${name} nahi mila`); break; }
    try {
      const p = blk.position;
      await b.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 3));
      await b.tool.equipForBlock(blk);
      await b.dig(blk);
      n++;
    } catch (e) { log('sys', 'Mine skip: ' + e.message); await new Promise(r => setTimeout(r, 500)); }
  }
  mining = false; log('sys', `Mining done: ${n}/${count}`);
}

function status() {
  if (!bot || !bot.entity) return { online: false };
  const p = bot.entity.position;
  return {
    online: true, username: bot.username, health: bot.health, food: bot.food,
    pos: [p.x, p.y, p.z].map(v => Math.round(v)),
    dimension: bot.game && bot.game.dimension,
    players: Object.keys(bot.players),
    inventory: bot.inventory.items().map(i => ({ name: i.name, count: i.count })),
    mining, attacking: !!attackTimer,
  };
}

const actions = {
  say: ({ text }) => need().chat(String(text).slice(0, 256)),
  goto: ({ x, y, z }) => need().pathfinder.setGoal(new goals.GoalBlock(+x, +y, +z)),
  follow: ({ player }) => {
    const e = need().players[player]?.entity;
    if (!e) throw new Error('Player paas me nahi hai');
    bot.pathfinder.setGoal(new goals.GoalFollow(e, 2), true);
  },
  stop: () => { mining = false; const b = need(); b.pathfinder.setGoal(null); b.clearControlStates(); },
  mine: ({ block, count }) => { mine(block, +count || 1).catch(e => log('sys', e.message)); },
  jump: () => { const b = need(); b.setControlState('jump', true); setTimeout(() => b.setControlState('jump', false), 300); },
  sneak: ({ on }) => need().setControlState('sneak', !!on),
  attack: ({ on }) => {
    const b = need(); clearInterval(attackTimer); attackTimer = null;
    if (!on) return;
    attackTimer = setInterval(() => {
      const t = b.nearestEntity(e => e.type === 'hostile' && e.position.distanceTo(b.entity.position) < 4);
      if (t) b.attack(t);
    }, 600);
  },
  equip: ({ item }) => {
    const it = need().inventory.items().find(i => i.name === item);
    if (!it) throw new Error('Item nahi mila');
    return bot.equip(it, 'hand');
  },
  drop: ({ item, count }) => {
    const it = need().inventory.items().find(i => i.name === item);
    if (!it) throw new Error('Item nahi mila');
    return bot.toss(it.type, null, +count || it.count);
  },
  use: () => need().activateItem(),
  lookat: ({ player }) => {
    const e = need().players[player]?.entity;
    if (!e) throw new Error('Player paas me nahi hai');
    return bot.lookAt(e.position.offset(0, 1.6, 0));
  },
  connect: () => { wantOnline = true; startBot(); },
  disconnect: () => { wantOnline = false; if (bot) bot.quit(); },
};

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) return next();
  const key = req.get('x-admin-password') || req.query.key;
  if (key !== PASS) return res.status(401).json({ error: 'Wrong password' });
  next();
});
app.use(express.static(__dirname + '/public'));
app.get('/api/status', (req, res) => res.json(status()));
app.get('/api/logs', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  logs.forEach(e => res.write(`data: ${JSON.stringify(e)}\n\n`));
  clients.add(res); req.on('close', () => clients.delete(res));
});
app.post('/api/action', async (req, res) => {
  const fn = actions[req.body.type];
  if (!fn) return res.status(400).json({ error: 'Unknown action' });
  try { await fn(req.body); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.listen(process.env.PORT || 3000, () => log('sys', 'Admin panel ready'));
startBot();
