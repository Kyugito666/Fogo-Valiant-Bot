import 'dotenv/config';
import axios from 'axios';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import FormData from 'form-data';
import sharp from 'sharp';
import UserAgents from 'user-agents';

import {
  Connection, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction, PublicKey
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  NATIVE_MINT,
  createInitializeAccountInstruction,
  createTransferCheckedInstruction,
  createCloseAccountInstruction,
  ACCOUNT_SIZE,
} from '@solana/spl-token';

import CryptoBotUI from './CryptoBotUI.js';


const RPC_URL = 'https://testnet.fogo.io/';
const VALIANT_API = 'https://api.valiant.trade/dex';
const EXPLORER_URL = 'https://fogoscan.com/tx/';
const OWNER_PROGRAM = TOKEN_PROGRAM_ID.toBase58(); 

const TOKENS = {
  FOGO: { name: 'SPL FOGO', ticker: 'FOGO', address: 'So11111111111111111111111111111111111111112', decimals: 9 },
  FUSD: { name: 'FOGO USD', ticker: 'FUSD', address: 'fUSDNGgHkZfwckbr5RLLvRbvqvRcTLdH9hcHJiq4jry', decimals: 6 },
  USDT: { name: 'USD TOKEN', ticker: 'USDT', address: '7fc38fbxd1q7gC5WqfauwdVME7ms64VGypyoHaTnLUAt', decimals: 6 },
  USDC: { name: 'USD COIN', ticker: 'USDC', address: 'ELNbJ1RtERV2fjtuZjbTscDekWhVzkQ1LjmiPsxp5uND', decimals: 6 },
};


const ALLOWED_MINTS = new Set([
  TOKENS.FOGO.address,
  TOKENS.FUSD.address,
  TOKENS.USDT.address,
  TOKENS.USDC.address,
]);


const ui = new CryptoBotUI({
  title: 'FOGO Testnet — Valiant Bot',
  menuItems: [
    '1) Random Trade',
    '2) Random Add Position',
    '3) Deploy Token Contract',
    '4) Run All Features',
    '5) Wrap FOGO ? SPL FOGO',
    '6) Unwrap SPL FOGO ? FOGO',
    '7) Exit'
  ],
  tickerText1: 'FOGO TESTNET',
  tickerText2: 'Invictuslabs - Airdrops',
  mirrorConsole: false
});


const leBufferToBigInt = (buf) => {
  let n = 0n;
  for (let i = 0; i < buf.length; i++) n += BigInt(buf[i]) << (8n * BigInt(i));
  return n;
};
function formatUiAmount(rawBig, decimals, maxFrac = 9) {
  const D = 10n ** BigInt(decimals);
  const int = rawBig / D;
  const frac = rawBig % D;
  if (frac === 0n) return int.toString();
  let fracStr = frac.toString().padStart(decimals, '0');
  if (decimals > maxFrac) fracStr = fracStr.slice(0, maxFrac);
  fracStr = fracStr.replace(/0+$/, '');
  return `${int.toString()}.${fracStr || '0'}`;
}


class Bot {
  constructor() {
    this.connection = new Connection(RPC_URL, { commitment: 'confirmed', disableRetryOnRateLimit: false });
    this.headers = {};
    this.ua = new UserAgents().toString();

    this.tradeCount = 0;
    this.positionCount = 0;
    this.deployCount = 0;

    this.amount = {
      trade: { FOGO: 0, FUSD: 0, USDT: 0, USDC: 0 },
      position: { FOGO: 0, FUSD: 0, USDT: 0 },
      wrap: 0,
      unwrap: 0
    };
    this.delay = { min: 0, max: 0 };

    this.kp = null;
    this.signingKey = null;
    this.publicKey = null;

    
    this.tokenAccounts = new Map(); 
    this.mintDecimals = new Map();  
    this.subId = null;

    
    this.pollHandle = null;

    
    this._txCountCache = { value: 0, lastAt: 0 };

    
    this.mintDecimals.set(TOKENS.FOGO.address, TOKENS.FOGO.decimals);
    this.mintDecimals.set(TOKENS.FUSD.address, TOKENS.FUSD.decimals);
    this.mintDecimals.set(TOKENS.USDT.address, TOKENS.USDT.decimals);
    this.mintDecimals.set(TOKENS.USDC.address, TOKENS.USDC.decimals);
  }

  log(type, msg) { ui.log(type, msg); }

