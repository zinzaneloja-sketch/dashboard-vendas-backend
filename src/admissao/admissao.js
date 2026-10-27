<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Zinzane · Admissão e Rescisão</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    color-scheme: light;
    --bg: #f5f5f7;
    --surface: #ffffff;
    --surface-2: #fbfbfd;
    --border: rgba(11,11,11,0.08);
    --text-primary: #1d1d1f;
    --text-secondary: #6e6e73;
    --text-muted: #98989d;
    --accent: #a32b57;
    --accent-ink: #ffffff;
    --accent-soft: rgba(163,43,87,0.10);
    --accent-2: #7f2144;
    --good: #0ca30c;
    --warning: #b8790a;
    --serious: #c05a34;
    --critical: #d03b3b;
    --series-1: #2a78d6;
    --series-2: #eb6834;
    --series-3: #1baf7a;
    --series-4: #c98500;
    --series-5: #c85c85;
    --series-6: #4a3aa7;
    --grid-line: #e5e4de;
    --shadow: 0 1px 2px rgba(0,0,0,0.04), 0 10px 28px rgba(0,0,0,0.06);
    --radius: 22px;
    --radius-sm: 14px;
    --btn-fill: #1d1d1f;
    --btn-fill-hover: #000000;
    --btn-fill-ink: #ffffff;
    --glass-bg: rgba(255,255,255,0.55);
    --glass-border: rgba(255,255,255,0.6);
    --font-body: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --bg: #000000;
      --surface: #1c1c1e;
      --surface-2: #222224;
      --border: rgba(255,255,255,0.09);
      --text-primary: #f5f5f7;
      --text-secondary: #aeaeb2;
      --text-muted: #8e8e93;
      --accent: #e8829f;
      --accent-ink: #1c0611;
      --accent-soft: rgba(232,130,159,0.16);
      --accent-2: #f1a4ba;
      --good: #34c759;
      --warning: #e0a527;
      --serious: #ec835a;
      --critical: #ff6b6b;
      --series-1: #3987e5;
      --series-2: #d9793f;
      --series-3: #2ec98e;
      --series-4: #e0a527;
      --series-5: #e18aab;
      --series-6: #9085e9;
      --grid-line: #2c2c2e;
      --shadow: 0 1px 2px rgba(0,0,0,0.4), 0 10px 28px rgba(0,0,0,0.5);
      --btn-fill: #f5f5f7;
      --btn-fill-hover: #ffffff;
      --btn-fill-ink: #0b0b0c;
      --glass-bg: rgba(28,28,30,0.55);
      --glass-border: rgba(255,255,255,0.14);
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg: #000000;
    --surface: #1c1c1e;
    --surface-2: #222224;
    --border: rgba(255,255,255,0.09);
    --text-primary: #f5f5f7;
    --text-secondary: #aeaeb2;
    --text-muted: #8e8e93;
    --accent: #e8829f;
    --accent-ink: #1c0611;
    --accent-soft: rgba(232,130,159,0.16);
    --accent-2: #f1a4ba;
    --good: #34c759;
    --warning: #e0a527;
    --serious: #ec835a;
    --critical: #ff6b6b;
    --series-1: #3987e5;
    --series-2: #d9793f;
    --series-3: #2ec98e;
    --series-4: #e0a527;
    --series-5: #e18aab;
    --series-6: #9085e9;
    --grid-line: #2c2c2e;
    --shadow: 0 1px 2px rgba(0,0,0,0.4), 0 10px 28px rgba(0,0,0,0.5);
    --btn-fill: #f5f5f7;
    --btn-fill-hover: #ffffff;
    --btn-fill-ink: #0b0b0c;
    --glass-bg: rgba(28,28,30,0.55);
    --glass-border: rgba(255,255,255,0.14);
  }
  * { box-sizing: border-box; }
  html, body { background: var(--bg); }
  body { margin: 0; color: var(--text-primary); font-family: var(--font-body); -webkit-font-smoothing: antialiased; padding-bottom: 60px; }
  [hidden] { display: none !important; }
  button, input, select, textarea { font-family: var(--font-body); }
  h1, h2, h3, h4 { margin: 0; font-weight: 700; letter-spacing: -0.01em; }
  p { margin: 0; }
  a { color: inherit; }

  /* ---------- topbar ---------- */
  .topbar { position: sticky; top: 0; z-index: 30; background: color-mix(in srgb, var(--bg) 82%, transparent); backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%); border-bottom: 1px solid var(--border); padding-top: env(safe-area-inset-top); }
  .topbar-in { max-width: 1240px; margin: 0 auto; padding: 10px 16px 0; }
  .row1 { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .brand .logo { height: 26px; width: auto; }
  .brand .sub { font-size: 12.5px; font-weight: 600; color: var(--text-secondary); white-space: nowrap; border-left: 1px solid var(--border); padding-left: 10px; }
  .actions { display: flex; align-items: center; gap: 8px; }
  .who { font-size: 12.5px; color: var(--text-secondary); max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pill { appearance: none; border: 1px solid var(--border); background: var(--surface-2); color: var(--text-primary); font-weight: 600; font-size: 12.5px; padding: 7px 13px; border-radius: 100px; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: 6px; transition: transform .12s ease-out, border-color .15s; white-space: nowrap; }
  .pill:active { transform: scale(0.97); }
  .pill:hover { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
  .pill.icon { padding: 7px 9px; }
  .pill svg { width: 15px; height: 15px; }
  .tabs { display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; margin-top: 8px; padding-bottom: 8px; -webkit-overflow-scrolling: touch; }
  .tabs::-webkit-scrollbar { display: none; }
  .tab { appearance: none; border: 0; background: transparent; color: var(--text-secondary); font-weight: 600; font-size: 13.5px; padding: 8px 14px; border-radius: 100px; cursor: pointer; white-space: nowrap; transition: background .15s, color .15s; }
  .tab:hover { color: var(--text-primary); }
  .tab[aria-selected="true"] { background: var(--text-primary); color: var(--bg); }
  .tab.new { margin-left: auto; background: var(--accent); color: var(--accent-ink); }
  .tab.new:hover { color: var(--accent-ink); filter: brightness(1.05); }

  @media (max-width: 640px) { .who, .brand .sub { display: none; } .brand .logo { height: 21px; } .topbar-in { padding-inline: 12px; } main { padding-inline: 12px !important; } }
  main { max-width: 1240px; margin: 0 auto; padding: 18px 16px 0; }
  .head { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
  .head h2 { font-size: 20px; }
  .head .cap { font-size: 12.5px; color: var(--text-secondary); margin-top: 2px; }

  /* ---------- cards & KPIs ---------- */
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 18px; }
  .card + .card { margin-top: 14px; }
  .card h3 { font-size: 14.5px; margin-bottom: 4px; }
  .card .cap { font-size: 12px; color: var(--text-secondary); margin-bottom: 12px; }
  .kpis { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 14px; }
  @media (min-width: 760px) { .kpis { grid-template-columns: repeat(5, 1fr); } }
  .kpi { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 14px 15px; box-shadow: var(--shadow); }
  .kpi .l { font-size: 11.5px; font-weight: 600; color: var(--text-secondary); }
  .kpi .v { font-size: 26px; font-weight: 800; letter-spacing: -0.02em; margin-top: 3px; font-variant-numeric: tabular-nums; }
  .kpi .s { font-size: 11.5px; color: var(--text-muted); margin-top: 1px; }
  .kpi.bad .v { color: var(--critical); }
  .kpi.warn .v { color: var(--warning); }

  /* ---------- chips ---------- */
  .chip { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 700; padding: 3px 9px; border-radius: 100px; background: var(--surface-2); color: var(--text-secondary); border: 1px solid var(--border); white-space: nowrap; }
  .chip.good { background: color-mix(in srgb, var(--good) 13%, transparent); color: var(--good); border-color: transparent; }
  .chip.bad { background: color-mix(in srgb, var(--critical) 13%, transparent); color: var(--critical); border-color: transparent; }
  .chip.warn { background: color-mix(in srgb, var(--warning) 15%, transparent); color: var(--warning); border-color: transparent; }
  .chip.acc { background: var(--accent-soft); color: var(--accent); border-color: transparent; }
  .chip.dark { background: var(--text-primary); color: var(--bg); border-color: transparent; }
  .chip.aer { background: color-mix(in srgb, #3b82f6 16%, transparent); color: color-mix(in srgb, #2563eb 70%, var(--text-primary)); border-color: transparent; }
  .chip.rod { background: color-mix(in srgb, #b7791f 14%, transparent); color: color-mix(in srgb, #92580a 65%, var(--text-primary)); border-color: transparent; }

  /* ---------- fluxo (15 etapas) ---------- */
  .flow { display: grid; gap: 14px; }
  .flow-group h4 { font-size: 11.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--text-muted); margin-bottom: 7px; font-weight: 700; }
  .flow-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(148px, 1fr)); gap: 8px; }
  .tile { appearance: none; text-align: left; cursor: pointer; background: var(--surface-2); border: 1.5px solid var(--border); border-radius: 14px; padding: 11px 12px; color: inherit; transition: transform .12s ease-out, border-color .15s, background .15s; position: relative; }
  .tile:active { transform: scale(0.98); }
  .tile .n { font-size: 11px; font-weight: 700; color: var(--text-muted); }
  .tile .nm { font-size: 12.5px; font-weight: 600; line-height: 1.25; margin: 2px 0 8px; min-height: 31px; }
  .tile .ct { font-size: 24px; font-weight: 800; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; line-height: 1; }
  .tile .ct small { font-size: 11px; font-weight: 600; color: var(--text-secondary); letter-spacing: 0; margin-left: 4px; }
  .tile .meta { font-size: 11px; color: var(--text-muted); margin-top: 5px; min-height: 14px; }
  .tile.has { background: var(--surface); border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); }
  .tile.late { border-color: var(--critical); background: color-mix(in srgb, var(--critical) 6%, var(--surface)); }
  .tile.late .meta { color: var(--critical); font-weight: 600; }
  .tile[aria-pressed="true"] { box-shadow: 0 0 0 3px var(--accent-soft); border-color: var(--accent); }

  /* ---------- lista de notas ---------- */
  .list { display: grid; gap: 10px; grid-template-columns: 1fr; }
  @media (min-width: 900px) { .list { grid-template-columns: 1fr 1fr; } }
  .nota { appearance: none; width: 100%; text-align: left; color: inherit; cursor: pointer; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 14px 15px; box-shadow: var(--shadow); transition: transform .12s ease-out, border-color .15s; display: block; }
  .nota:hover { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
  .nota:active { transform: scale(0.99); }
  .nota.late { border-left: 4px solid var(--critical); }
  .nota .t { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
  .nota .nf { font-weight: 800; font-size: 15px; }
  .nota .fo { font-size: 12.5px; color: var(--text-secondary); margin-top: 1px; }
  .nota .et { font-size: 13px; font-weight: 600; margin-top: 10px; }
  .nota .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
  .bar { height: 6px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; margin-top: 10px; overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--good); border-radius: 10px; }
  .bar i.warn { background: var(--warning); }
  .bar i.bad { background: var(--critical); }
  .empty { text-align: center; padding: 34px 14px; color: var(--text-secondary); font-size: 13.5px; }
  .filters { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; align-items: center; }
  .input, .select, .textarea { appearance: none; border: 1px solid var(--border); background: var(--surface); color: var(--text-primary); border-radius: 12px; padding: 11px 12px; font-size: 16px; outline: none; width: 100%; transition: border-color .15s, box-shadow .15s; }
  .select { padding-right: 30px; background-image: linear-gradient(45deg, transparent 50%, var(--text-secondary) 50%), linear-gradient(135deg, var(--text-secondary) 50%, transparent 50%); background-position: calc(100% - 17px) 50%, calc(100% - 12px) 50%; background-size: 5px 5px; background-repeat: no-repeat; }
  .input:focus, .select:focus, .textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .textarea { min-height: 70px; resize: vertical; }
  .filters .input { max-width: 280px; }
  .filters .select { width: auto; }

  /* ---------- botões ---------- */
  .btn { appearance: none; border: 0; background: var(--btn-fill); color: var(--btn-fill-ink); font-weight: 700; font-size: 14.5px; padding: 13px 20px; border-radius: 100px; cursor: pointer; transition: transform .12s ease-out, opacity .15s; }
  .btn:active { transform: scale(0.98); }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn.acc { background: var(--accent); color: var(--accent-ink); }
  .btn.sec { background: var(--surface-2); color: var(--text-primary); border: 1px solid var(--border); font-weight: 600; }
  .btn.dng { background: transparent; color: var(--critical); border: 1px solid color-mix(in srgb, var(--critical) 40%, var(--border)); font-weight: 600; }
  .btn.sm { padding: 8px 14px; font-size: 12.5px; }
  .btns { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
  .back { margin-bottom: 10px; }
  .lnk { appearance: none; border: 0; background: transparent; color: var(--critical); font-size: 12px; font-weight: 600; cursor: pointer; padding: 4px 0; margin-top: 2px; }
  .lnk:hover { text-decoration: underline; }

  /* ---------- nota (detalhe) ---------- */
  .nhead { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: center; justify-content: space-between; }
  .nhead h2 { font-size: 21px; }
  .nhead .sub { color: var(--text-secondary); font-size: 13px; margin-top: 2px; }
  .facts { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px 16px; margin-top: 14px; }
  @media (min-width: 760px) { .facts { grid-template-columns: repeat(5, 1fr); } }
  .fact .l { font-size: 11px; color: var(--text-muted); font-weight: 600; }
  .fact .v { font-size: 14.5px; font-weight: 700; margin-top: 1px; font-variant-numeric: tabular-nums; }
  .cols { display: grid; gap: 14px; grid-template-columns: minmax(0, 1fr); margin-top: 14px; }
  .cols > * { min-width: 0; }
  @media (min-width: 1000px) { .cols { grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); align-items: start; } }
  .cols .card + .card { margin-top: 14px; }
  .action { border: 1.5px solid color-mix(in srgb, var(--accent) 50%, var(--border)); }
  .action .st { font-size: 12.5px; font-weight: 600; margin: 2px 0 12px; }
  .help { font-size: 12.5px; color: var(--text-secondary); background: var(--surface-2); border-radius: 12px; padding: 10px 12px; margin-bottom: 12px; line-height: 1.45; }
  .field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
  .field > span { font-size: 12px; font-weight: 600; color: var(--text-secondary); }
  .grid2 { display: grid; gap: 0 12px; grid-template-columns: 1fr; }
  @media (min-width: 560px) { .grid2 { grid-template-columns: 1fr 1fr; } }

  .items { display: grid; gap: 8px; margin: 4px 0 12px; }
  .irow { background: var(--surface-2); border: 1px solid var(--border); border-radius: 14px; padding: 11px 12px; }
  .irow .ti { font-size: 13.5px; font-weight: 700; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .irow .ti span { font-weight: 500; color: var(--text-secondary); }
  .irow .flds { display: grid; gap: 8px 10px; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); }
  .irow label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; font-weight: 600; color: var(--text-secondary); }
  .irow .input { padding: 9px 10px; font-size: 16px; }
  .irow.diff { border-color: var(--critical); background: color-mix(in srgb, var(--critical) 5%, var(--surface-2)); }
  .irow .ref { font-size: 12px; color: var(--text-secondary); margin-bottom: 8px; display: flex; gap: 12px; flex-wrap: wrap; }
  .irow .ref b { color: var(--text-primary); font-variant-numeric: tabular-nums; }
  .toggle { display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 600; color: var(--text-primary); cursor: pointer; padding: 6px 0; }
  .toggle input { width: 24px; height: 24px; accent-color: var(--accent); }
  .add-row { display: grid; gap: 8px; grid-template-columns: 1fr 1fr 90px auto; align-items: end; margin-top: 6px; }
  @media (max-width: 600px) { .add-row { grid-template-columns: 1fr 1fr; } .add-row .btn { grid-column: 1 / -1; } }
  .add-row.sep { grid-template-columns: 1.4fr 1fr 80px auto; }
  @media (max-width: 600px) { .add-row.sep { grid-template-columns: 1fr 1fr; } .add-row.sep > label:first-child { grid-column: 1 / -1; } }
  .fcount { background: var(--surface-2); border: 1px solid var(--border); border-radius: 16px; padding: 14px; margin: 0 0 14px; }
  .fcount .frow { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .fcount .fnum b { font-size: 34px; font-weight: 800; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
  .fcount .fnum span { font-size: 13.5px; color: var(--text-secondary); font-weight: 600; margin-left: 4px; }
  .fcount .fbtns { display: flex; gap: 8px; }
  .fcount .fbtns .btn { padding: 14px 20px; }
  .fbar { height: 8px; border-radius: 10px; background: var(--border); overflow: hidden; margin-top: 12px; }
  .fbar i { display: block; height: 100%; width: 0; background: var(--accent); border-radius: 10px; transition: width .25s ease-out; }
  .fbar.ok i { background: var(--good); }
  .fbar.over i { background: var(--critical); }
  .nfstrip { margin: 0 0 14px; }
  .nfchips { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; -webkit-overflow-scrolling: touch; scrollbar-width: thin; }
  .nfchip { appearance: none; flex: none; text-align: left; cursor: pointer; color: var(--text-primary); background: var(--surface-2); border: 1px solid var(--border); border-radius: 12px; padding: 8px 12px; display: flex; flex-direction: column; gap: 2px; max-width: 220px; transition: border-color .15s, transform .12s ease-out; }
  .nfchip:active { transform: scale(0.97); }
  .nfchip:hover { border-color: var(--accent); }
  .nfchip b { font-size: 13px; }
  .nfchip span { font-size: 11px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .nfchip.ok { border-color: color-mix(in srgb, var(--good) 50%, var(--border)); background: color-mix(in srgb, var(--good) 8%, var(--surface-2)); }
  .nfchip.ok b { color: var(--good); }
  .addbox { background: var(--surface-2); border: 1px solid var(--border); border-radius: 16px; padding: 14px; margin-top: 6px; }
  .addbox .btn { width: 100%; }
  .tams { display: flex; flex-wrap: wrap; gap: 8px; }
  .qgrade { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 8px; margin: 0 0 14px; }
  .qrow { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-secondary); }
  .qrow b { font-size: 13px; color: var(--text-primary); }
  .qrow .input { padding: 10px 11px; }
  .tally { font-variant-numeric: tabular-nums; }
  .tam { appearance: none; min-width: 52px; padding: 11px 14px; border-radius: 12px; border: 1.5px solid var(--border); background: var(--surface); color: var(--text-primary); font-size: 15px; font-weight: 700; cursor: pointer; transition: background .12s, border-color .12s, transform .12s ease-out; }
  .tam:active { transform: scale(0.95); }
  .tam.on { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
  /* grade de tamanhos (igual à ficha de papel) e seletor de cor do catálogo */
  .sgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(86px, 1fr)); gap: 8px; margin: 0 0 12px; }
  .sgrid label { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--text-secondary); font-weight: 600; }
  .sgrid label b { font-size: 13px; color: var(--text-primary); }
  .sgrid label small { font-size: 10.5px; color: var(--text-muted); font-weight: 600; margin-left: 4px; }
  .sgrid .input { padding: 10px 10px; text-align: center; }
  .sgrid .on .input { border-color: var(--accent); background: var(--accent-soft); }
  .cpick { position: relative; }
  .cpick .opts { position: absolute; z-index: 20; left: 0; right: 0; top: calc(100% + 4px); background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); max-height: 260px; overflow-y: auto; }
  .cpick .opt { appearance: none; display: flex; width: 100%; gap: 10px; align-items: baseline; text-align: left; border: 0; background: transparent; color: var(--text-primary); padding: 10px 12px; font-size: 14px; cursor: pointer; }
  .cpick .opt:hover, .cpick .opt:focus { background: var(--accent-soft); outline: none; }
  .cpick .opt i { font-style: normal; font-variant-numeric: tabular-nums; color: var(--text-secondary); font-size: 12.5px; min-width: 44px; }
  .cpick .none { padding: 10px 12px; font-size: 12.5px; color: var(--text-secondary); }
  .cpick .sel { display: flex; align-items: center; justify-content: space-between; gap: 8px; border: 1.5px solid var(--good); background: color-mix(in srgb, var(--good) 8%, var(--surface)); border-radius: 12px; padding: 10px 12px; font-size: 14px; font-weight: 600; }
  .cpick .sel i { font-style: normal; color: var(--text-secondary); font-weight: 600; margin-right: 8px; font-variant-numeric: tabular-nums; }
  .cpick .sel button { appearance: none; border: 0; background: transparent; color: var(--text-secondary); font-size: 12px; font-weight: 700; cursor: pointer; }
  .irow .lbl { display: flex; flex-direction: column; gap: 4px; font-size: 11px; font-weight: 600; color: var(--text-secondary); grid-column: span 2; }
  .newcor { display: grid; grid-template-columns: 90px 1fr auto; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--border); }
  .grp.rec { border-color: var(--critical); }
  .rcg { border: 1px solid var(--border); border-radius: 12px; padding: 8px 10px; margin: 8px 0; background: var(--bg); }
  .rch { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 4px; flex-wrap: wrap; }
  .rcl { display: flex; align-items: center; gap: 10px; padding: 5px 0; border-top: 1px solid var(--border); font-size: 13px; }
  .rcl .rct { flex: 1; min-width: 100px; }
  .grp { border: 1px solid var(--border); border-radius: 14px; padding: 12px 14px; margin: 0 0 12px; background: var(--surface-2); }
  .grp h5 { margin: 0 0 4px; font-size: 13px; }
  .grp .cap { margin: 0 0 6px; }
  .sub3 { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12.5px; color: var(--text-secondary); margin: 2px 0 8px; }
  .sub3 b { color: var(--text-primary); font-variant-numeric: tabular-nums; }
  .irow .boas { grid-column: 1 / -1; font-size: 12.5px; color: var(--text-secondary); padding: 2px 0 0; }
  .irow.cont .flds { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .irow .flds .full { grid-column: 1 / -1; }
  .irow label.toggle { flex-direction: row; align-items: center; grid-column: 1 / -1; font-size: 13.5px; color: var(--text-primary); }
  .irow.cont .ti { flex-wrap: wrap; }
  .irow .boas b { color: var(--text-primary); }
  .sumbar { display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 10px; }
  .sumbar .chip b { font-variant-numeric: tabular-nums; }
  table.q.qprod td:first-child { min-width: 0; } table.q.qprod th, table.q.qprod td { padding-left: 5px; padding-right: 5px; } table.q.qprod td:nth-child(3), table.q.qprod th:nth-child(3) { text-align: center; } table.q.qprod td:nth-child(3) input { width: 22px; height: 22px; accent-color: var(--accent); }
  table.q td.sub, table.q th.sub { color: var(--warning); }
  table.fornec td:first-child { text-align: left; }
  .drop { appearance: none; width: 100%; display: flex; align-items: center; gap: 14px; text-align: left; cursor: pointer; color: inherit; background: var(--surface-2); border: 2px dashed color-mix(in srgb, var(--accent) 40%, var(--border)); border-radius: 16px; padding: 16px; transition: background .15s, border-color .15s; }
  .drop:hover, .drop.over { background: var(--accent-soft); border-color: var(--accent); }
  .drop .di { flex: none; width: 42px; height: 42px; border-radius: 50%; display: grid; place-items: center; background: var(--accent); color: var(--accent-ink); font-size: 20px; font-weight: 800; }
  .drop .dt { font-size: 14.5px; font-weight: 700; }
  .drop .ds { font-size: 12.5px; color: var(--text-secondary); margin-top: 2px; line-height: 1.4; }
  .scan { background: var(--surface-2); border: 2px solid color-mix(in srgb, var(--accent) 40%, var(--border)); border-radius: 16px; padding: 14px 16px; }
  .scan .scanh { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; font-size: 14.5px; }
  .scan .scanst { font-size: 12px; color: var(--text-muted); display: inline-flex; align-items: center; gap: 6px; }
  .scan .scanst::before { content: ""; width: 9px; height: 9px; border-radius: 50%; background: var(--text-muted); opacity: .5; }
  .scan .scanst.on { color: var(--good); font-weight: 700; }
  .scan .scanst.on::before { background: var(--good); opacity: 1; box-shadow: 0 0 0 4px color-mix(in srgb, var(--good) 22%, transparent); }
  .scan .scanin { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 16px; letter-spacing: .02em; }
  .scan:focus-within { border-color: var(--accent); background: var(--accent-soft); }
  .scan .scanok { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 2px; }
  .input.auto { border-color: var(--good); background: color-mix(in srgb, var(--good) 8%, var(--surface)); }
  .saved { font-size: 11.5px; color: var(--text-muted); height: 16px; margin-bottom: 4px; }
  .saved.ok { color: var(--good); }

  .conf { border-radius: 14px; padding: 12px 14px; margin: 10px 0; font-size: 13px; line-height: 1.5; }
  .conf.err { background: color-mix(in srgb, var(--critical) 10%, transparent); border: 1px solid color-mix(in srgb, var(--critical) 35%, transparent); }
  .conf.warn { background: color-mix(in srgb, var(--warning) 12%, transparent); border: 1px solid color-mix(in srgb, var(--warning) 35%, transparent); }
  .conf.good { background: color-mix(in srgb, var(--good) 11%, transparent); border: 1px solid color-mix(in srgb, var(--good) 35%, transparent); }
  .conf h5 { margin: 0 0 4px; font-size: 12.5px; }
  .conf ul { margin: 4px 0 0; padding-left: 18px; }

  /* ---------- timeline ---------- */
  .tl { display: grid; gap: 0; }
  .step { display: grid; grid-template-columns: 26px 1fr; gap: 10px; position: relative; padding-bottom: 12px; }
  .step::before { content: ""; position: absolute; left: 12px; top: 26px; bottom: -2px; width: 2px; background: var(--border); }
  .step:last-child::before { display: none; }
  .dot { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 800; background: var(--surface-2); border: 2px solid var(--border); color: var(--text-muted); z-index: 1; }
  .step.done .dot { background: var(--good); border-color: var(--good); color: #fff; }
  .step.doing .dot { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); box-shadow: 0 0 0 4px var(--accent-soft); }
  .step.wait .dot { border-color: var(--accent); color: var(--accent); }
  .step.div .dot { background: var(--warning); border-color: var(--warning); }
  .step .sh { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-height: 26px; }
  .step .sn { font-size: 13.5px; font-weight: 700; }
  .step.todo .sn { color: var(--text-muted); font-weight: 600; }
  .step .sw { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
  .step details { margin-top: 4px; }
  .step summary { font-size: 12px; color: var(--accent); cursor: pointer; font-weight: 600; }
  .kv { font-size: 12.5px; margin-top: 6px; display: grid; gap: 3px; }
  .kv b { font-weight: 600; color: var(--text-secondary); }

  table.q { width: 100%; border-collapse: collapse; font-size: 12.5px; font-variant-numeric: tabular-nums; }
  .qwrap { overflow-x: auto; margin: 0 -4px; padding: 0 4px; }
  table.q th { text-align: right; font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); font-weight: 700; padding: 6px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  table.q th:first-child, table.q td:first-child { text-align: left; }
  table.q td { text-align: right; padding: 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  table.q td:first-child { white-space: normal; min-width: 130px; font-weight: 600; }
  table.q td.neg { color: var(--critical); font-weight: 700; }
  table.q td.pos { color: var(--warning); font-weight: 700; }
  table.q tfoot td { font-weight: 800; border-bottom: 0; }

  .ev { font-size: 12.5px; padding: 8px 0; border-bottom: 1px solid var(--border); display: grid; grid-template-columns: 84px 1fr; gap: 8px; }
  .ev:last-child { border-bottom: 0; }
  .ev time { color: var(--text-muted); font-size: 11.5px; font-variant-numeric: tabular-nums; }
  .ev .u { color: var(--text-secondary); }
  .ev.alerta { background: color-mix(in srgb, var(--warning) 10%, transparent); border-radius: 8px; padding-left: 6px; }

  /* ---------- gargalos ---------- */
  .gtop { display: grid; gap: 10px; grid-template-columns: 1fr; }
  @media (min-width: 800px) { .gtop { grid-template-columns: repeat(3, 1fr); } }
  .gcard { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 14px 15px; box-shadow: var(--shadow); }
  .gcard .rk { font-size: 11px; font-weight: 800; color: var(--critical); text-transform: uppercase; letter-spacing: .06em; }
  .gcard h4 { font-size: 14.5px; margin: 4px 0 2px; }
  .gcard p { font-size: 12.5px; color: var(--text-secondary); line-height: 1.45; margin-top: 6px; }
  .gcard.nogap { text-align: center; color: var(--text-secondary); font-size: 13.5px; grid-column: 1 / -1; padding: 22px; }
  .hb { display: grid; grid-template-columns: minmax(120px, 190px) 1fr; gap: 6px 10px; align-items: center; }
  .hb .lb { font-size: 12.5px; font-weight: 600; line-height: 1.2; }
  .hb .lb small { display: block; font-weight: 500; color: var(--text-muted); font-size: 11px; }
  .hb .tr { position: relative; height: 24px; }
  .hb .seg { position: absolute; top: 3px; height: 18px; }
  .hb .seg.fila { background: var(--series-2); border-radius: 4px 0 0 4px; }
  .hb .seg.exec { background: var(--series-1); border-radius: 0 4px 4px 0; }
  .hb .seg.only { border-radius: 4px; }
  .hb .tot { position: absolute; top: 3px; height: 18px; display: flex; align-items: center; font-size: 11.5px; font-weight: 700; padding-left: 6px; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .hb .meta { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--text-primary); opacity: .75; }
  .legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; color: var(--text-secondary); margin-bottom: 12px; }
  .legend i { display: inline-block; width: 11px; height: 11px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
  .tbl { overflow-x: auto; }
  table.g { width: 100%; border-collapse: collapse; font-size: 12.5px; font-variant-numeric: tabular-nums; }
  table.g th { text-align: right; font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); padding: 6px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  table.g td { text-align: right; padding: 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  table.g th:first-child, table.g td:first-child { text-align: left; white-space: normal; min-width: 150px; font-weight: 600; }
  table.g td.bad { color: var(--critical); font-weight: 700; }

  /* ---------- faturamento e trânsito ---------- */
  .subtabs { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; margin: 0 0 14px; padding-bottom: 2px; }
  .subtabs::-webkit-scrollbar { display: none; }
  .pill.on { background: var(--text-primary); color: var(--bg); border-color: transparent; }
  .mfundo { position: fixed; inset: 0; z-index: 50; background: rgba(0,0,0,.45); display: flex; align-items: flex-start; justify-content: center; padding: 4vh 12px; overflow-y: auto; -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); }
  .mcaixa { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); width: 100%; max-width: 760px; padding: 18px; }
  .mtopo { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
  .mcaixa .cap { font-size: 12.5px; color: var(--text-secondary); margin: 6px 0 12px; line-height: 1.45; }
  .mtopo h3 { font-size: 16px; }
  .board { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(250px, 1fr); gap: 12px; overflow-x: auto; padding-bottom: 8px; margin-bottom: 14px; align-items: start; }
  @media (max-width: 700px) { .board { grid-auto-columns: 82%; scroll-snap-type: x mandatory; } .bcol { scroll-snap-align: start; } }
  .bcol { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px; display: flex; flex-direction: column; gap: 8px; min-height: 120px; }
  .bcol.bad { border-color: color-mix(in srgb, var(--critical) 45%, var(--border)); }
  .bcol.warn { border-color: color-mix(in srgb, var(--warning) 45%, var(--border)); }
  .bcol.good { border-color: color-mix(in srgb, var(--good) 40%, var(--border)); }
  .bcol { max-height: 72vh; overflow-y: auto; }
  .trc .cap { font-size: 12px; color: var(--text-secondary); }
  .trc .trt b { font-size: 13px; }
  .bh { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; padding: 2px 2px 4px; }
  .trc { appearance: none; text-align: left; width: 100%; cursor: pointer; color: inherit; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 10px 11px; transition: transform .12s ease-out, border-color .15s; font: inherit; }
  .trc:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
  .trc:active { transform: scale(0.985); }
  .trc.late { border-left: 4px solid var(--critical); }
  .trt { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 13px; }
  .trt b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .trl { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 4px; }
  .fpg { display: grid; grid-template-columns: 118px 1fr 104px; gap: 8px; align-items: center; margin: 5px 0; font-size: 12px; }
  .fpg .rot { color: var(--text-secondary); white-space: nowrap; }
  .fpg .tr { height: 16px; border-radius: 6px; background: var(--surface-2); overflow: hidden; }
  .fpg .tr i { display: block; height: 100%; border-radius: 6px; background: var(--accent); min-width: 2px; }
  .fpg.venc .tr i { background: var(--critical); }
  .fpg .val { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
  .barr { position: relative; height: 18px; border-radius: 100px; background: var(--surface-2); border: 1px solid var(--border); overflow: hidden; min-width: 90px; }
  .barr i { position: absolute; inset: 0 auto 0 0; background: var(--good); border-radius: 100px; }
  .barr span { position: relative; display: block; text-align: center; font-size: 11px; font-weight: 700; line-height: 16px; }
  table.g.tn td, table.g.tn th { padding: 6px 6px; }
  table.g.tn td:first-child, table.g.tn th:first-child { min-width: 0; }
  table.g.tn tr.falta td { background: color-mix(in srgb, var(--warning) 9%, transparent); }
  table.g.tn tr.sel td { background: var(--accent-soft); }
  table.g.tn .select, table.g.tn .input { font-size: 12.5px; padding: 6px 8px; }

  .toast { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%) translateY(20px); background: var(--text-primary); color: var(--bg); padding: 11px 18px; border-radius: 100px; font-size: 13.5px; font-weight: 600; opacity: 0; pointer-events: none; transition: opacity .2s, transform .2s; z-index: 60; max-width: 92vw; }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  .toast.err { background: var(--critical); color: #fff; }
  .foot { max-width: 1240px; margin: 26px auto 0; padding: 0 16px; font-size: 11.5px; color: var(--text-muted); line-height: 1.5; }
  .skel { height: 90px; border-radius: 16px; background: linear-gradient(90deg, var(--surface-2), var(--surface), var(--surface-2)); background-size: 200% 100%; animation: sk 1.2s infinite; }
  @keyframes sk { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
  @media (prefers-reduced-motion: reduce) { .skel { animation: none; } * { transition: none !important; } }

  /* ---------- chamados ---------- */
  .kpi.good .v { color: var(--good); }
  .ch-row { display: grid; gap: 4px 12px; grid-template-columns: 1fr; padding: 13px 15px; border: 1px solid var(--border); border-radius: 16px; background: var(--surface); margin-bottom: 8px; cursor: pointer; text-align: left; width: 100%; color: inherit; font: inherit; appearance: none; }
  .ch-row:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
  .ch-row.late { border-color: color-mix(in srgb, var(--critical) 45%, var(--border)); background: color-mix(in srgb, var(--critical) 4%, var(--surface)); }
  .ch-row.wait { border-color: color-mix(in srgb, var(--warning) 50%, var(--border)); }
  .ch-row .t { display: flex; gap: 8px; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; }
  .ch-row .p { font-weight: 800; font-size: 13px; letter-spacing: .02em; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
  .ch-row .a { font-weight: 700; font-size: 14.5px; }
  .ch-row .m { font-size: 12.5px; color: var(--text-secondary); line-height: 1.4; }
  .ch-row .chips { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: var(--text-muted); margin-right: 6px; vertical-align: middle; }
  .dot.ok { background: var(--good); } .dot.risco { background: var(--warning); } .dot.estourado { background: var(--critical); } .dot.pausado { background: var(--series-1); }
  .ch-grid { display: grid; gap: 14px; grid-template-columns: minmax(0, 1fr); align-items: start; }
  @media (min-width: 980px) { .ch-grid { grid-template-columns: minmax(0, 1fr) 330px; } }
  .msg { border: 1px solid var(--border); border-left-width: 4px; border-radius: 14px; padding: 12px 14px; background: var(--surface-2); margin-bottom: 10px; }
  .msg.loja { border-left-color: var(--series-1); }
  .msg.dp { border-left-color: var(--accent); }
  .msg.interno { border-left-color: var(--warning); background: color-mix(in srgb, var(--warning) 11%, var(--surface)); }
  .msg .mh { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--text-secondary); margin-bottom: 6px; }
  .msg .mh b { color: var(--text-primary); }
  .msg .mt { white-space: pre-wrap; word-break: break-word; font-size: 14px; line-height: 1.5; }
  .sys { text-align: center; font-size: 11.5px; color: var(--text-muted); margin: 6px 0 10px; }
  .anx { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
  .anx button, .anx .chip { cursor: pointer; font: inherit; }
  .fact { display: grid; grid-template-columns: 110px 1fr; gap: 4px 10px; font-size: 13px; margin: 0 0 4px; }
  .fact dt { color: var(--text-secondary); font-weight: 600; } .fact dd { margin: 0; word-break: break-word; }
  .sla { margin-bottom: 12px; }
  .sla .l { display: flex; justify-content: space-between; gap: 8px; font-size: 12.5px; font-weight: 600; margin-bottom: 4px; }
  .sla .l span:last-child { color: var(--text-secondary); font-weight: 500; text-align: right; }
  .sla .bar i.pausa { background: var(--series-1); }
  .sla .bar i.ok2 { background: var(--good); }
  .assuntos { display: grid; gap: 8px; grid-template-columns: 1fr; }
  @media (min-width: 700px) { .assuntos { grid-template-columns: repeat(2, 1fr); } }
  .asc { text-align: left; appearance: none; border: 1.5px solid var(--border); background: var(--surface); border-radius: 14px; padding: 11px 13px; cursor: pointer; color: inherit; font: inherit; }
  .asc:hover { border-color: color-mix(in srgb, var(--accent) 50%, var(--border)); }
  .asc[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-soft); }
  .asc b { display: block; font-size: 14px; } .asc small { display: block; color: var(--text-secondary); font-size: 12px; margin-top: 2px; line-height: 1.35; }
  .asc .cat { font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--accent); margin-bottom: 2px; }
  .seg { display: inline-flex; border: 1px solid var(--border); border-radius: 100px; overflow: hidden; background: var(--surface-2); }
  .seg button { appearance: none; border: 0; background: transparent; padding: 8px 14px; font-weight: 600; font-size: 13px; color: var(--text-secondary); cursor: pointer; }
  .seg button[aria-pressed="true"] { background: var(--text-primary); color: var(--bg); }
  .seg button.urg[aria-pressed="true"] { background: var(--critical); color: #fff; }
  .hbar { display: grid; grid-template-columns: minmax(90px, 36%) 1fr 54px; gap: 10px; align-items: center; margin: 7px 0; font-size: 12.5px; }
  .hbar .lb { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-primary); }
  .hbar .tr { height: 14px; background: var(--surface-2); border-radius: 0 7px 7px 0; position: relative; border: 1px solid var(--border); border-left: 0; }
  .hbar .tr i { position: absolute; left: 0; top: -1px; bottom: -1px; border-radius: 0 7px 7px 0; background: var(--accent); min-width: 3px; }
  .hbar .vl { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
  .legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--text-secondary); margin-bottom: 6px; }
  .legend i { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
  .chart { position: relative; width: 100%; }
  .chart svg { width: 100%; height: auto; display: block; }
  .tip { position: absolute; pointer-events: none; background: var(--text-primary); color: var(--bg); padding: 6px 10px; border-radius: 8px; font-size: 12px; line-height: 1.4; white-space: nowrap; z-index: 5; transform: translate(-50%, -110%); box-shadow: var(--shadow); }
  .grid-ind { display: grid; gap: 14px; grid-template-columns: 1fr; }
  @media (min-width: 1000px) { .grid-ind.dois { grid-template-columns: 1fr 1fr; } }
  .grid-ind .card + .card { margin-top: 0; }
  table.q td.num, table.q th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .pct { font-weight: 700; } .pct.good { color: var(--good); } .pct.warn { color: var(--warning); } .pct.bad { color: var(--critical); }
  .hint { font-size: 12px; color: var(--text-secondary); line-height: 1.45; }
  .filechip { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; padding: 4px 6px 4px 10px; border: 1px solid var(--border); border-radius: 100px; background: var(--surface-2); }
  .filechip button { appearance: none; border: 0; background: transparent; cursor: pointer; font-size: 14px; color: var(--text-secondary); }
  .kpis.k6 { grid-template-columns: repeat(2, 1fr); }
  @media (min-width: 900px) { .kpis.k6 { grid-template-columns: repeat(6, 1fr); } }
  .grid-ind, .grid-ind > *, .ch-grid > * { min-width: 0; }
  .grid-ind, .grid-ind.dois { grid-template-columns: minmax(0, 1fr); }
  @media (min-width: 1000px) { .grid-ind.dois { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }

.q.aud th, .q.aud td { text-align: left; }

.insights { display: grid; gap: 8px; margin-top: 10px; }
.ins { display: flex; gap: 12px; align-items: flex-start; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--border); background: var(--surface-2, #f7f7f9); }
.ins-tag { flex: none; font-size: 10.5px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; padding: 3px 9px; border-radius: 100px; color: #fff; margin-top: 2px; min-width: 76px; text-align: center; }
.ins.critico .ins-tag { background: #d23b3b; } .ins.atencao .ins-tag { background: #c98a00; } .ins.info .ins-tag { background: #2f6fb2; } .ins.ok .ins-tag { background: #1a9d74; }
.ins.critico { border-color: color-mix(in srgb, #d23b3b 40%, var(--border)); }
.ins-tx { font-size: 13px; color: var(--text-secondary); line-height: 1.45; margin-top: 2px; }
@media (max-width: 640px) { .ins { flex-direction: column; gap: 6px; } }
  /* escolha do departamento na abertura do chamado */
  .deps { display: grid; gap: 8px; grid-template-columns: 1fr; margin-bottom: 4px; }
  @media (min-width: 700px) { .deps { grid-template-columns: repeat(3, 1fr); } }
  .dep { display: flex; gap: 12px; align-items: flex-start; text-align: left; appearance: none; border: 1.5px solid var(--border); background: var(--surface); border-radius: 16px; padding: 14px 14px; cursor: pointer; color: inherit; font: inherit; transition: border-color .15s, transform .12s ease-out; }
  .dep:hover { border-color: color-mix(in srgb, var(--accent) 50%, var(--border)); }
  .dep:active { transform: scale(0.985); }
  .dep[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-soft); box-shadow: 0 0 0 3px var(--accent-soft); }
  .dep b { display: block; font-size: 15px; }
  .dep small { display: block; color: var(--text-secondary); font-size: 12px; margin-top: 3px; line-height: 1.35; }
  .dep .dico { flex: none; width: 38px; height: 38px; border-radius: 12px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent); }
  .dep .dico svg { width: 20px; height: 20px; }

  /* cabeçalho em celulares estreitos: logo nunca é cortado */
  .brand { flex-shrink: 0; }
  .brand .logo { max-width: none; }
  @media (max-width: 640px) {
    .row1 { flex-wrap: wrap; row-gap: 8px; }
    .actions { gap: 5px; margin-left: auto; flex-wrap: nowrap; }
    .actions .pill { font-size: 12px; padding: 6px 9px; }
    .actions .pill.icon { padding: 6px 8px; }
  }

  /* ---------- admissão e rescisão ---------- */
  .segs { display: flex; gap: 3px; margin-top: 8px; }
  .segs i { flex: 1; height: 6px; border-radius: 4px; background: var(--surface-2); border: 1px solid var(--border); }
  .segs i.done { background: var(--good); border-color: transparent; }
  .segs i.cur { background: var(--accent); border-color: transparent; }
  .segs i.cur.estourado { background: var(--critical); } .segs i.cur.risco { background: var(--warning); } .segs i.cur.pausado { background: var(--series-1); }
  .steps { display: flex; flex-direction: column; }
  .et { display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 12px; position: relative; padding-bottom: 14px; }
  .et:not(:last-child)::before { content: ""; position: absolute; left: 14px; top: 32px; bottom: -2px; width: 2px; background: var(--border); }
  .et.concluida:not(:last-child)::before, .et.dispensada:not(:last-child)::before { background: color-mix(in srgb, var(--good) 55%, var(--border)); }
  .et .dot2 { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; font-weight: 800; font-size: 12.5px; border: 2px solid var(--border); background: var(--surface); color: var(--text-secondary); position: relative; z-index: 1; }
  .et.concluida .dot2 { background: var(--good); border-color: var(--good); color: #fff; }
  .et.dispensada .dot2 { background: var(--surface-2); color: var(--text-muted); }
  .et.atual .dot2 { border-color: var(--accent); color: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
  .et.atual.estourado .dot2 { border-color: var(--critical); color: var(--critical); box-shadow: 0 0 0 4px color-mix(in srgb, var(--critical) 14%, transparent); }
  .et.atual.risco .dot2 { border-color: var(--warning); color: var(--warning); box-shadow: 0 0 0 4px color-mix(in srgb, var(--warning) 16%, transparent); }
  .et .eb { min-width: 0; padding-top: 4px; }
  .et.atual .eb { background: var(--surface-2); border: 1px solid var(--border); border-radius: 14px; padding: 12px 14px; margin-top: -2px; }
  .et.aguardando .eb b { color: var(--text-secondary); }
  .et .et1 { display: flex; gap: 8px; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; font-size: 14px; }
  .et .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  @media (prefers-reduced-motion: no-preference) { .et .dot2 { transition: box-shadow .2s ease, background .2s ease; } }
  #tabs .tab.new { margin-left: auto; }
.fbox{margin-top:10px;padding:12px;border:1px solid var(--border);border-radius:12px;background:var(--surface-2)}
.fitem{padding:10px 0;border-top:1px solid var(--border)}
.fitem:first-of-type{border-top:0}
</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-in">
    <div class="row1">
      <div class="brand"><img class="logo" alt="Zinzane &amp; Co." src="data:image/png;base64,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" data-logo-light="data:image/png;base64,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" data-logo-dark="data:image/png;base64,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"><span class="sub">Admissão e Rescisão</span></div>
      <div class="actions">
        <span class="who" id="who"></span>
        <a class="pill" id="modLink" href="portal-zinzane.html">Módulos</a>
        <button class="pill icon" id="themeBtn" title="Alternar tema" aria-label="Alternar tema"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg></button>
        <button class="pill" id="pwBtn" type="button">Minha senha</button>
        <button class="pill" id="logout">Sair</button>
      </div>
    </div>
    <nav class="tabs" id="tabs" role="tablist"></nav>
  </div>
</header>
<main id="view"></main>
<div class="foot" id="foot"></div>
<div class="toast" id="toast" role="status"></div>
<script>
(function () {
  "use strict";
  var API = "https://dashboard-vendas-backend-production.up.railway.app";
  var TOKEN_KEY = "zinzane_token", THEME_KEY = "zinzane_theme", PORTAL = "portal-zinzane.html";
  var AD = "/api/admissao";
  var S = { token: null, user: null, eu: null, fil: { status: "abertos", tipo: "", responsavel: "", sla: "", q: "", com: "" }, indFil: { dias: 90, de: "", ate: "", tipo: "", loja_id: "", responsavel: "" }, cad: "etapas", cadTipo: "admissao" };
  var $ = function (id) { return document.getElementById(id); };
  var view = $("view");
  function lget(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lset(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function ldel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  // ---------- DOM (texto sempre como texto) ----------
  function h(tag, attrs) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === undefined || v === null || v === false) return;
      if (k === "class") n.className = v;
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), v);
      else if (k === "value") n.value = v;
      else if (k === "checked" || k === "disabled" || k === "hidden" || k === "selected") n[k] = !!v;
      else n.setAttribute(k, v === true ? "" : v);
    });
    for (var i = 2; i < arguments.length; i++) add(n, arguments[i]);
    return n;
  }
  function add(n, c) {
    if (c === undefined || c === null || c === false) return;
    if (Array.isArray(c)) return c.forEach(function (x) { add(n, x); });
    n.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  var toastT;
  function toast(msg, isErr) { var t = $("toast"); t.textContent = msg; t.className = "toast show" + (isErr ? " err" : ""); clearTimeout(toastT); toastT = setTimeout(function () { t.className = "toast"; }, isErr ? 5500 : 3200); }

  // ---------- formatação ----------
  var TZ = "America/Sao_Paulo";
  function fmtDT(v) { if (!v) return "—"; return new Date(v).toLocaleString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); }
  function fmtD(v) { if (!v) return "—"; var p = String(v).slice(0, 10).split("-"); return p[2] + "/" + p[1]; }
  function fmtN(n) { return n === null || n === undefined ? "—" : Number(n).toLocaleString("pt-BR"); }
  function dec1(n) { return String(Math.round(n * 10) / 10).replace(".", ","); }
  // minutos úteis -> texto: "45 min", "4 h", "2 dias úteis" (1 dia útil = 10 h de expediente)
  function fmtUt(m) {
    if (m === null || m === undefined) return "—";
    var a = Math.abs(m);
    if (a < 1) return "<1 min";
    if (a < 60) return Math.round(a) + " min";
    if (a < 600) return dec1(a / 60) + " h";
    var d = a / 600; return dec1(d) + (Math.round(d * 10) / 10 === 1 ? " dia útil" : " dias úteis");
  }
  function ago(v) {
    var s = (Date.now() - new Date(v).getTime()) / 1000;
    if (s < 90) return "agora"; if (s < 3600) return "há " + Math.round(s / 60) + " min"; if (s < 86400) return "há " + Math.round(s / 3600) + " h";
    var d = Math.round(s / 86400); return "há " + d + (d === 1 ? " dia" : " dias");
  }
  // ---------- API ----------
  function api(method, path, body) {
    return fetch(API + path, { method: method, headers: Object.assign({ Authorization: "Bearer " + S.token }, body ? { "Content-Type": "application/json" } : {}), body: body ? JSON.stringify(body) : undefined }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401) { ldel(TOKEN_KEY); location.href = PORTAL + "?m=admissao"; throw new Error("Sessão expirada."); }
        if (r.status === 403 && j.codigo === "trocar_senha") { trocarSenha(true); var et = new Error(j.error); et.codigo = j.codigo; throw et; }
        if (r.status === 403 && /m[oó]dulo/i.test(j.error || "")) { location.href = PORTAL + "?semacesso=admissao"; throw new Error(j.error); }
        if (!r.ok) { var e = new Error(j.error || "Erro " + r.status); e.status = r.status; throw e; }
        return j;
      });
    }, function () { throw new Error("Sem conexão com o servidor. Tente de novo."); });
  }
  var trocaAberta = false;
  // Troca de senha pelo próprio usuário. forcada = senha provisória: não dá para fechar nem usar o painel antes.
  function trocarSenha(forcada) {
    if (trocaAberta) return; trocaAberta = true;
    var atual = h("input", { class: "input", type: "password", autocomplete: "current-password" }), nova = h("input", { class: "input", type: "password", autocomplete: "new-password" }), conf = h("input", { class: "input", type: "password", autocomplete: "new-password" }), msg = h("div");
    var corpo = h("div", null,
      forcada ? h("div", { class: "conf warn", style: "margin-bottom:10px" }, "Você entrou com uma senha provisória. Crie a sua senha pessoal para continuar.") : null,
      campo(forcada ? "Senha provisória (a que você recebeu)" : "Senha atual", atual), campo("Senha nova", nova, "Pelo menos 10 caracteres, com letras e números. Não repita a anterior."), campo("Repita a senha nova", conf), msg,
      h("div", { class: "btns" }, h("button", { class: "btn acc", type: "button", onclick: function () {
        if (nova.value !== conf.value) return clear(msg).appendChild(h("div", { class: "conf err" }, "As senhas novas não são iguais."));
        api("POST", "/api/auth/trocar-senha", { atual: atual.value, nova: nova.value }).then(function (r) {
          S.token = r.token; lset(TOKEN_KEY, r.token); m.fechar(); trocaAberta = false;
          if (forcada) location.reload(); else toast("Senha alterada. Os outros aparelhos conectados foram desconectados.");
        }).catch(function (e) { clear(msg).appendChild(h("div", { class: "conf err" }, e.message)); });
      } }, "Salvar senha")));
    var m = abrirModal(forcada ? "Crie a sua senha" : "Alterar minha senha", corpo, 480, forcada);
    var fechar0 = m.fechar; m.fechar = function () { trocaAberta = false; fechar0(); };
    if (!forcada) { var fb = m.caixa.querySelector(".mtopo .pill"); if (fb) fb.onclick = m.fechar; }
    setTimeout(function () { atual.focus(); }, 50);
  }
  // ---------- tema ----------
  function applyTheme(t) { if (t) document.documentElement.setAttribute("data-theme", t); else document.documentElement.removeAttribute("data-theme"); var dark = t === "dark" || (!t && matchMedia("(prefers-color-scheme: dark)").matches); document.querySelectorAll(".logo").forEach(function (img) { var n = dark ? img.dataset.logoDark : img.dataset.logoLight; if (n && img.src !== n) img.src = n; }); }
  var theme = lget(THEME_KEY); applyTheme(theme);
  $("themeBtn").addEventListener("click", function () { var dark = theme === "dark" || (!theme && matchMedia("(prefers-color-scheme: dark)").matches); theme = dark ? "light" : "dark"; lset(THEME_KEY, theme); applyTheme(theme); });
  $("logout").addEventListener("click", function () { ldel(TOKEN_KEY); location.href = PORTAL; });

  // ---------- componentes ----------
  function head(titulo, cap, extra) { return h("div", { class: "head" }, h("div", null, h("h2", null, titulo), cap ? h("div", { class: "cap" }, cap) : null), extra || null); }
  function kpi(l, v, s, cls) { return h("div", { class: "kpi " + (cls || "") }, h("div", { class: "l" }, l), h("div", { class: "v" }, v), h("div", { class: "s" }, s || " ")); }
  function skeleton(n) { clear(view); for (var i = 0; i < (n || 3); i++) view.appendChild(h("div", { class: "skel", style: "margin-bottom:12px" })); }
  function erroTela(e) { clear(view); view.appendChild(h("div", { class: "card empty" }, e.message || "Não foi possível carregar.", h("div", { class: "btns", style: "justify-content:center" }, h("button", { class: "btn sec sm", onclick: route }, "Tentar de novo")))); }
  function campo(label, el, dica) { return h("div", { class: "field" }, h("span", null, label), el, dica ? h("div", { class: "hint" }, dica) : null); }
  function go(hash) { location.hash = hash; }
  function abrirModal(titulo, corpo, largura, trava) {
    var fundo = h("div", { class: "mfundo" }), caixa = h("div", { class: "mcaixa", style: largura ? "max-width:" + largura + "px" : "" });
    function fechar() { fundo.remove(); document.removeEventListener("keydown", tecla); }
    function tecla(e) { if (e.key === "Escape" && !trava) fechar(); }
    caixa.appendChild(h("div", { class: "mtopo" }, h("h3", null, titulo), trava ? null : h("button", { class: "pill", type: "button", onclick: fechar }, "Fechar")));
    caixa.appendChild(corpo); fundo.appendChild(caixa);
    if (!trava) fundo.addEventListener("mousedown", function (e) { if (e.target === fundo) fechar(); });
    document.addEventListener("keydown", tecla); document.body.appendChild(fundo);
    return { fechar: fechar, caixa: caixa };
  }

  // ---------- domínio ----------
  function ehGestor() { return S.eu && S.eu.papel === "gestor"; }
  function ehAdmin() { return S.eu && S.eu.admin; }
  function ehGo() { return S.eu && S.eu.papel === "go"; }
  function podeAprovar() { return ehGo() || ehGestor(); }
  var TIPO = { admissao: "Admissão", rescisao: "Rescisão" };
  var SIT = { estourado: ["Atrasado", "bad"], risco: ["Em risco", "warn"], ok: ["No prazo", "good"], pausado: ["Pausado", "acc"], concluido: ["Concluído", "good"], cancelado: ["Cancelado", ""] };
  var COM_ROT = { rh: "Com o RH", fora: "Fora do RH", go: "Aguardando a GO", devolvidos: "Devolvidos" };
  var STATUS_ROT = { em_andamento: "Em andamento", pausado: "Pausado", concluido: "Concluído", cancelado: "Cancelado" };
  function chipSit(p) { var s = SIT[p.situacao] || [p.situacao, ""]; return h("span", { class: "chip " + s[1] }, s[0]); }
  function chipTipo(t) { return h("span", { class: "chip " + (t === "admissao" ? "acc" : "dark") }, TIPO[t] || t); }
  function fmtData(v) { if (!v) return "—"; var p = String(v).slice(0, 10).split("-"); return p[2] + "/" + p[1] + "/" + p[0]; }
  function fmtDTY(v) { if (!v) return "—"; return new Date(v).toLocaleString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }); }
  function fmtPct(n) { return n === null || n === undefined ? "—" : String(Math.round(n * 10) / 10).replace(".", ",") + "%"; }
  function pctCls(p) { return p === null || p === undefined ? "" : p >= 90 ? "good" : p >= 75 ? "warn" : "bad"; }
  function diasUteis(min) { return Math.round((min / 600) * 100) / 100; }        // minutos úteis -> dias úteis
  function paraMin(dias) { return Math.round(Number(String(dias).replace(",", ".")) * 600); }
  function numTxt(n) { return String(n).replace(".", ","); }
  // "em 7 dias", "hoje", "há 2 dias"
  function qtdDias(n) { return n === 0 ? "hoje" : n > 0 ? "em " + n + (n === 1 ? " dia" : " dias") : "há " + Math.abs(n) + (n === -1 ? " dia" : " dias"); }
  function textoPrazoData(p) {
    var d = p.prazo_data; if (!d) return "";
    if (p.status === "cancelado") return "";
    if (!d.limite) return p.status === "concluido" ? "" : "Data de início ainda não definida";
    if (p.status === "concluido") return d.situacao === "cumprido" ? d.rotulo + ": " + fmtData(d.limite) + " (cumprido)" : d.rotulo + ": " + fmtData(d.limite) + " (concluído depois)";
    var r = p.tipo === "admissao" ? "Início do colaborador em " : "Prazo legal de pagamento até ";
    return r + fmtData(d.limite) + " (" + qtdDias(d.dias) + ")";
  }
  function classePrazoData(p) { var s = p.prazo_data && p.prazo_data.situacao; return p.status === "em_andamento" || p.status === "pausado" ? (s === "estourado" ? "color:var(--critical);font-weight:700" : s === "risco" ? "color:var(--warning);font-weight:700" : "") : ""; }
  function iconeTipo(t) { var d = document.createElement("span"); d.className = "dico"; d.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (t === "admissao" ? '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/>' : '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 11h-6"/>') + '</svg>'; return d; }
  function barraSla(titulo, s) {
    var pct = s.meta ? Math.min(100, Math.round((s.decorrido / s.meta) * 100)) : 0;
    var sit = s.situacao, cls = sit === "estourado" || sit === "descumprido" || sit === "descumprida" ? "bad" : sit === "risco" ? "warn" : sit === "pausado" ? "pausa" : sit === "cumprido" || sit === "cumprida" ? "ok2" : "";
    var txt;
    if (sit === "cumprido" || sit === "cumprida") txt = "cumprido em " + fmtUt(s.decorrido);
    else if (sit === "descumprido" || sit === "descumprida") txt = "levou " + fmtUt(s.decorrido) + " (meta " + fmtUt(s.meta) + ")";
    else if (sit === "cancelado") txt = "cancelado";
    else if (sit === "pausado" && s.restante >= 0) txt = "pausado, relógio parado";
    else if (s.restante < 0) txt = "estourou há " + fmtUt(-s.restante);
    else txt = "faltam " + fmtUt(s.restante);
    return h("div", { class: "sla" }, h("div", { class: "l" }, h("span", null, titulo), h("span", null, txt)),
      h("div", { class: "bar", title: fmtUt(s.decorrido) + " de " + fmtUt(s.meta) }, h("i", { class: cls, style: "width:" + Math.max(pct, 3) + "%" })),
      h("div", { class: "hint", style: "margin-top:3px" }, "Meta: " + fmtUt(s.meta) + " · usado: " + fmtUt(s.decorrido)));
  }
  function segs(p) {
    var box = h("div", { class: "segs", title: p.progresso.feitas + " de " + p.progresso.total + " etapas" });
    for (var i = 0; i < p.progresso.total; i++) {
      var c = i < p.progresso.feitas ? "done" : (i === p.progresso.feitas && (p.status === "em_andamento" || p.status === "pausado") ? "cur " + (p.etapa_atual ? p.etapa_atual.situacao : "") : "");
      box.appendChild(h("i", { class: c }));
    }
    return box;
  }
  function pessoa(p) { return p.responsavel_nome || p.responsavel || "sem responsável"; }

  // ====================================================================================
  // PROCESSOS (fila)
  // ====================================================================================
  function linhaProc(p) {
    var atrasado = p.situacao === "estourado";
    var ea = p.etapa_atual;
    var linhaEtapa;
    if (p.status === "pausado") linhaEtapa = "Pausado" + (p.pausa && p.pausa.motivo ? ": " + p.pausa.motivo : "") + (ea ? " · etapa " + (p.progresso.feitas + 1) + " de " + p.progresso.total + ": " + ea.nome : "");
    else if (p.status === "concluido") linhaEtapa = "Concluído em " + fmtDTY(p.concluido_em) + " · levou " + fmtUt(p.total.decorrido) + " (meta " + fmtUt(p.total.meta) + ")";
    else if (p.status === "cancelado") linhaEtapa = (p.desfecho_rotulo || "Cancelado") + (p.cancelado_motivo ? ": " + p.cancelado_motivo : "");
    else if (ea) linhaEtapa = "Etapa " + (p.progresso.feitas + 1) + " de " + p.progresso.total + ": " + ea.nome + " · " + (ea.restante < 0 ? "estourou há " + fmtUt(-ea.restante) : "faltam " + fmtUt(ea.restante));
    else linhaEtapa = "";
    var pd = textoPrazoData(p);
    return h("button", { class: "ch-row" + (atrasado ? " late" : ""), type: "button", onclick: function () { go("processo/" + p.id); } },
      h("div", { class: "t" }, h("div", null, h("div", { class: "p" }, p.protocolo), h("div", { class: "a" }, p.colaborador + (p.cargo && p.candidato_definido !== false ? " · " + p.cargo : ""))), h("div", { class: "chips" }, chipTipo(p.tipo), chipSit(p))),
      ea && p.status === "em_andamento" ? h("div", { class: "chips", style: "margin-top:4px" }, h("span", { class: "chip " + (ea.externo ? "acc" : "dark") }, (ea.externo ? "Fora do RH · " + (ea.area || "") : "Com o RH" + (ea.area && ea.area !== "RH" ? " · " + ea.area : ""))), ea.voltas > 0 ? h("span", { class: "chip warn" }, "devolvido " + ea.voltas + (ea.voltas === 1 ? " vez" : " vezes")) : null, ea.acao === "aprovacao" ? h("span", { class: "chip warn" }, "aguardando aprovação") : null) : null,
      h("div", { class: "m" }, p.unidade + (p.subtipo ? " · " + p.subtipo : "") + " · responsável: " + pessoa(p)),
      linhaEtapa ? h("div", { class: "m", style: atrasado && p.etapa_atual && p.etapa_atual.situacao === "estourado" ? "color:var(--critical);font-weight:700" : p.situacao === "risco" ? "color:var(--warning);font-weight:700" : "" }, linhaEtapa) : null,
      pd ? h("div", { class: "m", style: classePrazoData(p) }, pd) : null,
      segs(p));
  }
  function viewFila() {
    skeleton(3);
    var f = S.fil;
    var qs = "?status=" + f.status + (f.tipo ? "&tipo=" + f.tipo : "") + (f.responsavel ? "&responsavel=" + encodeURIComponent(f.responsavel) : "") + (f.sla ? "&sla=" + f.sla : "") + (f.com ? "&com=" + f.com : "") + (f.q ? "&q=" + encodeURIComponent(f.q) : "") + "&limite=300";
    return Promise.all([api("GET", AD + "/processos" + qs), api("GET", AD + "/processos?status=abertos&limite=1000")]).then(function (rr) {
      var r = rr[0], todos = rr[1].processos;
      clear(view);
      if (ehGo()) view.appendChild(head("Vagas e admissões", "Aprove ou reprove as vagas e acompanhe cada admissão. O que está mais perto de estourar o prazo fica no topo."));
      else view.appendChild(head("Processos", "Admissões e rescisões de colaboradores. O que está mais perto de estourar o prazo fica no topo.", h("div", { class: "btns", style: "margin:0" }, h("button", { class: "btn sec sm", type: "button", onclick: exportarLista }, "Baixar Excel"), h("button", { class: "btn acc sm", type: "button", onclick: function () { go("novo"); } }, "+ Novo processo"))));
      var adm = todos.filter(function (x) { return x.tipo === "admissao"; }).length, res = todos.length - adm;
      var estour = todos.filter(function (x) { return x.situacao === "estourado"; }).length, risco = todos.filter(function (x) { return x.situacao === "risco"; }).length;
      var semResp = todos.filter(function (x) { return !x.responsavel; }).length, paus = todos.filter(function (x) { return x.status === "pausado"; }).length;
      var andando = todos.filter(function (x) { return x.status === "em_andamento" && x.etapa_atual; });
      var comRh = andando.filter(function (x) { return !x.etapa_atual.externo; }).length, foraRh = andando.length - comRh, naGo = andando.filter(function (x) { return x.etapa_atual.acao === "aprovacao"; }).length;
      if (ehGo()) view.appendChild(h("div", { class: "kpis" }, kpi("Aguardando a sua aprovação", fmtN(naGo), naGo ? "vagas esperando a GO" : "nenhuma vaga esperando", naGo ? "warn" : "good"), kpi("Admissões em andamento", fmtN(todos.length), "no total"), kpi("Atrasadas", fmtN(estour), estour ? "precisam de atenção" : "tudo dentro do prazo", estour ? "bad" : "good")));
      else view.appendChild(h("div", { class: "kpis" }, kpi("Em andamento", fmtN(todos.length), adm + (adm === 1 ? " admissão · " : " admissões · ") + res + (res === 1 ? " rescisão" : " rescisões")), kpi("Atrasados", fmtN(estour), estour ? "precisam de atenção agora" : "tudo dentro do prazo", estour ? "bad" : "good"),
        kpi("Em risco", fmtN(risco), "já usaram 80% do prazo", risco ? "warn" : ""), kpi("Com o RH", fmtN(comRh), "esperando ação do RH"), kpi("Fora do RH", fmtN(foraRh), naGo ? naGo + " na GO · loja, candidato ou clínica" : "GO, loja, candidato ou clínica"), kpi("Pausados", fmtN(paus), "aguardando terceiros"), kpi("Sem responsável", fmtN(semResp), semResp ? "atribua alguém" : "todos atribuídos", semResp ? "warn" : "")));
      var iq = h("input", { class: "input", type: "search", placeholder: "Buscar nome, protocolo, cargo ou loja", value: f.q });
      var tq; iq.addEventListener("input", function () { clearTimeout(tq); tq = setTimeout(function () { f.q = iq.value.trim(); viewFila().then(function () { var n = document.querySelector('input[type="search"]'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }); }, 350); });
      function sel(opts, val, on) { var s = h("select", { class: "select" }, opts.map(function (o) { return h("option", { value: o[0], selected: String(o[0]) === String(val) }, o[1]); })); s.addEventListener("change", function () { on(s.value); route(); }); return s; }
      var resp = [["", "Todos os responsáveis"], ["eu", "Só os meus"], ["sem", "Sem responsável"]].concat(S.eu.responsaveis.map(function (x) { return [x.email, x.nome]; }));
      if (ehGo()) view.appendChild(h("div", { class: "subtabs" }, [["go", "Para aprovar"], ["abertos", "Em andamento"], ["fechados", "Encerradas"]].map(function (x) { var on = x[0] === "go" ? f.com === "go" : (f.com !== "go" && x[0] === f.status); return h("button", { class: "pill" + (on ? " on" : ""), type: "button", onclick: function () { if (x[0] === "go") { f.status = "abertos"; f.com = "go"; } else { f.status = x[0]; f.com = ""; } route(); } }, x[1]); })));
      else view.appendChild(h("div", { class: "subtabs" }, [["abertos", "Em andamento"], ["fechados", "Encerrados"], ["todos", "Todos"]].map(function (x) { return h("button", { class: "pill" + (x[0] === f.status ? " on" : ""), type: "button", onclick: function () { f.status = x[0]; route(); } }, x[1]); })));
      if (ehGo()) view.appendChild(h("div", { class: "filters" }, sel([["", "Qualquer prazo"], ["atencao", "Atrasado ou em risco"], ["estourado", "Só atrasados"]], f.sla, function (v) { f.sla = v; }), iq));
      else view.appendChild(h("div", { class: "filters" },
        sel([["", "Admissões e rescisões"], ["admissao", "Só admissões"], ["rescisao", "Só rescisões"]], f.tipo, function (v) { f.tipo = v; }),
        sel([["", "Com quem está agora"], ["rh", "Com o RH"], ["fora", "Fora do RH (GO, loja, candidato, clínica)"], ["go", "Aguardando a GO"], ["devolvidos", "Devolvidos para correção"]], f.com, function (v) { f.com = v; }),
        sel(resp, f.responsavel, function (v) { f.responsavel = v; }),
        sel([["", "Qualquer prazo"], ["atencao", "Atrasado ou em risco"], ["estourado", "Só atrasados"]], f.sla, function (v) { f.sla = v; }), iq));
      if (!r.processos.length) { view.appendChild(h("div", { class: "card empty" }, f.status === "abertos" && !f.q && !f.tipo && !f.sla && !f.responsavel && !f.com ? "Nenhum processo em andamento." : f.com === "go" && ehGo() ? "Nenhuma vaga esperando a sua aprovação." : "Nenhum processo encontrado com esses filtros.", ehGo() ? null : h("div", { class: "btns", style: "justify-content:center" }, h("button", { class: "btn acc", type: "button", onclick: function () { go("novo"); } }, "Abrir um processo")))); return; }
      var lista = h("div", { class: "list" }); r.processos.forEach(function (p) { lista.appendChild(linhaProc(p)); }); view.appendChild(lista);
      if (r.total > r.processos.length) view.appendChild(h("div", { class: "hint", style: "text-align:center;margin-top:8px" }, "Mostrando " + r.processos.length + " de " + r.total + ". Use os filtros para refinar."));
      S.timer = setInterval(function () { if (document.visibilityState === "visible" && !document.querySelector(".mfundo") && document.activeElement && document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "SELECT") viewFila(); }, 90000);
    }).catch(erroTela);
  }

  // ====================================================================================
  // NOVO PROCESSO
  // ====================================================================================
  function viewNovo(editar) {
    skeleton(2);
    return api("GET", AD + "/etapas-modelo").then(function (cad) {
      clear(view);
      var eu = S.eu, tipo = null;
      view.appendChild(head("Novo processo", "Registre uma admissão ou uma rescisão. As etapas e os prazos vêm do cadastro e você acompanha cada uma até o fim."));
      var etapasBox = h("div", { class: "conf", style: "margin:0 0 12px" }); etapasBox.hidden = true;
      var tiposEl = h("div", { class: "deps", style: "grid-template-columns:1fr" });
      var f = {
        nome: h("input", { class: "input", maxlength: 120, autocomplete: "off" }), cpf: h("input", { class: "input", inputmode: "numeric", maxlength: 14, placeholder: "000.000.000-00", autocomplete: "off" }), cargo: h("input", { class: "input", maxlength: 100 }), solicitante: h("input", { class: "input", maxlength: 120, placeholder: "Gerente ou gestor da loja" }),
        data: h("input", { class: "input", type: "date" }), obs: h("textarea", { class: "textarea", rows: 3, maxlength: 1000, placeholder: "Opcional: algo que o DP precisa saber." }),
        subtipo: h("select", { class: "select" }), resp: h("select", { class: "select" }, eu.responsaveis.map(function (x) { return h("option", { value: x.email, selected: x.email.toLowerCase() === eu.email.toLowerCase() }, x.nome); })),
        loja: h("select", { class: "select" }, [h("option", { value: "" }, "Escolha a loja…")].concat(eu.lojas.map(function (l) { return h("option", { value: l.id }, l.nome); })).concat([h("option", { value: "outro" }, "Outro local (CD, escritório…)")])), unidade: h("input", { class: "input", maxlength: 120, placeholder: "Ex.: CD, Escritório" })
      };
      f.cpf.addEventListener("input", function () { var d = f.cpf.value.replace(/\D/g, "").slice(0, 11); f.cpf.value = d.replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d{1,2})$/, "$1-$2"); });
      var unBox = campo("Local de trabalho *", f.unidade); unBox.hidden = true;
      f.loja.addEventListener("change", function () { unBox.hidden = f.loja.value !== "outro"; });
      var rotData = h("span", null, "Data *"), dataBox = h("div", { class: "field" }, rotData, f.data, h("div", { class: "hint", id: "dicaData" }));
      var subBox = h("div", { class: "field" }, h("span", null, "Tipo *"), f.subtipo);
      var form = h("div", { class: "card" }), msg = h("div");
      var passo2 = h("div"); passo2.hidden = true;
      function escolher(t, btn) {
        tipo = t; Array.prototype.forEach.call(tiposEl.children, function (b) { b.setAttribute("aria-pressed", "false"); }); btn.setAttribute("aria-pressed", "true");
        rotData.textContent = t === "admissao" ? "Data de início do colaborador" : "Data do término do contrato *";
        nomeBox.firstChild.textContent = t === "admissao" ? "Nome do candidato" : "Nome completo *"; nomeDica.textContent = t === "admissao" ? "Se a vaga ainda está em aprovação e não tem candidato, deixe em branco. Informe antes de concluir a pré-admissão." : "";
        cargoBox.firstChild.textContent = t === "admissao" ? "Cargo da vaga *" : "Cargo"; solBox.hidden = t !== "admissao";
        subBox.firstChild.textContent = t === "admissao" ? "Tipo de contrato" : "Tipo de rescisão *";
        clear(f.subtipo); f.subtipo.appendChild(h("option", { value: "" }, t === "admissao" ? "Escolha (opcional)…" : "Escolha o tipo de rescisão…"));
        eu.subtipos[t].forEach(function (s) { f.subtipo.appendChild(h("option", { value: s }, s)); });
        dataBox.lastChild.textContent = t === "admissao" ? "Opcional agora. O processo precisa estar concluído até esse dia; informe antes de concluir a pré-admissão." : "Prazo legal para pagar as verbas e entregar os documentos: até " + eu.prazo_legal_dias + " dias corridos depois dessa data.";
        var et = cad.etapas.filter(function (x) { return x.tipo === t && x.ativo; }), tot = cad.totais[t].definido || cad.totais[t].soma;
        clear(etapasBox); etapasBox.appendChild(h("div", null, h("b", null, et.length + " etapas · prazo total " + fmtUt(tot)), ": " + et.map(function (x) { return x.nome; }).join(" → ")));
        etapasBox.hidden = false; passo2.hidden = false; f.nome.focus();
      }
      ["admissao", "rescisao"].forEach(function (t) {
        var b = h("button", { class: "dep", type: "button", "aria-pressed": "false", onclick: function () { escolher(t, b); } }, iconeTipo(t), h("span", null, h("b", null, t === "admissao" ? "Admissão de colaborador" : "Rescisão de colaborador"), h("small", null, t === "admissao" ? "Contratação: aprovação da vaga pela GO, documentos, exame admissional, contrato e boas-vindas." : "Desligamento: exame demissional, baixas, cálculo, pagamento dos valores e eSocial."))); tiposEl.appendChild(b);
      });
      form.appendChild(h("h3", null, "1. O que você vai registrar?")); form.appendChild(tiposEl);
      passo2.appendChild(h("h3", { style: "margin-top:18px" }, "2. Dados do colaborador"));
      passo2.appendChild(h("div", { class: "cap" }, "Só o necessário para acompanhar o processo. Salário e documentos ficam no sistema do DP."));
      passo2.appendChild(etapasBox);
      var nomeBox = campo("Nome completo *", f.nome), nomeDica = h("div", { class: "hint" }); nomeBox.appendChild(nomeDica);
      var cargoBox = campo("Cargo", f.cargo), solBox = campo("Quem pediu a vaga", f.solicitante, "Opcional. Gerente ou gestor da loja que abriu a demanda."); solBox.hidden = true;
      passo2.appendChild(h("div", { class: "grid2" }, nomeBox, campo("CPF", f.cpf, "Opcional. Evita abrir o mesmo processo duas vezes.")));
      passo2.appendChild(h("div", { class: "grid2" }, cargoBox, campo("Loja ou local *", f.loja)));
      passo2.appendChild(solBox);
      passo2.appendChild(unBox);
      passo2.appendChild(h("div", { class: "grid2" }, dataBox, subBox));
      passo2.appendChild(h("div", { class: "grid2" }, campo("Responsável pelo processo", f.resp), h("div")));
      passo2.appendChild(campo("Observação", f.obs)); passo2.appendChild(msg);
      var enviar = h("button", { class: "btn acc", type: "button" }, "Abrir processo");
      enviar.addEventListener("click", function () {
        clear(msg); enviar.disabled = true; enviar.textContent = "Abrindo…";
        var corpo = { tipo: tipo, colaborador: f.nome.value, cpf: f.cpf.value, cargo: f.cargo.value, solicitante: f.solicitante.value, data_prevista: f.data.value, subtipo: f.subtipo.value, observacao: f.obs.value, responsavel: f.resp.value };
        if (f.loja.value === "outro") corpo.unidade = f.unidade.value; else corpo.loja_id = f.loja.value;
        api("POST", AD + "/processos", corpo).then(function (r) { toast("Processo " + r.protocolo + " aberto."); go("processo/" + r.id); })
          .catch(function (e) { msg.appendChild(h("div", { class: "conf err" }, e.message)); enviar.disabled = false; enviar.textContent = "Abrir processo"; });
      });
      passo2.appendChild(h("div", { class: "btns" }, enviar, h("button", { class: "btn sec", type: "button", onclick: function () { go("processos"); } }, "Cancelar")));
      form.appendChild(passo2); view.appendChild(form);
    }).catch(erroTela);
  }

  // ====================================================================================
  // UM PROCESSO
  // ====================================================================================
  function pedirMotivo(titulo, explica, rotulo, botao, onOk, perigo, minimo) {
    var motivo = h("textarea", { class: "textarea", rows: 3, maxlength: 300, placeholder: "Escreva aqui…" }), msg = h("div");
    var ok = h("button", { class: "btn " + (perigo ? "dng" : "acc"), type: "button" }, botao);
    var corpo = h("div", null, explica ? h("div", { class: "cap" }, explica) : null, campo(rotulo, motivo), msg, h("div", { class: "btns" }, ok, h("button", { class: "btn sec", type: "button", onclick: function () { m.fechar(); } }, "Voltar")));
    var m = abrirModal(titulo, corpo, 480);
    ok.addEventListener("click", function () {
      var t = motivo.value.trim(); if (t.length < (minimo || 5)) return clear(msg).appendChild(h("div", { class: "conf err" }, "Explique em poucas palavras (mínimo " + (minimo || 5) + " letras)."));
      ok.disabled = true; onOk(t, m, msg, ok);
    });
    setTimeout(function () { motivo.focus(); }, 50);
  }
  function chamar(metodo, caminho, corpo, m, msg, ok, textoOk) {
    return api(metodo, caminho, corpo).then(function () { if (m) m.fechar(); toast(textoOk || "Feito."); route(); }).catch(function (e) { if (msg) clear(msg).appendChild(h("div", { class: "conf err" }, e.message)); else toast(e.message, true); if (ok) ok.disabled = false; });
  }
  function copiar(txt) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(txt).then(function () { toast("Mensagem copiada."); }, function () { toast("Não foi possível copiar. Selecione o texto e copie.", true); });
    var t = h("textarea", { style: "position:fixed;opacity:0" }); t.value = txt; document.body.appendChild(t); t.select();
    try { document.execCommand("copy"); toast("Mensagem copiada."); } catch (e) { toast("Não foi possível copiar. Selecione o texto e copie.", true); }
    t.remove(); return Promise.resolve();
  }

  // ---- formulários: Link 1 (gerente) e Link 2 (candidato) ----
  var FORM_ROT = { pre: "Link 1 · pré-admissão (gerente)", adm: "Link 2 · admissão (candidato)" };
  var FORM_ST = { rascunho: "aguardando preenchimento", devolvido: "devolvido para correção", enviado: "enviado, aguardando conferência do RH", aprovado: "aprovado pelo RH" };
  function urlFormulario(token) { return new URL("formulario-zinzane.html", location.href).href.split("#")[0].split("?")[0] + "?t=" + token; }
  function gerarForm(p, tipo) { return api("POST", AD + "/processos/" + p.id + "/formularios/" + tipo).then(function (r) { return r.formulario; }); }
  function telefoneDoCandidato(p) {
    return api("GET", AD + "/processos/" + p.id + "/formularios/pre").then(function (r) {
      var it = r.formulario && r.formulario.itens.filter(function (x) { return x.chave === "telefone"; })[0];
      return it && it.valor ? it.valor : "";
    }).catch(function () { return ""; });
  }
  function msgComLink(p, e) {
    gerarForm(p, e.formulario).then(function (f) {
      return (e.formulario === "adm" ? telefoneDoCandidato(p) : Promise.resolve("")).then(function (tel) { modalMensagens(p, e.mensagem, { link: urlFormulario(f.token), telefone: tel }); });
    }).catch(function (er) { toast(er.message, true); });
  }
  function verArquivo(p, a) {
    var w = window.open("", "_blank");
    api("GET", AD + "/processos/" + p.id + "/formulario-arquivos/" + a.id).then(function (r) {
      var bin = atob(r.base64), bytes = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var url = URL.createObjectURL(new Blob([bytes], { type: r.mime }));
      if (w) w.location = url; else { var x = h("a", { href: url, download: r.nome }); document.body.appendChild(x); x.click(); x.remove(); }
    }).catch(function (er) { if (w) w.close(); toast(er.message, true); });
  }
  function tamArq(n) { return n > 1048576 ? (n / 1048576).toFixed(1).replace(".", ",") + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; }
  function modalConferir(p, tipo, revisar) {
    var corpo = h("div", null, h("div", { class: "cap" }, "Carregando…")), m = abrirModal(FORM_ROT[tipo], corpo, 660), F = null;
    function marcar(it, status, obs) {
      return api("POST", AD + "/processos/" + p.id + "/formulario-itens/" + it.id, { status: status, obs: obs }).then(function () { it.status = status; it.obs_rh = status === "incorreto" ? obs : null; desenha(); }).catch(function (er) { toast(er.message, true); });
    }
    function linha(it, pode) {
      var cor = it.status === "ok" ? "good" : it.status === "incorreto" ? "bad" : "";
      var vazio = it.kind === "arquivo" ? !it.arquivos.length : !(it.valor || "").trim();
      var conteudo = it.kind === "arquivo" ? (it.arquivos.length ? h("div", { class: "btns", style: "margin:4px 0 0" }, it.arquivos.map(function (a) { return h("button", { class: "btn sec sm", type: "button", onclick: function () { verArquivo(p, a); } }, "Abrir " + a.nome + " (" + tamArq(a.tamanho) + ")"); })) : h("div", { class: "hint", style: "margin:2px 0 0" }, "Nada enviado."))
        : h("div", { style: "margin-top:2px;word-break:break-word" }, it.kind === "data" && it.valor ? fmtData(it.valor) : it.valor || h("span", { class: "hint", style: "margin:0" }, "Não preenchido."));
      var obsIn = h("input", { class: "input", maxlength: 300, placeholder: "O que está incorreto? (ex.: foto cortada, falta o verso)", value: it.obs_rh || "" });
      var obsBox = h("div", { style: "display:flex;gap:6px;margin-top:6px" }, obsIn, h("button", { class: "btn dng sm", type: "button", onclick: function () { if (obsIn.value.trim().length < 3) return toast("Explique o que está incorreto.", true); marcar(it, "incorreto", obsIn.value.trim()); } }, "Marcar incorreto"));
      obsBox.hidden = it.status !== "incorreto" || !pode || true;
      var revisavel = pode && !(vazio && !it.obrigatorio);
      var acoes = revisavel ? h("div", { class: "btns", style: "margin:6px 0 0" },
        h("button", { class: "btn sm " + (it.status === "ok" ? "acc" : "sec"), type: "button", onclick: function () { marcar(it, "ok", null); } }, "Correto"),
        h("button", { class: "btn sm " + (it.status === "incorreto" ? "dng" : "sec"), type: "button", onclick: function () { obsBox.hidden = false; obsIn.focus(); } }, "Incorreto")) : null;
      if (pode && it.status === "incorreto") obsBox.hidden = false;
      return h("div", { class: "fitem" },
        h("div", { style: "display:flex;justify-content:space-between;gap:8px;align-items:flex-start" }, h("b", null, it.rotulo + (it.obrigatorio ? " *" : "")),
          it.status !== "pendente" ? h("span", { class: "chip " + cor }, it.status === "ok" ? "correto" : "incorreto") : (vazio && !it.obrigatorio ? h("span", { class: "chip" }, "opcional") : null)),
        conteudo, it.status === "incorreto" && it.obs_rh && !pode ? h("div", { class: "hint", style: "margin:4px 0 0;color:var(--critical)" }, "Apontado: " + it.obs_rh) : null, acoes, pode ? obsBox : null);
    }
    function desenha() {
      var pode = revisar && F.status === "enviado";
      clear(corpo);
      corpo.appendChild(h("div", { class: "cap" }, "Situação: " + FORM_ST[F.status] + (F.enviado_em ? " · enviado em " + fmtDTY(F.enviado_em) + (F.enviado_vezes > 1 ? " (" + F.enviado_vezes + "º envio)" : "") : "") + "."));
      if (pode) corpo.appendChild(h("div", { class: "hint", style: "margin:0 0 8px" }, "Abra cada documento e marque como correto ou incorreto (explique o que está errado). Para aprovar a etapa todos precisam estar corretos; se algo estiver errado, feche aqui e use \"Devolver para correção\"."));
      F.itens.forEach(function (it) { corpo.appendChild(linha(it, pode)); });
      var conf = F.itens.filter(function (x) { return x.status === "ok"; }).length, inc = F.itens.filter(function (x) { return x.status === "incorreto"; }).length;
      corpo.appendChild(h("div", { class: "btns" }, h("span", { class: "hint", style: "margin:0;align-self:center" }, conf + " de " + F.itens.length + " corretos" + (inc ? " · " + inc + " incorreto(s)" : "")), h("button", { class: "btn acc", type: "button", onclick: function () { m.fechar(); route(); } }, "Fechar")));
    }
    api("GET", AD + "/processos/" + p.id + "/formularios/" + tipo).then(function (r) {
      F = r.formulario; if (!F) { clear(corpo).appendChild(h("div", { class: "cap" }, "Nenhum formulário foi gerado para esta vaga ainda.")); return; }
      desenha();
    }).catch(function (er) { clear(corpo).appendChild(h("div", { class: "conf err" }, er.message)); });
  }
  // painel dentro da etapa: gerar o link, copiar/enviar, acompanhar o envio e conferir
  function formPanel(p, e) {
    var fs = p.formularios && p.formularios[e.formulario], valid = e.acao === "validacao", aberto = p.status === "em_andamento" || p.status === "pausado";
    var box = h("div", { class: "fbox" }, h("div", { class: "hint", style: "margin:0 0 4px;font-weight:700" }, FORM_ROT[e.formulario]));
    if (!valid) {
      if (e.atual && aberto) {
        if (!fs) {
          box.appendChild(h("div", { class: "hint", style: "margin:0 0 6px" }, "O sistema gera um link próprio para esta vaga. Quem receber preenche e anexa os documentos sem login; ao enviar, esta etapa conclui sozinha e a validação do RH começa."));
          box.appendChild(h("button", { class: "btn acc sm", type: "button", onclick: function () { gerarForm(p, e.formulario).then(function () { toast("Link gerado."); route(); }).catch(function (er) { toast(er.message, true); }); } }, "Gerar link do formulário"));
        } else {
          var url = urlFormulario(fs.token);
          box.appendChild(h("div", { class: "hint", style: "margin:0 0 4px" }, "Situação: " + FORM_ST[fs.status] + ". Mande o link para " + (e.formulario === "pre" ? "o gerente da loja" : "o candidato") + "."));
          var inp = h("input", { class: "input", readonly: "readonly", value: url, onfocus: function () { this.select(); } });
          box.appendChild(inp);
          box.appendChild(h("div", { class: "btns", style: "margin-top:6px" }, h("button", { class: "btn acc sm", type: "button", onclick: function () { copiar(url); } }, "Copiar link"), h("button", { class: "btn sec sm", type: "button", onclick: function () { msgComLink(p, e); } }, "Mensagem pronta com o link")));
        }
      } else if (fs && e.status === "concluida") {
        box.appendChild(h("div", { class: "hint", style: "margin:0 0 6px" }, "Enviado em " + fmtDTY(fs.enviado_em) + (fs.enviado_vezes > 1 ? " (" + fs.enviado_vezes + " envios)" : "") + "."));
        box.appendChild(h("button", { class: "btn sec sm", type: "button", onclick: function () { modalConferir(p, e.formulario, false); } }, "Ver o que foi enviado"));
      } else return null;
    } else if (fs && (fs.status !== "rascunho" || e.atual)) {
      var atualEnviado = e.atual && fs.status === "enviado";
      box.appendChild(h("div", { class: "hint", style: "margin:0 0 6px" }, atualEnviado ? "Enviado em " + fmtDTY(fs.enviado_em) + ". Confira cada documento antes de aprovar." : "Situação: " + FORM_ST[fs.status] + "."));
      if (fs.status !== "rascunho") box.appendChild(h("button", { class: "btn " + (atualEnviado ? "acc" : "sec") + " sm", type: "button", onclick: function () { modalConferir(p, e.formulario, atualEnviado); } }, atualEnviado ? "Conferir documentos (" + fs.itens_ok + " de " + fs.itens + ")" : "Ver o que foi enviado"));
    } else if (e.atual) box.appendChild(h("div", { class: "hint", style: "margin:0" }, "Esta vaga foi aberta antes dos formulários, sem link gerado. Confira os documentos por fora e aprove ou devolva normalmente."));
    else return null;
    return box;
  }
  // modelos de mensagem: preenche com os dados do processo; nada disso é guardado
  function modalMensagens(p, chave, extra) {
    extra = extra || {};
    api("GET", AD + "/mensagens").then(function (r) {
      var sel = h("select", { class: "select" }, r.modelos.map(function (x) { return h("option", { value: x.chave, selected: x.chave === (chave || r.modelos[0].chave) }, x.titulo); }));
      var link = h("input", { class: "input", value: extra.link || "", placeholder: "Cole aqui o link do formulário" }), itens = h("input", { class: "input", value: extra.itens || "", placeholder: "Ex.: RG ilegível, comprovante de residência" }), motivo = h("input", { class: "input", value: extra.motivo || p.cancelado_motivo || "" });
      var linkBox = campo("Link do formulário", link), itensBox = campo("Itens a corrigir", itens), motivoBox = campo("Motivo", motivo);
      var texto = h("textarea", { class: "textarea", rows: 6 }), dest = h("div", { class: "hint", style: "margin:-4px 0 10px" });
      function monta() {
        var m = r.modelos.filter(function (x) { return x.chave === sel.value; })[0];
        var v = { nome: p.candidato_definido ? p.colaborador : "(nome do candidato)", cargo: p.cargo || "(cargo)", loja: p.unidade, data_inicio: p.data_prevista ? fmtData(p.data_prevista) : "(data a definir)", link: link.value.trim() || "[link]", itens: itens.value.trim() || "[itens a corrigir]", motivo: motivo.value.trim() || "[motivo]" };
        linkBox.hidden = m.texto.indexOf("{link}") < 0; itensBox.hidden = m.texto.indexOf("{itens}") < 0; motivoBox.hidden = m.texto.indexOf("{motivo}") < 0;
        texto.value = m.texto.replace(/\{(\w+)\}/g, function (x, k) { return v[k] !== undefined ? v[k] : x; });
        dest.textContent = "Para: " + m.destino + ".";
      }
      // o link da vaga entra sozinho nas mensagens de link (gerado na hora se ainda não existir)
      var FORM_DA_MSG = { link_pre: "pre", link_adm: "adm" };
      function autoLink() {
        var tipo = FORM_DA_MSG[sel.value]; if (!tipo || link.value.trim()) return;
        gerarForm(p, tipo).then(function (fm) { if (!link.value.trim()) { link.value = urlFormulario(fm.token); monta(); } }).catch(function () {});
        if (tipo === "adm" && !extra.telefone) telefoneDoCandidato(p).then(function (t) { if (t) extra.telefone = t; });
      }
      sel.addEventListener("change", autoLink);
      sel.addEventListener("change", monta); [link, itens, motivo].forEach(function (x) { x.addEventListener("input", monta); });
      var corpo = h("div", null, h("div", { class: "cap" }, "Escolha o modelo, complete o que faltar e copie para o WhatsApp ou o e-mail. O texto não fica guardado no sistema. O gestor edita os modelos em Cadastros."), campo("Mensagem", sel), dest, linkBox, itensBox, motivoBox, campo("Texto (pode ajustar antes de copiar)", texto),
        h("div", { class: "btns" }, h("button", { class: "btn acc", type: "button", onclick: function () { copiar(texto.value); } }, "Copiar"),
          h("button", { class: "btn sec", type: "button", onclick: function () { var tel = String(extra.telefone || "").replace(/\D/g, ""); if (tel && tel.length <= 11) tel = "55" + tel; window.open("https://wa.me/" + (tel.length >= 12 ? tel : "") + "?text=" + encodeURIComponent(texto.value), "_blank", "noopener"); } }, "Abrir no WhatsApp"),
          h("button", { class: "btn sec", type: "button", onclick: function () { m2.fechar(); } }, "Fechar")));
      var m2 = abrirModal("Mensagens prontas", corpo, 560); monta(); autoLink();
    }).catch(function (e) { toast(e.message, true); });
  }
  // O RH não aprova os documentos: volta para a etapa anterior (loja ou candidato corrige)
  function modalDevolver(p, e) {
    var ant = p.etapas[e.ordem - 2];
    var cat = h("select", { class: "select" }, S.eu.motivos_devolucao.map(function (x) { return h("option", { value: x }, x); }));
    var det = h("textarea", { class: "textarea", rows: 3, maxlength: 500, placeholder: "Ex.: RG ilegível; falta o comprovante de residência." }), msg = h("div");
    var ok = h("button", { class: "btn dng", type: "button" }, "Devolver para correção");
    var corpo = h("div", null, h("div", { class: "cap" }, "O processo volta para \"" + (ant ? ant.nome : "etapa anterior") + "\"" + (ant && ant.area ? " (" + ant.area + ")" : "") + " e esta validação volta para a fila do RH assim que o reenvio for registrado. A devolução entra nos indicadores de retrabalho."),
      campo("Motivo principal", cat), campo("O que está incorreto ou faltando? *", det), msg, h("div", { class: "btns" }, ok, h("button", { class: "btn sec", type: "button", onclick: function () { m.fechar(); } }, "Voltar")));
    var m = abrirModal("Devolver para correção", corpo, 520), tokenForm = null;
    if (e.formulario) api("GET", AD + "/processos/" + p.id + "/formularios/" + e.formulario).then(function (r) {
      if (!r.formulario) return; tokenForm = r.formulario.token;
      var apont = r.formulario.itens.filter(function (x) { return x.status === "incorreto"; }).map(function (x) { return x.rotulo + " (" + x.obs_rh + ")"; });
      if (apont.length && !det.value.trim()) det.value = apont.join("; ");
    }).catch(function () {});
    ok.addEventListener("click", function () {
      if (det.value.trim().length < 5) return clear(msg).appendChild(h("div", { class: "conf err" }, "Descreva o que precisa ser corrigido."));
      ok.disabled = true;
      api("POST", AD + "/processos/" + p.id + "/etapas/" + e.id + "/devolver", { motivo_cat: cat.value, detalhe: det.value.trim() }).then(function () { m.fechar(); toast("Devolvido para correção."); route(); modalMensagens(p, "correcao", { itens: det.value.trim(), link: tokenForm ? urlFormulario(tokenForm) : "" }); })
        .catch(function (er) { clear(msg).appendChild(h("div", { class: "conf err" }, er.message)); ok.disabled = false; });
    });
    setTimeout(function () { det.focus(); }, 50);
  }
  function checklist(p, e) {
    var ativo = e.atual && p.status === "em_andamento" && !ehGo();
    var box = h("div", { class: "chk", style: "margin-top:8px" }, h("div", { class: "hint", style: "margin:0 0 2px;font-weight:700" }, "Checklist: " + e.subtarefas_feitas + " de " + e.subtarefas.length));
    e.subtarefas.forEach(function (t) {
      var cb = h("input", { type: "checkbox", checked: t.feita, disabled: !ativo });
      cb.addEventListener("change", function () {
        cb.disabled = true;
        api("POST", AD + "/processos/" + p.id + "/etapas/" + e.id + "/tarefa", { indice: t.indice, feita: cb.checked }).then(function () { route(); }).catch(function (er) { toast(er.message, true); cb.checked = !cb.checked; cb.disabled = false; });
      });
      box.appendChild(h("label", { style: "display:flex;gap:8px;align-items:center;font-size:13px;padding:2px 0" }, cb, h("span", { style: t.feita ? "text-decoration:line-through;opacity:.7" : "" }, t.nome), t.feita && t.feita_por ? h("span", { class: "hint", style: "margin:0" }, "· " + String(t.feita_por).split("@")[0] + ", " + fmtDTY(t.feita_em)) : null));
    });
    return box;
  }
  function modalConcluir(p, e) {
    var final = e.ordem === p.etapas[p.etapas.length - 1].ordem, aprov = e.acao === "aprovacao", valid = e.acao === "validacao", aso = e.acao === "aso";
    var obs = h("textarea", { class: "textarea", rows: 3, maxlength: 500, placeholder: aprov ? "Opcional: observação da aprovação." : aso ? "Opcional: quem enviou o ASO, observações…" : "Opcional: quem confirmou, observações…" });
    var resultado = h("select", { class: "select" }, [h("option", { value: "" }, "Escolha o resultado…"), h("option", { value: "apto" }, "Apto"), h("option", { value: "inapto" }, "Inapto (encerra o processo)")]);
    var avisoInapto = h("div", { class: "conf err", style: "margin:0 0 10px" }, "Com o resultado inapto o processo é encerrado sem contratação."); avisoInapto.hidden = true;
    resultado.addEventListener("change", function () { avisoInapto.hidden = resultado.value !== "inapto"; });
    var outra = h("input", { type: "checkbox" }), quando = h("input", { class: "input", type: "datetime-local" }), quandoBox = h("div", { class: "field" }, h("span", null, "Data e hora em que foi concluída"), quando, h("div", { class: "hint" }, "Use quando a etapa terminou antes de você registrar. O tempo da etapa é contado até esse momento."));
    quandoBox.hidden = true;
    var pad = function (n) { return String(n).padStart(2, "0"); }, agora = new Date(); quando.max = agora.getFullYear() + "-" + pad(agora.getMonth() + 1) + "-" + pad(agora.getDate()) + "T" + pad(agora.getHours()) + ":" + pad(agora.getMinutes());
    quando.value = quando.max;
    outra.addEventListener("change", function () { quandoBox.hidden = !outra.checked; });
    var botao = aprov ? "Aprovar vaga" : valid ? "Documentos aprovados" : aso ? "Registrar resultado" : final ? "Concluir e finalizar o processo" : "Concluir etapa";
    var msg = h("div"), ok = h("button", { class: "btn acc", type: "button" }, botao);
    var corpo = h("div", null, h("div", { class: "cap" }, "Etapa " + e.ordem + " de " + p.etapas.length + ": " + e.nome),
      aprov ? h("div", { class: "hint", style: "margin:0 0 10px" }, "Aprova a abertura da vaga e a faixa salarial. O sistema não guarda valores de salário.") : null,
      final ? h("div", { class: "conf warn", style: "margin:0 0 12px" }, "É a última etapa: ao concluir, o processo inteiro será encerrado como contratado.") : null,
      aso ? campo("Resultado do exame *", resultado) : null, aso ? avisoInapto : null,
      campo("Observação", obs), h("label", { class: "check-row", style: "display:flex;gap:8px;align-items:center;margin-bottom:10px;font-size:13px" }, outra, "Informar outra data e hora"), quandoBox, msg,
      h("div", { class: "btns" }, ok, h("button", { class: "btn sec", type: "button", onclick: function () { m.fechar(); } }, "Voltar")));
    var m = abrirModal(aprov ? "Aprovar a vaga" : valid ? "Aprovar os documentos" : aso ? "Resultado do exame admissional" : final ? "Finalizar processo" : "Concluir etapa", corpo, 480);
    ok.addEventListener("click", function () {
      if (aso && !resultado.value) return clear(msg).appendChild(h("div", { class: "conf err" }, "Escolha o resultado do exame: apto ou inapto."));
      ok.disabled = true; var b = { obs: obs.value.trim() }; if (aso) b.resultado = resultado.value; if (outra.checked && quando.value) b.concluida_em = new Date(quando.value).toISOString();
      chamar("POST", AD + "/processos/" + p.id + "/etapas/" + e.id + "/concluir", b, m, msg, ok, aprov ? "Vaga aprovada." : final ? "Processo concluído." : aso && resultado.value === "inapto" ? "Processo encerrado: candidato inapto." : "Etapa concluída.");
    });
  }
  function modalAjustarPrazos(p) {
    var tot = h("input", { class: "input", inputmode: "decimal", value: numTxt(diasUteis(p.sla_total_min)) }), motivo = h("textarea", { class: "textarea", rows: 2, maxlength: 300, placeholder: "Ex.: candidato só entrega os documentos na semana que vem" }), msg = h("div");
    var linhas = p.etapas.filter(function (e) { return e.status === "pendente"; }).map(function (e) { var i = h("input", { class: "input", inputmode: "decimal", value: numTxt(diasUteis(e.prazo_min)) }); return { e: e, i: i }; });
    var corpo = h("div", null, h("div", { class: "cap" }, "Vale só para este processo, em dias úteis (1 dia útil = 10 h do expediente; use 0,5 para meio dia). Os prazos padrão ficam em Cadastros."),
      campo("Prazo total do processo (dias úteis)", tot), linhas.length ? h("div", { class: "cap", style: "margin-top:6px" }, "Etapas ainda não concluídas") : null,
      linhas.map(function (x) { return campo(x.e.ordem + ". " + x.e.nome, x.i); }), campo("Motivo do ajuste *", motivo), msg,
      h("div", { class: "btns" }, h("button", { class: "btn acc", type: "button", onclick: function () {
        var a = paraMin(tot.value); if (!(a > 0)) return clear(msg).appendChild(h("div", { class: "conf err" }, "Informe o prazo total em dias (maior que zero)."));
        var et = []; for (var k = 0; k < linhas.length; k++) { var v = paraMin(linhas[k].i.value); if (!(v > 0)) return clear(msg).appendChild(h("div", { class: "conf err" }, "Os prazos das etapas precisam ser maiores que zero.")); et.push({ id: linhas[k].e.id, prazo_min: v }); }
        if (motivo.value.trim().length < 5) return clear(msg).appendChild(h("div", { class: "conf err" }, "Informe o motivo do ajuste."));
        chamar("PUT", AD + "/processos/" + p.id + "/prazos", { total_min: a, etapas: et, motivo: motivo.value.trim() }, m, msg, null, "Prazos ajustados.");
      } }, "Salvar prazos"), h("button", { class: "btn sec", type: "button", onclick: function () { m.fechar(); } }, "Voltar")));
    var m = abrirModal("Ajustar prazos de " + p.protocolo, corpo, 500);
  }
  function modalEditar(p) {
    var eu = S.eu;
    var nome = h("input", { class: "input", value: p.candidato_definido ? p.colaborador : "", maxlength: 120 }), sol = h("input", { class: "input", value: p.solicitante || "", maxlength: 120, placeholder: "Gerente ou gestor da loja" }), cpf = h("input", { class: "input", value: p.cpf || "", inputmode: "numeric", maxlength: 14, placeholder: "000.000.000-00" }), cargo = h("input", { class: "input", value: p.cargo || "", maxlength: 100 });
    var data = h("input", { class: "input", type: "date", value: p.data_prevista }), obs = h("textarea", { class: "textarea", rows: 3, maxlength: 1000 }, p.observacao || "");
    obs.value = p.observacao || "";
    var sub = h("select", { class: "select" }, [h("option", { value: "" }, "—")].concat(eu.subtipos[p.tipo].map(function (s) { return h("option", { value: s, selected: s === p.subtipo }, s); })));
    var achou = eu.lojas.some(function (l) { return l.id === p.loja_id; });
    var loja = h("select", { class: "select" }, eu.lojas.map(function (l) { return h("option", { value: l.id, selected: l.id === p.loja_id }, l.nome); }).concat([h("option", { value: "outro", selected: !achou }, "Outro local")])), un = h("input", { class: "input", value: achou ? "" : p.unidade, maxlength: 120, placeholder: "Ex.: CD, Escritório" });
    var unBox = campo("Local de trabalho", un); unBox.hidden = achou; loja.addEventListener("change", function () { unBox.hidden = loja.value !== "outro"; });
    var msg = h("div");
    var corpo = h("div", null, campo(p.tipo === "admissao" ? "Nome do candidato" : "Nome completo", nome, p.tipo === "admissao" ? "Preencha quando o candidato for definido." : null), p.tipo === "admissao" ? campo("Quem pediu a vaga", sol) : null, h("div", { class: "grid2" }, campo("CPF", cpf), campo("Cargo", cargo)), h("div", { class: "grid2" }, campo("Loja ou local", loja), campo(p.tipo === "admissao" ? "Data de início" : "Data do término do contrato", data)), unBox, campo(p.tipo === "admissao" ? "Tipo de contrato" : "Tipo de rescisão", sub), campo("Observação", obs), msg,
      h("div", { class: "btns" }, h("button", { class: "btn acc", type: "button", onclick: function () {
        var b = { colaborador: nome.value, solicitante: sol.value, cpf: cpf.value, cargo: cargo.value, data_prevista: data.value, subtipo: sub.value, observacao: obs.value };
        if (loja.value === "outro") { b.loja_id = null; b.unidade = un.value; } else b.loja_id = loja.value;
        chamar("PUT", AD + "/processos/" + p.id, b, m, msg, null, "Dados atualizados.");
      } }, "Salvar"), h("button", { class: "btn sec", type: "button", onclick: function () { m.fechar(); } }, "Voltar")));
    var m = abrirModal("Editar dados", corpo, 520);
  }
  function modalExcluir(p) {
    var conf = h("input", { class: "input", placeholder: p.protocolo, autocomplete: "off" }), msg = h("div");
    var ok = h("button", { class: "btn dng", type: "button" }, "Excluir definitivamente");
    var corpo = h("div", null, h("div", { class: "conf err", style: "margin-top:0" }, "Isso apaga o processo, as etapas e o histórico, e não tem volta. Use para limpar testes ou lançamentos feitos por engano."), campo("Para confirmar, digite o protocolo: " + p.protocolo, conf), msg, h("div", { class: "btns" }, ok, h("button", { class: "btn sec", type: "button", onclick: function () { m.fechar(); } }, "Voltar")));
    var m = abrirModal("Excluir " + p.protocolo, corpo, 480);
    ok.addEventListener("click", function () { ok.disabled = true; api("POST", AD + "/processos/" + p.id + "/excluir", { confirmar: conf.value }).then(function () { m.fechar(); toast("Processo excluído."); go("processos"); }).catch(function (e) { clear(msg).appendChild(h("div", { class: "conf err" }, e.message)); ok.disabled = false; }); });
  }
  var EV = {
    criado: function (e) { return "Processo aberto por " + e.usuario; },
    etapa_concluida: function (e) { return (e.detalhe.final ? "Processo concluído. " : "") + (e.detalhe.aprovacao ? "Vaga aprovada. " : "") + "Etapa " + e.detalhe.ordem + " concluída: " + e.detalhe.etapa + (e.detalhe.obs ? " · " + e.detalhe.obs : "") + " · " + e.usuario; },
    devolvida: function (e) { return "Documentos devolvidos para correção (" + e.detalhe.motivo_cat + "): " + e.detalhe.detalhe + " · volta para: " + e.detalhe.para + " · " + e.usuario; },
    vaga_reprovada: function (e) { return "Vaga reprovada: " + e.detalhe.motivo + " · " + e.usuario; },
    tarefa: function (e) { return (e.detalhe.feita ? "Tarefa feita: " : "Tarefa desmarcada: ") + e.detalhe.tarefa + " · " + e.usuario; },
    etapa_dispensada: function (e) { return "Etapa " + e.detalhe.ordem + " não se aplica: " + e.detalhe.etapa + " · " + e.detalhe.motivo + " · " + e.usuario; },
    etapa_reaberta: function (e) { return "Etapa " + e.detalhe.ordem + " voltou a ficar pendente: " + e.detalhe.etapa + " · " + e.detalhe.motivo + " · " + e.usuario; },
    pausado: function (e) { return "Processo pausado: " + e.detalhe.motivo + " · " + e.usuario; },
    retomado: function (e) { return "Processo retomado · " + e.usuario; },
    responsavel: function (e) { return "Responsável: " + (e.detalhe.para || "—") + " · " + e.usuario; },
    cancelado: function (e) { return ((S.eu.desfechos && S.eu.desfechos[e.detalhe.desfecho]) || "Processo cancelado") + ": " + e.detalhe.motivo + " · " + e.usuario; },
    editado: function (e) { return "Dados editados · " + e.usuario; },
    prazos_alterados: function (e) {
      var d = e.detalhe, partes = [];
      if (d.de.total !== d.para.total) partes.push("prazo total " + fmtUt(d.de.total) + " → " + fmtUt(d.para.total));
      Object.keys(d.para.etapas || {}).forEach(function (n) { partes.push(n + ": " + fmtUt(d.de.etapas[n]) + " → " + fmtUt(d.para.etapas[n])); });
      return "Prazos ajustados (" + (partes.join("; ") || "sem mudança") + ") · motivo: " + d.motivo + " · " + e.usuario;
    }
  };
  function viewProcesso(id) {
    skeleton(3);
    return api("GET", AD + "/processos/" + id).then(function (d) {
      var p = d.processo, aberto = p.status === "em_andamento" || p.status === "pausado";
      clear(view);
      view.appendChild(h("div", { class: "btns", style: "margin:0 0 10px" }, h("button", { class: "btn sec sm", type: "button", onclick: function () { go("processos"); } }, "← Voltar")));
      var principal = h("div"), lado = h("div");
      // cabeçalho do processo
      var fatos = h("dl", { class: "fact" });
      [].concat(ehGo() ? [] : [["CPF", p.cpf || "—"]]).concat([["Cargo", p.cargo || "—"], ["Loja ou local", p.unidade]]).concat(p.solicitante ? [["Pedido por", p.solicitante]] : []).concat([[p.tipo === "admissao" ? "Início" : "Fim do contrato", p.data_prevista ? fmtData(p.data_prevista) : "a definir"], [p.tipo === "admissao" ? "Contrato" : "Tipo de rescisão", p.subtipo || "—"], ["Responsável", pessoa(p)], ["Aberto por", p.criado_por + " em " + fmtDTY(p.criado_em)]]).forEach(function (f) { fatos.appendChild(h("dt", null, f[0])); fatos.appendChild(h("dd", null, f[1])); });
      principal.appendChild(h("div", { class: "card" }, h("div", { class: "t", style: "display:flex;gap:8px;justify-content:space-between;flex-wrap:wrap" }, h("div", null, h("div", { class: "p", style: "font-weight:800;font-size:13px;color:var(--text-secondary);letter-spacing:.02em" }, p.protocolo), h("h2", { style: "font-size:20px;margin:2px 0 4px" }, p.colaborador)), h("div", { class: "chips", style: "display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap" }, chipTipo(p.tipo), chipSit(p))), fatos,
        p.observacao ? h("div", { class: "hint", style: "margin-top:8px" }, "Observação: " + p.observacao) : null));
      if (p.status === "pausado") principal.appendChild(h("div", { class: "conf warn" }, h("b", null, "Processo pausado. "), "Os prazos estão parados desde " + fmtDTY(p.pausa && p.pausa.desde) + (p.pausa && p.pausa.motivo ? " (" + p.pausa.motivo + ")." : "."), h("div", { class: "btns", style: "margin-top:8px" }, h("button", { class: "btn acc sm", type: "button", onclick: function () { chamar("POST", AD + "/processos/" + p.id + "/retomar", {}, null, null, null, "Processo retomado."); } }, "Retomar agora"))));
      if (p.status === "cancelado") principal.appendChild(h("div", { class: "conf err" }, h("b", null, (p.desfecho_rotulo || "Processo cancelado") + ". "), p.cancelado_motivo || ""));
      if (p.status === "concluido") principal.appendChild(h("div", { class: "conf good" }, h("b", null, "Processo concluído em " + fmtDTY(p.concluido_em) + ". "), "Levou " + fmtUt(p.total.decorrido) + " úteis (meta " + fmtUt(p.total.meta) + ")."));
      // etapas
      var steps = h("div", { class: "steps" });
      p.etapas.forEach(function (e) {
        var corpo = h("div", { class: "eb" });
        corpo.appendChild(h("div", { class: "et1" }, h("b", null, e.nome), h("span", { class: "chips" }, e.area ? h("span", { class: "chip " + (e.externo ? "acc" : "") }, (e.externo ? "Fora do RH · " : "") + e.area) : null,
          e.voltas > 0 ? h("span", { class: "chip warn" }, "devolvida " + e.voltas + (e.voltas === 1 ? " vez" : " vezes")) : null,
          e.status === "concluida" ? h("span", { class: "chip " + (e.situacao === "cumprida" ? "good" : "bad") }, e.situacao === "cumprida" ? "no prazo" : "fora do prazo") : e.status === "dispensada" ? h("span", { class: "chip" }, "não se aplica") : null)));
        if (e.descricao) corpo.appendChild(h("div", { class: "hint" }, e.descricao));
        if (e.formulario && !ehGo()) { var fp = formPanel(p, e); if (fp) corpo.appendChild(fp); }
        if (e.subtarefas && e.subtarefas.length && (e.atual || e.status !== "pendente")) corpo.appendChild(checklist(p, e));
        var passagensTxt = e.passagens > 1 ? " · passou " + e.passagens + " vezes por aqui" : "";
        if (e.status === "concluida") corpo.appendChild(h("div", { class: "hint", style: "margin-top:4px" }, "Concluída em " + fmtDTY(e.concluida_em) + " por " + (e.concluida_por || "—") + " · levou " + fmtUt(e.decorrido) + " (meta " + fmtUt(e.prazo_min) + ")" + passagensTxt + (e.obs ? " · " + e.obs : "")));
        else if (e.status === "dispensada") corpo.appendChild(h("div", { class: "hint", style: "margin-top:4px" }, "Não se aplica: " + (e.obs || "") + " · " + (e.concluida_por || "")));
        else if (e.atual) {
          corpo.appendChild(h("div", { style: "margin-top:10px" }, barraSla("Prazo desta etapa" + (e.passagens > 1 ? " (nesta passagem)" : ""), { meta: e.prazo_min, decorrido: e.decorrido, restante: e.restante, situacao: e.situacao })));
          if (e.passagens > 1) corpo.appendChild(h("div", { class: "hint" }, "Tempo somado de todas as passagens por esta etapa: " + fmtUt(e.tempo_total) + "."));
          if (p.status !== "em_andamento") corpo.appendChild(h("div", { class: "hint" }, "Retome o processo para continuar."));
          else {
            var acoesEt = h("div", { class: "btns", style: "margin-top:6px" }), ultima = e.ordem === p.etapas.length;
            var checkOk = !e.subtarefas || e.subtarefas_feitas === e.subtarefas.length;
            var dispensar = function () { return h("button", { class: "btn sec sm", type: "button", onclick: function () { pedirMotivo("Etapa não se aplica", e.nome, "Por que essa etapa não se aplica? *", "Dispensar etapa", function (t, m, msg, ok) { chamar("POST", AD + "/processos/" + p.id + "/etapas/" + e.id + "/dispensar", { motivo: t }, m, msg, ok, "Etapa dispensada."); }); } }, "Não se aplica"); };
            var msgBtn = e.mensagem ? h("button", { class: "btn sec sm", type: "button", onclick: function () { if (e.formulario && e.acao !== "validacao") msgComLink(p, e); else modalMensagens(p, e.mensagem); } }, "Mensagem pronta") : null;
            if (e.acao === "aprovacao") {
              if (podeAprovar()) {
                acoesEt.appendChild(h("button", { class: "btn acc sm", type: "button", onclick: function () { modalConcluir(p, e); } }, "Aprovar vaga"));
                acoesEt.appendChild(h("button", { class: "btn dng sm", type: "button", onclick: function () { pedirMotivo("Reprovar a vaga", "O processo é encerrado e a justificativa fica registrada. Avise a loja com a mensagem pronta.", "Justificativa da reprovação *", "Reprovar vaga", function (t, m, msg, ok) { api("POST", AD + "/processos/" + p.id + "/etapas/" + e.id + "/reprovar", { motivo: t }).then(function () { m.fechar(); toast("Vaga reprovada."); route(); modalMensagens(p, "vaga_reprovada", { motivo: t }); }).catch(function (er) { clear(msg).appendChild(h("div", { class: "conf err" }, er.message)); ok.disabled = false; }); }, true); } }, "Reprovar vaga"));
                acoesEt.appendChild(dispensar());
              } else acoesEt.appendChild(h("div", { class: "hint", style: "margin:0" }, "Aguardando a GO aprovar ou reprovar a vaga e a faixa salarial."));
            } else if (ehGo()) acoesEt.appendChild(h("div", { class: "hint", style: "margin:0" }, "Etapa conduzida pelo RH. Você acompanha por aqui."));
            else if (e.acao === "validacao") {
              acoesEt.appendChild(h("button", { class: "btn acc sm", type: "button", onclick: function () { modalConcluir(p, e); } }, "Aprovar documentos"));
              acoesEt.appendChild(h("button", { class: "btn sec sm", type: "button", onclick: function () { modalDevolver(p, e); } }, "Devolver para correção"));
              if (msgBtn) acoesEt.appendChild(msgBtn); acoesEt.appendChild(dispensar());
            } else if (e.acao === "aso") {
              acoesEt.appendChild(h("button", { class: "btn acc sm", type: "button", onclick: function () { modalConcluir(p, e); } }, "Registrar resultado do exame"));
              if (msgBtn) acoesEt.appendChild(msgBtn); acoesEt.appendChild(dispensar());
            } else {
              acoesEt.appendChild(h("button", { class: "btn acc sm", type: "button", disabled: !checkOk, title: checkOk ? "" : "Marque todas as tarefas do checklist", onclick: function () { modalConcluir(p, e); } }, ultima ? "Concluir e finalizar" : e.nome.indexOf("Pré-admissão") === 0 ? "Documentos recebidos" : "Concluir etapa"));
              if (msgBtn) acoesEt.appendChild(msgBtn); acoesEt.appendChild(dispensar());
              if (!checkOk) acoesEt.appendChild(h("div", { class: "hint", style: "margin:0;align-self:center" }, "Marque o checklist para concluir."));
            }
            corpo.appendChild(acoesEt);
          }
        } else if (e.status === "pendente" && p.status !== "cancelado") corpo.appendChild(h("div", { class: "hint", style: "margin-top:2px" }, "Prazo: " + fmtUt(e.prazo_min) + (e.passagens > 0 ? " · já passou " + e.passagens + (e.passagens === 1 ? " vez" : " vezes") + " por aqui (" + fmtUt(e.tempo_total) + ")" : "")));
        var dot = e.status === "concluida" ? h("span", { class: "dot2" }, "✓") : e.status === "dispensada" ? h("span", { class: "dot2" }, "–") : h("span", { class: "dot2" }, String(e.ordem));
        steps.appendChild(h("div", { class: "et " + (e.atual ? "atual " : "") + e.status + " " + e.situacao }, dot, corpo));
      });
      var podeVoltar = !ehGo() && p.progresso.feitas > 0 && p.status !== "cancelado" && (p.status !== "concluido" || ehGestor());
      principal.appendChild(h("div", { class: "card" }, h("div", { class: "head", style: "margin-bottom:10px" }, h("div", null, h("h3", null, "Etapas"), h("div", { class: "cap", style: "margin:0" }, p.progresso.feitas + " de " + p.progresso.total + " concluídas. Cada etapa começa quando a anterior termina; se o RH devolver documentos, a etapa anterior reabre.")),
        podeVoltar ? h("button", { class: "btn sec sm", type: "button", onclick: function () { pedirMotivo("Voltar a última etapa", "A última etapa concluída volta a ficar pendente e o tempo dela volta a correr.", "Por que está voltando? *", "Voltar etapa", function (t, m, msg, ok) { chamar("POST", AD + "/processos/" + p.id + "/voltar-etapa", { motivo: t }, m, msg, ok, "Etapa reaberta."); }); } }, "Desfazer última etapa") : null), steps));
      // histórico e anotações
      var nota = h("textarea", { class: "textarea", rows: 3, maxlength: 1000, placeholder: "Anote o que aconteceu: o que o colaborador entregou, quem foi acionado…" });
      var hist = h("div", { style: "margin-top:12px" });
      d.eventos.slice().reverse().forEach(function (e) {
        if (e.tipo === "nota") hist.appendChild(h("div", { class: "msg dp" }, h("div", { class: "mh" }, h("b", null, (e.detalhe && e.detalhe.nome) || e.usuario), h("span", null, fmtDTY(e.criado_em))), h("div", { class: "mt" }, e.detalhe.texto)));
        else if (EV[e.tipo]) hist.appendChild(h("div", { class: "sys" }, EV[e.tipo](e) + " · " + fmtDTY(e.criado_em)));
      });
      principal.appendChild(h("div", { class: "card" }, h("h3", null, "Anotações e histórico"), h("div", { class: "cap" }, "Tudo o que acontece no processo fica registrado com usuário e horário."),
        h("div", null, nota, h("div", { class: "btns", style: "margin-top:8px" }, h("button", { class: "btn sec sm", type: "button", onclick: function () { if (nota.value.trim().length < 2) return toast("Escreva a anotação.", true); api("POST", AD + "/processos/" + p.id + "/notas", { texto: nota.value }).then(function () { toast("Anotação salva."); route(); }).catch(function (e) { toast(e.message, true); }); } }, "Adicionar anotação"))), hist));
      // lateral: prazos
      var pd = p.prazo_data, dataTxt = textoPrazoData(p);
      lado.appendChild(h("div", { class: "card" }, h("h3", null, "Prazos (SLA)"), h("div", { class: "cap" }, "Contados só no expediente e parados enquanto o processo está pausado."),
        barraSla("Prazo total do processo", p.total), p.etapa_atual ? barraSla("Etapa atual", { meta: p.etapa_atual.prazo_min, decorrido: p.etapa_atual.decorrido, restante: p.etapa_atual.restante, situacao: p.etapa_atual.situacao }) : null,
        dataTxt ? (pd.situacao === "estourado" || pd.situacao === "cumprido" ? h("div", { class: "conf " + (pd.situacao === "estourado" ? "err" : "good"), style: "margin:0 0 6px" }, dataTxt) : h("div", { style: "margin:0 0 6px;font-weight:700" + (pd.situacao === "risco" ? ";color:var(--warn,#b45309)" : "") }, dataTxt)) : null,
        p.tipo === "rescisao" ? h("div", { class: "hint" }, "O prazo legal vem do art. 477 da CLT: pagamento das verbas e entrega dos documentos em até " + S.eu.prazo_legal_dias + " dias corridos do término do contrato. Confirme casos especiais com o jurídico ou a contabilidade.") : h("div", { class: "hint" }, "O registro precisa estar pronto antes de o colaborador começar."),
        ehGestor() && aberto ? h("div", { class: "btns", style: "margin-top:10px" }, h("button", { class: "btn sec sm", type: "button", onclick: function () { modalAjustarPrazos(p); } }, "Ajustar prazos deste processo")) : null));
      // lateral: quem está segurando o processo
      var tl = (p.lados.rh || 0) + (p.lados.fora || 0);
      if (tl > 0 && p.tipo === "admissao") {
        var ext = {}; p.etapas.forEach(function (e) { if (e.area) ext[e.area] = !!e.externo; });
        lado.appendChild(h("div", { class: "card" }, h("h3", null, "Quem está segurando o processo"), h("div", { class: "cap" }, "Tempo útil em cada área, somando as voltas. Fora do RH: " + fmtPct(Math.round(p.lados.fora / tl * 1000) / 10) + " do tempo."),
          barrasH(Object.keys(p.por_area).filter(function (k) { return p.por_area[k] > 0; }).sort(function (a, b) { return p.por_area[b] - p.por_area[a]; }).map(function (k) { return { l: k + (ext[k] ? " (fora do RH)" : ""), v: p.por_area[k], t: k + ": " + fmtUt(p.por_area[k]) }; }), fmtUt)));
      }
      if (p.retornos > 0) {
        var dvl = h("div");
        p.devolucoes.slice().reverse().forEach(function (x) { dvl.appendChild(h("div", { class: "msg dp" }, h("div", { class: "mh" }, h("b", null, x.motivo_cat + " · volta para " + x.etapa), h("span", null, fmtDTY(x.em))), h("div", { class: "mt" }, x.detalhe + " (" + String(x.por || "").split("@")[0] + ")"))); });
        lado.appendChild(h("div", { class: "card" }, h("h3", null, "Devoluções (" + p.retornos + ")"), h("div", { class: "cap" }, "Cada vez que o RH devolveu documentos para correção."), dvl));
      }
      // lateral: ações
      if (ehGo()) lado.appendChild(h("div", { class: "card" }, h("h3", null, "Seu perfil: GO"), h("div", { class: "cap", style: "margin:0" }, "Você aprova ou reprova a vaga e a faixa salarial na etapa 1 e acompanha as demais etapas. As outras ações são do RH."), podeAprovar() && p.etapa_atual && p.etapa_atual.acao === "aprovacao" && p.status === "em_andamento" ? h("div", { class: "hint", style: "margin-top:8px;font-weight:700" }, "Esta vaga está esperando a sua decisão.") : null));
      else if (aberto) {
        var respSel = h("select", { class: "select" }, S.eu.responsaveis.map(function (x) { return h("option", { value: x.email, selected: x.email.toLowerCase() === String(p.responsavel || "").toLowerCase() }, x.nome); }));
        respSel.addEventListener("change", function () { api("POST", AD + "/processos/" + p.id + "/responsavel", { responsavel: respSel.value }).then(function () { toast("Responsável atualizado."); route(); }).catch(function (e) { toast(e.message, true); }); });
        var acoes = h("div", { class: "btns", style: "flex-direction:column;align-items:stretch;margin-top:12px" });
        acoes.appendChild(h("button", { class: "btn sec sm", type: "button", onclick: function () { modalEditar(p); } }, "Editar dados do colaborador"));
        if (p.tipo === "admissao") acoes.appendChild(h("button", { class: "btn sec sm", type: "button", onclick: function () { modalMensagens(p); } }, "Mensagens prontas (WhatsApp / e-mail)"));
        if (p.status === "em_andamento") acoes.appendChild(h("button", { class: "btn sec sm", type: "button", onclick: function () { pedirMotivo("Pausar o processo", "Use quando o processo depende de terceiros, por exemplo o candidato que ainda não entregou os documentos. Os prazos ficam parados até você retomar.", "O que está sendo aguardado? *", "Pausar processo", function (t, m, msg, ok) { chamar("POST", AD + "/processos/" + p.id + "/pausar", { motivo: t }, m, msg, ok, "Processo pausado."); }); } }, "Pausar (aguardando terceiros)"));
        else acoes.appendChild(h("button", { class: "btn acc sm", type: "button", onclick: function () { chamar("POST", AD + "/processos/" + p.id + "/retomar", {}, null, null, null, "Processo retomado."); } }, "Retomar processo"));
        if (p.tipo === "admissao") acoes.appendChild(h("button", { class: "btn sec sm", type: "button", onclick: function () { pedirMotivo("Candidato desistiu", "O processo é encerrado como desistência e entra nos indicadores. O histórico fica guardado.", "O que aconteceu? *", "Registrar desistência", function (t, m, msg, ok) { chamar("POST", AD + "/processos/" + p.id + "/encerrar", { motivo: t }, m, msg, ok, "Desistência registrada."); }, true); } }, "Candidato desistiu"));
        if (ehGestor()) acoes.appendChild(h("button", { class: "btn dng sm", type: "button", onclick: function () { pedirMotivo("Cancelar o processo", "Use quando a admissão ou a rescisão não vai mais acontecer por outro motivo (erro de lançamento, mudança de planos). O histórico fica guardado.", "Motivo do cancelamento *", "Cancelar processo", function (t, m, msg, ok) { chamar("POST", AD + "/processos/" + p.id + "/cancelar", { motivo: t }, m, msg, ok, "Processo cancelado."); }, true); } }, "Cancelar processo"));
        lado.appendChild(h("div", { class: "card" }, h("h3", null, "Responsável e ações"), campo("Responsável", respSel), acoes));
      } else if (ehGestor() && p.status === "concluido") lado.appendChild(h("div", { class: "card" }, h("h3", null, "Ações"), h("div", { class: "btns", style: "margin-top:4px" }, h("button", { class: "btn sec sm", type: "button", onclick: function () { modalEditar(p); } }, "Editar dados"))));
      if (ehAdmin()) lado.appendChild(h("div", { class: "card" }, h("h3", null, "Administrador"), h("div", { class: "cap" }, "Exclusão definitiva, útil para limpar testes."), h("button", { class: "btn dng sm", type: "button", onclick: function () { modalExcluir(p); } }, "Excluir processo")));
      view.appendChild(h("div", { class: "ch-grid" }, principal, lado));
    }).catch(erroTela);
  }

  // ====================================================================================
  // INDICADORES
  // ====================================================================================
  function barrasH(itens, fmt) {
    var max = Math.max.apply(null, itens.map(function (i) { return i.v; }).concat([1])), box = h("div");
    if (!itens.length) return h("div", { class: "hint" }, "Sem dados no período.");
    itens.forEach(function (i) { box.appendChild(h("div", { class: "hbar", title: i.t || "" }, h("div", { class: "lb" }, i.l), h("div", { class: "tr" }, h("i", { style: "width:" + Math.max(1, Math.round(i.v / max * 100)) + "%" })), h("div", { class: "vl" }, fmt ? fmt(i.v) : fmtN(i.v)))); });
    return box;
  }
  var MES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  function graficoMeses(porMes) {
    if (!porMes.length) return h("div", { class: "hint" }, "Sem dados no período.");
    var W = 640, H = 220, ml = 30, mb = 28, mt = 20, w = W - ml - 8, hh = H - mb - mt;
    var max = Math.max.apply(null, porMes.map(function (m) { return Math.max(m.admissoes, m.rescisoes); }).concat([1]));
    var top = Math.max(2, max % 2 ? max + 1 : max), ns = "http://www.w3.org/2000/svg";
    function el(t, a, txt) { var n = document.createElementNS(ns, t); Object.keys(a || {}).forEach(function (k) { n.setAttribute(k, a[k]); }); if (txt !== undefined) n.textContent = txt; return n; }
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Admissões e rescisões por mês" });
    [0, 0.5, 1].forEach(function (f) { var y = mt + hh - f * hh; svg.appendChild(el("line", { x1: ml, x2: W - 8, y1: y, y2: y, stroke: "currentColor", "stroke-opacity": ".12" })); svg.appendChild(el("text", { x: ml - 6, y: y + 4, "text-anchor": "end", "font-size": 10, fill: "currentColor", "fill-opacity": ".55" }, String(Math.round(top * f)))); });
    var gw = w / porMes.length, bw = Math.min(26, gw / 3);
    porMes.forEach(function (m, i) {
      var cx = ml + gw * i + gw / 2, ym = m.mes.split("-");
      [[m.admissoes, "var(--accent)", -bw - 1, "Admissões"], [m.rescisoes, "var(--series-1)", 1, "Rescisões"]].forEach(function (b) {
        var bh = (b[0] / top) * hh, r = el("rect", { x: cx + b[2], y: mt + hh - bh, width: bw, height: Math.max(bh, b[0] ? 2 : 0), rx: 4, fill: b[1] }); r.appendChild(el("title", {}, MES[Number(ym[1]) - 1] + "/" + ym[0].slice(2) + " · " + b[3] + ": " + b[0]));
        svg.appendChild(r);
        if (b[0]) svg.appendChild(el("text", { x: cx + b[2] + bw / 2, y: mt + hh - bh - 4, "text-anchor": "middle", "font-size": 10, "font-weight": 700, fill: "currentColor" }, String(b[0])));
      });
      svg.appendChild(el("text", { x: cx, y: H - 8, "text-anchor": "middle", "font-size": 10.5, fill: "currentColor", "fill-opacity": ".7" }, MES[Number(ym[1]) - 1] + "/" + ym[0].slice(2)));
    });
    return h("div", null, h("div", { class: "legend" }, h("span", null, h("i", { style: "background:var(--accent)" }), "Admissões"), h("span", null, h("i", { style: "background:var(--series-1)" }), "Rescisões")), h("div", { class: "chart" }, svg));
  }
  function gerarInsights(d) {
    var k = d.kpis, out = [], add = function (n, t, x) { out.push({ n: n, t: t, x: x }); };
    if (k.estourados > 0) add("critico", "Processos atrasados agora", k.estourados + (k.estourados === 1 ? " processo em andamento está fora do prazo" : " processos em andamento estão fora do prazo")+ " (etapa, prazo total, início do colaborador ou prazo legal da rescisão). Priorize os que estão em \"Mais urgentes\".");
    else if (k.em_risco > 0) add("atencao", "Processos perto de estourar", k.em_risco + (k.em_risco === 1 ? " processo já usou" : " processos já usaram") + " 80% do prazo. Vale avançar antes que estourem.");
    else if (k.abertos_agora > 0) add("ok", "Tudo dentro do prazo", "Os " + k.abertos_agora + " processos em andamento estão dentro do prazo.");
    var gargalos = d.por_etapa.filter(function (e) { return e.atrasadas_agora > 0; }).sort(function (a, b) { return b.atrasadas_agora - a.atrasadas_agora; });
    if (gargalos.length) add("critico", "Gargalo agora", "\"" + gargalos[0].nome + "\" (" + TIPO[gargalos[0].tipo].toLowerCase() + ") tem " + gargalos[0].atrasadas_agora + (gargalos[0].atrasadas_agora === 1 ? " processo parado" : " processos parados") + " além do prazo da etapa" + (gargalos.length > 1 ? "; " + (gargalos.length - 1) + (gargalos.length === 2 ? " outra etapa também está atrasada." : " outras etapas também estão atrasadas.") : "."));
    var piores = d.por_etapa.filter(function (e) { return e.concluidas >= 3 && e.no_prazo_pct !== null && e.no_prazo_pct < 75; }).sort(function (a, b) { return a.no_prazo_pct - b.no_prazo_pct; });
    if (piores.length) add("atencao", "Etapa que mais estoura o prazo", "\"" + piores[0].nome + "\": só " + fmtPct(piores[0].no_prazo_pct) + " das conclusões ficaram no prazo (tempo médio " + fmtUt(piores[0].tempo_medio_min) + " para uma meta de " + fmtUt(piores[0].meta_min) + "). Reveja a meta ou o fluxo dessa etapa.");
    if (k.rescisoes_prazo_legal_pct !== null && k.rescisoes_prazo_legal_pct < 100) add("critico", "Rescisões pagas depois do prazo legal", "Só " + fmtPct(k.rescisoes_prazo_legal_pct) + " das rescisões concluídas foram pagas em até 10 dias corridos do término do contrato. Atraso pode gerar multa (art. 477 da CLT): confirme com o jurídico.");
    if (k.admissoes_antes_inicio_pct !== null && k.admissoes_antes_inicio_pct < 90) add("atencao", "Admissões concluídas depois do início", "Só " + fmtPct(k.admissoes_antes_inicio_pct) + " das admissões ficaram prontas até a data de início do colaborador. Antecipe documentos e exame admissional.");
    var prox = d.proximos_prazos.filter(function (x) { return x.prazo_data.dias <= 3; });
    if (prox.length) add("atencao", "Datas chegando", prox.length + (prox.length === 1 ? " processo tem" : " processos têm") + " início do colaborador ou prazo legal em até 3 dias e ainda não terminou.");
    if (k.sem_responsavel > 0) add("atencao", "Processos sem responsável", k.sem_responsavel + (k.sem_responsavel === 1 ? " processo em andamento não tem" : " processos em andamento não têm") + " ninguém atribuído.");
    if (k.pausados > 0) add("info", "Processos pausados", k.pausados + (k.pausados === 1 ? " processo está pausado" : " processos estão pausados") + " aguardando terceiros. Eles não contam prazo, mas vale cobrar o retorno.");
    if (k.concluidos > 0) add("info", "Tempo de conclusão", "Os " + k.concluidos + " processos concluídos levaram em média " + fmtUt(k.tempo_medio_conclusao_min) + " úteis, com " + fmtPct(k.no_prazo_total_pct) + " dentro do prazo total.");
    if (k.novos > 0) add("info", "Movimentação do período", k.admissoes + (k.admissoes === 1 ? " admissão e " : " admissões e ") + k.rescisoes + (k.rescisoes === 1 ? " rescisão abertas" : " rescisões abertas") + (k.admissoes !== k.rescisoes ? " (saldo de " + (k.admissoes - k.rescisoes > 0 ? "+" : "") + (k.admissoes - k.rescisoes) + " colaboradores)." : "."));
    if (k.aguardando_go > 0) add("atencao", "Vagas esperando a GO", k.aguardando_go + (k.aguardando_go === 1 ? " vaga está" : " vagas estão") + " esperando aprovação da GO. Enquanto não aprovam, o processo não anda.");
    if (k.retrabalho_pct !== null && k.retrabalho_pct >= 25 && d.devolucoes.total > 0) {
      var mot = d.devolucoes.por_motivo[0], etp = d.devolucoes.por_etapa[0];
      add("atencao", "Retrabalho nos documentos", fmtPct(k.retrabalho_pct) + " das admissões voltaram ao menos uma vez para correção (" + k.retornos_total + (k.retornos_total === 1 ? " devolução" : " devoluções") + "). Motivo mais comum: " + (mot ? mot.rotulo.toLowerCase() : "—") + (etp ? "; a etapa que mais volta é \"" + etp.rotulo + "\"" : "") + ". Orientar as lojas e os candidatos antes do envio reduz o prazo.");
    }
    if (k.fora_do_rh_pct !== null && k.fora_do_rh_pct >= 60 && d.por_area.length) {
      var ar = d.por_area.filter(function (x) { return x.externo; })[0];
      add("info", "Quem segura o processo", fmtPct(k.fora_do_rh_pct) + " do tempo das admissões está fora do RH (GO, loja, candidato ou clínica)" + (ar ? ", principalmente com " + ar.area + " (média de " + fmtUt(ar.media_por_processo_min) + " por processo)" : "") + ". Cobrar esses retornos encurta o prazo mais do que acelerar o RH.");
    }
    if (d.por_desfecho.length) add("info", "Encerrados sem contratação", d.por_desfecho.map(function (x) { return x.n + " " + x.rotulo.toLowerCase(); }).join("; ") + ".");
    return out;
  }
  function cardInsights(lista) {
    var etq = { critico: "Crítico", atencao: "Atenção", info: "Informação", ok: "Tudo certo" };
    return h("div", { class: "card" }, h("h3", null, "Insights do período"), h("div", { class: "cap" }, "Leitura automática dos números: o que está atrasado, onde está o gargalo e o que vale fazer."),
      h("div", { class: "insights" }, lista.length ? lista.map(function (i) { return h("div", { class: "ins " + i.n }, h("span", { class: "ins-tag" }, etq[i.n]), h("div", null, h("b", null, i.t), h("div", { class: "ins-tx" }, i.x))); }) : h("div", { class: "hint" }, "Ainda não há movimentação para analisar.")));
  }
  function tabelaEtapas(d) {
    var tb = h("tbody"), ult = null;
    d.por_etapa.forEach(function (e) {
      if (e.tipo !== ult) { ult = e.tipo; tb.appendChild(h("tr", null, h("td", { colspan: 7, style: "font-weight:800;background:var(--surface-2)" }, TIPO[e.tipo]))); }
      tb.appendChild(h("tr", null, h("td", null, e.ordem + ". " + e.nome, e.area ? h("div", { class: "cap", style: "margin:0" }, e.area + (e.externo ? " · fora do RH" : "")) : null), h("td", { class: "num" }, fmtUt(e.meta_min)), h("td", { class: "num" }, e.concluidas ? fmtUt(e.tempo_medio_min) : "—"),
        h("td", { class: "num" }, e.no_prazo_pct === null ? "—" : h("span", { class: "pct " + pctCls(e.no_prazo_pct) }, fmtPct(e.no_prazo_pct)) , e.concluidas ? h("div", { class: "cap", style: "margin:0" }, e.concluidas + " concl.") : null), h("td", { class: "num" }, e.voltas ? h("b", { style: "color:var(--warning)" }, e.voltas) : "0"), h("td", { class: "num" }, e.em_andamento ? String(e.em_andamento) : "0"), h("td", { class: "num" }, e.atrasadas_agora ? h("b", { style: "color:var(--critical)" }, e.atrasadas_agora) : "0")));
    });
    return h("div", { class: "qwrap" }, h("table", { class: "q" }, h("thead", null, h("tr", null, h("th", null, "Etapa"), h("th", { class: "num" }, "Meta"), h("th", { class: "num" }, "Tempo médio"), h("th", { class: "num" }, "No prazo"), h("th", { class: "num" }, "Voltas"), h("th", { class: "num" }, "Agora"), h("th", { class: "num" }, "Atrasadas"))), tb));
  }
  function tabelaResp(lista) {
    var tb = h("tbody");
    lista.forEach(function (x) { tb.appendChild(h("tr", null, h("td", null, x.rotulo), h("td", { class: "num" }, fmtN(x.volume)), h("td", { class: "num" }, x.abertos ? h("b", null, x.abertos) : "0"), h("td", { class: "num" }, x.atrasados ? h("b", { style: "color:var(--critical)" }, x.atrasados) : "0"), h("td", { class: "num" }, fmtN(x.concluidos)), h("td", { class: "num" }, x.concluidos ? fmtUt(x.tempo_medio_min) : "—"), h("td", { class: "num" }, x.no_prazo_pct === null ? "—" : h("span", { class: "pct " + pctCls(x.no_prazo_pct) }, fmtPct(x.no_prazo_pct))))); });
    return h("div", { class: "qwrap" }, h("table", { class: "q" }, h("thead", null, h("tr", null, h("th", null, "Responsável"), h("th", { class: "num" }, "Processos"), h("th", { class: "num" }, "Abertos"), h("th", { class: "num" }, "Atrasados"), h("th", { class: "num" }, "Concluídos"), h("th", { class: "num" }, "Tempo médio"), h("th", { class: "num" }, "No prazo"))), tb));
  }
  function qsInd(f, extra) { return "?" + (f.de && f.ate ? "de=" + f.de + "&ate=" + f.ate : "dias=" + f.dias) + (f.tipo ? "&tipo=" + f.tipo : "") + (f.loja_id ? "&loja_id=" + f.loja_id : "") + (f.responsavel ? "&responsavel=" + encodeURIComponent(f.responsavel) : "") + (extra || ""); }
  function viewIndicadores() {
    skeleton(3);
    var f = S.indFil;
    return api("GET", AD + "/indicadores" + qsInd(f)).then(function (d) {
      var k = d.kpis;
      clear(view);
      view.appendChild(head("Indicadores", "Período de " + fmtData(d.periodo.de) + " a " + fmtData(d.periodo.ate) + ". Os prazos (SLA) contam só o expediente e param quando o processo está pausado.", h("button", { class: "btn sec sm", type: "button", onclick: function () { exportarExcel(f); } }, "Baixar Excel")));
      function sel(opts, val, on) { var s = h("select", { class: "select" }, opts.map(function (o) { return h("option", { value: o[0], selected: String(o[0]) === String(val) }, o[1]); })); s.addEventListener("change", function () { on(s.value); route(); }); return s; }
      var de = h("input", { class: "input", type: "date", value: f.de || d.periodo.de, style: "width:auto" }), ate = h("input", { class: "input", type: "date", value: f.ate || d.periodo.ate, style: "width:auto" });
      function aplica() { if (de.value && ate.value) { f.de = de.value; f.ate = ate.value; route(); } }
      de.addEventListener("change", aplica); ate.addEventListener("change", aplica);
      view.appendChild(h("div", { class: "filters" },
        sel([["30", "Últimos 30 dias"], ["90", "Últimos 90 dias"], ["180", "Últimos 6 meses"], ["365", "Últimos 12 meses"], ["custom", "Datas…"]], f.de ? "custom" : f.dias, function (v) { if (v === "custom") { f.de = d.periodo.de; f.ate = d.periodo.ate; } else { f.dias = Number(v); f.de = ""; f.ate = ""; } }),
        h("span", { class: "cap", style: "margin:0" }, "de"), de, h("span", { class: "cap", style: "margin:0" }, "até"), ate,
        sel([["", "Admissões e rescisões"], ["admissao", "Só admissões"], ["rescisao", "Só rescisões"]], f.tipo, function (v) { f.tipo = v; }),
        sel([["", "Todas as lojas"]].concat(S.eu.lojas.map(function (l) { return [l.id, l.nome]; })), f.loja_id, function (v) { f.loja_id = v; }),
        sel([["", "Todos os responsáveis"]].concat(S.eu.responsaveis.map(function (x) { return [x.email, x.nome]; })), f.responsavel, function (v) { f.responsavel = v; })));
      view.appendChild(h("div", { class: "kpis", style: "grid-template-columns:repeat(auto-fit,minmax(250px,1fr))" },
        kpi("Em andamento agora", fmtN(k.abertos_agora), k.pausados + (k.pausados === 1 ? " pausado · " : " pausados · ") + k.sem_responsavel + " sem responsável"),
        kpi("Atrasados", fmtN(k.estourados), k.em_risco + " em risco (80% do prazo)", k.estourados ? "bad" : "good"),
        kpi("Abertos no período", fmtN(k.novos), k.admissoes + " admissões · " + k.rescisoes + " rescisões"),
        kpi("Concluídos", fmtN(k.concluidos), k.cancelados + (k.cancelados === 1 ? " encerrado sem contratação" : " encerrados sem contratação")),
        kpi("Concluídos no prazo", fmtPct(k.no_prazo_total_pct), "contra o prazo total", pctCls(k.no_prazo_total_pct)),
        kpi("Tempo médio", k.concluidos ? fmtUt(k.tempo_medio_conclusao_min) : "—", "do pedido à conclusão"),
        kpi("Admissões prontas antes do início", fmtPct(k.admissoes_antes_inicio_pct), "concluídas até a data de início", pctCls(k.admissoes_antes_inicio_pct)),
        kpi("Rescisões no prazo legal", fmtPct(k.rescisoes_prazo_legal_pct), "pagas em até 10 dias corridos", pctCls(k.rescisoes_prazo_legal_pct)),
        kpi("Tempo fora do RH", fmtPct(k.fora_do_rh_pct), "com GO, loja, candidato ou clínica"),
        kpi("Retrabalho", fmtPct(k.retrabalho_pct), k.retornos_total + (k.retornos_total === 1 ? " devolução em " : " devoluções em ") + k.com_retorno + (k.com_retorno === 1 ? " processo" : " processos"), k.retrabalho_pct === null ? "" : k.retrabalho_pct >= 25 ? "bad" : k.retrabalho_pct >= 10 ? "warn" : "good"),
        kpi("Agora com o RH / fora", k.com_rh_agora + " / " + k.fora_agora, k.aguardando_go + (k.aguardando_go === 1 ? " vaga na GO" : " vagas na GO"), k.aguardando_go ? "warn" : "")));
      var linhas = h("div", { class: "grid-ind" });
      linhas.appendChild(cardInsights(gerarInsights(d)));
      linhas.appendChild(h("div", { class: "card" }, h("h3", null, "Admissões e rescisões por mês"), h("div", { class: "cap" }, "Processos abertos em cada mês, sem os cancelados."), graficoMeses(d.por_mes)));
      if (d.por_area.length) linhas.appendChild(h("div", { class: "card" }, h("h3", null, "Quem segura o processo"), h("div", { class: "cap" }, "Tempo útil que os processos do período ficaram com cada área, já somando as voltas. Quem está \"fora do RH\" (GO, loja, candidato, clínica) é onde mais dá para ganhar prazo cobrando retorno."),
        barrasH(d.por_area.map(function (x) { return { l: x.area + (x.externo ? " (fora do RH)" : ""), v: x.total_min, t: x.area + ": " + fmtUt(x.total_min) + " no total · média " + fmtUt(x.media_por_processo_min) + " por processo" }; }), fmtUt)));
      var funil = d.por_etapa.filter(function (e) { return e.tipo === "admissao" && e.chegaram > 0; });
      if (funil.length > 1 && (!f.tipo || f.tipo === "admissao")) {
        var topo = funil[0].chegaram, fim = funil[funil.length - 1];
        linhas.appendChild(h("div", { class: "card" }, h("h3", null, "Funil da admissão"), h("div", { class: "cap" }, "Quantos processos chegaram a cada etapa. De " + topo + (topo === 1 ? " vaga aberta, " : " vagas abertas, ") + fim.concluidas + (fim.concluidas === 1 ? " chegou" : " chegaram") + " ao fim. A queda entre uma etapa e outra mostra onde o processo se perde."),
          barrasH(funil.map(function (e) { return { l: e.ordem + ". " + e.nome, v: e.chegaram, t: e.nome + ": " + e.chegaram + " chegaram, " + e.concluidas + " concluídas" }; }))));
      }
      if (d.devolucoes.total > 0) linhas.appendChild(h("div", { class: "grid-ind dois" },
        h("div", { class: "card" }, h("h3", null, "Retrabalho: por quê?"), h("div", { class: "cap" }, "Motivo das " + d.devolucoes.total + (d.devolucoes.total === 1 ? " devolução" : " devoluções") + " de documentos para correção."), barrasH(d.devolucoes.por_motivo.map(function (x) { return { l: x.rotulo, v: x.n, t: x.rotulo + ": " + x.n }; })),
          h("div", { class: "cap", style: "margin-top:12px" }, "Etapas que mais voltam"), barrasH(d.devolucoes.por_etapa.slice(0, 5).map(function (x) { return { l: x.rotulo, v: x.n, t: x.rotulo + ": " + x.n }; }))),
        h("div", { class: "card" }, h("h3", null, "Lojas com mais devoluções"), h("div", { class: "cap" }, "Onde os documentos mais voltam para correção. Vale orientar o gerente."), d.devolucoes.por_loja.length ? barrasH(d.devolucoes.por_loja.map(function (x) { return { l: x.rotulo, v: x.devolucoes, t: x.rotulo + ": " + x.devolucoes + " devoluções em " + x.processos + " admissões" }; })) : h("div", { class: "hint" }, "Sem dados."))));
      if (d.por_desfecho.length) linhas.appendChild(h("div", { class: "card" }, h("h3", null, "Encerrados sem contratação"), h("div", { class: "cap" }, "Vaga reprovada pela GO, candidato inapto no exame, desistência ou cancelamento."), barrasH(d.por_desfecho.map(function (x) { return { l: x.rotulo, v: x.n, t: x.rotulo + ": " + x.n }; }))));
      linhas.appendChild(h("div", { class: "card" }, h("h3", null, "SLA por etapa"), h("div", { class: "cap" }, "Tempo médio contra a meta de cada etapa e % dentro do prazo (verde 90% ou mais, amarelo 75% a 89%, vermelho abaixo de 75%). \"Atrasadas\" mostra onde há processos parados agora: é o gargalo."), d.por_etapa.length ? tabelaEtapas(d) : h("div", { class: "hint" }, "Sem dados.")));
      linhas.appendChild(h("div", { class: "grid-ind dois" },
        h("div", { class: "card" }, h("h3", null, "Por responsável"), h("div", { class: "cap" }, "Carga e cumprimento do prazo de cada pessoa."), d.por_responsavel.length ? tabelaResp(d.por_responsavel) : h("div", { class: "hint" }, "Sem dados.")),
        h("div", { class: "card" }, h("h3", null, "Tipos de rescisão"), h("div", { class: "cap" }, "Motivos dos desligamentos no período."), barrasH(d.por_subtipo.slice(0, 8).map(function (x) { return { l: x.rotulo, v: x.volume, t: x.rotulo + ": " + x.volume }; })))));
      linhas.appendChild(h("div", { class: "card" }, h("h3", null, "Lojas e locais com mais processos"), h("div", { class: "cap" }, "Os 10 locais com mais admissões e rescisões no período."), barrasH(d.por_loja.slice(0, 10).map(function (x) { return { l: x.rotulo, v: x.volume, t: x.rotulo + ": " + x.volume }; }))));
      function listaProc(arr, vazio, tipoLista) {
        var box = h("div"); if (!arr.length) box.appendChild(h("div", { class: "hint" }, vazio));
        arr.forEach(function (x) {
          var txt = tipoLista === "urg" ? (x.etapa_atual ? "Etapa: " + x.etapa_atual.nome + " · " + (x.etapa_atual.restante < 0 ? "estourou há " + fmtUt(-x.etapa_atual.restante) : "faltam " + fmtUt(x.etapa_atual.restante)) : "") : x.prazo_data.rotulo + ": " + fmtData(x.prazo_data.limite) + " (" + qtdDias(x.prazo_data.dias) + ") · " + x.progresso.feitas + " de " + x.progresso.total + " etapas";
          box.appendChild(h("button", { class: "ch-row" + (x.situacao === "estourado" || (x.prazo_data && x.prazo_data.situacao === "estourado") ? " late" : ""), type: "button", onclick: function () { go("processo/" + x.id); } }, h("div", { class: "t" }, h("div", null, h("div", { class: "p" }, x.protocolo + " · " + x.unidade), h("div", { class: "a" }, x.colaborador)), h("div", { class: "chips" }, chipTipo(x.tipo))), h("div", { class: "m" }, txt)));
        });
        return box;
      }
      linhas.appendChild(h("div", { class: "grid-ind dois" },
        h("div", { class: "card" }, h("h3", null, "Mais urgentes agora"), h("div", { class: "cap" }, "Processos em andamento com prazo estourado ou perto de estourar."), listaProc(d.mais_urgentes, "Nenhum processo atrasado ou em risco agora.", "urg")),
        h("div", { class: "card" }, h("h3", null, "Próximas datas"), h("div", { class: "cap" }, "Início de colaboradores e prazos legais de rescisão nos próximos 14 dias (ou já vencidos) em processos abertos."), listaProc(d.proximos_prazos, "Nenhuma data próxima.", "data"))));
      view.appendChild(linhas);
    }).catch(erroTela);
  }

  // ====================================================================================
  // EXCEL
  // ====================================================================================
  var LIBS = { exceljs: "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js" }, libCache = {};
  function carregarLib(nome) {
    if (libCache[nome]) return libCache[nome];
    libCache[nome] = new Promise(function (ok, falha) {
      var s = document.createElement("script"); s.src = LIBS[nome]; s.onload = ok; s.onerror = function () { delete libCache[nome]; falha(new Error("Não foi possível carregar a biblioteca de exportação. Verifique a conexão e tente de novo.")); };
      document.head.appendChild(s);
    });
    return libCache[nome];
  }
  function horasUt(m) { return m === null || m === undefined ? null : Math.round((m / 60) * 10) / 10; }
  function exportarExcel(f) {
    toast("Gerando o Excel…");
    return Promise.all([carregarLib("exceljs"), api("GET", AD + "/indicadores" + qsInd(f))]).then(function (rr) {
      var d = rr[1], k = d.kpis, wb = new ExcelJS.Workbook();
      wb.creator = "Zinzane · Admissão e Rescisão"; wb.created = new Date();
      var BORDO = "FFA3274F", fonteH = { bold: true, color: { argb: "FFFFFFFF" } };
      function folha(nome, cols, linhas) {
        var ws = wb.addWorksheet(nome, { views: [{ state: "frozen", ySplit: 1 }] });
        ws.columns = cols.map(function (c) { return { header: c.t, key: c.k, width: c.w || 16, style: c.fmt ? { numFmt: c.fmt } : {} }; });
        var hr = ws.getRow(1); hr.font = fonteH; hr.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BORDO } }; hr.alignment = { vertical: "middle", wrapText: true }; hr.height = 30;
        linhas.forEach(function (l) { ws.addRow(l); });
        if (linhas.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
        return ws;
      }
      var rs = folha("Resumo", [{ t: "Indicador", k: "a", w: 44 }, { t: "Valor", k: "b", w: 22 }, { t: "Detalhe", k: "c", w: 50 }], [
        { a: "Período", b: fmtData(d.periodo.de) + " a " + fmtData(d.periodo.ate), c: "Os prazos (SLA) contam só o expediente e param quando o processo está pausado." },
        { a: "Em andamento agora", b: k.abertos_agora, c: k.pausados + (k.pausados === 1 ? " pausado · " : " pausados · ") + k.sem_responsavel + " sem responsável" }, { a: "Atrasados agora", b: k.estourados, c: k.em_risco + " em risco" },
        { a: "Abertos no período", b: k.novos, c: k.admissoes + " admissões · " + k.rescisoes + " rescisões" }, { a: "Concluídos", b: k.concluidos, c: k.cancelados + " cancelados" },
        { a: "Concluídos no prazo total", b: k.no_prazo_total_pct === null ? "—" : k.no_prazo_total_pct / 100, c: "" }, { a: "Tempo médio de conclusão (horas úteis)", b: horasUt(k.tempo_medio_conclusao_min) === null ? "—" : horasUt(k.tempo_medio_conclusao_min), c: "" },
        { a: "Admissões prontas antes do início", b: k.admissoes_antes_inicio_pct === null ? "—" : k.admissoes_antes_inicio_pct / 100, c: "" }, { a: "Rescisões pagas no prazo legal (10 dias corridos)", b: k.rescisoes_prazo_legal_pct === null ? "—" : k.rescisoes_prazo_legal_pct / 100, c: "Art. 477 da CLT" },
        { a: "Tempo fora do RH (GO, loja, candidato, clínica)", b: k.fora_do_rh_pct === null ? "—" : k.fora_do_rh_pct / 100, c: "Do tempo útil total dos processos do período" }, { a: "Admissões com devolução de documentos", b: k.retrabalho_pct === null ? "—" : k.retrabalho_pct / 100, c: k.retornos_total + " devoluções em " + k.com_retorno + " processos" }]);
      [7, 9, 10, 11, 12].forEach(function (r) { var c = rs.getRow(r).getCell(2); if (typeof c.value === "number") c.numFmt = "0.0%"; });
      folha("SLA por etapa", [{ t: "Tipo", k: "t", w: 12 }, { t: "Etapa", k: "n", w: 46 }, { t: "Área", k: "a", w: 20 }, { t: "Quem segura", k: "q", w: 14 }, { t: "Chegaram", k: "ch", w: 12 }, { t: "Voltas", k: "v", w: 10 }, { t: "Meta (h úteis)", k: "m", w: 14, fmt: "0.0" }, { t: "Concluídas", k: "c", w: 12 }, { t: "Tempo médio (h úteis)", k: "tm", w: 18, fmt: "0.0" }, { t: "% no prazo", k: "p", w: 12, fmt: "0.0%" }, { t: "Em andamento", k: "e", w: 14 }, { t: "Atrasadas agora", k: "x", w: 15 }],
        d.por_etapa.map(function (e) { return { t: TIPO[e.tipo], n: e.ordem + ". " + e.nome, a: e.area || "", q: e.externo ? "Fora do RH" : "RH", ch: e.chegaram, v: e.voltas, m: horasUt(e.meta_min), c: e.concluidas, tm: horasUt(e.tempo_medio_min), p: e.no_prazo_pct === null ? null : e.no_prazo_pct / 100, e: e.em_andamento, x: e.atrasadas_agora }; }));
      var STP = { em_andamento: "Em andamento", pausado: "Pausado", concluido: "Concluído", cancelado: "Cancelado" }, SLAP = { cumprido: "No prazo", descumprido: "Fora do prazo", ok: "No prazo (em andamento)", risco: "Em risco", estourado: "Atrasado", pausado: "Pausado", cancelado: "Cancelado" };
      var DAT = function (s) { return s ? new Date(s) : null; };
      folha("Processos", [{ t: "Protocolo", k: "p", w: 18 }, { t: "Tipo", k: "t", w: 12 }, { t: "Colaborador", k: "n", w: 32 }, { t: "CPF", k: "cpf", w: 16 }, { t: "Cargo", k: "cg", w: 22 }, { t: "Loja ou local", k: "u", w: 28 }, { t: "Tipo de contrato / rescisão", k: "st", w: 30 }, { t: "Início / fim do contrato", k: "dp", w: 16, fmt: "dd/mm/yyyy" }, { t: "Situação", k: "s", w: 14 }, { t: "Responsável", k: "r", w: 24 }, { t: "Aberto em", k: "ab", w: 18, fmt: "dd/mm/yyyy hh:mm" }, { t: "Concluído em", k: "co", w: 18, fmt: "dd/mm/yyyy hh:mm" }, { t: "Etapa atual", k: "ea", w: 38 }, { t: "Devoluções", k: "dv", w: 12 }, { t: "Tempo com o RH (h úteis)", k: "trh", w: 16, fmt: "0.0" }, { t: "Tempo fora do RH (h úteis)", k: "tfo", w: 16, fmt: "0.0" }, { t: "Encerramento", k: "enc", w: 30 }, { t: "Prazo total (h úteis)", k: "mt", w: 16, fmt: "0.0" }, { t: "Tempo usado (h úteis)", k: "tt", w: 16, fmt: "0.0" }, { t: "SLA total", k: "sl", w: 20 }, { t: "Data limite", k: "dl", w: 16, fmt: "dd/mm/yyyy" }, { t: "Situação da data limite", k: "dls", w: 22 }],
        d.lista.map(function (x) { return { p: x.protocolo, t: x.tipo, n: x.colaborador, cpf: x.cpf || "", cg: x.cargo || "", u: x.unidade, st: x.subtipo || "", dp: x.data_prevista ? DAT(x.data_prevista + "T12:00:00") : null, s: STP[x.status] || x.status, r: x.responsavel || "", ab: DAT(x.criado_em), co: DAT(x.concluido_em), ea: x.etapa_atual || "", dv: x.retornos || 0, trh: horasUt(x.tempo_rh_min), tfo: horasUt(x.tempo_fora_min), enc: x.desfecho || "", mt: horasUt(x.meta_total_min), tt: horasUt(x.tempo_total_min), sl: SLAP[x.sla_total] || x.sla_total, dl: x.prazo_data_limite ? DAT(x.prazo_data_limite + "T12:00:00") : null, dls: SLAP[x.prazo_data] || x.prazo_data }; }));
      var linhasEt = []; d.lista.forEach(function (x) { x.etapas.forEach(function (e, i) { linhasEt.push({ p: x.protocolo, t: x.tipo, n: x.colaborador, o: i + 1, e: e.nome, a: e.area || "", v: e.voltas || 0, m: horasUt(e.meta_min), tm: horasUt(e.tempo_min), s: ({ cumprida: "No prazo", descumprida: "Fora do prazo", dispensada: "Não se aplica", aguardando: "Pendente", cancelada: "Cancelada", ok: "Em andamento", risco: "Em risco (em andamento)", estourado: "Atrasada (em andamento)", pausado: "Pausada" })[e.situacao] || e.situacao }); }); });
      folha("Etapas dos processos", [{ t: "Protocolo", k: "p", w: 18 }, { t: "Tipo", k: "t", w: 12 }, { t: "Colaborador", k: "n", w: 32 }, { t: "Nº", k: "o", w: 6 }, { t: "Etapa", k: "e", w: 46 }, { t: "Área", k: "a", w: 18 }, { t: "Voltas", k: "v", w: 10 }, { t: "Meta (h úteis)", k: "m", w: 14, fmt: "0.0" }, { t: "Tempo total na etapa (h úteis)", k: "tm", w: 18, fmt: "0.0" }, { t: "Situação", k: "s", w: 24 }], linhasEt);
      var linhasRt = []; d.devolucoes.por_motivo.forEach(function (x) { linhasRt.push({ g: "Motivo", r: x.rotulo, n: x.n }); }); d.devolucoes.por_etapa.forEach(function (x) { linhasRt.push({ g: "Etapa que voltou", r: x.rotulo, n: x.n }); }); d.devolucoes.por_loja.forEach(function (x) { linhasRt.push({ g: "Loja", r: x.rotulo, n: x.devolucoes }); }); d.por_desfecho.forEach(function (x) { linhasRt.push({ g: "Encerrado sem contratação", r: x.rotulo, n: x.n }); });
      folha("Retrabalho e encerramentos", [{ t: "Agrupamento", k: "g", w: 28 }, { t: "Item", k: "r", w: 50 }, { t: "Quantidade", k: "n", w: 14 }], linhasRt);
      return wb.xlsx.writeBuffer().then(function (buf) {
        var u = URL.createObjectURL(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })), a = document.createElement("a");
        a.href = u; a.download = "admissao-rescisao-" + d.periodo.de + "_a_" + d.periodo.ate + ".xlsx"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(u); }, 4000); toast("Excel gerado. O CPF aparece mascarado.");
      });
    }).catch(function (e) { toast(e.message, true); });
  }
  function exportarLista() { return exportarExcel({ dias: 365, de: "", ate: "", tipo: S.fil.tipo, loja_id: "", responsavel: "" }); }

  // ====================================================================================
  // CADASTROS (gestor)
  // ====================================================================================
  function viewCadastros() {
    clear(view);
    view.appendChild(head("Cadastros", "Etapas e prazos de cada tipo de processo, mensagens prontas e a equipe que usa o módulo."));
    var box = h("div"), abas = [["etapas", "Etapas e prazos"], ["formularios", "Formulários"], ["mensagens", "Mensagens prontas"], ["equipe", "Equipe"]];
    view.appendChild(h("div", { class: "subtabs" }, abas.map(function (x) { return h("button", { class: "pill" + (x[0] === S.cad ? " on" : ""), type: "button", onclick: function () { S.cad = x[0]; viewCadastros(); } }, x[1]); })));
    view.appendChild(box);
    if (S.cad === "equipe") cadEquipe(box); else if (S.cad === "mensagens") cadMensagens(box); else if (S.cad === "formularios") cadFormularios(box); else cadEtapas(box);
  }
  var ACAO_ROT = { normal: "Etapa comum", aprovacao: "Aprovação da vaga (GO)", validacao: "Validação do RH (pode devolver)", aso: "Resultado do exame (apto ou inapto)" };
  function cadEtapas(box) {
    api("GET", AD + "/etapas-modelo").then(function (r) {
      MENSAGENS_LISTA = r.mensagens || [];
      var t = S.cadTipo, todas = r.etapas.filter(function (x) { return x.tipo === t; }), lista = todas.filter(function (x) { return x.ativo; }), inativas = todas.filter(function (x) { return !x.ativo; }), tot = r.totais[t];
      box.appendChild(h("div", { class: "seg", style: "margin-bottom:12px" }, ["admissao", "rescisao"].map(function (x) { return h("button", { type: "button", "aria-pressed": String(x === t), onclick: function () { S.cadTipo = x; viewCadastros(); } }, TIPO[x]); })));
      var totIn = h("input", { class: "input", inputmode: "decimal", value: tot.definido ? numTxt(diasUteis(tot.definido)) : "", placeholder: "Soma das etapas: " + numTxt(diasUteis(tot.soma)), style: "max-width:200px" });
      box.appendChild(h("div", { class: "card" }, h("h3", null, "Prazo total da " + TIPO[t].toLowerCase()), h("div", { class: "cap" }, "O processo inteiro precisa terminar dentro desse prazo, em dias úteis (1 dia útil = 10 h; use 0,5 para meio dia). Deixe em branco para usar a soma das etapas ativas (" + fmtUt(tot.soma) + ")."),
        h("div", { class: "filters", style: "margin:0" }, totIn, h("button", { class: "btn acc sm", type: "button", onclick: function () { var b = {}; b["sla_total_" + t] = totIn.value.trim() ? paraMin(totIn.value) : null; api("PUT", AD + "/config", b).then(function () { toast("Prazo total salvo."); viewCadastros(); }).catch(function (e) { toast(e.message, true); }); } }, "Salvar")),
        h("div", { class: "hint", style: "margin-top:6px" }, "Vale para os processos abertos a partir de agora; os que já estão em andamento mantêm o prazo com que começaram (ajustável processo a processo).")));
      var tb = h("tbody");
      function mover(i, delta) {
        var j = i + delta; if (j < 0 || j >= lista.length) return;
        var nova = lista.slice(); var tmp = nova[i]; nova[i] = nova[j]; nova[j] = tmp;
        Promise.all(nova.map(function (x, n) { return x.ordem === n + 1 ? null : api("PUT", AD + "/etapas-modelo/" + x.id, { nome: x.nome, descricao: x.descricao, area: x.area, prazo_min: x.prazo_min, ordem: n + 1, acao: x.acao, externo: x.externo, exige_candidato: x.exige_candidato, subtarefas: x.subtarefas, mensagem: x.mensagem, formulario: x.formulario }); })).then(function () { viewCadastros(); }).catch(function (e) { toast(e.message, true); });
      }
      lista.forEach(function (e, i) {
        tb.appendChild(h("tr", { style: e.ativo ? "" : "opacity:.55" }, h("td", null, h("div", { style: "display:flex;gap:4px" }, h("button", { class: "pill", type: "button", "aria-label": "Subir", disabled: i === 0, onclick: function () { mover(i, -1); } }, "▲"), h("button", { class: "pill", type: "button", "aria-label": "Descer", disabled: i === lista.length - 1, onclick: function () { mover(i, 1); } }, "▼"))),
          h("td", { style: "white-space:normal;min-width:260px;text-align:left" }, h("b", null, e.nome), e.descricao ? h("div", { class: "cap", style: "margin:0" }, e.descricao) : null,
            h("div", { class: "chips", style: "margin-top:4px" }, e.acao && e.acao !== "normal" ? h("span", { class: "chip warn" }, ACAO_ROT[e.acao]) : null, e.exige_candidato ? h("span", { class: "chip" }, "exige candidato e data") : null, e.subtarefas && e.subtarefas.length ? h("span", { class: "chip" }, "checklist de " + e.subtarefas.length) : null)),
          h("td", null, e.area || "—", e.externo ? h("div", { class: "cap", style: "margin:0" }, "fora do RH") : null), h("td", { class: "num" }, fmtUt(e.prazo_min)), h("td", null, h("span", { class: "chip " + (e.ativo ? "good" : "") }, e.ativo ? "ativa" : "desativada")), h("td", { class: "num" }, h("button", { class: "btn sec sm", type: "button", onclick: function () { modalEtapa(e); } }, "Editar"))));
      });
      box.appendChild(h("div", { class: "card" }, h("div", { class: "head", style: "margin-bottom:8px" }, h("div", null, h("h3", null, "Etapas da " + TIPO[t].toLowerCase()), h("div", { class: "cap", style: "margin:0" }, "Na ordem em que acontecem. Mudanças valem para os novos processos; os que já estão abertos mantêm as etapas com que começaram.")), h("button", { class: "btn acc sm", type: "button", onclick: function () { modalEtapa(null); } }, "+ Nova etapa")),
        h("div", { class: "qwrap" }, h("table", { class: "q" }, h("thead", null, h("tr", null, h("th", null, "Ordem"), h("th", { style: "text-align:left" }, "Etapa"), h("th", null, "Área"), h("th", { class: "num" }, "Prazo"), h("th", null, "Situação"), h("th"))), tb))));
      if (inativas.length) {
        var tb2 = h("tbody");
        inativas.forEach(function (e) { tb2.appendChild(h("tr", { style: "opacity:.7" }, h("td", { style: "white-space:normal;min-width:260px;text-align:left" }, h("b", null, e.nome), e.descricao ? h("div", { class: "cap", style: "margin:0" }, e.descricao) : null), h("td", null, e.area || "—"), h("td", { class: "num" }, fmtUt(e.prazo_min)), h("td", { class: "num" }, h("button", { class: "btn sec sm", type: "button", onclick: function () { modalEtapa(e); } }, "Editar ou reativar")))); });
        box.appendChild(h("details", { class: "card" }, h("summary", { style: "cursor:pointer;font-weight:700" }, "Etapas desativadas (" + inativas.length + ")"), h("div", { class: "cap" }, "Não entram em novos processos. Os que já estavam abertos mantêm essas etapas."), h("div", { class: "qwrap" }, h("table", { class: "q" }, h("thead", null, h("tr", null, h("th", null, "Etapa"), h("th", null, "Área"), h("th", { class: "num" }, "Prazo"), h("th"))), tb2))));
      }
    }).catch(function (e) { box.appendChild(h("div", { class: "conf err" }, e.message)); });
  }
  function modalEtapa(e) {
    var nome = h("input", { class: "input", value: e ? e.nome : "", maxlength: 140 }), desc = h("textarea", { class: "textarea", rows: 2, maxlength: 400 }), area = h("input", { class: "input", value: e ? e.area || "" : "", maxlength: 60, list: "areas", placeholder: "Ex.: RH" });
    desc.value = e ? e.descricao || "" : "";
    var dl = h("datalist", { id: "areas" }, ["RH", "GO", "Loja", "Candidato", "Clínica", "Contabilidade", "Financeiro", "Jurídico"].map(function (a) { return h("option", { value: a }); }));
    var prazo = h("input", { class: "input", inputmode: "decimal", value: e ? numTxt(diasUteis(e.prazo_min)) : "1" }), ativo = h("input", { type: "checkbox", checked: e ? e.ativo : true }), msg = h("div");
    var acao = h("select", { class: "select" }, Object.keys(ACAO_ROT).map(function (k) { return h("option", { value: k, selected: (e ? e.acao : "normal") === k }, ACAO_ROT[k]); }));
    var quem = h("select", { class: "select" }, [h("option", { value: "rh", selected: !(e && e.externo) }, "RH (equipe interna)"), h("option", { value: "fora", selected: !!(e && e.externo) }, "Fora do RH (GO, loja, candidato ou clínica)")]);
    var exige = h("input", { type: "checkbox", checked: !!(e && e.exige_candidato) });
    var chk = h("textarea", { class: "textarea", rows: 3, maxlength: 1200, placeholder: "Uma tarefa por linha. Deixe em branco se a etapa não tem checklist." }); chk.value = e && e.subtarefas ? e.subtarefas.join("\n") : "";
    var msgSel = h("select", { class: "select" }, [h("option", { value: "" }, "Nenhuma")].concat(MENSAGENS_LISTA.map(function (m) { return h("option", { value: m.chave, selected: e && e.mensagem === m.chave }, m.titulo); })));
    var formSel = h("select", { class: "select" }, [["", "Nenhum"], ["pre", "Link 1 · pré-admissão (gerente)"], ["adm", "Link 2 · admissão (candidato)"]].map(function (x) { return h("option", { value: x[0], selected: (e && e.formulario || "") === x[0] }, x[1]); }));
    var corpo = h("div", null, campo("Nome da etapa *", nome), campo("O que acontece nessa etapa", desc), h("div", { class: "grid2" }, campo("Área responsável", area), campo("Prazo (dias úteis) *", prazo, "1 dia útil = 10 h. Ex.: 0,5 = meio dia; 3 = três dias úteis.")), dl,
      h("div", { class: "grid2" }, campo("Quem executa", quem, "\"Fora do RH\" conta o tempo da etapa como espera pela GO, loja, candidato ou clínica."), campo("Tipo da etapa", acao, "Validação permite devolver para a etapa anterior. Aprovação é da GO. Exame registra apto ou inapto.")),
      campo("Checklist da etapa", chk, "A etapa só conclui com todas as tarefas marcadas."), campo("Mensagem pronta sugerida", msgSel), campo("Formulário ligado a esta etapa", formSel, "Em etapa comum: o link é gerado aqui e, quando a pessoa envia, a etapa conclui sozinha. Em etapa de validação: o RH confere os documentos desse formulário."),
      h("label", { style: "display:flex;gap:8px;align-items:center;font-size:13px;margin-bottom:10px" }, exige, "Exigir nome do candidato e data de início para concluir"),
      e ? h("label", { style: "display:flex;gap:8px;align-items:center;font-size:13px;margin-bottom:10px" }, ativo, "Etapa ativa (entra nos novos processos)") : null, msg,
      h("div", { class: "btns" }, h("button", { class: "btn acc", type: "button", onclick: function () {
        var p = paraMin(prazo.value); if (!(p > 0)) return clear(msg).appendChild(h("div", { class: "conf err" }, "Informe o prazo em dias úteis (maior que zero)."));
        var b = { tipo: S.cadTipo, nome: nome.value, descricao: desc.value, area: area.value, prazo_min: p, acao: acao.value, externo: quem.value === "fora", exige_candidato: exige.checked, subtarefas: chk.value.split("\n").map(function (x) { return x.trim(); }).filter(Boolean), mensagem: msgSel.value || null, formulario: formSel.value || null };
        if (e) { b.ativo = ativo.checked; b.ordem = e.ordem; }
        api(e ? "PUT" : "POST", AD + "/etapas-modelo" + (e ? "/" + e.id : ""), b).then(function () { m.fechar(); toast("Etapa salva."); viewCadastros(); }).catch(function (er) { clear(msg).appendChild(h("div", { class: "conf err" }, er.message)); });
      } }, "Salvar"), h("button", { class: "btn sec", type: "button", onclick: function () { m.fechar(); } }, "Voltar")));
    var m = abrirModal(e ? "Editar etapa" : "Nova etapa de " + TIPO[S.cadTipo].toLowerCase(), corpo, 540);
  }

  var FORM_KIND_ROT = { texto: "Texto", data: "Data", arquivo: "Anexo (foto ou PDF)" };
  function cadFormularios(box) {
    api("GET", AD + "/formularios-modelo").then(function (r) {
      box.appendChild(h("div", { class: "card" }, h("h3", null, "Formulários do gerente e do candidato"), h("div", { class: "cap", style: "margin:0" }, "Cada vaga ganha um link próprio para o gerente (pré-admissão) e outro para o candidato (admissão). A pessoa preenche os campos e anexa os documentos sem precisar de login. Mudanças valem só para os links gerados a partir de agora; os que já foram gerados mantêm os campos com que nasceram.")));
      [["pre", "Link 1 · pré-admissão (gerente)"], ["adm", "Link 2 · admissão (candidato)"]].forEach(function (par) {
        var tipo = par[0], lista = r[tipo].slice();
        function salvar(nova, texto) { api("PUT", AD + "/formularios-modelo/" + tipo, { campos: nova }).then(function () { toast(texto || "Formulário salvo."); viewCadastros(); }).catch(function (er) { toast(er.message, true); }); }
        function mover(i, d) { var j = i + d; if (j < 0 || j >= lista.length) return; var n = lista.slice(), t = n[i]; n[i] = n[j]; n[j] = t; salvar(n, "Ordem salva."); }
        var tb = h("tbody");
        lista.forEach(function (c, i) {
          tb.appendChild(h("tr", null, h("td", null, h("div", { style: "display:flex;gap:4px" }, h("button", { class: "pill", type: "button", "aria-label": "Subir", disabled: i === 0, onclick: function () { mover(i, -1); } }, "▲"), h("button", { class: "pill", type: "button", "aria-label": "Descer", disabled: i === lista.length - 1, onclick: function () { mover(i, 1); } }, "▼"))),
            h("td", { style: "white-space:normal;text-align:left" }, h("b", null, c.rotulo), c.fixo ? h("div", { class: "cap", style: "margin:0" }, "Campo fixo: alimenta o nome e a data de início da vaga") : null),
            h("td", null, FORM_KIND_ROT[c.kind]), h("td", null, c.obrigatorio ? h("span", { class: "chip warn" }, "obrigatório") : h("span", { class: "chip" }, "opcional")),
            h("td", { class: "num" }, h("div", { class: "btns", style: "margin:0;justify-content:flex-end" }, h("button", { class: "btn sec sm", type: "button", onclick: function () { modalCampo(c, function (novo) { var n = lista.slice(); n[i] = novo; salvar(n); }); } }, "Editar"),
              c.fixo ? null : h("button", { class: "btn sec sm", type: "button", onclick: function () { var n = lista.slice(); n.splice(i, 1); salvar(n, "Campo removido."); } }, "Remover")))));
        });
        box.appendChild(h("div", { class: "card" }, h("div", { class: "head", style: "margin-bottom:8px" }, h("div", null, h("h3", null, par[1]), h("div", { class: "cap", style: "margin:0" }, lista.length + " campos")), h("button", { class: "btn acc sm", type: "button", onclick: function () { modalCampo(null, function (novo) { salvar(lista.concat([novo]), "Campo adicionado."); }); } }, "+ Novo campo")),
          h("div", { class: "qwrap" }, h("table", { class: "q" }, h("thead", null, h("tr", null, h("th", null, "Ordem"), h("th", { style: "text-align:left" }, "Campo"), h("th", null, "Tipo"), h("th", null, "Preenchimento"), h("th"))), tb))));
      });
    }).catch(function (e) { box.appendChild(h("div", { class: "conf err" }, e.message)); });
  }
  function modalCampo(c, aoSalvar) {
    var rot = h("input", { class: "input", maxlength: 120, value: c ? c.rotulo : "", placeholder: "Ex.: Comprovante de residência recente" });
    var kind = h("select", { class: "select" }, Object.keys(FORM_KIND_ROT).map(function (k) { return h("option", { value: k, selected: (c ? c.kind : "texto") === k }, FORM_KIND_ROT[k]); }));
    var obr = h("input", { type: "checkbox", checked: c ? c.obrigatorio : false, disabled: !!(c && c.fixo) }), msg = h("div");
    var corpo = h("div", null, campo("Nome do campo (o que a pessoa vê) *", rot), campo("Tipo", kind, c && c.fixo ? "Campo fixo: o tipo não pode mudar." : "Texto: resposta curta. Data: calendário. Anexo: a pessoa fotografa ou envia PDF, JPG ou PNG (até 5 MB, 3 arquivos)."),
      h("label", { style: "display:flex;gap:8px;align-items:center;font-size:13px;margin-bottom:10px" }, obr, "Obrigatório (a pessoa só consegue enviar com ele preenchido)"), msg,
      h("div", { class: "btns" }, h("button", { class: "btn acc", type: "button", onclick: function () {
        if (rot.value.trim().length < 2) return clear(msg).appendChild(h("div", { class: "conf err" }, "Dê um nome ao campo."));
        var novo = { chave: c ? c.chave : undefined, rotulo: rot.value.trim(), kind: c && c.fixo ? c.kind : kind.value, obrigatorio: c && c.fixo ? true : obr.checked, fixo: c ? c.fixo : undefined };
        m.fechar(); aoSalvar(novo);
      } }, "Salvar"), h("button", { class: "btn sec", type: "button", onclick: function () { m.fechar(); } }, "Voltar")));
    var m = abrirModal(c ? "Editar campo" : "Novo campo", corpo, 480);
  }
  var MENSAGENS_LISTA = [];
  function cadMensagens(box) {
    api("GET", AD + "/mensagens").then(function (r) {
      box.appendChild(h("div", { class: "card" }, h("h3", null, "Mensagens prontas"), h("div", { class: "cap" }, "Textos que o RH copia para o WhatsApp ou e-mail dentro de cada processo. Use " + r.variaveis.join(", ") + " para o sistema preencher com os dados do processo."),
        h("div", { class: "hint" }, "As alterações valem para todo o time. \"Restaurar\" volta ao texto original.")));
      r.modelos.forEach(function (m) {
        var t = h("textarea", { class: "textarea", rows: 4, maxlength: 1200 }); t.value = m.texto;
        box.appendChild(h("div", { class: "card" }, h("div", { class: "head", style: "margin-bottom:6px" }, h("div", null, h("h3", null, m.titulo), h("div", { class: "cap", style: "margin:0" }, "Para: " + m.destino + (m.personalizada ? " · personalizada" : ""))),
          h("div", { class: "btns", style: "margin:0" }, h("button", { class: "btn acc sm", type: "button", onclick: function () { api("PUT", AD + "/mensagens/" + m.chave, { texto: t.value }).then(function () { toast("Mensagem salva."); viewCadastros(); }).catch(function (e) { toast(e.message, true); }); } }, "Salvar"),
            m.personalizada ? h("button", { class: "btn sec sm", type: "button", onclick: function () { api("PUT", AD + "/mensagens/" + m.chave, { texto: "" }).then(function () { toast("Texto original restaurado."); viewCadastros(); }).catch(function (e) { toast(e.message, true); }); } }, "Restaurar") : null)), t));
      });
    }).catch(function (e) { box.appendChild(h("div", { class: "conf err" }, e.message)); });
  }
  function cadEquipe(box) {
    api("GET", AD + "/equipe").then(function (r) {
      var tb = h("tbody");
      r.equipe.forEach(function (x) {
        tb.appendChild(h("tr", { style: x.ativo ? "" : "opacity:.55" }, h("td", null, h("b", null, x.nome || x.email), h("div", { class: "cap", style: "margin:0" }, x.email)), h("td", null, x.papel === "gestor" ? "Gestor" : x.papel === "go" ? "GO" : "Analista"), h("td", null, h("span", { class: "chip " + (x.ativo && x.tem_acesso ? "good" : "") }, x.ativo && x.tem_acesso ? "ativo" : "bloqueado")),
          h("td", { class: "num" }, h("div", { class: "btns", style: "margin:0;justify-content:flex-end" }, h("button", { class: "btn sec sm", type: "button", onclick: function () { modalPessoa(x); } }, "Editar"), x.ativo ? h("button", { class: "btn sec sm", type: "button", onclick: function () { modalSenha(x); } }, "Redefinir senha") : null))));
      });
      box.appendChild(h("div", { class: "card" }, h("div", { class: "head", style: "margin-bottom:8px" }, h("div", null, h("h3", null, "Equipe do módulo"), h("div", { class: "cap", style: "margin:0" }, "Analista (RH) conduz os processos. Gestor também cadastra etapas, prazos e equipe, ajusta prazos e cancela processos. GO aprova ou reprova as vagas e acompanha as admissões, sem ver CPF.")), h("button", { class: "btn acc sm", type: "button", onclick: function () { modalPessoa(null); } }, "+ Nova pessoa")),
        r.equipe.length ? h("div", { class: "qwrap" }, h("table", { class: "q" }, h("thead", null, h("tr", null, h("th", null, "Pessoa"), h("th", null, "Perfil"), h("th", null, "Acesso"), h("th"))), tb)) : h("div", { class: "hint" }, "Ninguém cadastrado ainda."),
        h("div", { class: "hint", style: "margin-top:10px" }, "Administradores do sistema (" + r.administradores.map(function (a) { return a.email; }).join(", ") + ") têm acesso total e não precisam estar nesta lista.")));
    }).catch(function (e) { box.appendChild(h("div", { class: "conf err" }, e.message)); });
  }
  function modalPessoa(x) {
    var nome = h("input", { class: "input", value: x ? x.nome || "" : "", maxlength: 100 }), email = h("input", { class: "input", type: "email", value: x ? x.email : "", disabled: !!x }), senha = h("input", { class: "input", type: "text", autocomplete: "off", placeholder: "Mínimo 8 caracteres" });
    var papel = h("select", { class: "select" }, [["analista", "Analista (RH, conduz os processos)"], ["gestor", "Gestor (também cadastra e cancela)"], ["go", "GO (aprova ou reprova vagas)"]].map(function (o) { return h("option", { value: o[0], selected: x && x.papel === o[0] }, o[1]); }));
    var ativo = h("input", { type: "checkbox", checked: x ? x.ativo : true }), msg = h("div");
    var corpo = h("div", null, campo("Nome", nome), campo("E-mail de login *", email), campo("Perfil", papel), x ? h("label", { style: "display:flex;gap:8px;align-items:center;font-size:13px;margin-bottom:10px" }, ativo, "Acesso ativo") : campo("Senha provisória", senha, "Só é necessária se a pessoa ainda não tem login no sistema. Ela troca no primeiro acesso."), msg,
      h("div", { class: "btns" }, h("button", { class: "btn acc", type: "button", onclick: function () {
        var req = x ? api("PUT", AD + "/equipe/" + x.id, { nome: nome.value, papel: papel.value, ativo: ativo.checked }) : api("POST", AD + "/equipe", { nome: nome.value, email: email.value, papel: papel.value, senha: senha.value });
        req.then(function (r) { m.fechar(); toast(x ? "Pessoa atualizada." : r.acesso_criado ? "Acesso criado. Passe o e-mail e a senha provisória à pessoa." : "Acesso liberado."); viewCadastros(); }).catch(function (er) { clear(msg).appendChild(h("div", { class: "conf err" }, er.message)); });
      } }, "Salvar"), h("button", { class: "btn sec", type: "button", onclick: function () { m.fechar(); } }, "Voltar")));
    var m = abrirModal(x ? "Editar pessoa" : "Nova pessoa na equipe", corpo, 480);
  }
  function modalSenha(x) {
    var senha = h("input", { class: "input", type: "text", autocomplete: "off", placeholder: "Mínimo 8 caracteres" }), msg = h("div");
    var corpo = h("div", null, h("div", { class: "cap" }, "A pessoa troca essa senha provisória no próximo acesso e os aparelhos conectados saem."), campo("Nova senha provisória para " + (x.nome || x.email), senha), msg, h("div", { class: "btns" }, h("button", { class: "btn acc", type: "button", onclick: function () {
      api("POST", AD + "/equipe/senha", { email: x.email, senha: senha.value }).then(function () { m.fechar(); toast("Senha redefinida."); }).catch(function (er) { clear(msg).appendChild(h("div", { class: "conf err" }, er.message)); });
    } }, "Redefinir"), h("button", { class: "btn sec", type: "button", onclick: function () { m.fechar(); } }, "Voltar")));
    var m = abrirModal("Redefinir senha", corpo, 440);
  }

  // ====================================================================================
  // rotas e boot
  // ====================================================================================
  function route() {
    clearInterval(S.timer);
    var parts = (location.hash || "#").slice(1).split("/"), v = parts[0] || "processos";
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) { t.setAttribute("aria-selected", String(t.dataset.v === v || (v === "processo" && t.dataset.v === "processos"))); });
    window.scrollTo(0, 0);
    if (v === "processo") return viewProcesso(parts[1]);
    if (ehGo() && v !== "processos") return viewFila();
    if (v === "novo") return viewNovo();
    if (v === "indicadores") return viewIndicadores();
    if (v === "cadastros" && ehGestor()) return viewCadastros();
    return viewFila();
  }
  window.addEventListener("hashchange", route);
  S.token = lget(TOKEN_KEY);
  if (!S.token) { location.href = PORTAL + "?m=admissao"; return; }
  api("GET", "/api/auth/me").then(function (r) {
    S.user = r.user;
    if (S.user.role !== "admin" && (S.user.modules || []).indexOf("admissao") < 0) { location.href = PORTAL + "?semacesso=admissao"; return; }
    var outros = S.user.role === "admin" || (S.user.modules || []).some(function (m) { return m !== "admissao"; });
    var ml = $("modLink"); if (ml && !outros) ml.hidden = true;
    return api("GET", AD + "/eu").then(function (eu) {
      S.eu = eu;
      var tabs = $("tabs"); clear(tabs);
      (ehGo() ? [["processos", "Vagas e admissões"]] : [["processos", "Processos"], ["indicadores", "Indicadores"]].concat(ehGestor() ? [["cadastros", "Cadastros"]] : [])).forEach(function (x) { tabs.appendChild(h("button", { class: "tab", role: "tab", "data-v": x[0], onclick: function () { go(x[0]); } }, x[1])); });
      if (!ehGo()) tabs.appendChild(h("button", { class: "tab new", role: "tab", "data-v": "novo", onclick: function () { go("novo"); } }, "+ Novo processo"));
      if (ehGo()) { S.fil.status = "abertos"; S.fil.com = "go"; }
      $("who").textContent = eu.nome + " · " + (eu.admin ? "Administrador" : eu.papel === "gestor" ? "Gestor" : eu.papel === "go" ? "GO" : "Analista");
      var ex = eu.expediente, hm = function (m) { return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); }, dn = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
      $("foot").textContent = "Conectado como " + eu.nome + ". Prazos (SLA) contados só no expediente (" + hm(ex.inicio_min) + " às " + hm(ex.fim_min) + ", " + ex.dias.map(function (x) { return dn[x]; }).join(", ") + "). Cada consulta e alteração fica registrada com usuário e horário.";
      var pw = $("pwBtn"); if (pw) pw.onclick = function () { trocarSenha(false); };
      if (eu.trocar_senha) { trocarSenha(true); return; }
      route();
    }, function (e) { view.appendChild(h("div", { class: "card empty" }, e.message)); });
  }).catch(function (e) { if (e && e.message) view.appendChild(h("div", { class: "card empty" }, e.message)); });
})();

</script>
</body>
</html>
