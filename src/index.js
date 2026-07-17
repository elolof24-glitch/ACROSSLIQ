import { JsonRpcProvider, formatUnits, Interface, id, zeroPadValue, getAddress } from 'ethers';

// ---- Env + config ----

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_TOPIC = zeroPadValue(ZERO_ADDRESS, 32);

const env = {
  RPC_URL: process.env.RPC_URL || process.env.ARC_RPC_HTTP || 'https://rpc.arc.network',
  ARC_CHAIN_ID: Number(process.env.ARC_CHAIN_ID || '5042'),
  USDC_ADDRESS: process.env.USDC_ADDRESS || process.env.ARC_USDC || '0x3600000000000000000000000000000000000000',

  TARGET_WALLETS: splitCsv(
    process.env.TARGET_WALLETS ||
      '0x837219D7a9C666F5542c4559Bf17D7B804E5c5fe,0x2B9CAc7a18C70cBB6F6639571785b70a41B8AE03,0x996267d7d1B7f5046543feDe2c2Db473Ed4f65e9,0xe767C1fCbeC2F9B3a229B82bBC8aa21baC09BDB4,0x4851ec4e5A5B392328b825ecD94aF1cA93Fd609e'
  ),

  TARGET_CONTRACTS: splitCsv(
    process.env.TARGET_CONTRACTS ||
      '0xd396CcB6770EAB84045c9Bce2939c478639E2A7F,0x9b4A302A548c7e313c2b74C461db7b84d3074A84,0xCA5f9960022078F3585a188e06F910eeC29c7eBD'
  ),

  MIN_LIQUIDITY: BigInt(process.env.MIN_LIQUIDITY || '1'),
  POLL_INTERVAL_MS: Number(process.env.POLL_INTERVAL_MS || '4000'),
  LOG_LOOKBACK_BLOCKS: Number(process.env.LOG_LOOKBACK_BLOCKS || '20'),
  SUPPLY_ALERT_MIN_DELTA: BigInt(process.env.SUPPLY_ALERT_MIN_DELTA || '1'),

  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || '',
  DISCORD_USERNAME: process.env.DISCORD_USERNAME || 'Arc USDC Tracker',
  DISCORD_AVATAR_URL: process.env.DISCORD_AVATAR_URL || ''
};

function splitCsv(value = '') {
  return value.split(',').map(v => v.trim()).filter(Boolean);
}

function short(addr) {
  return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : 'n/a';
}

function safeAddr(addr) {
  try {
    return getAddress(addr);
  } catch {
    return addr;
  }
}

if (!env.DISCORD_WEBHOOK_URL) {
  console.error('Missing DISCORD_WEBHOOK_URL');
  process.exit(1);
}

// ---- Provider & ABI ----

const provider = new JsonRpcProvider(env.RPC_URL, {
  name: 'arc-mainnet',
  chainId: env.ARC_CHAIN_ID
});

const erc20 = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'event Transfer(address indexed from, address indexed to, uint256 value)'
]);

const TRANSFER_TOPIC = id('Transfer(address,address,uint256)');

const state = {
  balances: new Map(),
  totalSupply: null,
  decimals: 6,
  lastCheckedBlock: null,
  seenLogs: new Set()
};

let discordBackoffUntil = 0;

// ---- RPC helpers ----

async function readUsdcBalance(address) {
  const data = erc20.encodeFunctionData('balanceOf', [address]);
  const result = await provider.call({ to: env.USDC_ADDRESS, data });
  const [balance] = erc20.decodeFunctionResult('balanceOf', result);
  return balance;
}

async function readTotalSupply() {
  const data = erc20.encodeFunctionData('totalSupply', []);
  const result = await provider.call({ to: env.USDC_ADDRESS, data });
  const [supply] = erc20.decodeFunctionResult('totalSupply', result);
  return supply;
}

async function readDecimals() {
  const data = erc20.encodeFunctionData('decimals', []);
  const result = await provider.call({ to: env.USDC_ADDRESS, data });
  const [decimals] = erc20.decodeFunctionResult('decimals', result);
  return Number(decimals);
}

function human(amount) {
  return formatUnits(amount, state.decimals);
}

// ---- Discord ----

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

async function alertLiquidity(target, balance, previous) {
  const prev = previous ?? 0n;
  const delta = balance - prev;

  await sendDiscord({
    embeds: [
      {
        title: 'Arc USDC liquidity update',
        description: `Balance change on monitored target ${short(target)}.`,
        color: 0x58a6ff,
        fields: [
          { name: 'Target', value: `\`${target}\``, inline: false },
          { name: 'Balance', value: `${human(balance)} USDC`, inline: true },
          { name: 'Previous', value: `${human(prev)} USDC`, inline: true },
          { name: 'Δ', value: `${human(delta)} USDC`, inline: true }
        ],
        timestamp: new Date().toISOString()
      }
    ]
  });
}

