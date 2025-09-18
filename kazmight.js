import 'dotenv/config';
import fs from 'fs';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import FormData from 'form-data';
import sharp from 'sharp';
import UserAgents from 'user-agents';

import {
  Connection, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction
} from '@solana/web3.js';
import * as spl from '@solana/spl-token';

import CryptoBotUI from './CryptoBotUI.js';

process.on('uncaughtException', (err) => {
  console.error('TERJADI ERROR FATAL YANG TIDAK TERDUGA:', err);
  process.exit(1);
});

// --- PENGATURAN PROXY ---
let proxies = [];
let proxyEnabled = false;
let currentProxyIndex = 0;

function loadProxies() {
    try {
        const proxyData = fs.readFileSync('proxy.txt', 'utf8');
        proxies = proxyData.split(/\r?\n/).filter(line => line.trim() !== '');
        if (proxies.length > 0) {
            ui.log('proxy', `Berhasil memuat ${proxies.length} proksi.`);
        } else {
            ui.log('warning', 'File proxy.txt kosong atau tidak ditemukan.');
        }
    } catch (error) {
        ui.log('warning', 'Gagal memuat proxy.txt. Menjalankan tanpa proksi.');
        proxies = [];
    }
}

function getNextProxy() {
    if (proxies.length === 0) return null;
    const proxy = proxies[currentProxyIndex];
    currentProxyIndex = (currentProxyIndex + 1) % proxies.length;
    return proxy;
}

// --- KONFIGURASI UTAMA ---
const RPC_URL = 'https://testnet.fogo.io/';
const VALIANT_API = 'https://api.valiant.trade/dex';
const OWNER_PROGRAM = spl.TOKEN_PROGRAM_ID.toBase58();

const TOKENS = {
  FOGO: { name: 'SPL FOGO', ticker: 'FOGO', address: 'So11111111111111111111111111111111111111112', decimals: 9 },
  FUSD: { name: 'FOGO USD', ticker: 'FUSD', address: 'fUSDNGgHkZfwckbr5RLLvRbvqvRcTLdH9hcHJiq4jry', decimals: 6 },
  USDT: { name: 'USD TOKEN', ticker: 'USDT', address: '7fc38fbxd1q7gC5WqfauwdVME7ms64VGypyoHaTnLUAt', decimals: 6 },
  USDC: { name: 'USD COIN', ticker: 'USDC', address: 'ELNbJ1RtERV2fjtuZjbTscDekWhVzkQ1LjmiPsxp5uND', decimals: 6 },
};

const ALLOWED_MINTS = new Set(Object.values(TOKENS).map(t => t.address));
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
        '7) Toggle Proxy: OFF',
        '8) Exit'
      ],
      tickerText1: 'FOGO TESTNET',
      tickerText2: 'Invictuslabs - Airdrops'
  });
} catch (e) { console.error("Gagal menginisialisasi UI.", e); process.exit(1); }

function formatUiAmount(rawBig, decimals, maxFrac = 9) {
  const D = 10n ** BigInt(decimals);
  const int = rawBig / D, frac = rawBig % D;
  if (frac === 0n) return int.toString();
  let fracStr = frac.toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '');
  return `${int}.${fracStr || '0'}`;
}

class Wallet {
    constructor(privateKey, uiInstance) {
        this.ui = uiInstance;
        this.connection = new Connection(RPC_URL, { commitment: 'confirmed' });
        this.ua = new UserAgents().toString();
        this.amount = {
            trade: { FOGO: 0.0001, FUSD: 0.0001, USDT: 0.0001, USDC: 0.0001 },
            position: { FOGO: 0.0001, FUSD: 0.001, USDT: 0.001 },
            wrap: 0.01,
            unwrap: 0.01
        };
        this.delay = { min: 2, max: 4 };

        const { kp, signingKey, publicKey } = this.generateWallet(privateKey);
        if (!kp) throw new Error(`Kunci pribadi tidak valid.`);
        this.kp = kp;
        this.signingKey = signingKey;
        this.publicKey = publicKey;
        this.tokenAccounts = new Map();
        this.mintDecimals = new Map(Object.values(TOKENS).map(t => [t.address, t.decimals]));
        this._txCountCache = { value: 0, lastAt: 0 };
    }

