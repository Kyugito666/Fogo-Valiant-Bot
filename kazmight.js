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
import * as spl from '@solana/spl-token';

import CryptoBotUI from './CryptoBotUI.js';

process.on('uncaughtException', (err) => {
  console.error('TERJADI ERROR FATAL YANG TIDAK TERDUGA:', err);
  process.exit(1);
});


const RPC_URL = 'https://testnet.fogo.io/';
const VALIANT_API = 'https://api.valiant.trade/dex';
const EXPLORER_URL = 'https://fogoscan.com/tx/';
const OWNER_PROGRAM = spl.TOKEN_PROGRAM_ID.toBase58();

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

let ui;

try {
  ui = new CryptoBotUI({
      title: 'FOGO Testnet — Valiant Bot (Multi-Wallet)',
      menuItems: [
        '1) Random Trade',
        '2) Random Add Position',
        '3) Deploy Token Contract',
        '4) Run All Features',
        '5) Wrap FOGO → SPL FOGO',
        '6) Unwrap SPL FOGO → FOGO',
        '7) Exit'
      ],
      tickerText1: 'FOGO TESTNET',
      tickerText2: 'Invictuslabs - Airdrops',
      mirrorConsole: false
  });
} catch (e) {
    console.error("Gagal menginisialisasi UI. Pastikan terminal Anda mendukungnya.", e);
    process.exit(1);
}


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

class Wallet {
    constructor(privateKey, uiInstance) {
        this.ui = uiInstance;
        this.connection = new Connection(RPC_URL, { commitment: 'confirmed', disableRetryOnRateLimit: false });
        this.headers = {};
        this.ua = new UserAgents().toString();
        this.amount = {
            trade: { FOGO: 0.0001, FUSD: 0.0001, USDT: 0.0001, USDC: 0.0001 },
            position: { FOGO: 0.0001, FUSD: 0.001, USDT: 0.001 },
            wrap: 0.01,
            unwrap: 0.01
        };
        this.delay = { min: 2, max: 4 };

        const { kp, signingKey, publicKey } = this.generateWallet(privateKey);
        if (!kp || !signingKey || !publicKey) {
            throw new Error(`Kunci pribadi tidak valid atau format salah.`);
        }
        this.kp = kp;
        this.signingKey = signingKey;
        this.publicKey = publicKey;

        this.tokenAccounts = new Map();
        this.mintDecimals = new Map();
        this._txCountCache = { value: 0, lastAt: 0 };

        this.mintDecimals.set(TOKENS.FOGO.address, TOKENS.FOGO.decimals);
        this.mintDecimals.set(TOKENS.FUSD.address, TOKENS.FUSD.decimals);
        this.mintDecimals.set(TOKENS.USDT.address, TOKENS.USDT.decimals);
        this.mintDecimals.set(TOKENS.USDC.address, TOKENS.USDC.decimals);
    }

    log(type, msg) { this.ui.log(type, `[${this.publicKey.slice(0, 4)}..] ${msg}`); }

    async init() {
        this.headers[this.publicKey] = {
            'Accept': '*/*',
            'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
            'Origin': 'https://valiant.trade',
            'Referer': 'https://valiant.trade/',
            'User-Agent': this.ua
        };
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
    
      }
    