  async init() {
    const priv = process.env.PRIVATE_KEY;
    if (!priv) {
      this.log('error', 'PRIVATE_KEY missing in .env');
      process.exit(1);
    }
    const { kp, signingKey, publicKey } = this.generateWallet(priv);
    if (!kp || !signingKey || !publicKey) {
      this.log('error', 'Invalid PRIVATE_KEY (base58 64-byte secretKey required)');
      process.exit(1);
    }
    this.kp = kp; this.signingKey = signingKey; this.publicKey = publicKey;

    this.headers[publicKey] = {
      'Accept': '*/*',
      'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      'Origin': 'https://valiant.trade',
      'Referer': 'https://valiant.trade/',
      'User-Agent': this.ua
    };

    
    await this.loadInitialTokens();           
    await this.refreshBalancesUI();           

    
    await this.startTokenSubscription();

    
    this.pollHandle = setInterval(() => this.loadInitialTokens().catch(()=>{}), 4000);

    
    ui.on('menu:select', async (_, idx) => {
      const pick = idx + 1;
      if (pick === 7) ui.destroy(0);
      try {
        await this.handleMenu(pick);
      } catch (e) {
        this.log('error', e.message || String(e));
      }
    });

    
    setInterval(() => this.refreshBalancesUI().catch(()=>{}), 2000);
  }

  
  async fogoLamports(addr) {
    const payload = { jsonrpc: '2.0', method: 'getBalance', params: [addr, { commitment: 'finalized' }], id: 1 };
    const res = await axios.post(RPC_URL, payload, { validateStatus: () => true });
    return Number(res.data?.result?.value || 0);
  }

  async getAllTokenAccountsParsed(addr) {
    const payload = {
      jsonrpc: '2.0',
      method: 'getTokenAccountsByOwner',
      params: [addr, { programId: OWNER_PROGRAM }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
      id: 1
    };
    const res = await axios.post(RPC_URL, payload, { validateStatus: () => true });
    const accounts = res.data?.result?.value || [];
    return accounts;
  }

  
  async txCountAll(address, maxTotal = 20000) {
    let before = null;
    let total = 0;
    while (true) {
      const body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignaturesForAddress',
        params: [address, { limit: 1000, ...(before ? { before } : {}) }]
      };
      const res = await axios.post(RPC_URL, body, { validateStatus: () => true });
      const arr = res.data?.result || [];
      total += arr.length;

      if (arr.length < 1000) break;
      before = arr[arr.length - 1].signature;
      if (total >= maxTotal) break;
    }
    return total;
  }
  async getTxCountCached(address) {
    const now = Date.now();
    if (now - this._txCountCache.lastAt < 30000 && this._txCountCache.value >= 0) {
      return this._txCountCache.value;
    }
    const n = await this.txCountAll(address).catch(() => this._txCountCache.value || 0);
    this._txCountCache = { value: n, lastAt: Date.now() };
    return n;
  }

  
  async loadInitialTokens() {
    const owner = this.publicKey;
    if (!owner) return;

    const list = await this.getAllTokenAccountsParsed(owner);
    this.tokenAccounts.clear();

    for (const it of list) {
      try {
        const pubkey = it.pubkey;
        const info = it.account.data.parsed.info;
        const mint = info.mint;
        if (!ALLOWED_MINTS.has(mint)) continue; 

        const amtStr = info.tokenAmount.amount; 
        const raw = BigInt(amtStr);
        this.tokenAccounts.set(pubkey, { mint, amountRaw: raw });

        if (!this.mintDecimals.has(mint)) {
          const d = Number(info.tokenAmount.decimals || 0);
          this.mintDecimals.set(mint, d);
        }
      } catch {}
    }

    this.updateTokensUI();
  }

  async startTokenSubscription() {
    if (this.subId != null) {
      try { await this.connection.removeProgramAccountChangeListener(this.subId); } catch {}
      this.subId = null;
    }
    const owner = new PublicKey(this.publicKey);

    try {
      this.subId = await this.connection.onProgramAccountChange(
        TOKEN_PROGRAM_ID,
        async ({ accountId, accountInfo }) => {
          try {
            const data = accountInfo.data;
            const mint = new PublicKey(data.subarray(0, 32)).toBase58();
            const ownerPk = new PublicKey(data.subarray(32, 64)).toBase58();
            if (ownerPk !== this.publicKey) return;
            if (!ALLOWED_MINTS.has(mint)) return; 

            const amountRaw = leBufferToBigInt(data.subarray(64, 72));
            this.tokenAccounts.set(accountId.toBase58(), { mint, amountRaw });

            this.updateTokensUI();
          } catch (e) {
            this.log('warning', `WS parse error: ${e.message}`);
          }
        },
        'confirmed',
        [
          { dataSize: 165 },
          { memcmp: { offset: 32, bytes: owner.toBase58() } }
        ]
      );
      this.log('info', 'Realtime token subscription aktif (filtered)');
    } catch (e) {
      this.log('warning', `Gagal start WS subscription: ${e.message}`);
    }
  }