    log(type, msg) { this.ui.log(type, `[${this.publicKey.slice(0, 4)}..] ${msg}`); }
    
    async createAxiosInstance() {
        if (proxyEnabled && proxies.length > 0) {
            const proxyUrl = getNextProxy();
            if (proxyUrl) {
                this.log('proxy', `Menggunakan proksi: ${proxyUrl.split('@')[1]}`);
                const agent = new HttpsProxyAgent(proxyUrl);
                return axios.create({ httpsAgent: agent, timeout: 120000 });
            }
        }
        return axios.create({ timeout: 120000 });
    }

    async httpGet(url) {
        const client = await this.createAxiosInstance();
        const res = await client.get(url, { headers: { 'User-Agent': this.ua, 'Accept': '*/*' }, validateStatus: () => true });
        if (res.status >= 200 && res.status < 300) return res.data;
        throw new Error(`GET ${res.status}`);
    }

    async httpPost(url, body, headers = {}) {
        const client = await this.createAxiosInstance();
        const res = await client.post(url, body, { headers: { 'User-Agent': this.ua, ...headers }, validateStatus: () => true });
        if (res.status >= 200 && res.status < 300) return res.data;
        throw new Error(`POST ${res.status}`);
    }

    async rpc(body) {
        const client = await this.createAxiosInstance();
        const res = await client.post(RPC_URL, body, { headers: { 'Content-Type': 'application/json' }, validateStatus: () => true });
        if (res.status >= 200 && res.status < 300) return res.data;
        throw new Error(`RPC ${res.status}`);
    }

    async getAllTokenAccountsParsed(addr) {
        const payload = { jsonrpc: '2.0', method: 'getTokenAccountsByOwner', params: [addr, { programId: OWNER_PROGRAM }, { encoding: 'jsonParsed', commitment: 'confirmed' }], id: 1 };
        const res = await this.rpc(payload);
        return res?.result?.value || [];
    }
      
    async txCountAll(address) {
        let before = null, total = 0;
        while (true) {
            const res = await this.rpc({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [address, { limit: 1000, ...(before ? { before } : {}) }] });
            const arr = res?.result || [];
            total += arr.length;
            if (arr.length < 1000) break;
            before = arr[arr.length - 1].signature;
        }
        return total;
    }

    async getTxCountCached(address) {
        const now = Date.now();
        if (now - this._txCountCache.lastAt < 30000) return this._txCountCache.value;
        const n = await this.txCountAll(address).catch(() => this._txCountCache.value || 0);
        this._txCountCache = { value: n, lastAt: now };
        return n;
    }
    
    async refreshBalancesUI() {
        const addr = this.publicKey;
        const [fogo, txCount, accounts] = await Promise.all([
            this.connection.getBalance(this.kp.publicKey),
            this.getTxCountCached(addr),
            this.getAllTokenAccountsParsed(addr)
        ]);
        
        this.tokenAccounts.clear();
        for (const it of accounts) {
            try {
                const info = it.account.data.parsed.info;
                if (ALLOWED_MINTS.has(info.mint)) {
                    this.tokenAccounts.set(it.pubkey, { mint: info.mint, amountRaw: BigInt(info.tokenAmount.amount) });
                }
            } catch {}
        }

        const totals = new Map();
        for (const { mint, amountRaw } of this.tokenAccounts.values()) {
            totals.set(mint, (totals.get(mint) || 0n) + amountRaw);
        }

        const tokenItems = Object.values(TOKENS).map(({ address, ticker, decimals }) => ({
            symbol: ticker,
            balance: formatUiAmount(totals.get(address) || 0n, decimals, 9)
        }));
        this.ui.setTokens(tokenItems);
    
        this.ui.updateWallet({ address: addr, nativeBalance: (fogo / 1e9).toFixed(9), network: 'FOGO Testnet', nonce: String(txCount) });
    }
    
