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
      demo: options.demo ?? false,
      controlled: options.controlled ?? true,
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
      menuItems: options.menuItems || [
        '1) Random Trade',
        '2) Random Add Position',
        '3) Deploy Token Contract',
        '4) Run All Features',
        '5) Wrap FOGO ? SPL FOGO',
        '6) Unwrap SPL FOGO ? FOGO',
        '7) Exit'
      ],
    };

    this.logFile = path.resolve(process.cwd(), options.logFile || process.env.LOG_FILE || 'transactions.log');
    this._logStream = fs.createWriteStream(this.logFile, { flags: 'a' });
    this._mirrorConsole = !!options.mirrorConsole;

    this.tickerSpeed  = Number(options.tickerSpeed || 200);
    this.tickerColor1 = options.tickerColor1 || 'cyan';
    this.tickerColor2 = options.tickerColor2 || 'yellow';
    const tArr = Array.isArray(options.tickerText) ? options.tickerText : [];
    this.tickerText1  = options.tickerText1 || tArr[0] || 'FOGO TESTNET';
    this.tickerText2  = options.tickerText2 || tArr[1] || 'Invictuslabs - Airdrops';

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
    this.successRate = 100;
    this.failedTx = 0;
    this.pendingTx = 0;
    this.currentGasPrice = 0;
    this._intervals = new Set();

    this.nativeSymbol = options.nativeSymbol || 'FOGO';
    this.walletData = { address: '-', nativeBalance: '-', network: '-', gasPrice: '-', nonce: '-' };
    this.tokens = Array.from({ length: 10 }).map(() => ({ enabled: true, name: '-', symbol: '-', balance: '-' }));

    this.screen = blessed.screen({
      smartCSR: true,
      fullUnicode: true,
      dockBorders: true,
      title: this.opts.title,
      cursor: { artificial: true, shape: 'line', blink: true, color: null }
    });
    this.screen.key(['escape', 'q', 'C-c'], () => this.destroy());

    this.banner = blessed.box({
      parent: this.screen,
      top: 0, left: 'center', width: '100%', height: 6,
      align: 'center', tags: true, content: '',
      style: { bg: C.background }
    });
    this._setBannerFrame(this.bannerTexts[0], this.bannerFont, C.primary);

    this.mainContainer = blessed.box({
      parent: this.screen, top: 6, left: 0, width: '100%', height: '100%-9',
      style: { bg: C.background }
    });

    this.walletBox = blessed.box({
      parent: this.mainContainer, label: ' Wallet Information ',
      top: 0, left: 0, width: '50%', height: '40%',
      border: { type: 'line' },
      style: { fg: C.text, border: { fg: C.primary }, label: { fg: C.primary, bold: true } },
      tags: true, padding: 1
    });

    this.tokenBox = blessed.box({
      parent: this.mainContainer, label: ' Token Information ',
      top: 0, left: '50%', width: '50%', height: '40%',
      border: { type: 'line' },
      style: { fg: C.text, border: { fg: C.secondary }, label: { fg: C.secondary, bold: true } },
      tags: true, padding: 1
    });

    this.menuBox = blessed.box({
      parent: this.mainContainer, label: ' Transaction Menu ',
      top: '40%', left: 0, width: '30%', height: '60%',
      border: { type: 'line' },
      style: { fg: C.text, border: { fg: C.info }, label: { fg: C.info, bold: true } }
    });

    this.transactionList = blessed.list({
      parent: this.menuBox, top: 0, left: 0, width: '100%-2', height: '100%-2',
      keys: true, vi: true, mouse: true, tags: true,
      scrollbar: { ch: ' ', track: { bg: C.background }, style: { bg: C.cyan } },
      style: { selected: { bg: C.info, fg: 'white', bold: true }, item: { hover: { bg: C.background } } },
      items: this.opts.menuItems
    });

    this.transactionList.on('select', (item, index) => {
      const label = (item?.content || '').replace(/\x1b\[[0-9;]*m/g, '');
      this.emit('menu:select', label, index);
    });

    this.statsBox = blessed.box({
      parent: this.mainContainer, label: ' Statistics ',
      top: '40%', left: '30%', width: '35%', height: '30%',
      border: { type: 'line' },
      style: { fg: C.text, border: { fg: C.orange }, label: { fg: C.orange, bold: true } },
      tags: true, padding: 1
    });

    this.logsBox = blessed.log({
      parent: this.mainContainer, label: ' Transaction Logs ',
      top: '40%', left: '65%', width: '35%', height: '60%',
      border: { type: 'line' },
      scrollable: true, alwaysScroll: true, mouse: true, keys: true, vi: true,
      scrollbar: { ch: ' ', track: { bg: C.background }, style: { bg: C.purple } },
      style: { fg: C.text, border: { fg: C.purple }, label: { fg: C.purple, bold: true } },
      tags: true
    });

    this.delayOverlay = blessed.text({
      parent: this.logsBox,
      bottom: 1, left: 1, width: '100%-2', height: 1,
      tags: true, content: '', style: { fg: this.opts.colors.cyan }, hidden: true
    });

    this.timerOverlay = blessed.text({
      parent: this.logsBox,
      bottom: 0, left: 1, width: '100%-2', height: 1,
      tags: true, content: '', style: { fg: this.opts.colors.secondary }, hidden: true
    });

    this.activityBox = blessed.box({
      parent: this.mainContainer, label: ' Activity Monitor ',
      top: '70%', left: '30%', width: '35%', height: '30%',
      border: { type: 'line' },
      style: { fg: C.text, border: { fg: C.pink }, label: { fg: C.pink, bold: true } },
      tags: true, padding: 1
    });

    this.tickerBox = blessed.box({
      parent: this.screen,
      bottom: 3, left: 0, width: '100%', height: 1,
      tags: true, style: { bg: C.background }
    });

    this.statusBar = blessed.box({
      parent: this.screen, bottom: 0, left: 0, width: '100%', height: 3,
      border: { type: 'line' },
      style: { fg: C.text, bg: C.background, border: { fg: C.cyan } },
      tags: true
    });
    this.statusText = blessed.text({ parent: this.statusBar, left: 1, top: 0, tags: true, content: '' });

    this._wireKeys();

    this._refreshAll();
    this.transactionList.focus();

    this._viewportW = Math.max(1, this.screen.width || 80);
    this._buildTickerTape();
    this._scrollPos = 0;
    this._drawTickerFrame();

    this._every(1000, () => { this._drawStatus(); this.render(); });
    this._startTicker();
    this._animateBanner();

    this.screen.on('resize', () => {
      this._viewportW = Math.max(1, this.screen.width || 80);
      this._buildTickerTape();
      this._scrollPos = 0;
      this._drawTickerFrame();
      this.render();
    });

    this._welcomeLogs();
    this._filelog('===== UI started =====');
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
  async promptText(label, initial = '') {
    const prompt = blessed.prompt({ parent: this.screen, keys: true, mouse: true, border: 'line', height: 'shrink', width: '60%', top: 'center', left: 'center', label: ' Input ', tags: true });
    return new Promise((resolve) => {
      prompt.input(`${label}`, initial, (err, value) => {
        try { prompt.destroy(); } catch {}
        if (err) return resolve(null);
        resolve(String(value || ''));
      });
    });
  }

  countdown(ms, label = 'Delay') {
    return new Promise((resolve) => {
      const start = Date.now();
      const end   = start + Math.max(0, Number(ms) || 0);
      this.delayOverlay.show();

      const tick = () => {
        const now = Date.now();
        const rem = Math.max(0, end - now);
        const s   = (rem / 1000);
        const text = `${label}: ${s.toFixed(1)}s remaining`;
        this.delayOverlay.setContent(`{${this.opts.colors.cyan}-fg}[PENDING]{/${this.opts.colors.cyan}-fg} {${this.opts.colors.orange}-fg}${text}{/${this.opts.colors.orange}-fg}`);
        this.render();
        if (rem <= 0) {
          clearInterval(id);
          this._intervals.delete(id);
          this.delayOverlay.hide();
          this.render();
          this.log('completed', `${label} finished`);
          resolve();
        }
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
      const ms = Date.now() - started;
      const sec = (ms / 1000);
      const mm = Math.floor(sec / 60).toString().padStart(2, '0');
      const ss = Math.floor(sec % 60).toString().padStart(2, '0');
      const dec = Math.floor((sec * 10) % 10);
      this.timerOverlay.setContent(`{${this.opts.colors.secondary}-fg}[PENDING]{/${this.opts.colors.secondary}-fg} ${label}: {${this.opts.colors.info}-fg}${mm}:${ss}.${dec}{/${this.opts.colors.info}-fg}`);
      this.render();
    };

    tick();
    const id = setInterval(tick, 100);
    this._intervals.add(id);

    return () => {
      try { clearInterval(id); } catch {}
      this._intervals.delete(id);
      this.timerOverlay.hide();
      this.render();
      this.log('completed', `${label} done`);
    };
  }

  _filelog(message) {
    try {
      const line = `[${new Date().toISOString()}] ${message}\n`;
      this._logStream.write(line);
    } catch (_) {}
  }
  setLogFile(newPath) {
    try { this._logStream?.end?.(); } catch (_) {}
    this.logFile = path.resolve(process.cwd(), newPath);
    this._logStream = fs.createWriteStream(this.logFile, { flags: 'a' });
    this._filelog('===== switched log file =====');
  }

  render() { try { this.screen?.render(); } catch (_) {} }
  destroy(code = 0) {
    for (const id of this._intervals) clearInterval(id);
    this._intervals.clear();
    try { this._filelog('===== UI destroyed ====='); } catch (_) {}
    try { this._logStream?.end?.(); } catch (_) {}
    try { this.screen?.destroy(); } catch (_) {}
    process.exit(code);
  }

  setMenu(items = []) {
    this.transactionList.setItems(items);
    this.transactionList.select(0);
    this.render();
  }
  setActive(active) {
    this.isActive = !!active;
    this._drawActivity();
    this._drawStatus();
    this.render();
  }
  setNativeSymbol(sym) {
    this.nativeSymbol = sym || this.nativeSymbol;
    this.updateWallet({});
  }
  setTokenColumns(n) {
    const cols = Math.max(1, Math.min(4, Number(n) || 2));
    this.opts.tokenColumns = cols;
    this._drawTokensGrid();
    this.render();
  }

  updateWallet(partial = {}) {
  Object.assign(this.walletData, partial);
  const C = this.opts.colors, w = this.walletData;
  const content =
    `{${C.cyan}-fg}Address:{/${C.cyan}-fg} ${String(w.address).substring(0, 20)}...\n` +
    `{${C.success}-fg}${this.nativeSymbol} Balance:{/${C.success}-fg} ${w.nativeBalance}\n` +
    `{${C.info}-fg}Network:{/${C.info}-fg} ${w.network}\n` +
    `{${C.purple}-fg}Gas Price:{/${C.purple}-fg} ${w.gasPrice}\n` +
    `{${C.orange}-fg}Tx Count:{/${C.orange}-fg} ${w.nonce}`;
  this.walletBox.setContent(content);
  this.render();
  }
  setTokens(tokensArray = []) {
    const arr = Array.from({ length: 10 }).map((_, i) => {
      const src = tokensArray[i] || {};
      return {
        enabled: !!src.enabled,
        name: src.name || '-',
        symbol: src.symbol || '-',
        balance: src.balance ?? '-'
      };
    });
    this.tokens = arr;
    this._drawTokensGrid();
    this.render();
  }
  updateTokenAt(index, partial = {}) {
    if (index < 0 || index > 9) return;
    const cur = this.tokens[index] || { enabled: false, name: '-', symbol: '-', balance: '-' };
    this.tokens[index] = { ...cur, ...partial };
    this._drawTokensGrid();
    this.render();
  }

  updateStats(partial = {}) {
    if ('transactionCount' in partial) this.transactionCount = partial.transactionCount;
    if ('successRate'      in partial) this.successRate      = partial.successRate;
    if ('failedTx'         in partial) this.failedTx         = partial.failedTx;
    if ('pendingTx'        in partial) this.pendingTx        = partial.pendingTx;
    if ('currentGasPrice'  in partial) this.currentGasPrice  = partial.currentGasPrice;
    this._drawStats();
    this._drawActivity();
    this._drawStatus();
    this.render();
  }

  clearLogs() { this.logsBox.setContent(''); this.render(); }
  log(type = 'info', message = '') {
    const C = this.opts.colors;
    const LOGS = {
      success:   { symbol: '[SUCCESS]',  color: C.success },
      error:     { symbol: '[ERROR]',    color: C.error },
      warning:   { symbol: '[WARNING]',  color: C.warning },
      info:      { symbol: '[INFO]',     color: C.info },
      pending:   { symbol: '[PENDING]',  color: C.secondary },
      completed: { symbol: '[DONE]',     color: C.success },
      failed:    { symbol: '[FAILED]',   color: C.error },
      swap:      { symbol: '[SWAP]',     color: C.cyan },
      liquidity: { symbol: '[LIQUID]',   color: C.purple },
      bridge:    { symbol: C.orange,     color: C.orange },
      stake:     { symbol: '[STAKE]',    color: C.pink },
      gas:       { symbol: '[GAS]',      color: C.warning }
    };
    const cfg = LOGS[type] || LOGS.info;
    const ts = moment().format('HH:mm:ss');
    const lineForFile = `[${ts}] ${cfg.symbol} ${message}`;
    this.logsBox.log(`{grey-fg}[${ts}]{/grey-fg} {${cfg.color}-fg}${cfg.symbol}{/${cfg.color}-fg} {${cfg.color}-fg}${message}{/${cfg.color}-fg}`);
    this._filelog(lineForFile);
    this.render();
  }

  _wireKeys() {
    this.screen.key(['s', 'S'], () => {
      this.setActive(!this.isActive);
      this.log(this.isActive ? 'success' : 'warning', this.isActive ? 'ACTIVE' : 'IDLE');
    });
    this.screen.key(['r', 'R'], () => { this._refreshAll(); this.render(); this.log('info','Redraw UI'); });
    this.screen.key(['c', 'C'], () => { this.clearLogs(); this.log('info','Logs cleared'); });
    this.screen.key(['t','T'], () => { this._tickerPaused = !this._tickerPaused; this.log('info', this._tickerPaused ? 'Ticker paused' : 'Ticker resumed'); });
    this.screen.key(['l','L'], () => { this.log('info', `Log file: ${this.logFile}`); });
  }

  _setBannerFrame(text, font, colorHex) {
    this.banner.setContent(
      `{${colorHex}-fg}` +
      figlet.textSync(text, { font: font || 'ANSI Shadow', horizontalLayout: 'default', verticalLayout: 'default' }) +
      `{/${colorHex}-fg}`
    );
  }
  _animateBanner() {
    const colors = [this.opts.colors.primary, this.opts.colors.cyan, this.opts.colors.purple, this.opts.colors.secondary, this.opts.colors.orange, this.opts.colors.pink];
    let idx = 0;
    this._every(5000, () => {
      const col = colors[Math.floor(Math.random() * colors.length)];
      const text = this.bannerTexts[idx];
      this._setBannerFrame(text, this.bannerFont, col);
      idx = (idx + 1) % this.bannerTexts.length;
      this.render();
    });
  }

  _drawStats() {
    const C = this.opts.colors;
    const content =
      `{${C.success}-fg}Total Transactions:{/${C.success}-fg} ${this.transactionCount}\n` +
      `{${C.info}-fg}Success Rate:{/${C.info}-fg} ${Number(this.successRate || 0).toFixed(1)}%\n` +
      `{${C.error}-fg}Failed:{/${C.error}-fg} ${this.failedTx}\n` +
      `{${C.secondary}-fg}Pending:{/${C.secondary}-fg} ${this.pendingTx}\n` +
      `{${C.cyan}-fg}Avg Gas:{/${C.cyan}-fg} ${this.currentGasPrice || 0} Gwei`;
    this.statsBox.setContent(content);
  }
  _drawActivity() {
    const C = this.opts.colors;
    const lines = [];
    if (this.isActive) {
      lines.push(`{${C.success}-fg}[RUNNING] Active{/${C.success}-fg}`);
      lines.push(`{${C.cyan}-fg}[MONITOR] Strategy{/${C.cyan}-fg}`);
    } else {
      lines.push(`{${C.warning}-fg}[IDLE] Waiting commands{/${C.warning}-fg}`);
    }
    if (this.pendingTx > 0) lines.push(`{${C.secondary}-fg}[PENDING] ${this.pendingTx} Tx Processing{/${C.secondary}-fg}`);
    this.activityBox.setContent(lines.join('\n'));
  }
  _drawStatus() {
    const C = this.opts.colors;
    const now = moment();
    const statusColor = this.isActive ? C.success : C.warning;
    const statusTextStr = this.isActive ? 'ACTIVE' : 'IDLE';
    const content =
      `{bold}Status:{/bold} {${statusColor}-fg}${statusTextStr}{/${statusColor}-fg}  ` +
      `{bold}Time:{/bold} {${C.cyan}-fg}${now.format('HH:mm:ss')}{/${C.cyan}-fg}  ` +
      `{bold}Date:{/bold} {${C.info}-fg}${now.format('DD/MM/YYYY')}{/${C.info}-fg}  ` +
      `{bold}Tx:{/bold} {${C.success}-fg}${this.transactionCount}{/${C.success}-fg}  ` +
      `{bold}Gas:{/bold} {${C.purple}-fg}${this.currentGasPrice || 0} Gwei`;
    this.statusText.setContent(content);
  }
  _drawTokensGrid() {
    const C = this.opts.colors;
    const enabled = this.tokens.filter(t => t && t.enabled);
    if (enabled.length === 0) {
      this.tokenBox.setContent(`{${C.info}-fg}No tokens enabled{/${C.info}-fg}`);
      return;
    }
    const tokenColors = [C.cyan, C.purple, C.orange, C.pink, C.secondary, C.success, C.error, C.info, C.warning, C.primary];
    const cols = Math.max(1, Math.min(4, this.opts.tokenColumns || 2));
    const items = enabled.map((t, i) => {
      const col = tokenColors[i % tokenColors.length];
      const label = `{${col}-fg}${t.name || '-'} (${t.symbol || '-'}){/${col}-fg}`;
      const bal = `{${col}-fg}${String(t.balance ?? '0')}{/${col}-fg}`;
      return `${label}: ${bal}`;
    });
    const stripTags = (s) => s.replace(/\{\/?[#a-z0-9]+\-[a-z]+\}/gi, '');
    const maxPlainLen = Math.max(...items.map(s => stripTags(s).length));
    const colWidth = Math.min(Math.max(maxPlainLen + 2, 22), 36);
    const rows = [];
    for (let i = 0; i < items.length; i += cols) {
      const slice = items.slice(i, i + cols);
      const line = slice.map(s => {
        const plainLen = stripTags(s).length;
        const padLen = Math.max(colWidth - plainLen, 0);
        return s + ' '.repeat(padLen);
      }).join(' ');
      rows.push(line);
    }
    this.tokenBox.setContent(rows.join('\n'));
  }

  _refreshAll() {
    this.updateWallet({});
    this._drawTokensGrid();
    this._drawStats();
    this._drawActivity();
    this._drawStatus();
    this._drawTickerFrame();
    this.render();
  }

  _welcomeLogs() {
    this.log('info', '================================');
    this.log('success', `${this.opts.title}`);
    this.log('info', 'Hotkeys: [S] active, [R] redraw, [C] clear, [T] ticker, [L] log path, [Q/ESC] exit');
    this.log('info', `Log file: ${this.logFile}`);
    this.log('info', '================================');
  }

  _every(ms, fn) {
    const id = setInterval(fn, ms);
    this._intervals.add(id);
    return id;
  }

  _buildTickerTape() {
    const w = this._viewportW || 80;
    const spacer = '   ';
    const leftPad  = ' '.repeat(w);
    const rightPad = ' '.repeat(w);

    const m1 = String(this.tickerText1);
    const m2 = String(this.tickerText2);

    const unit = m1 + spacer + m2 + spacer;

    let tape = leftPad + unit;
    while (tape.length < w * 4) tape += unit;
    tape += rightPad;

    const mask = new Array(tape.length).fill(0);
    const markAll = (haystack, needle, val) => {
      if (!needle || !needle.length) return;
      let i = 0;
      while (i <= haystack.length - needle.length) {
        const j = haystack.indexOf(needle, i);
        if (j === -1) break;
        for (let k = 0; k < needle.length; k++) mask[j + k] = val;
        i = j + Math.max(1, needle.length);
      }
    };
    markAll(tape, m1, 1);
    markAll(tape, m2, 2);

    this._tickerTape = tape;
    this._tickerMask = mask;
  }

  _drawTickerFrame() {
    const w = this._viewportW;
    if (!w || w <= 0 || !this._tickerTape) return;

    const N = this._tickerTape.length;
    const start = ((this._scrollPos % N) + N) % N;

    let sliceText, sliceMask;
    if (start + w <= N) {
      sliceText = this._tickerTape.slice(start, start + w);
      sliceMask = this._tickerMask.slice(start, start + w);
    } else {
      const endLen = (start + w) - N;
      sliceText = this._tickerTape.slice(start) + this._tickerTape.slice(0, endLen);
      sliceMask = this._tickerMask.slice(start).concat(this._tickerMask.slice(0, endLen));
    }

    let out = '';
    let cur = sliceMask[0] || 0;
    let buf = '';

    const open = (code) => code === 1 ? `{${this.tickerColor1}-fg}` : code === 2 ? `{${this.tickerColor2}-fg}` : '';
    const close = (code) => code === 1 ? `{/${this.tickerColor1}-fg}` : code === 2 ? `{/${this.tickerColor2}-fg}` : '';

    for (let i = 0; i < sliceText.length; i++) {
      const c = sliceText[i];
      const m = sliceMask[i] || 0;
      if (m === cur) buf += c;
      else {
        if (cur === 0) out += buf; else out += open(cur) + buf + close(cur);
        cur = m; buf = c;
      }
    }
    if (buf) out += (cur === 0 ? buf : open(cur) + buf + close(cur));

    this.tickerBox.setContent(out);
  }

  _startTicker() {
    this._every(this.tickerSpeed, () => {
      if (this._tickerPaused) return;
      this._scrollPos += 1;
      this._drawTickerFrame();
      this.render();
    });
  }
}

function pick(obj, keys) {
  const out = {};
  keys.forEach(k => { if (k in obj) out[k] = obj[k]; });
  return out;
}

export default CryptoBotUI;
export { CryptoBotUI };