  updateTokensUI() {
    
    const totals = new Map(); 
    for (const { mint, amountRaw } of this.tokenAccounts.values()) {
      totals.set(mint, (totals.get(mint) || 0n) + amountRaw);
    }

    
    const ORDER = [
      { mint: TOKENS.FOGO.address, name: TOKENS.FOGO.name, symbol: TOKENS.FOGO.ticker },
      { mint: TOKENS.FUSD.address, name: TOKENS.FUSD.name, symbol: TOKENS.FUSD.ticker },
      { mint: TOKENS.USDT.address, name: TOKENS.USDT.name, symbol: TOKENS.USDT.ticker },
      { mint: TOKENS.USDC.address, name: TOKENS.USDC.name, symbol: TOKENS.USDC.ticker },
    ];

    const items = ORDER.map(({ mint, name, symbol }) => {
      const raw = totals.get(mint) || 0n;
      const dec = this.mintDecimals.get(mint) ?? 0;
      return {
        key: mint,
        enabled: true,
        name,
        symbol,
        balance: formatUiAmount(raw, dec, 9),
        amtRaw: raw,
        decimals: dec
      };
    });

    ui.setTokens(items); 
  }

  async refreshBalancesUI() {
    const addr = this.publicKey;
    if (!addr) return;

    const [fogo, txCount] = await Promise.all([
      this.fogoLamports(addr),
      this.getTxCountCached(addr)
    ]);

    ui.updateWallet({
      address: addr,
      nativeBalance: (fogo / 1e9).toFixed(9),
      network: 'FOGO Testnet',
      gasPrice: '-',               
      nonce: String(txCount)       
    });
  }

  
  generateWallet(base58Secret) {
    try {
      const secret = bs58.decode(base58Secret);
      const kp = Keypair.fromSecretKey(Uint8Array.from(secret)); 
      const pubKey = kp.publicKey.toBase58();
      const seed32 = secret.slice(0, 32);
      const keyPair = nacl.sign.keyPair.fromSeed(Uint8Array.from(seed32));
      return { kp, signingKey: keyPair.secretKey, publicKey: pubKey };
    } catch {
      return { kp: null, signingKey: null, publicKey: null };
    }
  }
  signSerializedBase64(serializedBase64, sigIndex) {
    try {
      const tx = Buffer.from(serializedBase64, 'base64');
      const num = tx[0];
      if (sigIndex < 0 || sigIndex >= num) throw new Error(`sigIndex ${sigIndex} out of range`);
      const msgOffset = 1 + 64 * num;
      const message = tx.slice(msgOffset);
      const sig = nacl.sign.detached(message, this.signingKey);
      Buffer.from(sig).copy(tx, 1 + 64 * sigIndex);
      return tx.toString('base64');
    } catch (e) {
      this.log('error', `Sign error: ${e.message}`);
      return null;
    }
  }

  
  async httpGet(url) {
    const res = await axios.get(url, {
      headers: { 'User-Agent': this.ua, 'Accept': '*/*' },
      timeout: 120000, validateStatus: () => true
    });
    if (res.status>=200 && res.status<300) return res.data;
    throw new Error(`GET ${res.status}`);
  }
  async httpPost(url, body, headers = {}) {
    const res = await axios.post(url, body, {
      headers, timeout: 120000, validateStatus: () => true
    });
    if (res.status>=200 && res.status<300) return res.data;
    throw new Error(`POST ${res.status}`);
  }
  async rpc(body) {
    const res = await axios.post(RPC_URL, body, {
      headers: { 'Content-Type':'application/json' },
      timeout: 120000, validateStatus: () => true
    });
    if (res.status>=200 && res.status<300) return res.data;
    throw new Error(`RPC ${res.status}`);
  }
  async getQuote(fromMint, toMint, inputAmount) {
    const url = `${VALIANT_API}/twoHopQuote?inputMint=${fromMint}&outputMint=${toMint}&isExactIn=true&inputAmount=${inputAmount}`;
    return this.httpGet(url);
  }
  buildTwoHopUrl(address, quote, slippageBps = 100) {
    const tokenIn = Number(quote.tokenIn);
    const tokenEstOut = Number(quote.tokenEstOut);
    const minOut = Math.floor(tokenEstOut * (10000 - slippageBps) / 10000);
    const params = new URLSearchParams({
      userAddress: address, isExactIn: 'true',
      inputAmount: String(tokenIn),
      outputAmount: String(minOut),
      sessionAddress: address, feePayer: address
    });
    for (const r of quote.quote.route) params.append('route', r);
    for (const p of quote.quote.pools) params.append('pools', p);
    return `${VALIANT_API}/txs/twoHopSwap?${params}`;
  }
  async getTradeTxs(url) { return this.httpGet(url); }
  async getNewPosition(address, mintA, mintB, tick, amountA) {
    const url = `${VALIANT_API}/txs/newPosition?userAddress=${address}&mintA=${mintA}&mintB=${mintB}&amountA=${amountA}&slippageToleranceBps=0&tickSpacing=${tick}&feePayer=${address}&sessionAddress=${address}`;
    return this.httpGet(url);
  }
  async sendTransactionBase64(b64) {
    const payload = { jsonrpc:'2.0', method:'sendTransaction', params:[b64, {encoding:'base64', skipPreflight:true}], id: 1 };
    return this.rpc(payload);
  }
  async statusTx(sig) {
    const payload = { jsonrpc:'2.0', method:'getSignatureStatuses', params:[[sig]], id: 1 };
    return this.rpc(payload);
  }

  
  async countdownDelay() {
    const min = this.delay.min || 0;
    const max = Math.max(this.delay.max || 0, min);
    const seconds = Math.floor(Math.random()*(max - min + 1)) + min;
    if (seconds > 0) await ui.countdown(seconds*1000, 'Next Tx Delay');
  }
  randomTradePair() {
    const P = [
      [TOKENS.FOGO, TOKENS.FUSD, this.amount.trade.FOGO],
      [TOKENS.FOGO, TOKENS.USDT, this.amount.trade.FOGO],
      [TOKENS.FOGO, TOKENS.USDC, this.amount.trade.FOGO],
      [TOKENS.FUSD, TOKENS.FOGO, this.amount.trade.FUSD],
      [TOKENS.FUSD, TOKENS.USDT, this.amount.trade.FUSD],
      [TOKENS.FUSD, TOKENS.USDC, this.amount.trade.FUSD],
      [TOKENS.USDT, TOKENS.FOGO, this.amount.trade.USDT],
      [TOKENS.USDT, TOKENS.FUSD, this.amount.trade.USDT],
      [TOKENS.USDT, TOKENS.USDC, this.amount.trade.USDT],
      [TOKENS.USDC, TOKENS.FOGO, this.amount.trade.USDC],
      [TOKENS.USDC, TOKENS.FUSD, this.amount.trade.USDC],
      [TOKENS.USDC, TOKENS.USDT, this.amount.trade.USDC],
    ];
    return P[Math.floor(Math.random()*P.length)];
  }
  randomPositionPair() {
    const P = [
      [TOKENS.FOGO, TOKENS.FUSD, 64, this.amount.position.FOGO],
      [TOKENS.FOGO, TOKENS.USDT, 64, this.amount.position.FOGO],
      [TOKENS.FOGO, TOKENS.USDC, 64, this.amount.position.FOGO],
      [TOKENS.FUSD, TOKENS.USDT, 1,  this.amount.position.FUSD],
      [TOKENS.FUSD, TOKENS.USDC, 1,  this.amount.position.FUSD],
      [TOKENS.USDT, TOKENS.USDC, 1,  this.amount.position.USDT],
    ];
    return P[Math.floor(Math.random()*P.length)];
  }
  async buildLogoJpeg(name, symbol) {
    const bg = ['#111827','#1f2937','#0f766e','#1d4ed8','#6d28d9','#be123c'][Math.floor(Math.random()*6)];
    const svg = `
      <svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${bg}" /><stop offset="100%" stop-color="#111111" />
        </linearGradient></defs>
        <rect width="512" height="512" fill="url(#g)"/>
        <circle cx="256" cy="256" r="200" fill="#ffffff22"/><circle cx="256" cy="256" r="150" fill="#ffffff22"/>
        <text x="50%" y="48%" text-anchor="middle" font-family="Montserrat,Arial" font-size="72" fill="#fff" font-weight="700">${symbol}</text>
        <text x="50%" y="61%" text-anchor="middle" font-family="Montserrat,Arial" font-size="28" fill="#ffffffcc">${name}</text>
      </svg>`;
    const svgBuf = Buffer.from(svg);
    let quality = 85;
    let jpeg = await sharp(svgBuf).jpeg({ quality, mozjpeg: true }).toBuffer();
    while (jpeg.length > 200*1024 && quality > 25) {
      quality -= 5;
      jpeg = await sharp(svgBuf).jpeg({ quality, mozjpeg: true }).toBuffer();
    }
    return jpeg;
  }

  
  async doTradeOnce() {
    const [from, to, amountUi] = this.randomTradePair();
    const amount = Math.trunc(amountUi * (10 ** from.decimals));
    ui.log('swap', `Quote ${from.ticker}?${to.ticker} amount ${amountUi}`);

    const quote = await this.getQuote(from.address, to.address, amount);
    const url = this.buildTwoHopUrl(this.publicKey, quote);
    const txObj = await this.getTradeTxs(url);

    const serialized = String(txObj.serializedTx || '');
    const signed = this.signSerializedBase64(serialized, 0);
    if (!signed) { ui.updateStats({ failedTx: ++ui.failedTx }); ui.log('failed','Sign failed'); return; }

    ui.updateStats({ pendingTx: ++ui.pendingTx });
    const stopTimer = ui.startTimer('Trading');
    const sent = await this.sendTransactionBase64(signed).catch(e => ({ error: { message: e.message } }));
    stopTimer();

    if (sent.result) {
      const sig = sent.result;
      ui.log('success', `Tx: ${sig}`);
      ui.log('info', `Explorer: ${EXPLORER_URL}${sig}`);
      ui.updateStats({ transactionCount: ++ui.transactionCount });
      await this.waitStatus(sig);
      this._txCountCache.lastAt = 0; 
    } else {
      ui.log('failed', sent.error?.message || 'Unknown error');
      ui.updateStats({ failedTx: ++ui.failedTx });
    }
    ui.updateStats({ pendingTx: Math.max(0, ui.pendingTx - 1) });
    await this.refreshBalancesUI();
    await this.countdownDelay();
  }

