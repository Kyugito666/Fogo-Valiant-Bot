import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import blessed from 'blessed';
import figlet from 'figlet';
import moment from 'moment';

class CryptoBotUI extends EventEmitter {
  constructor(options = {}) {
    super();

    this.opts = {
      title: options.title || 'Dashboard',
      tokenColumns: options.tokenColumns || 2,
      colors: {
        primary: '#00ff00',
        secondary: '#ffff00',
        info: '#3498db',
        warning: '#f39c12',
        error: '#e74c3c',
        success: '#2ecc71',
        text: '#ffffff',
        background: '#1a1a1a',
        purple: '#9b59b6',
        cyan: '#00ffff',
        pink: '#ff69b4',
        orange: '#ff8c00',
        ...(options.colors || {})
      },
      menuItems: options.menuItems || [],
    };

    this.logFile = path.resolve(process.cwd(), options.logFile || 'transactions.log');
    this._logStream = fs.createWriteStream(this.logFile, { flags: 'a' });

    this.tickerSpeed  = Number(options.tickerSpeed || 200);
    this.tickerColor1 = options.tickerColor1 || 'cyan';
    this.tickerColor2 = options.tickerColor2 || 'yellow';
    this.tickerText1  = options.tickerText1 || 'FOGO TESTNET';
    this.tickerText2  = options.tickerText2 || 'Invictuslabs - Airdrops';

    this._scrollPos   = 0;
    this._viewportW   = 80;
    this._tickerPaused = false;
    this._tickerTape = '';
    this._tickerMask = [];

    this.bannerTexts = options.bannerTexts || ['INVICTUSLABS', 'AUTOMATION', 'TESTNET'];
    this.bannerFont = options.bannerFont || 'ANSI Shadow';

    const C = this.opts.colors;
    this.isActive = false;
    this.transactionCount = 0;
    this.failedTx = 0;
    this.pendingTx = 0;
    this._intervals = new Set();
    this.walletData = { address: '-', nativeBalance: '-', network: '-', gasPrice: '-', nonce: '-' };
    this.tokens = [];
    this.wallets = [];
    this.activeWalletIndex = 0;
    this.proxyStatus = { enabled: false, current: 'N/A' };

    this.screen = blessed.screen({
      smartCSR: true,
      fullUnicode: true,
      dockBorders: true,
      title: this.opts.title,
      cursor: { artificial: true, shape: 'line', blink: true, color: null }
    });
    this.screen.key(['escape', 'q', 'C-c'], () => this.destroy());

    // --- Definisi Layout Baru ---
    this.banner = blessed.box({ parent: this.screen, top: 0, height: 6, width: '100%', align: 'center', tags: true, style: { bg: C.background } });
    this.walletListBox = blessed.box({ parent: this.screen, label: ' Wallets ', top: 6, height: 5, width: '100%', border: 'line', style: { border: { fg: C.primary }, label: { fg: C.primary, bold: true } }, tags: true, padding: { left: 1, right: 1 } });
    this.walletBox = blessed.box({ parent: this.screen, label: ' Wallet Information ', top: 11, height: 7, left: 0, width: '50%', border: 'line', style: { border: { fg: C.primary }, label: { fg: C.primary, bold: true } }, tags: true, padding: 1 });
    this.tokenBox = blessed.box({ parent: this.screen, label: ' Token Information ', top: 11, height: 7, left: '50%', width: '50%', border: 'line', style: { border: { fg: C.secondary }, label: { fg: C.secondary, bold: true } }, tags: true, padding: 1 });
    
    const bottomTop = 18;
    const bottomHeight = '100%-' + (bottomTop + 4);

    this.menuBox = blessed.box({ parent: this.screen, label: ' Transaction Menu ', top: bottomTop, height: bottomHeight, left: 0, width: '30%', border: 'line', style: { border: { fg: C.info }, label: { fg: C.info, bold: true } } });
    this.transactionList = blessed.list({ parent: this.menuBox, keys: true, mouse: true, tags: true, width: '100%-2', height: '100%-2', scrollbar: { ch: ' ', track: { bg: C.background }, style: { bg: C.cyan } }, style: { selected: { bg: C.info, fg: 'white', bold: true }, item: { hover: { bg: C.background } } }, items: this.opts.menuItems });
    this.transactionList.on('select', (item, index) => { const label = (item?.content || '').replace(/\x1b\[[0-9;]*m/g, ''); this.emit('menu:select', label, index); });

    this.statsBox = blessed.box({ parent: this.screen, label: ' Statistics ', top: bottomTop, height: '35%', left: '30%', width: '35%', border: 'line', style: { border: { fg: C.orange }, label: { fg: C.orange, bold: true } }, tags: true, padding: 1 });
    this.proxyBox = blessed.box({ parent: this.screen, label: ' Proxy Status ', top: bottomTop + '+35%', height: '15%', left: '30%', width: '35%', border: 'line', style: { border: { fg: C.cyan }, label: { fg: C.cyan, bold: true } }, tags: true, padding: 1 });
    this.activityBox = blessed.box({ parent: this.screen, label: ' Activity Monitor ', top: bottomTop + '+50%', height: '50%-1', left: '30%', width: '35%', border: 'line', style: { border: { fg: C.pink }, label: { fg: C.pink, bold: true } }, tags: true, padding: 1 });

    this.logsBox = blessed.log({ parent: this.screen, label: ' Transaction Logs ', top: bottomTop, height: bottomHeight, left: '65%', width: '35%', border: 'line', scrollable: true, alwaysScroll: true, mouse: true, keys: true, scrollbar: { ch: ' ', track: { bg: C.background }, style: { bg: C.purple } }, style: { border: { fg: C.purple }, label: { fg: C.purple, bold: true } }, tags: true });
    this.delayOverlay = blessed.text({ parent: this.logsBox, bottom: 1, height: 1, left: 1, width: '100%-2', tags: true, content: '', style: { fg: C.cyan }, hidden: true });
    this.timerOverlay = blessed.text({ parent: this.logsBox, bottom: 0, height: 1, left: 1, width: '100%-2', tags: true, content: '', style: { fg: C.secondary }, hidden: true });
    
    this.tickerBox = blessed.box({ parent: this.screen, bottom: 3, height: 1, width: '100%', tags: true, style: { bg: C.background } });
    this.statusBar = blessed.box({ parent: this.screen, bottom: 0, height: 3, width: '100%', border: 'line', style: { border: { fg: C.cyan }, bg: C.background }, tags: true });
    this.statusText = blessed.text({ parent: this.statusBar, left: 1, top: 0, tags: true, content: '' });

    this._wireKeys();
    this._setBannerFrame(this.bannerTexts[0], this.bannerFont, C.primary);
    this._refreshAll();
    this.transactionList.focus();
    this._viewportW = this.screen.width || 80;
    this._buildTickerTape();
    this._every(1000, () => { this._drawStatus(); this.render(); });
    this._startTicker();
    this._animateBanner();
    this.screen.on('resize', () => { this._viewportW = this.screen.width || 80; this._buildTickerTape(); });
    this._welcomeLogs();
  }

  _wireKeys() {
    this.screen.key(['s', 'S'], () => { this.setActive(!this.isActive); this.log(this.isActive ? 'success' : 'warning', this.isActive ? 'ACTIVE' : 'IDLE'); });
    this.screen.key(['r', 'R'], () => { this._refreshAll(); this.log('info','Redraw UI'); });
    this.screen.key(['c', 'C'], () => { this.clearLogs(); this.log('info','Logs cleared'); });
    this.screen.key(['t','T'], () => { this._tickerPaused = !this._tickerPaused; this.log('info', this._tickerPaused ? 'Ticker paused' : 'Ticker resumed'); });
    this.screen.key(['l','L'], () => { this.log('info', `Log file: ${this.logFile}`); });
  }

  async promptNumber(label, initial = '') {
    const prompt = blessed.prompt({ parent: this.screen, keys: true, mouse: true, border: 'line', height: 'shrink', width: '50%', top: 'center', left: 'center', label: ' Input ', tags: true });
    return new Promise((resolve) => {
      prompt.input(`${label}`, initial, (err, value) => {
        try { prompt.destroy(); } catch {}
        if (err) return resolve(null);
        const n = Number(value);
        if (Number.isFinite(n)) return resolve(n);
        resolve(null);
      });
    });
  }
  
  countdown(ms, label = 'Delay') {
    return new Promise((resolve) => {
      const start = Date.now(), end = start + Math.max(0, Number(ms) || 0);
      this.delayOverlay.show();
      const tick = () => {
        const rem = Math.max(0, end - Date.now());
        this.delayOverlay.setContent(`{${this.opts.colors.cyan}-fg}[PENDING]{/} {${this.opts.colors.orange}-fg}${label}: ${(rem / 1000).toFixed(1)}s{/}`);
        this.render();
        if (rem <= 0) { clearInterval(id); this._intervals.delete(id); this.delayOverlay.hide(); this.render(); this.log('completed', `${label} finished`); resolve(); }
      };
      tick();
      const id = setInterval(tick, 100);
      this._intervals.add(id);
    });
  }

  startTimer(label = 'Waiting confirmation') {
    this.timerOverlay.show();
    const started = Date.now();
    const tick = () => {
      const ms = Date.now() - started, sec = ms / 1000;
      const mm = Math.floor(sec / 60).toString().padStart(2, '0');
      const ss = Math.floor(sec % 60).toString().padStart(2, '0');
      this.timerOverlay.setContent(`{${this.opts.colors.secondary}-fg}[PENDING]{/} ${label}: {${this.opts.colors.info}-fg}${mm}:${ss}.${Math.floor((sec * 10) % 10)}{/}`);
      this.render();
    };
    tick();
    const id = setInterval(tick, 100);
    this._intervals.add(id);
    return () => { clearInterval(id); this._intervals.delete(id); this.timerOverlay.hide(); this.render(); this.log('completed', `${label} done`); };
  }

  _filelog(message) { try { this._logStream.write(`[${new Date().toISOString()}] ${message}\n`); } catch (_) {} }
  render() { try { this.screen?.render(); } catch (_) {} }
  destroy(code = 0) {
    for (const id of this._intervals) clearInterval(id);
    this._intervals.clear();
    try { this._filelog('===== UI destroyed ====='); this._logStream?.end?.(); } catch (_) {}
    try { this.screen?.destroy(); } catch (_) {}
    process.exit(code);
  }

  setWallets(wallets) { this.wallets = wallets; this.drawWalletList(); }
  setActiveWallet(index) { this.activeWalletIndex = index; this.drawWalletList(); }
  setProxyStatus(enabled, currentProxy = 'N/A') { this.proxyStatus = { enabled, current: currentProxy }; this._drawProxyStatus(); this.render(); }
  setActive(active) { this.isActive = !!active; this._drawActivity(); this._drawStatus(); this.render(); }

  updateWallet(partial = {}) {
    Object.assign(this.walletData, partial);
    const C = this.opts.colors, w = this.walletData;
    const content = `_Address:_{/} ${String(w.address)}\n_Balance:_{/} ${w.nativeBalance}\n_Network:_{/} ${w.network}\n_Tx Count:_{/} ${w.nonce}`.replace(/_(.*?)_:/g, `{${C.cyan}-fg}$1:{/${C.cyan}-fg}`);
    this.walletBox.setContent(content);
    this.render();
  }

  setTokens(tokensArray = []) { this.tokens = tokensArray; this._drawTokensGrid(); this.render(); }
  updateStats(partial = {}) {
    if ('transactionCount' in partial) this.transactionCount = partial.transactionCount;
    if ('failedTx' in partial) this.failedTx = partial.failedTx;
    if ('pendingTx' in partial) this.pendingTx = partial.pendingTx;
    this._drawStats(); this._drawActivity(); this._drawStatus();
    this.render();
  }

  clearLogs() { this.logsBox.setContent(''); this.render(); }
  log(type = 'info', message = '') {
    const C = this.opts.colors;
    const LOGS = {
      success: { symbol: '[SUCCESS]', color: C.success }, error: { symbol: '[ERROR]', color: C.error },
      warning: { symbol: '[WARNING]', color: C.warning }, info: { symbol: '[INFO]', color: C.info },
      pending: { symbol: '[PENDING]', color: C.secondary }, completed: { symbol: '[DONE]', color: C.success },
      failed: { symbol: '[FAILED]', color: C.error }, swap: { symbol: '[SWAP]', color: C.cyan },
      liquidity: { symbol: '[LIQUID]', color: C.purple }, proxy: { symbol: '[PROXY]', color: C.cyan }
    };
    const cfg = LOGS[type] || LOGS.info;
    const ts = moment().format('HH:mm:ss');
    this.logsBox.log(`{grey-fg}[${ts}]{/} {${cfg.color}-fg}${cfg.symbol}{/} {${C.text}-fg}${message}{/}`);
    this._filelog(`[${ts}] ${cfg.symbol} ${message}`);
  }

  drawWalletList() {
    const C = this.opts.colors;
    const content = this.wallets.map((wallet, index) => {
      const prefix = index === this.activeWalletIndex ? `{${C.success}-fg}▶ ` : '  ';
      const color = index === this.activeWalletIndex ? C.success : C.text;
      return `${prefix}{${color}-fg}${wallet}{/}`;
    }).join('\n');
    this.walletListBox.setContent(content);
    this.render();
  }

  _setBannerFrame(text, font, colorHex) { this.banner.setContent(`{${colorHex}-fg}${figlet.textSync(text, { font, horizontalLayout: 'full' })}{/}`); }
  _animateBanner() {
    const colors = [this.opts.colors.primary, this.opts.colors.cyan, this.opts.colors.purple, this.opts.colors.secondary, this.opts.colors.orange, this.opts.colors.pink];
    let idx = 0;
    this._every(5000, () => {
      const text = this.bannerTexts[idx];
      this._setBannerFrame(text, this.bannerFont, colors[Math.floor(Math.random() * colors.length)]);
      idx = (idx + 1) % this.bannerTexts.length;
      this.render();
    });
  }

  _drawStats() {
    const C = this.opts.colors;
    this.statsBox.setContent(`{${C.success}-fg}Total Transactions:{/} ${this.transactionCount}\n{${C.error}-fg}Failed:{/} ${this.failedTx}\n{${C.secondary}-fg}Pending:{/} ${this.pendingTx}`);
  }
  _drawProxyStatus() {
    const C = this.opts.colors;
    const { enabled, current } = this.proxyStatus;
    const statusText = enabled ? `{${C.success}-fg}ON{/}` : `{${C.error}-fg}OFF{/}`;
    this.proxyBox.setContent(`Status: ${statusText} | Current: {${C.secondary}-fg}${enabled ? current : 'N/A'}{/}`);
  }
  _drawActivity() {
    const C = this.opts.colors;
    const lines = [this.isActive ? `{${C.success}-fg}[RUNNING] Menjalankan tugas...{/}` : `{${C.warning}-fg}[IDLE] Menunggu perintah...{/}`];
    if (this.pendingTx > 0) lines.push(`{${C.secondary}-fg}[PENDING] ${this.pendingTx} Tx sedang diproses...{/}`);
    this.activityBox.setContent(lines.join('\n'));
  }
  _drawStatus() {
    const C = this.opts.colors;
    const now = moment();
    const s = this.isActive ? `{${C.success}-fg}ACTIVE{/}` : `{${C.warning}-fg}IDLE{/}`;
    this.statusText.setContent(`{bold}Status:{/bold} ${s}  {bold}Time:{/bold} {${C.cyan}-fg}${now.format('HH:mm:ss')}{/}  {bold}Tx:{/bold} {${C.success}-fg}${this.transactionCount}{/}`);
  }
  _drawTokensGrid() {
    const C = this.opts.colors;
    if (this.tokens.length === 0) { this.tokenBox.setContent(`{${C.info}-fg}Tidak ada token.{/}`); return; }
    const items = this.tokens.map((t, i) => `{${[C.cyan, C.purple, C.orange, C.pink][i % 4]}-fg}${t.symbol || '-'}{/}: {white-fg}${String(t.balance ?? '0')}{/}`);
    this.tokenBox.setContent(items.slice(0, 2).join('\n') + '\n' + items.slice(2, 4).join('\n'));
  }
  _refreshAll() { this.updateWallet({}); this._drawTokensGrid(); this._drawStats(); this._drawProxyStatus(); this._drawActivity(); this._drawStatus(); this.render(); }
  _welcomeLogs() {
    this.log('info', '================================');
    this.log('success', `${this.opts.title}`);
    this.log('info', 'Pilih menu untuk memulai tugas.');
    this.log('info', '================================');
  }

  _every(ms, fn) { const id = setInterval(fn, ms); this._intervals.add(id); return id; }

  _buildTickerTape() {
    const w = this._viewportW || 80;
    const unit = `${this.tickerText1}   ${this.tickerText2}   `;
    this._tickerTape = ' '.repeat(w) + unit.repeat(Math.ceil(w * 4 / unit.length));
    const mask = new Array(this._tickerTape.length).fill(0);
    const mark = (needle, val) => { for (let i = this._tickerTape.indexOf(needle); i !== -1; i = this._tickerTape.indexOf(needle, i + 1)) mask.fill(val, i, i + needle.length); };
    mark(this.tickerText1, 1); mark(this.tickerText2, 2);
    this._tickerMask = mask;
  }

  _drawTickerFrame() {
    if (!this._viewportW || !this._tickerTape) return;
    const w = this._viewportW, N = this._tickerTape.length, start = this._scrollPos % N;
    const text = start + w > N ? this._tickerTape.slice(start) + this._tickerTape.slice(0, (start + w) % N) : this._tickerTape.slice(start, start + w);
    const mask = start + w > N ? this._tickerMask.slice(start).concat(this._tickerMask.slice(0, (start + w) % N)) : this._tickerMask.slice(start, start + w);
    let out = '', cur = 0, buf = '', open = (c) => `{${c === 1 ? this.tickerColor1 : this.tickerColor2}-fg}`, close = (c) => `{/${c === 1 ? this.tickerColor1 : this.tickerColor2}-fg}`;
    for (let i = 0; i < text.length; i++) {
      if (mask[i] !== cur) { out += cur === 0 ? buf : open(cur) + buf + close(cur); cur = mask[i]; buf = text[i]; } else { buf += text[i]; }
    }
    out += cur === 0 ? buf : open(cur) + buf + close(cur);
    this.tickerBox.setContent(out);
  }

  _startTicker() {
    this._every(this.tickerSpeed, () => {
      if (this._tickerPaused) return;
      this._scrollPos = (this._scrollPos + 1) % this._tickerTape.length;
      this._drawTickerFrame();
      this.render();
    });
  }
}

export default CryptoBotUI;