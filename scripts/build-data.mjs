// Gera _site/ (index.html + data.js + data.json) para o GitHub Pages.
// Roda na GitHub Action a cada 15 min. O iPad (iOS 9) não abre as APIs de
// cotação direto, então ele só lê data.js do próprio site.
import { mkdir, writeFile, copyFile } from 'node:fs/promises';

const OUT = '_site';
const UA = { 'User-Agent': 'mini-setup-painel', Accept: 'application/json' };

async function safe(label, fn) {
  try { return await fn(); } catch (e) { console.warn(`⚠ ${label}: ${e.message}`); return null; }
}

async function json(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status} em ${url}`);
  return r.json();
}

// 1ª opção: CoinGecko (preço em BRL e USD + variação 24h)
async function coingecko() {
  const j = await json('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=brl,usd&include_24hr_change=true');
  const map = (c) => ({ brl: c.brl, usd: c.usd, chg: c.brl_24h_change ?? c.usd_24h_change ?? null });
  return { source: 'coingecko', btc: map(j.bitcoin), eth: map(j.ethereum) };
}

// reserva: Coinbase (só preço, sem variação)
async function coinbase() {
  const spot = async (pair) => Number((await json(`https://api.coinbase.com/v2/prices/${pair}/spot`)).data.amount);
  const [btcBrl, btcUsd, ethBrl, ethUsd] = await Promise.all(['BTC-BRL', 'BTC-USD', 'ETH-BRL', 'ETH-USD'].map(spot));
  return { source: 'coinbase', btc: { brl: btcBrl, usd: btcUsd, chg: null }, eth: { brl: ethBrl, usd: ethUsd, chg: null } };
}

await mkdir(OUT, { recursive: true });
await copyFile('index.html', `${OUT}/index.html`);

const crypto = (await safe('coingecko', coingecko)) || (await safe('coinbase', coinbase));
const data = { generatedAt: new Date().toISOString(), crypto: crypto ? { ...crypto, at: new Date().toISOString() } : null };

await writeFile(`${OUT}/data.json`, JSON.stringify(data));
await writeFile(`${OUT}/data.js`, `window.PAINEL_DATA = ${JSON.stringify(data)};\n`);
console.log(crypto
  ? `✓ ${crypto.source}: BTC R$ ${Math.round(crypto.btc.brl)} · ETH R$ ${Math.round(crypto.eth.brl)}`
  : '✗ nenhuma fonte de cotação respondeu');