      async refreshBalancesUI() {
        const addr = this.publicKey;
        if (!addr) return;
    
        const [fogo, txCount, _] = await Promise.all([
          this.fogoLamports(addr),
          this.getTxCountCached(addr),
          this.loadInitialTokens()
        ]);
        
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

        const tokenItems = ORDER.map(({ mint, name, symbol }) => {
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

        this.ui.setTokens(tokenItems);
    
        this.ui.updateWallet({
          address: addr,
          nativeBalance: (fogo / 1e9).toFixed(9),
          network: 'FOGO Testnet',
          gasPrice: '-',               
          nonce: String(txCount)       
        });
      }
    
      
      generateWallet(base58Secret) {
        try {
          const secret = Uint8Array.from(Buffer.from(base58Secret, 'hex')).slice(0, 64);
          const kp = Keypair.fromSecretKey(secret); 
          const pubKey = kp.publicKey.toBase58();
          const seed32 = secret.slice(0, 32);
          const keyPair = nacl.sign.keyPair.fromSeed(seed32);
          return { kp, signingKey: keyPair.secretKey, publicKey: pubKey };
        } catch (e) {
          console.error("Error saat generate wallet:", e);
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
        this.log('swap', `Quote ${from.ticker}→${to.ticker} amount ${amountUi}`);
    
        const quote = await this.getQuote(from.address, to.address, amount);
        const url = this.buildTwoHopUrl(this.publicKey, quote);
        const txObj = await this.getTradeTxs(url);
    
        const serialized = String(txObj.serializedTx || '');
        const signed = this.signSerializedBase64(serialized, 0);
        if (!signed) { ui.updateStats({ failedTx: ++ui.failedTx }); this.log('failed','Sign failed'); return; }
    
        ui.updateStats({ pendingTx: ++ui.pendingTx });
        const stopTimer = ui.startTimer('Trading');
        const sent = await this.sendTransactionBase64(signed).catch(e => ({ error: { message: e.message } }));
        stopTimer();
    
        if (sent.result) {
          const sig = sent.result;
          this.log('success', `Tx: ${sig.slice(0, 30)}...`);
          ui.updateStats({ transactionCount: ++ui.transactionCount });
          await this.waitStatus(sig);
          this._txCountCache.lastAt = 0; 
        } else {
          this.log('failed', sent.error?.message || 'Unknown error');
          ui.updateStats({ failedTx: ++ui.failedTx });
        }
        ui.updateStats({ pendingTx: Math.max(0, ui.pendingTx - 1) });
        await this.countdownDelay();
      }
    
      async doPositionOnce() {
        const [a, b, tick, amountUi] = this.randomPositionPair();
        const amount = Math.trunc(amountUi * (10 ** a.decimals));
        this.log('liquidity', `Posisi baru ${a.ticker}/${b.ticker} tick=${tick} amt=${amountUi}`);
    
        const txObj = await this.getNewPosition(this.publicKey, a.address, b.address, tick, amount);
        const serialized = String(txObj.serializedTx || '');
    
        const signed = this.signSerializedBase64(serialized, 0);
        if (!signed) { ui.updateStats({ failedTx: ++ui.failedTx }); this.log('failed','Sign failed'); return; }
    
        ui.updateStats({ pendingTx: ++ui.pendingTx });
        const stopTimer = ui.startTimer('Adding Liquidity');
        const sent = await this.sendTransactionBase64(signed).catch(e => ({ error: { message: e.message } }));
        stopTimer();
    
        if (sent.result) {
          const sig = sent.result;
          this.log('success', `Tx: ${sig.slice(0, 30)}...`);
          ui.updateStats({ transactionCount: ++ui.transactionCount });
          await this.waitStatus(sig);
          this._txCountCache.lastAt = 0;
        } else {
          this.log('failed', sent.error?.message || 'Unknown error');
          ui.updateStats({ failedTx: ++ui.failedTx });
        }
        ui.updateStats({ pendingTx: Math.max(0, ui.pendingTx - 1) });
        await this.countdownDelay();
      }
    
      async doDeployOnce() {
        const presets = [
          ['Token','TKN'], ['MyToken','MTK'], ['NewToken','NTK'], ['CryptoCoin','CRC'],
          ['SmartToken','SMT'], ['MetaCoin','MTC'], ['ChainToken','CTK']
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
    
        this.log('pending', `Deploy token ${tokenName} (${tokenSymbol})`);
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
            this.log('failed', `Sign error: ${e.message}`);
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
          this.log('success', `Tx: ${sig.slice(0, 30)}...`);
          ui.updateStats({ transactionCount: ++ui.transactionCount });
          await this.waitStatus(sig);
          this._txCountCache.lastAt = 0;
        } else {
          this.log('failed', sent.error?.message || 'Unknown error');
          ui.updateStats({ failedTx: ++ui.failedTx });
        }
        ui.updateStats({ pendingTx: Math.max(0, ui.pendingTx - 1) });
        await this.countdownDelay();
      }
    
      async waitStatus(signature) {
        for (let i=0;i<5;i++) {
          const r = await this.statusTx(signature).catch(()=>null);
          const val = r?.result?.value?.[0];
          if (val) {
            const st = String(val.confirmationStatus || 'unknown').toUpperCase();
            this.log('info', `Status: ${st}`);
            break;
          }
          await new Promise(r=>setTimeout(r,3000));
        }
      }
    
      
      async wrapFOGO(amountUi) {
        const owner = this.kp.publicKey;
        const lamports = Math.floor(amountUi * 1e9);
    
        const rent = await this.connection.getMinimumBalanceForRentExemption(spl.ACCOUNT_SIZE);
        const temp = Keypair.generate();
        const ata = await spl.getOrCreateAssociatedTokenAccount(this.connection, this.kp, spl.NATIVE_MINT, owner);
    
        const tx = new Transaction().add(
          SystemProgram.createAccount({ fromPubkey: owner, newAccountPubkey: temp.publicKey, lamports: rent + lamports, space: spl.ACCOUNT_SIZE, programId: spl.TOKEN_PROGRAM_ID }),
          spl.createInitializeAccountInstruction(temp.publicKey, spl.NATIVE_MINT, owner, spl.TOKEN_PROGRAM_ID),
          spl.createTransferCheckedInstruction(temp.publicKey, spl.NATIVE_MINT, ata.address, owner, lamports, 9, [], spl.TOKEN_PROGRAM_ID),
          spl.createCloseAccountInstruction(temp.publicKey, owner, owner, [], spl.TOKEN_PROGRAM_ID)
        );
    
        ui.updateStats({ pendingTx: ++ui.pendingTx });
        const stopTimer = ui.startTimer('Wrapping');
        const sig = await sendAndConfirmTransaction(this.connection, tx, [this.kp, temp], { commitment: 'finalized' }).catch(e => { this.log('failed', e.message); return null; });
        stopTimer();
    
        if (sig) {
          this.log('success', `Wrap Tx: ${sig.slice(0, 30)}...`);
          ui.updateStats({ transactionCount: ++ui.transactionCount });
          this._txCountCache.lastAt = 0;
        } else {
          ui.updateStats({ failedTx: ++ui.failedTx });
        }
        ui.updateStats({ pendingTx: Math.max(0, ui.pendingTx - 1) });
      }
    
      async unwrapFOGO(amountUi) {
        const owner = this.kp.publicKey;
        const lamports = Math.floor(amountUi * 1e9);
    
        const ata = await spl.getOrCreateAssociatedTokenAccount(this.connection, this.kp, spl.NATIVE_MINT, owner);
        const rent = await this.connection.getMinimumBalanceForRentExemption(spl.ACCOUNT_SIZE);
        const temp = Keypair.generate();
    
        const tx = new Transaction().add(
          SystemProgram.createAccount({ fromPubkey: owner, newAccountPubkey: temp.publicKey, lamports: rent, space: spl.ACCOUNT_SIZE, programId: spl.TOKEN_PROGRAM_ID }),
          spl.createInitializeAccountInstruction(temp.publicKey, spl.NATIVE_MINT, owner, spl.TOKEN_PROGRAM_ID),
          spl.createTransferCheckedInstruction(ata.address, spl.NATIVE_MINT, temp.publicKey, owner, lamports, 9, [], spl.TOKEN_PROGRAM_ID),
          spl.createCloseAccountInstruction(temp.publicKey, owner, owner, [], spl.TOKEN_PROGRAM_ID)
        );
    
        ui.updateStats({ pendingTx: ++ui.pendingTx });
        const stopTimer = ui.startTimer('Unwrapping');
        const sig = await sendAndConfirmTransaction(this.connection, tx, [this.kp, temp], { commitment: 'finalized' }).catch(e => { this.log('failed', e.message); return null; });
        stopTimer();
    
        if (sig) {
          this.log('success', `Unwrap Tx: ${sig.slice(0, 30)}...`);
          ui.updateStats({ transactionCount: ++ui.transactionCount });
          this._txCountCache.lastAt = 0;
        } else {
          ui.updateStats({ failedTx: ++ui.failedTx });
        }
        ui.updateStats({ pendingTx: Math.max(0, ui.pendingTx - 1) });
      }
}

class MultiWalletBot {
    constructor(uiInstance) {
        this.ui = uiInstance;
        this.wallets = [];
    }

    async init() {
        this.ui.log('info', 'Memulai inisialisasi Multi-Wallet Bot...');
        const privateKeys = process.env.PRIVATE_KEYS;
        if (!privateKeys) {
            this.ui.log('error', 'PRIVATE_KEYS tidak ditemukan di file .env');
            process.exit(1);
        }

        const keys = privateKeys.split(',').map(k => k.trim());
        this.ui.log('info', `Ditemukan ${keys.length} kunci pribadi.`);

        for (const key of keys) {
            try {
                const wallet = new Wallet(key, this.ui);
                await wallet.init();
                this.wallets.push(wallet);
                this.ui.log('success', `Wallet ${wallet.publicKey.slice(0, 8)}.. berhasil diinisialisasi.`);
            } catch (e) {
                this.ui.log('error', `Gagal memuat wallet: ${e.message}`);
            }
        }

        if (this.wallets.length === 0) {
            this.ui.log('error', 'Tidak ada wallet yang valid. Bot berhenti.');
            process.exit(1);
        }

        this.ui.setWallets(this.wallets.map(w => w.publicKey));
        
        this.ui.on('menu:select', async (_, idx) => {
            const pick = idx + 1;
            if (pick === 7) this.ui.destroy(0);
            try {
                await this.handleMenu(pick);
            } catch (e) {
                this.ui.log('error', `Menu handler error: ${e.message || String(e)}`);
            }
        });
        
        await this.updateCurrentWalletUI(0); // Tampilkan info wallet pertama saat start
    }
    
    async updateCurrentWalletUI(index) {
        const wallet = this.wallets[index];
        if(wallet) {
            this.ui.setActiveWallet(index);
            await wallet.refreshBalancesUI();
        }
    }
    
    // --- LOGIKA AUTO-RUN BARU ---
    async handleMenu(pick) {
        ui.setActive(true);
        this.ui.log('info', `===== Memulai Tugas Otomatis untuk ${this.wallets.length} Dompet =====`);

        if (pick === 1) { // Random Trade
            const count = await ui.promptNumber('Jumlah Trade per Dompet?', '1');
            if(count === null) { ui.setActive(false); return; }

            for (const [index, wallet] of this.wallets.entries()) {
                await this.updateCurrentWalletUI(index);
                this.ui.log('info', `Memproses Trade untuk dompet ${index + 1}/${this.wallets.length}`);
                for(let i=0; i < count; i++) await wallet.doTradeOnce();
            }
        }
        
        if (pick === 2) { // Add Position
            const count = await ui.promptNumber('Jumlah Tambah Posisi per Dompet?', '1');
            if(count === null) { ui.setActive(false); return; }

            for (const [index, wallet] of this.wallets.entries()) {
                await this.updateCurrentWalletUI(index);
                this.ui.log('info', `Memproses Posisi untuk dompet ${index + 1}/${this.wallets.length}`);
                for(let i=0; i < count; i++) await wallet.doPositionOnce();
            }
        }
        
        if (pick === 3) { // Deploy Token
            const count = await ui.promptNumber('Jumlah Deploy Token per Dompet?', '1');
            if(count === null) { ui.setActive(false); return; }

            for (const [index, wallet] of this.wallets.entries()) {
                await this.updateCurrentWalletUI(index);
                this.ui.log('info', `Memproses Deploy untuk dompet ${index + 1}/${this.wallets.length}`);
                for(let i=0; i < count; i++) await wallet.doDeployOnce();
            }
        }
        
        if (pick === 4) { // Run All
            const tradeCount = await ui.promptNumber('Jumlah Trade per Dompet?', '1');
            const posCount = await ui.promptNumber('Jumlah Tambah Posisi per Dompet?', '1');
            const deployCount = await ui.promptNumber('Jumlah Deploy Token per Dompet?', '1');
            if(tradeCount === null || posCount === null || deployCount === null) { ui.setActive(false); return; }

            for (const [index, wallet] of this.wallets.entries()) {
                await this.updateCurrentWalletUI(index);
                this.ui.log('info', `====== Menjalankan Semua Fitur untuk Dompet ${index + 1} ======`);
                for(let i=0; i < tradeCount; i++) await wallet.doTradeOnce();
                for(let i=0; i < posCount; i++) await wallet.doPositionOnce();
                for(let i=0; i < deployCount; i++) await wallet.doDeployOnce();
            }
        }

        if (pick === 5) { // Wrap FOGO
            const amount = await ui.promptNumber('Jumlah FOGO untuk di-Wrap (per dompet)?', '0.01');
            if(amount === null || amount <= 0) { ui.setActive(false); return; }

            for (const [index, wallet] of this.wallets.entries()) {
                await this.updateCurrentWalletUI(index);
                this.ui.log('info', `Memproses Wrap untuk dompet ${index + 1}/${this.wallets.length}`);
                await wallet.wrapFOGO(amount);
            }
        }
        
        if (pick === 6) { // Unwrap SPL FOGO
            const amount = await ui.promptNumber('Jumlah SPL FOGO untuk di-Unwrap (per dompet)?', '0.01');
            if(amount === null || amount <= 0) { ui.setActive(false); return; }

            for (const [index, wallet] of this.wallets.entries()) {
                await this.updateCurrentWalletUI(index);
                this.ui.log('info', `Memproses Unwrap untuk dompet ${index + 1}/${this.wallets.length}`);
                await wallet.unwrapFOGO(amount);
            }
        }

        this.ui.log('success', '===== Semua Tugas Otomatis Selesai =====');
        ui.setActive(false);
    }
}

async function main() {
    const bot = new MultiWalletBot(ui);
    await bot.init();
}

main().catch(err => {
    console.error("Terjadi error pada level tertinggi aplikasi:", err);
    if(ui) {
      ui.destroy();
    }
    process.exit(1);
});