    generateWallet(base58Secret) {
        try {
            const secret = Uint8Array.from(bs58.decode(base58Secret));
            const kp = Keypair.fromSecretKey(secret);
            const seed32 = secret.slice(0, 32);
            return { kp, signingKey: nacl.sign.keyPair.fromSeed(seed32).secretKey, publicKey: kp.publicKey.toBase58() };
        } catch (e) {
            console.error("Error saat generate wallet:", e.message);
            return { kp: null, signingKey: null, publicKey: null };
        }
    }

    signSerializedBase64(serializedBase64) {
        try {
            const tx = Buffer.from(serializedBase64, 'base64');
            const message = tx.slice(1 + 64);
            const sig = nacl.sign.detached(message, this.signingKey);
            Buffer.from(sig).copy(tx, 1);
            return tx.toString('base64');
        } catch (e) {
            this.log('error', `Sign error: ${e.message}`);
            return null;
        }
    }

    async getQuote(from, to, amount) { return this.httpGet(`${VALIANT_API}/twoHopQuote?inputMint=${from.address}&outputMint=${to.address}&isExactIn=true&inputAmount=${amount}`); }
    buildTwoHopUrl(quote, slippageBps = 100) {
        const minOut = Math.floor(Number(quote.tokenEstOut) * (10000 - slippageBps) / 10000);
        const params = new URLSearchParams({ userAddress: this.publicKey, isExactIn: 'true', inputAmount: String(quote.tokenIn), outputAmount: String(minOut), sessionAddress: this.publicKey, feePayer: this.publicKey });
        for (const r of quote.quote.route) params.append('route', r);
        for (const p of quote.quote.pools) params.append('pools', p);
        return `${VALIANT_API}/txs/twoHopSwap?${params}`;
    }
    async sendTransactionBase64(b64) { return this.rpc({ jsonrpc:'2.0', method:'sendTransaction', params:[b64, {encoding:'base64', skipPreflight:true}], id: 1 }); }
    async statusTx(sig) { return this.rpc({ jsonrpc:'2.0', method:'getSignatureStatuses', params:[[sig]], id: 1 }); }
    
    async countdownDelay() {
        const seconds = Math.floor(Math.random() * (this.delay.max - this.delay.min + 1)) + this.delay.min;
        if (seconds > 0) await ui.countdown(seconds * 1000, 'Next Tx Delay');
    }

    randomPair(type) {
        const pairs = {
            trade: [
                [TOKENS.FOGO, TOKENS.FUSD], [TOKENS.FOGO, TOKENS.USDT], [TOKENS.FOGO, TOKENS.USDC],
                [TOKENS.FUSD, TOKENS.FOGO], [TOKENS.FUSD, TOKENS.USDT], [TOKENS.FUSD, TOKENS.USDC],
                [TOKENS.USDT, TOKENS.FOGO], [TOKENS.USDT, TOKENS.FUSD], [TOKENS.USDT, TOKENS.USDC],
                [TOKENS.USDC, TOKENS.FOGO], [TOKENS.USDC, TOKENS.FUSD], [TOKENS.USDC, TOKENS.USDT],
            ],
            position: [
                [TOKENS.FOGO, TOKENS.FUSD, 64], [TOKENS.FOGO, TOKENS.USDT, 64], [TOKENS.FOGO, TOKENS.USDC, 64],
                [TOKENS.FUSD, TOKENS.USDT, 1], [TOKENS.FUSD, TOKENS.USDC, 1], [TOKENS.USDT, TOKENS.USDC, 1],
            ]
        };
        const list = pairs[type];
        const chosen = list[Math.floor(Math.random() * list.length)];
        const amount = this.amount[type][chosen[0].ticker];
        return [...chosen, amount];
    }