  async doPositionOnce() {
    const [a, b, tick, amountUi] = this.randomPositionPair();
    const amount = Math.trunc(amountUi * (10 ** a.decimals));
    ui.log('liquidity', `New position ${a.ticker}/${b.ticker} tick=${tick} amt=${amountUi}`);

    const txObj = await this.getNewPosition(this.publicKey, a.address, b.address, tick, amount);
    const serialized = String(txObj.serializedTx || '');

    const signed = this.signSerializedBase64(serialized, 0);
    if (!signed) { ui.updateStats({ failedTx: ++ui.failedTx }); ui.log('failed','Sign failed'); return; }

    ui.updateStats({ pendingTx: ++ui.pendingTx });
    const stopTimer = ui.startTimer('Adding Liquidity');
    const sent = await this.sendTransactionBase64(signed).catch(e => ({ error: { message: e.message } }));
    stopTimer();

    if (sent.result) {
      const sig = sent.result;
      ui.log('success', `Tx: ${sig}`);
      ui.log('info', `Explorer: ${EXPLORER_URL}${sig}`);
      ui.updateStats({ transactionCount: ++ui.transactionCount });
      await this.waitStatus(sig);
      this._txCountCache.lastAt = 0;
    } else {
      ui.log('failed', sent.error?.message || 'Unknown error');
      ui.updateStats({ failedTx: ++ui.failedTx });
    }
    ui.updateStats({ pendingTx: Math.max(0, ui.pendingTx - 1) });
    await this.refreshBalancesUI();
    await this.countdownDelay();
  }

