const express = require('express');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());


const API_TOKEN      = process.env.PIPEDRIVE_TOKEN;
const ORG            = process.env.PIPEDRIVE_ORG   || 'boardacademy';
const FILTER_ID      = process.env.FILTER_ID       || '1631100';
const PRODUCT_FIELD  = '8bdce76ba66f0fed0280918a4845190c92899ed5';
const CAMPAIGN_FIELD = 'ae03fa460a108b8cdfa87e97ebca24379d2779d6';

const LEAN_IDS = new Set(['22395618474', '22402104677', '22406191339']);
const CES_IDS  = new Set(['22734871401', '23367012467']);

// ── Classificação ─────────────────────────────────────────────────────
// Retorna array: pode ser ['LEAN'], ['CES'] ou ['LEAN','CES'] (venda master)
function classifyProduct(v) {
  if (!v) return [];
  const s = String(v);
  const r = [];
  if (/lean/i.test(s) && !/livro/i.test(s))    r.push('LEAN');
  if (/ces/i.test(s)  && !/ascesso/i.test(s))  r.push('CES');
  return r;
}

function classifyCampaign(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (LEAN_IDS.has(s)) return 'LEAN';
  if (CES_IDS.has(s))  return 'CES';
  return null;
}

// ── Date utils ────────────────────────────────────────────────────────
const toYM  = d => d ? String(d).substring(0, 7) : null;
const toYMD = d => d ? String(d).substring(0, 10) : null;

function weekStart(dateStr) {
  if (!dateStr) return null;
  const d = new Date(String(dateStr).substring(0, 10) + 'T00:00:00Z');
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1));
  return d.toISOString().substring(0, 10);
}

function getWeeks(n = 8) {
  const now  = new Date();
  const day  = now.getUTCDay();
  const base = new Date(now);
  base.setUTCDate(now.getUTCDate() - (day === 0 ? 6 : day - 1));
  base.setUTCHours(0, 0, 0, 0);
  const weeks = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setUTCDate(base.getUTCDate() - i * 7);
    weeks.push(d.toISOString().substring(0, 10));
  }
  return weeks;
}

// ── Pipedrive ─────────────────────────────────────────────────────────
const BASE = `https://${ORG}.pipedrive.com/api/v1`;

async function pipeGet(ep) {
  const sep = ep.includes('?') ? '&' : '?';
  const r   = await fetch(`${BASE}${ep}${sep}api_token=${API_TOKEN}`);
  if (!r.ok) throw new Error(`Pipedrive ${r.status} → ${ep}`);
  return r.json();
}

async function fetchAllDeals() {
  const all = []; let start = 0;
  while (true) {
    const j = await pipeGet(`/deals?filter_id=${FILTER_ID}&status=all&limit=500&start=${start}`);
    (j.data || []).forEach(d => all.push(d));
    if (!j.additional_data?.pagination?.more_items_in_collection) break;
    start += 500;
  }
  return all;
}

// ── Estrutura de dados por produto ────────────────────────────────────
function emptyData() {
  return {
    // criados e perdidos: baseado em campanha
    criados:  { mes: { t: 0, dia: {}, st: { a: 0, g: 0, p: 0 } }, sem: {} },
    // ganhos: dois ângulos
    ganhosProd: { mes: { t: 0, rev: 0, dia: {} }, sem: {} },  // produto vendido
    ganhosCamp: { mes: { t: 0, rev: 0, dia: {} }, sem: {} },  // origem da campanha
    perdidos: { mes: { t: 0, dia: {}, motivos: {} }, sem: {} },
  };
}