    async buildLogoJpeg(name, symbol) {
        const bg = ['#111827','#1f2937','#0f766e','#1d4ed8','#6d28d9','#be123c'][Math.floor(Math.random()*6)];
        const svg = `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${bg}"/><stop offset="100%" stop-color="#111"/></linearGradient></defs><rect width="512" height="512" fill="url(#g)"/><circle cx="256" cy="256" r="200" fill="#fff2"/><circle cx="256" cy="256" r="150" fill="#fff2"/><text x="50%" y="48%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="72" fill="#fff" font-weight="700">${symbol}</text><text x="50%" y="61%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="28" fill="#fffC">${name}</text></svg>`;
        let quality = 85, jpeg;
        do { jpeg = await sharp(Buffer.from(svg)).jpeg({ quality, mozjpeg: true }).toBuffer(); quality -= 5; } while (jpeg.length > 200 * 1024 && quality > 25);
        return jpeg;
    }
    
    async executeTransaction(label, task) {
        ui.updateStats({ pendingTx: ++ui.pendingTx });
        const stopTimer = ui.startTimer(label);
        const sent = await task().catch(e => ({ error: { message: e.message } }));
        stopTimer();

        if (sent.result) {
            this.log('success', `Tx: ${sent.result.slice(0, 30)}...`);
            ui.updateStats({ transactionCount: ++ui.transactionCount });
            await this.waitStatus(sent.result);
            this._txCountCache.lastAt = 0;
        } else {
            this.log('failed', sent.error?.message || 'Unknown error');
            ui.updateStats({ failedTx: ++ui.failedTx });
        }
        ui.updateStats({ pendingTx: Math.max(0, ui.pendingTx - 1) });
        await this.countdownDelay();
    }
    
    async doTradeOnce() {
        const [from, to, amountUi] = this.randomPair('trade');
        const amount = Math.trunc(amountUi * (10 ** from.decimals));
        this.log('swap', `Quote ${from.ticker}→${to.ticker} amount ${amountUi}`);
        
        await this.executeTransaction('Trading', async () => {
            const quote = await this.getQuote(from, to, amount);
            const url = this.buildTwoHopUrl(quote);
            const txObj = await this.httpGet(url);
            const signed = this.signSerializedBase64(txObj.serializedTx);
            if (!signed) throw new Error('Sign failed');
            return this.sendTransactionBase64(signed);
        });
    }

    async doPositionOnce() {
        const [a, b, tick, amountUi] = this.randomPair('position');
        const amount = Math.trunc(amountUi * (10 ** a.decimals));
        this.log('liquidity', `Posisi baru ${a.ticker}/${b.ticker} amt=${amountUi}`);
        
        await this.executeTransaction('Adding Liquidity', async () => {
            const url = `${VALIANT_API}/txs/newPosition?userAddress=${this.publicKey}&mintA=${a.address}&mintB=${b.address}&amountA=${amount}&tickSpacing=${tick}&feePayer=${this.publicKey}&sessionAddress=${this.publicKey}`;
            const txObj = await this.httpGet(url);
            const signed = this.signSerializedBase64(txObj.serializedTx);
            if (!signed) throw new Error('Sign failed');
            return this.sendTransactionBase64(signed);
        });
    }
    