async function alertSupplyChange(current, previous) {
  const delta = current - previous;
  const color = delta >= 0n ? 0x22c55e : 0xef4444;

  await sendDiscord({
    embeds: [
      {
        title: 'Arc USDC supply changed',
        description: `USDC total supply changed on chain ${env.ARC_CHAIN_ID}.`,
        color,
        fields: [
          { name: 'Current', value: `${human(current)} USDC`, inline: true },
          { name: 'Previous', value: `${human(previous)} USDC`, inline: true },
          { name: 'Δ', value: `${human(delta)} USDC`, inline: true }
        ],
        timestamp: new Date().toISOString()
      }
    ]
  });
}

async function alertMintOrBurn(kind, from, to, value, txHash, blockNumber) {
  const isMint = kind === 'mint';

  await sendDiscord({
    embeds: [
      {
        title: isMint ? 'Arc USDC mint detected' : 'Arc USDC burn detected',
        description: isMint
          ? `USDC minted to ${short(to)}.`
          : `USDC burned from ${short(from)}.`,
        color: isMint ? 0x22c55e : 0xef4444,
        fields: [
          { name: 'Amount', value: `${human(value)} USDC`, inline: true },
          { name: isMint ? 'To' : 'From', value: `\`${isMint ? to : from}\``, inline: false },
          { name: 'Block', value: String(blockNumber), inline: true },
          { name: 'Tx', value: `\`${txHash}\``, inline: false }
        ],
        timestamp: new Date().toISOString()
      }
    ]
  });
}

// ---- Tracking ----

async function checkTarget(target) {
  try {
    const balance = await readUsdcBalance(target);
    const previous = state.balances.has(target) ? state.balances.get(target) : null;
    const changed = previous === null || balance !== previous;

    state.balances.set(target, balance);

    if (balance >= env.MIN_LIQUIDITY && changed) {
      await alertLiquidity(target, balance, previous);
    }
  } catch (err) {
    console.error('checkTarget error', target, err?.message || err);
  }
}

async function checkSupply() {
  try {
    const current = await readTotalSupply();

    if (state.totalSupply === null) {
      state.totalSupply = current;
      console.log('Initial USDC total supply:', human(current));
      return;
    }

    const previous = state.totalSupply;
    const deltaAbs = current >= previous ? current - previous : previous - current;

    if (deltaAbs >= env.SUPPLY_ALERT_MIN_DELTA && current !== previous) {
      await alertSupplyChange(current, previous);
    }

    state.totalSupply = current;
  } catch (err) {
    console.error('checkSupply error', err?.message || err);
  }
}

async function checkMintBurnLogs() {
  try {
    const latest = await provider.getBlockNumber();

    let fromBlock;
    if (state.lastCheckedBlock === null) {
      fromBlock = Math.max(0, latest - env.LOG_LOOKBACK_BLOCKS);
    } else {
      fromBlock = state.lastCheckedBlock + 1;
    }

    const toBlock = latest;
    if (fromBlock > toBlock) return;

    const logs = await provider.getLogs({
      address: env.USDC_ADDRESS,
      fromBlock,
      toBlock,
      topics: [TRANSFER_TOPIC]
    });

    for (const log of logs) {
      const key = `${log.transactionHash}:${log.index}`;
      if (state.seenLogs.has(key)) continue;
      state.seenLogs.add(key);

      let parsed;
      try {
        parsed = erc20.parseLog(log);
      } catch {
        continue;
      }

      const from = safeAddr(parsed.args.from);
      const to = safeAddr(parsed.args.to);
      const value = parsed.args.value;

      if (from === ZERO_ADDRESS) {
        await alertMintOrBurn('mint', from, to, value, log.transactionHash, log.blockNumber);
      } else if (to === ZERO_ADDRESS) {
        await alertMintOrBurn('burn', from, to, value, log.transactionHash, log.blockNumber);
      }
    }

    if (state.seenLogs.size > 5000) {
      state.seenLogs = new Set([...state.seenLogs].slice(-2000));
    }

    state.lastCheckedBlock = toBlock;
  } catch (err) {
    console.error('checkMintBurnLogs error', err?.message || err);
  }
}

async function tick() {
  const targets = [...new Set([...env.TARGET_WALLETS, ...env.TARGET_CONTRACTS])];

  if (targets.length === 0) {
    console.log('No targets configured yet. Add TARGET_WALLETS or TARGET_CONTRACTS.');
  } else {
    await Promise.all(targets.map(checkTarget));
  }

  await checkSupply();
  await checkMintBurnLogs();
}

// ---- Boot ----

async function boot() {
  console.log('Starting Arc USDC tracker');
  console.log('Chain ID:', env.ARC_CHAIN_ID);
  console.log('RPC:', env.RPC_URL);
  console.log('Wallet targets:', env.TARGET_WALLETS.length);
  console.log('Contract targets:', env.TARGET_CONTRACTS.length);

  state.decimals = await readDecimals();
  state.totalSupply = await readTotalSupply();
  state.lastCheckedBlock = await provider.getBlockNumber();

  await sendDiscord({
    content: `Arc USDC tracker online on chain ${env.ARC_CHAIN_ID}. Monitoring ${env.TARGET_WALLETS.length + env.TARGET_CONTRACTS.length} targets. Current supply: ${human(state.totalSupply)} USDC.`
  });

  await tick();
  setInterval(tick, env.POLL_INTERVAL_MS);
}

boot().catch((err) => {
  console.error('Fatal boot error', err);
  process.exit(1);
});
