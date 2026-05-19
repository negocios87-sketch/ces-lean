const express = require('express');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const API_TOKEN          = process.env.PIPEDRIVE_TOKEN;
const ORG                = process.env.PIPEDRIVE_ORG        || 'boardacademy';
const FILTER_CRIADOS     = process.env.FILTER_CRIADOS       || '1631100';
const FILTER_GANHOS      = process.env.FILTER_GANHOS        || '1647346';
const FILTER_PERDIDOS    = process.env.FILTER_PERDIDOS      || '1647390';
const PRODUCT_FIELD      = '8bdce76ba66f0fed0280918a4845190c92899ed5';
const CAMPAIGN_FIELD     = 'ae03fa460a108b8cdfa87e97ebca24379d2779d6';

const LEAN_IDS = new Set(['22395618474', '22402104677', '22406191339']);
const CES_IDS  = new Set(['22734871401', '23367012467']);

// ── Classificações ────────────────────────────────────────────
function classifyProduct(v) {
  if (!v) return [];
  const s = String(v);
  const r = [];
  if (/lean/i.test(s) && !/livro/i.test(s))   r.push('LEAN');
  if (/ces/i.test(s)  && !/ascesso/i.test(s)) r.push('CES');
  return r;
}

function classifyCampaign(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (LEAN_IDS.has(s)) return 'LEAN';
  if (CES_IDS.has(s))  return 'CES';
  return null;
}

function classifyOrigem(v) {
  if (!v) return 'Outras Origens';
  const s = String(v).trim();
  if (/pfcc/i.test(s)) return 'PFCC';
  if (LEAN_IDS.has(s)) return 'LEAN';
  if (CES_IDS.has(s))  return 'CES';
  return 'Outras Origens';
}

// ── Date utils ────────────────────────────────────────────────
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

// ── Pipedrive ─────────────────────────────────────────────────
const BASE = `https://${ORG}.pipedrive.com/api/v1`;

async function pipeGet(ep) {
  const sep = ep.includes('?') ? '&' : '?';
  const r   = await fetch(`${BASE}${ep}${sep}api_token=${API_TOKEN}`);
  if (!r.ok) throw new Error(`Pipedrive ${r.status} → ${ep}`);
  return r.json();
}

async function fetchByFilter(filterId) {
  const all = []; let start = 0;
  while (true) {
    const j = await pipeGet(`/deals?filter_id=${filterId}&status=all&limit=500&start=${start}`);
    (j.data || []).forEach(d => all.push(d));
    if (!j.additional_data?.pagination?.more_items_in_collection) break;
    start += 500;
  }
  return all;
}