    async doDeployOnce() {
        const [n, s] = [['Token','TKN'], ['MyToken','MTK']][Math.floor(Math.random()*2)];
        const serial = String(Math.floor(Math.random()*1e6));
        const tokenName = n+serial, tokenSymbol = s+serial;
        const initialSupply = String(BigInt(100000000) * BigInt(10 ** 9));
        
        await this.executeTransaction('Deploy Token', async () => {
            const jpeg = await this.buildLogoJpeg(tokenName, tokenSymbol);
            const presign = await this.httpPost(`${VALIANT_API}/getPresignedUrl`, null, { 'Content-Length':'0' });
            
            const fd = new FormData();
            fd.append('file', jpeg, { filename: 'token.jpeg', contentType: 'image/jpeg' });
            fd.append('network','public');
            const up = await this.httpPost(presign.url, fd, fd.getHeaders());
            const cid = up?.data?.cid || '';
            
            const mintKey = nacl.sign.keyPair();
            const body = { newTokenTransactionDetails: { name: tokenName, symbol: tokenSymbol, image: `https://ipfs.io/ipfs/${cid}`, decimals: 9, initialSupply, userAddress: this.publicKey, mint: bs58.encode(mintKey.publicKey) } };
            const deployTx = await this.httpPost(`${VALIANT_API}/txs/newToken`, JSON.stringify(body), { 'Content-Type': 'application/json' });
            
            const tx = Buffer.from(deployTx.serializedTx, 'base64');
            const sig = nacl.sign.detached(tx.slice(1 + 64 * 2), mintKey.secretKey);
            Buffer.from(sig).copy(tx, 1 + 64);
            const signed = this.signSerializedBase64(tx.toString('base64'));
            return this.sendTransactionBase64(signed);
        });
    }
    
    async waitStatus(signature) {
        for (let i=0;i<5;i++) {
            const r = await this.statusTx(signature).catch(()=>null);
            const val = r?.result?.value?.[0];
            if (val) { this.log('info', `Status: ${String(val.confirmationStatus || '?').toUpperCase()}`); break; }
            await new Promise(r=>setTimeout(r,3000));
        }
    }
    
    async wrapUnwrapFOGO(amountUi, wrap = true) {
        const owner = this.kp.publicKey;
        const lamports = Math.floor(amountUi * 1e9);
        const ata = await spl.getOrCreateAssociatedTokenAccount(this.connection, this.kp, spl.NATIVE_MINT, owner);
        const temp = Keypair.generate();
        const rent = await this.connection.getMinimumBalanceForRentExemption(spl.ACCOUNT_SIZE);
        
        const tx = new Transaction();
        if (wrap) {
            tx.add( SystemProgram.createAccount({ fromPubkey: owner, newAccountPubkey: temp.publicKey, lamports: rent + lamports, space: spl.ACCOUNT_SIZE, programId: spl.TOKEN_PROGRAM_ID }), spl.createInitializeAccountInstruction(temp.publicKey, spl.NATIVE_MINT, owner), spl.createTransferCheckedInstruction(temp.publicKey, spl.NATIVE_MINT, ata.address, owner, lamports, 9), spl.createCloseAccountInstruction(temp.publicKey, owner, owner) );
        } else {
            tx.add( SystemProgram.createAccount({ fromPubkey: owner, newAccountPubkey: temp.publicKey, lamports: rent, space: spl.ACCOUNT_SIZE, programId: spl.TOKEN_PROGRAM_ID }), spl.createInitializeAccountInstruction(temp.publicKey, spl.NATIVE_MINT, owner), spl.createTransferCheckedInstruction(ata.address, spl.NATIVE_MINT, temp.publicKey, owner, lamports, 9), spl.createCloseAccountInstruction(temp.publicKey, owner, owner) );
        }

        ui.updateStats({ pendingTx: ++ui.pendingTx });
        const stopTimer = ui.startTimer(wrap ? 'Wrapping' : 'Unwrapping');
        const sig = await sendAndConfirmTransaction(this.connection, tx, [this.kp, temp]).catch(e => { this.log('failed', e.message); return null; });
        stopTimer();

        if (sig) { this.log('success', `${wrap ? 'Wrap' : 'Unwrap'} Tx: ${sig.slice(0, 30)}...`); ui.updateStats({ transactionCount: ++ui.transactionCount }); this._txCountCache.lastAt = 0; } else { ui.updateStats({ failedTx: ++ui.failedTx }); }
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
        loadProxies();

        const privateKeys = process.env.PRIVATE_KEYS;
        if (!privateKeys) { this.ui.log('error', 'PRIVATE_KEYS tidak ditemukan di file .env'); process.exit(1); }
        
        const keys = privateKeys.split(',').map(k => k.trim());
        this.ui.log('info', `Ditemukan ${keys.length} kunci pribadi.`);

        for (const key of keys) {
            try {
                const wallet = new Wallet(key, this.ui);
                this.wallets.push(wallet);
                this.ui.log('success', `Wallet ${wallet.publicKey.slice(0, 8)}.. berhasil diinisialisasi.`);
            } catch (e) { this.ui.log('error', `Gagal memuat wallet: ${e.message}`); }
        }

        if (this.wallets.length === 0) { this.ui.log('error', 'Tidak ada wallet yang valid. Bot berhenti.'); process.exit(1); }
        
        this.ui.setWallets(this.wallets.map(w => w.publicKey));
        this.ui.on('menu:select', (_, idx) => this.handleMenu(idx + 1).catch(e => this.ui.log('error', `Menu error: ${e.message}`)));
        await this.updateCurrentWalletUI(0);
    }
    
