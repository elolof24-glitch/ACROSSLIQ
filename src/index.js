import { JsonRpcProvider, formatUnits, Interface } from 'ethers';

const env = {
  ARC_RPC_HTTP: process.env.ARC_RPC_HTTP || 'https://5042.rpc.thirdweb.com',
  ARC_EXPLORER_BASE: process.env.ARC_EXPLORER_BASE || 'https://arc-mainnet.cloud.blockscout.com',
  ARC_CHAIN_ID: Number(process.env.ARC_CHAIN_ID || '5042'),
  ARC_USDC: process.env.ARC_USDC || '0x3600000000000000000000000000000000000000',
  TARGET_WALLETS: splitCsv(process.env.TARGET_WALLETS),
  TARGET_CONTRACTS: splitCsv(process.env.TARGET_CONTRACTS),
  MIN_LIQUIDITY: BigInt(process.env.MIN_LIQUIDITY || '1'),
  POLL_INTERVAL_MS: Number(process.env.POLL_INTERVAL_MS || '4000'),
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || '',
  DISCORD_USERNAME: process.env.DISCORD_USERNAME || 'Arc LP Tracker',
  DISCORD_AVATAR_URL: process.env.DISCORD_AVATAR_URL || ''
};

function splitCsv(value = '') {
  return value.split(',').map(v => v.trim()).filter(Boolean);
}

function short(addr) {
  return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : 'n/a';
}

if (!env.DISCORD_WEBHOOK_URL) {
  console.error('Missing DISCORD_WEBHOOK_URL');
  process.exit(1);
}

const provider = new JsonRpcProvider(env.ARC_RPC_HTTP, {
  name: 'arc-mainnet',
  chainId: env.ARC_CHAIN_ID
});

const erc20 = new Interface([
  'function balanceOf(address) view returns (uint256)'
]);

const state = new Map();
let discordBackoffUntil = 0;

async function readUsdcBalance(address) {
  const data = erc20.encodeFunctionData('balanceOf', [address]);
  const result = await provider.call({ to: env.ARC_USDC, data });
  const [balance] = erc20.decodeFunctionResult('balanceOf', result);
  return balance;
}

async function fetchExplorerTokenTx(address) {
  const url = new URL(`${env.ARC_EXPLORER_BASE}/api`);
  url.searchParams.set('module', 'account');
  url.searchParams.set('action', 'tokentx');
  url.searchParams.set('contractaddress', env.ARC_USDC);
  url.searchParams.set('address', address);
  url.searchParams.set('sort', 'desc');

  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) return null;

  const json = await res.json();
  if (!json || !Array.isArray(json.result) || json.result.length === 0) return null;
  return json.result[0];
}

async function sendDiscord(payload) {
  const now = Date.now();
  if (now < discordBackoffUntil) return;

  const body = {
    username: env.DISCORD_USERNAME,
    ...(env.DISCORD_AVATAR_URL ? { avatar_url: env.DISCORD_AVATAR_URL } : {}),
    ...payload
  };

  const res = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after') || '2');
    discordBackoffUntil = Date.now() + Math.ceil(retryAfter * 1000);
    return;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('Discord webhook error', res.status, text);
  }
}

async function alertLiquidity(target, balance, previous, source, explorerTx = null) {
  const human = formatUnits(balance, 6);
  const prevHuman = previous === null ? '0' : formatUnits(previous, 6);

  const fields = [
    { name: 'Target', value: `\`${target}\``, inline: false },
    { name: 'Balance', value: `${human} USDC`, inline: true },
    { name: 'Previous', value: `${prevHuman} USDC`, inline: true },
    { name: 'Source', value: source, inline: true }
  ];

  if (explorerTx?.hash) {
    fields.push({
      name: 'Explorer TX',
      value: `[${short(explorerTx.hash)}](${env.ARC_EXPLORER_BASE}/tx/${explorerTx.hash})`,
      inline: false
    });
  }

  await sendDiscord({
    embeds: [
      {
        title: 'Arc liquidity update',
        description: `Liquidity detected on monitored Arc target ${short(target)}.`,
        color: 5763719,
        fields,
        timestamp: new Date().toISOString()
      }
    ]
  });
}

async function checkTarget(target) {
  try {
    const balance = await readUsdcBalance(target);
    const previous = state.has(target) ? state.get(target) : null;
    const changed = previous === null || balance !== previous;
    state.set(target, balance);

    if (balance >= env.MIN_LIQUIDITY && changed) {
      const explorerTx = await fetchExplorerTokenTx(target).catch(() => null);
      await alertLiquidity(target, balance, previous, 'rpc+explorer', explorerTx);
    }
  } catch (err) {
    console.error('checkTarget error', target, err?.message || err);
  }
}

async function tick() {
  const targets = [...new Set([...env.TARGET_WALLETS, ...env.TARGET_CONTRACTS])];

  if (targets.length === 0) {
    console.log('No targets configured yet. Add TARGET_WALLETS or TARGET_CONTRACTS.');
    return;
  }

  await Promise.all(targets.map(checkTarget));
}

async function boot() {
  console.log('Starting Arc Discord tracker');
  console.log('Chain ID:', env.ARC_CHAIN_ID);
  console.log('RPC:', env.ARC_RPC_HTTP);
  console.log('Explorer:', env.ARC_EXPLORER_BASE);
  console.log('Wallet targets:', env.TARGET_WALLETS.length);
  console.log('Contract targets:', env.TARGET_CONTRACTS.length);

  await sendDiscord({
    content: `Arc Discord tracker online on chain ${env.ARC_CHAIN_ID}. Monitoring ${env.TARGET_WALLETS.length + env.TARGET_CONTRACTS.length} targets.`
  });

  await tick();
  setInterval(tick, env.POLL_INTERVAL_MS);
}

boot().catch((err) => {
  console.error('Fatal boot error', err);
  process.exit(1);
});