  async doDeployOnce() {
    const presets = [
      ['Token','TKN'], ['MyToken','MTK'], ['NewToken','NTK'], ['CryptoCoin','CRC'],
      ['SmartToken','SMT'], ['MetaCoin','MTC'], ['ChainToken','CTK'], ['BlockCoin','BKC'],
      ['FutureToken','FUT'], ['GalaxyCoin','GLX'], ['QuantumToken','QTK'], ['StarCoin','STR'],
      ['HyperToken','HPT'], ['NovaCoin','NVC'], ['PulseToken','PLT'], ['OrbitCoin','ORC'],
      ['UnityToken','UNT'], ['PrimeCoin','PMC'], ['AeroToken','AET'], ['LunaCoin','LNC'],
    ];
    const [n, s] = presets[Math.floor(Math.random()*presets.length)];
    const serial = String(Math.floor(Math.random()*1e6));
    const tokenName = n+serial, tokenSymbol = s+serial;
    const supplies = [100000000, 1000000000, 10000000000];
    const raw = supplies[Math.floor(Math.random()*supplies.length)];
    const initialSupply = String(BigInt(raw) * BigInt(10 ** 9));
    const jpeg = await this.buildLogoJpeg(tokenName, tokenSymbol);

    const presign = await this.httpPost(`${VALIANT_API}/getPresignedUrl`, null, { 'Content-Length':'0' });
    const fd = new FormData();
    fd.append('file', jpeg, { filename: 'my_token.jpeg', contentType: 'image/jpeg' });
    fd.append('network','public');
    const up = await this.httpPost(presign.url, fd, fd.getHeaders());
    const cid = up?.data?.cid || up?.cid || up?.data?.IpfsHash || '';

    const mintKey = nacl.sign.keyPair();
    const mintPub58 = bs58.encode(Buffer.from(mintKey.publicKey));

    ui.log('pending', `Deploy token ${tokenName} (${tokenSymbol})`);
    const body = JSON.stringify({
      newTokenTransactionDetails: {
        name: tokenName, symbol: tokenSymbol, description: '',
        image: `https://ipfs.io/ipfs/${cid}`, decimals: 9, initialSupply,
        userAddress: this.publicKey, website: 'https://valiant.com', mint: mintPub58
      }
    });
    const deployTx = await this.httpPost(`${VALIANT_API}/txs/newToken`, body, {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)
    });