    async updateCurrentWalletUI(index) {
        const wallet = this.wallets[index];
        if(wallet) { this.ui.setActiveWallet(index); await wallet.refreshBalancesUI(); }
    }
    
    async handleMenu(pick) {
        if (pick === 8) return this.ui.destroy(0);

        if (pick === 7) {
            proxyEnabled = !proxyEnabled;
            const status = proxyEnabled ? 'ON' : 'OFF';
            this.ui.log('proxy', `Proxy sekarang ${status}.`);
            this.ui.transactionList.setItem(6, `7) Toggle Proxy: ${status}`);
            this.ui.setProxyStatus(proxyEnabled, proxyEnabled && proxies.length > 0 ? proxies[currentProxyIndex] : 'N/A');
            return;
        }

        ui.setActive(true);
        this.ui.log('info', `===== Memulai Tugas Otomatis untuk ${this.wallets.length} Dompet =====`);

        const tasks = {
            1: { name: 'Trade', method: 'doTradeOnce', prompt: 'Jumlah Trade per Dompet?' },
            2: { name: 'Posisi', method: 'doPositionOnce', prompt: 'Jumlah Tambah Posisi per Dompet?' },
            3: { name: 'Deploy', method: 'doDeployOnce', prompt: 'Jumlah Deploy Token per Dompet?' },
            5: { name: 'Wrap', method: 'wrapUnwrapFOGO', prompt: 'Jumlah FOGO untuk di-Wrap?', extraArgs: [true] },
            6: { name: 'Unwrap', method: 'wrapUnwrapFOGO', prompt: 'Jumlah SPL FOGO untuk di-Unwrap?', extraArgs: [false] }
        };

        if (tasks[pick]) {
            const { name, method, prompt, extraArgs = [] } = tasks[pick];
            const count = await ui.promptNumber(prompt, '1');
            if (count === null || count <= 0) { ui.setActive(false); return; }

            for (const [index, wallet] of this.wallets.entries()) {
                await this.updateCurrentWalletUI(index);
                this.ui.log('info', `Memproses ${name} untuk dompet ${index + 1}/${this.wallets.length}`);
                for(let i=0; i < count; i++) await wallet[method](...extraArgs, count);
            }
        }
        
        if (pick === 4) {
            const counts = {
                trade: await ui.promptNumber('Jumlah Trade?', '1'),
                pos: await ui.promptNumber('Jumlah Posisi?', '1'),
                deploy: await ui.promptNumber('Jumlah Deploy?', '1')
            };
            if(Object.values(counts).some(c => c === null)) { ui.setActive(false); return; }

            for (const [index, wallet] of this.wallets.entries()) {
                await this.updateCurrentWalletUI(index);
                this.ui.log('info', `====== Menjalankan Semua Fitur untuk Dompet ${index + 1} ======`);
                for(let i=0; i < counts.trade; i++) await wallet.doTradeOnce();
                for(let i=0; i < counts.pos; i++) await wallet.doPositionOnce();
                for(let i=0; i < counts.deploy; i++) await wallet.doDeployOnce();
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
    console.error("Terjadi error pada level tertinggi:", err);
    if(ui) ui.destroy();
    process.exit(1);
});