// ── /api/report ───────────────────────────────────────────────────────
app.get('/api/report', async (req, res) => {
  if (!API_TOKEN) return res.status(500).json({ ok: false, error: 'PIPEDRIVE_TOKEN não configurado.' });
  try {
    const deals  = await fetchAllDeals();
    const curYM  = new Date().toISOString().substring(0, 7);
    const weeks  = getWeeks(8);
    const wSet   = new Set(weeks);
    const D      = { LEAN: emptyData(), CES: emptyData() };

    for (const deal of deals) {
      const camp  = classifyCampaign(deal[CAMPAIGN_FIELD]);
      const prods = classifyProduct(deal[PRODUCT_FIELD]);
      const val   = parseFloat(deal.value || 0);

      // ── CRIADOS: filtro por campanha, inclui todos (val=0 ok) ──────
      if (camp && deal.add_time) {
        const _ym = toYM(deal.add_time);
        const _w  = weekStart(deal.add_time);
        const d   = D[camp].criados;

        if (_ym === curYM) {
          const _d = toYMD(deal.add_time);
          d.mes.t++;
          d.mes.dia[_d] = (d.mes.dia[_d] || 0) + 1;
          if (deal.status === 'open')  d.mes.st.a++;
          if (deal.status === 'won')   d.mes.st.g++;
          if (deal.status === 'lost')  d.mes.st.p++;
        }
        if (wSet.has(_w)) d.sem[_w] = (d.sem[_w] || 0) + 1;
      }

      // ── GANHOS POR PRODUTO: só val > 0 ────────────────────────────
      if (deal.status === 'won' && deal.won_time && val > 0 && prods.length) {
        const _ym = toYM(deal.won_time);
        const _w  = weekStart(deal.won_time);
        const _d  = toYMD(deal.won_time);

        for (const p of prods) {
          const g = D[p].ganhosProd;
          if (_ym === curYM) {
            g.mes.t++; g.mes.rev += val;
            if (!g.mes.dia[_d]) g.mes.dia[_d] = { t: 0, r: 0 };
            g.mes.dia[_d].t++; g.mes.dia[_d].r += val;
          }
          if (wSet.has(_w)) {
            if (!g.sem[_w]) g.sem[_w] = { t: 0, r: 0 };
            g.sem[_w].t++; g.sem[_w].r += val;
          }
        }
      }

      // ── GANHOS POR CAMPANHA: só val > 0 ───────────────────────────
      if (deal.status === 'won' && deal.won_time && val > 0 && camp) {
        const _ym = toYM(deal.won_time);
        const _w  = weekStart(deal.won_time);
        const _d  = toYMD(deal.won_time);
        const g   = D[camp].ganhosCamp;

        if (_ym === curYM) {
          g.mes.t++; g.mes.rev += val;
          if (!g.mes.dia[_d]) g.mes.dia[_d] = { t: 0, r: 0 };
          g.mes.dia[_d].t++; g.mes.dia[_d].r += val;
        }
        if (wSet.has(_w)) {
          if (!g.sem[_w]) g.sem[_w] = { t: 0, r: 0 };
          g.sem[_w].t++; g.sem[_w].r += val;
        }
      }

      // ── PERDIDOS: filtro por campanha, inclui todos (val=0 ok) ────
      if (deal.status === 'lost' && deal.lost_time && camp) {
        const _ym = toYM(deal.lost_time);
        const _w  = weekStart(deal.lost_time);
        const d   = D[camp].perdidos;

        if (_ym === curYM) {
          const _d   = toYMD(deal.lost_time);
          const motivo = deal.lost_reason?.trim() || 'Não informado';
          d.mes.t++;
          d.mes.dia[_d] = (d.mes.dia[_d] || 0) + 1;
          d.mes.motivos[motivo] = (d.mes.motivos[motivo] || 0) + 1;
        }
        if (wSet.has(_w)) d.sem[_w] = (d.sem[_w] || 0) + 1;
      }
    }

    // ── Serialização ──────────────────────────────────────────────────
    const year        = parseInt(curYM.split('-')[0]);
    const month       = parseInt(curYM.split('-')[1]);
    const daysInMonth = new Date(year, month, 0).getDate();
    const allDays     = Array.from({ length: daysInMonth }, (_, i) =>
      `${curYM}-${String(i + 1).padStart(2, '0')}`);

    const ser = p => ({
      criados: {
        total:    p.criados.mes.t,
        mediaDia: allDays.length ? +(p.criados.mes.t / allDays.length).toFixed(1) : 0,
        status:   p.criados.mes.st,
        porDia:   allDays.map(d => ({ d, v: p.criados.mes.dia[d] || 0 })),
        porSemana: weeks.map(w => ({ w, v: p.criados.sem[w] || 0 })),
      },
      ganhos: {
        porProduto: {
          total:   p.ganhosProd.mes.t,
          receita: p.ganhosProd.mes.rev,
          ticket:  p.ganhosProd.mes.t ? p.ganhosProd.mes.rev / p.ganhosProd.mes.t : 0,
          porSemana: weeks.map(w => ({ w, v: p.ganhosProd.sem[w]?.t || 0, r: p.ganhosProd.sem[w]?.r || 0 })),
        },
        porCampanha: {
          total:   p.ganhosCamp.mes.t,
          receita: p.ganhosCamp.mes.rev,
          ticket:  p.ganhosCamp.mes.t ? p.ganhosCamp.mes.rev / p.ganhosCamp.mes.t : 0,
          porSemana: weeks.map(w => ({ w, v: p.ganhosCamp.sem[w]?.t || 0, r: p.ganhosCamp.sem[w]?.r || 0 })),
        },
      },
      perdidos: {
        total:    p.perdidos.mes.t,
        mediaDia: allDays.length ? +(p.perdidos.mes.t / allDays.length).toFixed(1) : 0,
        porDia:   allDays.map(d => ({ d, v: p.perdidos.mes.dia[d] || 0 })),
        porSemana: weeks.map(w => ({ w, v: p.perdidos.sem[w] || 0 })),
        topMotivos: Object.entries(p.perdidos.mes.motivos)
          .sort((a, b) => b[1] - a[1]).slice(0, 10)
          .map(([m, c]) => ({ m, c, pct: p.perdidos.mes.t ? Math.round(c / p.perdidos.mes.t * 100) : 0 })),
      },
    });

    res.json({
      ok:        true,
      mes:       curYM,
      updatedAt: new Date().toISOString(),
      lean:      ser(D.LEAN),
      ces:       ser(D.CES),
    });

  } catch (e) {
    console.error('[/api/report]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// local dev
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`✓ Porta ${PORT}`));
}

module.exports = app;