// ── /api/report ───────────────────────────────────────────────
app.get('/api/report', async (req, res) => {
  if (!API_TOKEN) return res.status(500).json({ ok: false, error: 'PIPEDRIVE_TOKEN não configurado.' });
  try {
    // 3 fetches paralelos — cada um no seu filtro e eixo temporal
    const [dealsCriados, dealsGanhos, dealsPerdidos] = await Promise.all([
      fetchByFilter(FILTER_CRIADOS),
      fetchByFilter(FILTER_GANHOS),
      fetchByFilter(FILTER_PERDIDOS),
    ]);

    const curYM = new Date().toISOString().substring(0, 7);
    const weeks = getWeeks(8);
    const wSet  = new Set(weeks);

    const year        = parseInt(curYM.split('-')[0]);
    const month       = parseInt(curYM.split('-')[1]);
    const daysInMonth = new Date(year, month, 0).getDate();
    const allDays     = Array.from({ length: daysInMonth }, (_, i) =>
      `${curYM}-${String(i + 1).padStart(2, '0')}`);

    // ── Estrutura vazia por produto ───────────────────────────
    const empty = () => ({
      criados: {
        mes: { t:0, dia:{}, diaA:{}, diaG:{}, diaP:{}, st:{a:0,g:0,p:0}, produtosVendidos:{} },
        sem: {},
      },
      ganhos: {
        mes: { t:0, rev:0, dia:{}, origens:{} },
        sem: {},
      },
      camp: {
        mes: { t:0, rev:0, dia:{} },
        sem: {},
      },
      perdidos: {
        mes: { t:0, dia:{}, motivos:{} },
        sem: {},
      },
    });

    const D = { LEAN: empty(), CES: empty() };

    // ── CRIADOS (filtro por campanha, eixo: add_time) ─────────
    for (const deal of dealsCriados) {
      const camp = classifyCampaign(deal[CAMPAIGN_FIELD]);
      if (!camp || !deal.add_time) continue;

      const _ym = toYM(deal.add_time);
      const _w  = weekStart(deal.add_time);
      const dc  = D[camp].criados;

      if (_ym === curYM) {
        const _d = toYMD(deal.add_time);
        dc.mes.t++;
        dc.mes.dia[_d]  = (dc.mes.dia[_d]  || 0) + 1;
        if (deal.status === 'open')  { dc.mes.st.a++; dc.mes.diaA[_d] = (dc.mes.diaA[_d]||0)+1; }
        if (deal.status === 'won')   { dc.mes.st.g++; dc.mes.diaG[_d] = (dc.mes.diaG[_d]||0)+1; }
        if (deal.status === 'lost')  { dc.mes.st.p++; dc.mes.diaP[_d] = (dc.mes.diaP[_d]||0)+1; }

        // produtos vendidos de leads criados esse mês
        const val   = parseFloat(deal.value || 0);
        const prods = classifyProduct(deal[PRODUCT_FIELD]);
        if (deal.status === 'won' && val > 0 && prods.length) {
          for (const p of prods) {
            const nome = p === 'LEAN' ? 'Lean Governance' : 'CES';
            if (!dc.mes.produtosVendidos[nome]) dc.mes.produtosVendidos[nome] = { t:0, rev:0 };
            dc.mes.produtosVendidos[nome].t++;
            dc.mes.produtosVendidos[nome].rev += val;
          }
        }
      }
      if (wSet.has(_w)) dc.sem[_w] = (dc.sem[_w] || 0) + 1;
    }

    // ── GANHOS (filtro por produto, eixo: won_time) ───────────
    for (const deal of dealsGanhos) {
      if (deal.status !== 'won' || !deal.won_time) continue;
      const val   = parseFloat(deal.value || 0);
      if (val <= 0) continue;
      const prods  = classifyProduct(deal[PRODUCT_FIELD]);
      const camp   = classifyCampaign(deal[CAMPAIGN_FIELD]);
      const origem = classifyOrigem(deal[CAMPAIGN_FIELD]);
      if (!prods.length) continue;

      const _ym = toYM(deal.won_time);
      const _w  = weekStart(deal.won_time);
      const _d  = toYMD(deal.won_time);

      for (const p of prods) {
        const g = D[p].ganhos;
        if (_ym === curYM) {
          g.mes.t++; g.mes.rev += val;
          if (!g.mes.dia[_d]) g.mes.dia[_d] = { t:0, r:0 };
          g.mes.dia[_d].t++; g.mes.dia[_d].r += val;
          if (!g.mes.origens[origem]) g.mes.origens[origem] = { t:0, rev:0 };
          g.mes.origens[origem].t++;
          g.mes.origens[origem].rev += val;
        }
        if (wSet.has(_w)) {
          if (!g.sem[_w]) g.sem[_w] = { t:0, r:0 };
          g.sem[_w].t++; g.sem[_w].r += val;
        }
      }

      // Ganhos por campanha de origem
      if (camp) {
        const gc = D[camp].camp;
        if (_ym === curYM) {
          gc.mes.t++; gc.mes.rev += val;
          if (!gc.mes.dia[_d]) gc.mes.dia[_d] = { t:0, r:0 };
          gc.mes.dia[_d].t++; gc.mes.dia[_d].r += val;
        }
        if (wSet.has(_w)) {
          if (!gc.sem[_w]) gc.sem[_w] = { t:0, r:0 };
          gc.sem[_w].t++; gc.sem[_w].r += val;
        }
      }
    }

    // ── PERDIDOS (filtro por campanha, eixo: lost_time) ───────
    for (const deal of dealsPerdidos) {
      if (deal.status !== 'lost' || !deal.lost_time) continue;
      const camp = classifyCampaign(deal[CAMPAIGN_FIELD]);
      if (!camp) continue;

      const _ym  = toYM(deal.lost_time);
      const _w   = weekStart(deal.lost_time);
      const dp   = D[camp].perdidos;

      if (_ym === curYM) {
        const _d     = toYMD(deal.lost_time);
        const motivo = deal.lost_reason?.trim() || 'Não informado';
        dp.mes.t++;
        dp.mes.dia[_d]         = (dp.mes.dia[_d] || 0) + 1;
        dp.mes.motivos[motivo] = (dp.mes.motivos[motivo] || 0) + 1;
      }
      if (wSet.has(_w)) dp.sem[_w] = (dp.sem[_w] || 0) + 1;
    }

    // ── Serialização ──────────────────────────────────────────
    const ser = p => ({
      criados: {
        total:    p.criados.mes.t,
        mediaDia: allDays.length ? +(p.criados.mes.t / allDays.length).toFixed(1) : 0,
        status:   p.criados.mes.st,
        taxaConv: p.criados.mes.t > 0
          ? +((p.criados.mes.st.g / p.criados.mes.t) * 100).toFixed(1) : 0,
        porDia: allDays.map(d => ({
          d,
          v: p.criados.mes.dia[d]  || 0,
          a: p.criados.mes.diaA[d] || 0,
          g: p.criados.mes.diaG[d] || 0,
          p: p.criados.mes.diaP[d] || 0,
        })),
        porSemana: weeks.map(w => ({ w, v: p.criados.sem[w] || 0 })),
        produtosVendidos: Object.entries(p.criados.mes.produtosVendidos)
          .sort((a,b) => b[1].rev - a[1].rev)
          .map(([nome,x]) => ({ nome, t:x.t, rev:x.rev, ticket: x.t ? x.rev/x.t : 0 })),
      },
      ganhos: {
        porProduto: {
          total:   p.ganhos.mes.t,
          receita: p.ganhos.mes.rev,
          ticket:  p.ganhos.mes.t ? p.ganhos.mes.rev / p.ganhos.mes.t : 0,
          porDia:  allDays.map(d => ({ d, v: p.ganhos.mes.dia[d]?.t||0, r: p.ganhos.mes.dia[d]?.r||0 })),
          porSemana: weeks.map(w => ({ w, v: p.ganhos.sem[w]?.t||0, r: p.ganhos.sem[w]?.r||0 })),
          origens: Object.entries(p.ganhos.mes.origens)
            .sort((a,b) => b[1].rev - a[1].rev)
            .map(([nome,x]) => ({ nome, t:x.t, rev:x.rev, ticket: x.t ? x.rev/x.t : 0 })),
        },
        porCampanha: {
          total:   p.camp.mes.t,
          receita: p.camp.mes.rev,
          ticket:  p.camp.mes.t ? p.camp.mes.rev / p.camp.mes.t : 0,
          porDia:  allDays.map(d => ({ d, v: p.camp.mes.dia[d]?.t||0, r: p.camp.mes.dia[d]?.r||0 })),
          porSemana: weeks.map(w => ({ w, v: p.camp.sem[w]?.t||0, r: p.camp.sem[w]?.r||0 })),
        },
      },
      perdidos: {
        total:     p.perdidos.mes.t,
        mediaDia:  allDays.length ? +(p.perdidos.mes.t / allDays.length).toFixed(1) : 0,
        porDia:    allDays.map(d => ({ d, v: p.perdidos.mes.dia[d] || 0 })),
        porSemana: weeks.map(w => ({ w, v: p.perdidos.sem[w] || 0 })),
        topMotivos: Object.entries(p.perdidos.mes.motivos)
          .sort((a,b) => b[1]-a[1]).slice(0,10)
          .map(([m,c]) => ({ m, c, pct: p.perdidos.mes.t ? Math.round(c/p.perdidos.mes.t*100) : 0 })),
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

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`✓ Porta ${PORT}`));
}

module.exports = app;