    const serialized = String(deployTx.serializedTx || '');
    const signed = (() => {
      try {
        const tx = Buffer.from(serialized, 'base64');
        const num = tx[0];
        const msgOffset = 1 + 64 * num;
        const message = tx.slice(msgOffset);
        const sig = nacl.sign.detached(message, mintKey.secretKey);
        Buffer.from(sig).copy(tx, 1 + 64 * 1);
        return tx.toString('base64');
      } catch (e) {
        ui.log('failed', `Sign error: ${e.message}`);
        return null;
      }
    })();
    if (!signed) { ui.updateStats({ failedTx: ++ui.failedTx }); return; }

    ui.updateStats({ pendingTx: ++ui.pendingTx });
    const stopTimer = ui.startTimer('Deploy Token');
    const sent = await this.sendTransactionBase64(signed).catch(e => ({ error: { message: e.message } }));
    stopTimer();

    if (sent.result) {
      const sig = sent.result;
      ui.log('success', `Tx: ${sig}`);
      ui.log('info', `Explorer: ${EXPLORER_URL}${sig}`);
      ui.updateStats({ transactionCount: ++ui.transactionCount });
      await this.waitStatus(sig);
      this._txCountCache.lastAt = 0;
    } else {
      ui.log('failed', sent.error?.message || 'Unknown error');
      ui.updateStats({ failedTx: ++ui.failedTx });
    }
    ui.updateStats({ pendingTx: Math.max(0, ui.pendingTx - 1) });
    await this.refreshBalancesUI();
    await this.countdownDelay();
  }

  async waitStatus(signature) {
    for (let i=0;i<5;i++) {
      const r = await this.statusTx(signature).catch(()=>null);
      const val = r?.result?.value?.[0];
      if (val) {
        const st = String(val.confirmationStatus || 'unknown').toUpperCase();
        ui.log('info', `Status: ${st}`);
        break;
      }
      await new Promise(r=>setTimeout(r,3000));
    }
  }

  
  async wrapFOGO(amountUi) {
    const owner = this.kp.publicKey;
    const lamports = Math.floor(amountUi * 1e9);

    const rent = await this.connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
    const temp = Keypair.generate();
    const ata = await getOrCreateAssociatedTokenAccount(this.connection, this.kp, NATIVE_MINT, owner);

    const tx = new Transaction().add(
      SystemProgram.createAccount({ fromPubkey: owner, newAccountPubkey: temp.publicKey, lamports: rent + lamports, space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeAccountInstruction(temp.publicKey, NATIVE_MINT, owner, TOKEN_PROGRAM_ID),
      createTransferCheckedInstruction(temp.publicKey, NATIVE_MINT, ata.address, owner, lamports, 9, [], TOKEN_PROGRAM_ID),
      createCloseAccountInstruction(temp.publicKey, owner, owner, [], TOKEN_PROGRAM_ID)
    );

    ui.updateStats({ pendingTx: ++ui.pendingTx });
    const stopTimer = ui.startTimer('Wrapping');
    const sig = await sendAndConfirmTransaction(this.connection, tx, [this.kp, temp], { commitment: 'finalized' }).catch(e => { ui.log('failed', e.message); return null; });
    stopTimer();

    if (sig) {
      ui.log('success', `Wrap Tx: ${sig}`);
      ui.log('info', `Explorer: ${EXPLORER_URL}${sig}`);
      ui.updateStats({ transactionCount: ++ui.transactionCount });
      this._txCountCache.lastAt = 0;
    } else {
      ui.updateStats({ failedTx: ++ui.failedTx });
    }
    ui.updateStats({ pendingTx: Math.max(0, ui.pendingTx - 1) });
    await this.refreshBalancesUI();
  }

  async unwrapFOGO(amountUi) {
    const owner = this.kp.publicKey;
    const lamports = Math.floor(amountUi * 1e9);

    const ata = await getOrCreateAssociatedTokenAccount(this.connection, this.kp, NATIVE_MINT, owner);
    const rent = await this.connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
    const temp = Keypair.generate();

    const tx = new Transaction().add(
      SystemProgram.createAccount({ fromPubkey: owner, newAccountPubkey: temp.publicKey, lamports: rent, space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeAccountInstruction(temp.publicKey, NATIVE_MINT, owner, TOKEN_PROGRAM_ID),
      createTransferCheckedInstruction(ata.address, NATIVE_MINT, temp.publicKey, owner, lamports, 9, [], TOKEN_PROGRAM_ID),
      createCloseAccountInstruction(temp.publicKey, owner, owner, [], TOKEN_PROGRAM_ID)
    );

    ui.updateStats({ pendingTx: ++ui.pendingTx });
    const stopTimer = ui.startTimer('Unwrapping');
    const sig = await sendAndConfirmTransaction(this.connection, tx, [this.kp, temp], { commitment: 'finalized' }).catch(e => { ui.log('failed', e.message); return null; });
    stopTimer();

    if (sig) {
      ui.log('success', `Unwrap Tx: ${sig}`);
      ui.log('info', `Explorer: ${EXPLORER_URL}${sig}`);
      ui.updateStats({ transactionCount: ++ui.transactionCount });
      this._txCountCache.lastAt = 0;
    } else {
      ui.updateStats({ failedTx: ++ui.failedTx });
    }
    ui.updateStats({ pendingTx: Math.max(0, ui.pendingTx - 1) });
    await this.refreshBalancesUI();
  }

  
  async handleMenu(pick) {
    if (pick === 1) {
      const count = await ui.promptNumber('Trade Count', String(this.tradeCount || 1));
      const fogo = await ui.promptNumber('Trade Amount [FOGO]', String(this.amount.trade.FOGO || 0.0001));
      const fusd = await ui.promptNumber('Trade Amount [FUSD]', String(this.amount.trade.FUSD || 0.0001));
      const usdt = await ui.promptNumber('Trade Amount [USDT]', String(this.amount.trade.USDT || 0.0001));
      const usdc = await ui.promptNumber('Trade Amount [USDC]', String(this.amount.trade.USDC || 0.0001));
      const dmin = await ui.promptNumber('Min Delay Each Tx (sec)', String(this.delay.min || 2));
      const dmax = await ui.promptNumber('Max Delay Each Tx (sec)', String(this.delay.max || 4));

      if ([count,fogo,fusd,usdt,usdc,dmin,dmax].some(v => v==null)) return;
      this.tradeCount = Math.max(1, Math.floor(count));
      this.amount.trade = { FOGO:fogo, FUSD:fusd, USDT:usdt, USDC:usdc };
      this.delay = { min:Math.max(0,Math.floor(dmin)), max:Math.max(0,Math.floor(dmax)) };

      ui.setActive(true);
      for (let i=0;i<this.tradeCount;i++) await this.doTradeOnce().catch(e=>ui.log('failed', e.message));
      ui.setActive(false);
    }

    if (pick === 2) {
      const count = await ui.promptNumber('Add Position Count', String(this.positionCount || 1));
      const fogo = await ui.promptNumber('Position Amount [FOGO]', String(this.amount.position.FOGO || 0.0001));
      const fusd = await ui.promptNumber('Position Amount [FUSD]', String(this.amount.position.FUSD || 0.001));
      const usdt = await ui.promptNumber('Position Amount [USDT]', String(this.amount.position.USDT || 0.001));
      const dmin = await ui.promptNumber('Min Delay Each Tx (sec)', String(this.delay.min || 2));
      const dmax = await ui.promptNumber('Max Delay Each Tx (sec)', String(this.delay.max || 4));
      if ([count,fogo,fusd,usdt,dmin,dmax].some(v => v==null)) return;

      this.positionCount = Math.max(1, Math.floor(count));
      this.amount.position = { FOGO:fogo, FUSD:fusd, USDT:usdt };
      this.delay = { min:Math.max(0,Math.floor(dmin)), max:Math.max(0,Math.floor(dmax)) };

      ui.setActive(true);
      for (let i=0;i<this.positionCount;i++) await this.doPositionOnce().catch(e=>ui.log('failed', e.message));
      ui.setActive(false);
    }

    if (pick === 3) {
      const count = await ui.promptNumber('Deploy Token Count', String(this.deployCount || 1));
      const dmin = await ui.promptNumber('Min Delay Each Tx (sec)', String(this.delay.min || 2));
      const dmax = await ui.promptNumber('Max Delay Each Tx (sec)', String(this.delay.max || 4));
      if ([count,dmin,dmax].some(v=>v==null)) return;
      this.deployCount = Math.max(1, Math.floor(count));
      this.delay = { min:Math.max(0,Math.floor(dmin)), max:Math.max(0,Math.floor(dmax)) };

      ui.setActive(true);
      for (let i=0;i<this.deployCount;i++) await this.doDeployOnce().catch(e=>ui.log('failed', e.message));
      ui.setActive(false);
    }

    if (pick === 4) {
      const tcount = await ui.promptNumber('Trade Count', String(this.tradeCount || 1));
      const fogo = await ui.promptNumber('Trade Amount [FOGO]', String(this.amount.trade.FOGO || 0.0001));
      const fusd = await ui.promptNumber('Trade Amount [FUSD]', String(this.amount.trade.FUSD || 0.0001));
      const usdt = await ui.promptNumber('Trade Amount [USDT]', String(this.amount.trade.USDT || 0.0001));
      const usdc = await ui.promptNumber('Trade Amount [USDC]', String(this.amount.trade.USDC || 0.0001));
      const pcount = await ui.promptNumber('Add Position Count', String(this.positionCount || 1));
      const pfogo = await ui.promptNumber('Position Amount [FOGO]', String(this.amount.position.FOGO || 0.0001));
      const pfusd = await ui.promptNumber('Position Amount [FUSD]', String(this.amount.position.FUSD || 0.001));
      const pusdt = await ui.promptNumber('Position Amount [USDT]', String(this.amount.position.USDT || 0.001));
      const dcount = await ui.promptNumber('Deploy Token Count', String(this.deployCount || 1));
      const dmin = await ui.promptNumber('Min Delay Each Tx (sec)', String(this.delay.min || 2));
      const dmax = await ui.promptNumber('Max Delay Each Tx (sec)', String(this.delay.max || 4));

      if ([tcount,fogo,fusd,usdt,usdc,pcount,pfogo,pfusd,pusdt,dcount,dmin,dmax].some(v=>v==null)) return;

      this.tradeCount = Math.max(1, Math.floor(tcount));
      this.amount.trade = { FOGO:fogo, FUSD:fusd, USDT:usdt, USDC:usdc };
      this.positionCount = Math.max(1, Math.floor(pcount));
      this.amount.position = { FOGO:pfogo, FUSD:pfusd, USDT:pusdt };
      this.deployCount = Math.max(1, Math.floor(dcount));
      this.delay = { min:Math.max(0,Math.floor(dmin)), max:Math.max(0,Math.floor(dmax)) };

      ui.setActive(true);
      for (let i=0;i<this.tradeCount;i++) await this.doTradeOnce().catch(e=>ui.log('failed', e.message));
      for (let i=0;i<this.positionCount;i++) await this.doPositionOnce().catch(e=>ui.log('failed', e.message));
      for (let i=0;i<this.deployCount;i++) await this.doDeployOnce().catch(e=>ui.log('failed', e.message));
      ui.setActive(false);
    }

    if (pick === 5) {
      const amt = await ui.promptNumber('Amount of FOGO to Wrap', String(this.amount.wrap || 0.01));
      if (amt==null || !(amt>0)) return;
      this.amount.wrap = amt;
      await this.wrapFOGO(amt);
    }

    if (pick === 6) {
      const amt = await ui.promptNumber('Amount of SPL FOGO to Unwrap', String(this.amount.unwrap || 0.01));
      if (amt==null || !(amt>0)) return;
      this.amount.unwrap = amt;
      await this.unwrapFOGO(amt);
    }
  }
}


const bot = new Bot();
bot.init().catch(e => ui.log('error', e.message));
