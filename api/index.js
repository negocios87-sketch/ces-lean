const express = require('express');
const app  = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

const API_TOKEN       = process.env.PIPEDRIVE_TOKEN;
const ORG             = process.env.PIPEDRIVE_ORG     || 'boardacademy';
const FILTER_CRIADOS  = process.env.FILTER_CRIADOS    || '1631100';
const FILTER_GANHOS   = process.env.FILTER_GANHOS     || '1647346';
const FILTER_PERDIDOS = process.env.FILTER_PERDIDOS   || '1647390';
const PRODUCT_FIELD   = '8bdce76ba66f0fed0280918a4845190c92899ed5';
const CAMPAIGN_FIELD  = 'ae03fa460a108b8cdfa87e97ebca24379d2779d6';

// ── Score fields ──────────────────────────────────────────────
const FIELD_RENDA        = 'c95b2c453828853409c0a1f5d5f1a6ab30eebebf';
const FIELD_CARGO        = '718c8aba81211c883ffd9f4616f75ee22a10b2da';
const FIELD_IDADE        = '83d18fca9a1f15041acebd03956039213f47c75a';
const FIELD_ESCOLARIDADE = '93ce10ba72f6b8aab8a4d18d699ddeb36b12ab1f';
const TURMAS_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSvwO3Ag2f2cbkVgR1pJZp6fANQcbualGKlAG50fmOljuEGKZ1gJBbSAjRdO3SomXUEVQOWnTvlfHRd/pub?gid=715115296&single=true&output=csv';

const SCORE_RULES_URL    = process.env.SCORE_RULES_URL ||
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vSvwO3Ag2f2cbkVgR1pJZp6fANQcbualGKlAG50fmOljuEGKZ1gJBbSAjRdO3SomXUEVQOWnTvlfHRd/pub?gid=422517996&single=true&output=csv';

const SCORE_DEFAULTS = { renda:1.1, cargo:0.9, idade:0.5, escolaridade:1.0 };
const SCORE_FAIXAS = [
  {label:'De 2 a 2,9', min:2,  max:3},
  {label:'De 3 a 3,9', min:3,  max:4},
  {label:'De 4 a 4,9', min:4,  max:5},
  {label:'De 5 a 5,9', min:5,  max:6},
  {label:'De 6 a 6,9', min:6,  max:7},
  {label:'De 7 a 7,9', min:7,  max:8},
  {label:'De 8 a 8,9', min:8,  max:9},
  {label:'De 9 a 10',  min:9,  max:10.000001},
];

const LEAN_IDS = new Set(['22395618474','22402104677','22406191339']);

// Classificação de times por pipeline
const TIMES = {
  'Time Diarley': new Set([39]),
  'Time Denise':  new Set([46,51,87,88]),
};
function classifyTime(pipeId){
  const id = parseInt(pipeId)||0;
  if (TIMES['Time Diarley'].has(id)) return 'Time Diarley';
  if (TIMES['Time Denise'].has(id))  return 'Time Denise';
  return 'Outros';
}
const CES_IDS  = new Set(['22734871401','23367012467']);

// ── Classificações ────────────────────────────────────────────
function classifyProduct(v) {
  if (!v) return [];
  const s=String(v), r=[];
  if (/lean/i.test(s)&&!/livro/i.test(s))   r.push('LEAN');
  if (/ces/i.test(s) &&!/ascesso/i.test(s)) r.push('CES');
  return r;
}
function classifyCampaign(v) {
  if (!v) return null;
  const s=String(v).trim();
  if (LEAN_IDS.has(s)||(/lean/i.test(s)&&!/ascesso/i.test(s))) return 'LEAN';
  if (CES_IDS.has(s) ||(/ces/i.test(s) &&!/ascesso/i.test(s))) return 'CES';
  return null;
}
function classifyOrigem(v) {
  if (!v) return 'Outras Origens';
  const s=String(v).trim();
  if (/pfcc/i.test(s)) return 'PFCC';
  if (LEAN_IDS.has(s)||(/lean/i.test(s)&&!/ascesso/i.test(s))) return 'LEAN';
  if (CES_IDS.has(s) ||(/ces/i.test(s) &&!/ascesso/i.test(s))) return 'CES';
  return 'Outras Origens';
}

// ── Score ─────────────────────────────────────────────────────
async function carregarTurmas() {
  try {
    const r=await fetch(TURMAS_URL,{cache:'no-store'});
    if (!r.ok) return [];
    const txt=await r.text();
    const linhas=txt.split(/\r?\n/).filter(l=>l.trim());
    if (linhas.length<2) return [];
    const delim=linhas[0].includes('\t')?'\t':',';
    const headers=parseCsvLine(linhas[0],delim).map(h=>h.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z]/g,''));
    return linhas.slice(1).filter(l=>l.trim()).map(line=>{
      const cols=parseCsvLine(line,delim);
      const o={};
      headers.forEach((h,i)=>o[h]=(cols[i]||'').trim());
      const parseNum=v=>parseInt(String(v||'').replace(/[^\d]/g,''))||0;
      return {
        produto:    (o.produto||'').toUpperCase().trim(),
        dataInicio: o.datadeinicio||o.datainicio||o.data||'',
        turma:      o.turma||'',
        volumeReal: parseNum(o.volumereal||o.volume||'0'),
        minimo:     parseNum(o.minimo||o.mnimo||'0'),
        ideal:      parseNum(o.ideal||'0'),
      };
    }).filter(t=>t.produto&&t.turma);
  } catch(e){ console.warn('Turmas failed:',e.message); return []; }
}

function normalizarTexto(v) {
  return String(v||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
}
function parseCsvLine(line, delim) {
  const out=[]; let cur=''; let inQ=false;
  for (let i=0;i<line.length;i++) {
    const ch=line[i],nx=line[i+1];
    if (ch==='"'&&inQ&&nx==='"'){cur+='"';i++;continue;}
    if (ch==='"'){inQ=!inQ;continue;}
    if (ch===delim&&!inQ){out.push(cur);cur='';continue;}
    cur+=ch;
  }
  out.push(cur);
  return out.map(x=>x.trim());
}
function parsePontuacao(v) {
  const n=parseFloat(String(v||'').replace(',','.'));
  return Number.isFinite(n)?n:null;
}
async function carregarRegrasScore() {
  try {
    const r=await fetch(SCORE_RULES_URL,{cache:'no-store'});
    if (!r.ok) return [];
    const txt=await r.text();
    const linhas=txt.split(/\r?\n/).filter(l=>l.trim());
    if (!linhas.length) return [];
    const delim=linhas[0].includes('\t')?'\t':',';
    return linhas.slice(1).map(line=>{
      const cols=parseCsvLine(line,delim);
      const tipo=normalizarTexto(cols[0]);
      const contem=String(cols[1]||'').trim();
      const pontuacao=parsePontuacao(cols[2]);
      const legenda=String(cols[4]||cols[3]||contem).trim();
      return {tipo,contem,contemNorm:normalizarTexto(contem),pontuacao,legenda};
    }).filter(r=>r.tipo&&r.pontuacao!==null);
  } catch(e) { console.warn('Score rules failed:',e.message); return []; }
}
function scorePorTipo(tipo, texto, regras) {
  const textoNorm=normalizarTexto(texto);
  if (!textoNorm) return SCORE_DEFAULTS[tipo]||0;
  const match=regras.find(r=>r.tipo===tipo&&r.contemNorm&&textoNorm.includes(r.contemNorm));
  return match?match.pontuacao:(SCORE_DEFAULTS[tipo]||0);
}
function legendaDoTipo(tipo, texto, regras) {
  const textoNorm=normalizarTexto(texto);
  if (!textoNorm) {
    // Usa legenda da linha com contem vazio se existir
    const emptyMatch=regras.find(r=>r.tipo===tipo&&!r.contemNorm);
    return { legenda: emptyMatch?(emptyMatch.legenda||'Não informado'):'Não informado', raw: null };
  }
  const match=regras.find(r=>r.tipo===tipo&&r.contemNorm&&textoNorm.includes(r.contemNorm));
  if (match) return { legenda: match.legenda||match.contem, raw: null };
  // Não bateu — Outros, guarda valor bruto
  return { legenda: 'Outros', raw: String(texto||'').trim().slice(0,80) };
}

function calcularScore(deal, regras) {
  return +(
    scorePorTipo('renda',       deal[FIELD_RENDA],       regras)+
    scorePorTipo('cargo',       deal[FIELD_CARGO],       regras)+
    scorePorTipo('idade',       deal[FIELD_IDADE],       regras)+
    scorePorTipo('escolaridade',deal[FIELD_ESCOLARIDADE],regras)
  ).toFixed(2);
}
function faixaScore(score) {
  const f=SCORE_FAIXAS.find(x=>score>=x.min&&score<x.max);
  return f?f.label:null;
}
function emptyFaixas() {
  return Object.fromEntries(SCORE_FAIXAS.map(f=>[f.label,0]));
}

// ── Date utils ────────────────────────────────────────────────
const toYM  = d=>d?String(d).substring(0,7):null;
const toYMD = d=>d?String(d).substring(0,10):null;

function weekStart(dateStr) {
  if (!dateStr) return null;
  const d=new Date(String(dateStr).substring(0,10)+'T00:00:00Z');
  const day=d.getUTCDay();
  d.setUTCDate(d.getUTCDate()-((day-4+7)%7));
  return d.toISOString().substring(0,10);
}
function getWeeks(n=8) {
  const now=new Date();
  const day=now.getUTCDay();
  const currThu=new Date(now);
  currThu.setUTCDate(now.getUTCDate()-((day-4+7)%7));
  currThu.setUTCHours(0,0,0,0);
  const base=new Date(currThu);
  base.setUTCDate(currThu.getUTCDate()-7);
  const weeks=[];
  for (let i=n-1;i>=0;i--) {
    const d=new Date(base);
    d.setUTCDate(base.getUTCDate()-i*7);
    weeks.push(d.toISOString().substring(0,10));
  }
  return weeks;
}
function addMonths(ym,n) {
  const[y,m]=ym.split('-').map(Number);
  const d=new Date(y,m-1+n,1);
  return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

// ── Pipedrive ─────────────────────────────────────────────────
const BASE=`https://${ORG}.pipedrive.com/api/v1`;
async function pipeGet(ep) {
  const sep=ep.includes('?')?'&':'?';
  const r=await fetch(`${BASE}${ep}${sep}api_token=${API_TOKEN}`);
  if (!r.ok) throw new Error(`Pipedrive ${r.status} → ${ep}`);
  return r.json();
}
async function fetchByFilter(filterId) {
  const all=[]; let start=0;
  while(true) {
    const j=await pipeGet(`/deals?filter_id=${filterId}&status=all&limit=500&start=${start}`);
    (j.data||[]).forEach(d=>all.push(d));
    if (!j.additional_data?.pagination?.more_items_in_collection) break;
    start+=500;
  }
  return all;
}

// ── Report ────────────────────────────────────────────────────
app.get('/api/report', async (req,res) => {
  if (!API_TOKEN) return res.status(500).json({ok:false,error:'PIPEDRIVE_TOKEN não configurado.'});
  try {
    const [dealsCriados,dealsGanhos,dealsPerdidos,regrasScore,pipelinesRaw,stagesRaw,turmasRaw] = await Promise.all([
      fetchByFilter(FILTER_CRIADOS),
      fetchByFilter(FILTER_GANHOS),
      fetchByFilter(FILTER_PERDIDOS),
      carregarRegrasScore(),
      pipeGet('/pipelines').catch(()=>({data:[]})),
      pipeGet('/stages').catch(()=>({data:[]})),
      carregarTurmas(),
    ]);
    const pipelineMap = Object.fromEntries((pipelinesRaw.data||[]).map(p=>[String(p.id), p.name]));
    // stageMap: id → {name, order_nr, pipeline_id}
    const stageMap = Object.fromEntries((stagesRaw.data||[]).map(s=>[String(s.id),{name:s.name,order:s.order_nr||0,pipeId:String(s.pipeline_id)}]));

    const now=new Date();
    const paramMes=req.query.mes;
    const curYM=paramMes&&/^\d{4}-\d{2}$/.test(paramMes)?paramMes:now.toISOString().substring(0,7);
    const prevYM=addMonths(curYM,-1);
    const prev2YM=addMonths(curYM,-2);
    const weeks=getWeeks(8);
    const wSet=new Set(weeks);
    const year=parseInt(curYM.split('-')[0]);
    const month=parseInt(curYM.split('-')[1]);
    const daysInMonth=new Date(year,month,0).getDate();
    const allDays=Array.from({length:daysInMonth},(_,i)=>`${curYM}-${String(i+1).padStart(2,'0')}`);

    const empty = () => ({
      criados: { mes:{t:0,dia:{},diaA:{},diaG:{},diaP:{},st:{a:0,g:0,p:0},produtosVendidos:{},scoreFaixas:emptyFaixas(),funis:{},etapas:{}}, sem:{} },
      ganhos:  { mes:{t:0,rev:0,dia:{},origens:{},origTemporal:{}}, sem:{} },
      camp:    { mes:{t:0,rev:0,dia:{},deals:[],produtos:{}}, sem:{} },
      perdidos:{ mes:{t:0,dia:{},motivos:{},motivosTimes:{'Time Diarley':{},'Time Denise':{},'Outros':{}},origTemporal:{},scoreFaixas:emptyFaixas(),negociacao:[],
        analitica:{
          'Sem perfil':   {renda:{},cargo:{},idade:{},escolaridade:{},outrosRaw:{renda:{},cargo:{},idade:{},escolaridade:{}}},
          'Sem interesse':{renda:{},cargo:{},idade:{},escolaridade:{},outrosRaw:{renda:{},cargo:{},idade:{},escolaridade:{}}},
        }
      }, sem:{} },
    });
    const D={LEAN:empty(),CES:empty()};

    // Set de IDs de ganhos válidos (após filtros de valor, Matheus Paz, etc.)
    const ganhoValidoIds = new Set();
    for (const deal of dealsGanhos) {
      if (deal.status!=='won'||!deal.won_time) continue;
      const val=parseFloat(deal.value||0)||0;
      if (val<=0||!isFinite(val)) continue;
      const owner=(deal.owner_name||(deal.user_id&&deal.user_id.name)||'').toLowerCase();
      if (owner.includes('matheus paz')) continue;
      ganhoValidoIds.add(deal.id);
    }

    // ── CRIADOS ───────────────────────────────────────────────
    for (const deal of dealsCriados) {
      const camp=classifyCampaign(deal[CAMPAIGN_FIELD]);
      if (!camp||!deal.add_time) continue;
      const _ym=toYM(deal.add_time),_w=weekStart(deal.add_time);
      const dc=D[camp].criados;
      if (_ym===curYM) {
        const _d=toYMD(deal.add_time);
        dc.mes.t++;
        dc.mes.dia[_d]=(dc.mes.dia[_d]||0)+1;
        if (deal.status==='open')  {dc.mes.st.a++;dc.mes.diaA[_d]=(dc.mes.diaA[_d]||0)+1;}
        // Ganho válido: só conta se está no filtro de ganhos e passou todos os filtros
        if (deal.status==='won'&&ganhoValidoIds.has(deal.id)) {dc.mes.st.g++;dc.mes.diaG[_d]=(dc.mes.diaG[_d]||0)+1;}
        if (deal.status==='lost')  {dc.mes.st.p++;dc.mes.diaP[_d]=(dc.mes.diaP[_d]||0)+1;}
        // Score
        const score=calcularScore(deal,regrasScore);
        const faixa=faixaScore(score);
        if (faixa) dc.mes.scoreFaixas[faixa]=(dc.mes.scoreFaixas[faixa]||0)+1;
        // Funil — agrupa por time
        const pipeId=String(deal.pipeline_id||'');
        const timeName=classifyTime(deal.pipeline_id);
        if (!dc.mes.funis[timeName]) dc.mes.funis[timeName]={t:0,scoreFaixas:emptyFaixas()};
        dc.mes.funis[timeName].t++;
        if (faixa) dc.mes.funis[timeName].scoreFaixas[faixa]=(dc.mes.funis[timeName].scoreFaixas[faixa]||0)+1;
        // Etapas (só abertos) — agrupa por time
        if (deal.status==='open') {
          const stageId=String(deal.stage_id||'');
          const stageInfo=stageMap[stageId]||{name:stageId||'Desconhecida',order:999,pipeId:pipeId};
          if (!dc.mes.etapas[timeName]) dc.mes.etapas[timeName]={};
          const stageKey=stageInfo.name;
          if (!dc.mes.etapas[timeName][stageKey]) dc.mes.etapas[timeName][stageKey]={t:0,order:stageInfo.order};
          dc.mes.etapas[timeName][stageKey].t++;
        }
        // Produtos vendidos
        const val=parseFloat(deal.value||0);
        const prods=classifyProduct(deal[PRODUCT_FIELD]);
        if (deal.status==='won'&&val>0&&prods.length) {
          for (const p of prods) {
            const nome=p==='LEAN'?'Lean Governance':'CES';
            if (!dc.mes.produtosVendidos[nome]) dc.mes.produtosVendidos[nome]={t:0,rev:0,deals:[]};
            dc.mes.produtosVendidos[nome].t++;dc.mes.produtosVendidos[nome].rev+=val;
            dc.mes.produtosVendidos[nome].deals.push({
              campanha:String(deal[CAMPAIGN_FIELD]||'—').trim(),
              dataGanho:deal.won_time?deal.won_time.substring(0,10):'—',
              proprietario:deal.owner_name||(deal.user_id&&deal.user_id.name)||'—',
              valor:val, produto:String(deal[PRODUCT_FIELD]||'—'),
            });
          }
        }
      }
      if (wSet.has(_w)) dc.sem[_w]=(dc.sem[_w]||0)+1;
    }

    // ── GANHOS ───────────────────────────────────────────────
    for (const deal of dealsGanhos) {
      if (deal.status!=='won'||!deal.won_time) continue;
      const val=parseFloat(deal.value||0)||0;
      if (val<=0||!isFinite(val)) continue;
      // Ignora deals do Matheus Paz
      const owner=(deal.owner_name||(deal.user_id&&deal.user_id.name)||'').toLowerCase();
      if (owner.includes('matheus paz')) continue;
      const prods=classifyProduct(deal[PRODUCT_FIELD]);
      const camp=classifyCampaign(deal[CAMPAIGN_FIELD]);
      const origem=classifyOrigem(deal[CAMPAIGN_FIELD]);
      const _ym=toYM(deal.won_time),_w=weekStart(deal.won_time),_d=toYMD(deal.won_time);
      const addYM=toYM(deal.add_time);
      let tempCat;
      if (addYM===curYM) tempCat='cur';
      else if (addYM===prevYM) tempCat='prev';
      else if (addYM===prev2YM) tempCat='prev2';
      else tempCat='antes';

      // ── Por Campanha: independente do produto ──────────────
      if (camp) {
        const gc=D[camp].camp;
        if (_ym===curYM) {
          gc.mes.t++;gc.mes.rev+=val;
          if (!gc.mes.dia[_d]) gc.mes.dia[_d]={t:0,r:0};
          gc.mes.dia[_d].t++;gc.mes.dia[_d].r+=val;
          gc.mes.deals.push({
            campanha:String(deal[CAMPAIGN_FIELD]||'—').trim(),
            dataGanho:deal.won_time?deal.won_time.substring(0,10):'—',
            proprietario:deal.owner_name||(deal.user_id&&deal.user_id.name)||'—',
            valor:val, produto:String(deal[PRODUCT_FIELD]||'—'),
          });
          const nomeProd=String(deal[PRODUCT_FIELD]||'Não informado').trim();
          if (!gc.mes.produtos[nomeProd]) gc.mes.produtos[nomeProd]={t:0,rev:0};
          gc.mes.produtos[nomeProd].t++;
          gc.mes.produtos[nomeProd].rev+=val;
        }
        if (wSet.has(_w)) {if (!gc.sem[_w]) gc.sem[_w]={t:0,r:0};gc.sem[_w].t++;gc.sem[_w].r+=val;}
      }

      // ── Por Produto: só classifica produtos LEAN/CES ──────
      if (!prods.length) continue;
      for (const p of prods) {
        const g=D[p].ganhos;
        if (_ym===curYM) {
          g.mes.t++;g.mes.rev+=val;
          if (!g.mes.dia[_d]) g.mes.dia[_d]={t:0,r:0};
          g.mes.dia[_d].t++;g.mes.dia[_d].r+=val;
          if (!g.mes.origens[origem]) g.mes.origens[origem]={t:0,rev:0,deals:[]};
          g.mes.origens[origem].t++;g.mes.origens[origem].rev+=val;
          g.mes.origens[origem].deals.push({
            campanha:String(deal[CAMPAIGN_FIELD]||'—').trim(),
            dataGanho:deal.won_time?deal.won_time.substring(0,10):'—',
            proprietario:deal.owner_name||(deal.user_id&&deal.user_id.name)||'—',
            valor:val, produto:String(deal[PRODUCT_FIELD]||'—'),
          });
          g.mes.origTemporal[tempCat]=(g.mes.origTemporal[tempCat]||0)+1;
        }
        if (wSet.has(_w)) {if (!g.sem[_w]) g.sem[_w]={t:0,r:0};g.sem[_w].t++;g.sem[_w].r+=val;}
      }
    }

    // ── PERDIDOS ─────────────────────────────────────────────
    for (const deal of dealsPerdidos) {
      if (deal.status!=='lost'||!deal.lost_time) continue;
      const camp=classifyCampaign(deal[CAMPAIGN_FIELD]);
      if (!camp) continue;
      const _ym=toYM(deal.lost_time),_w=weekStart(deal.lost_time);
      const dp=D[camp].perdidos;
      const addYM=toYM(deal.add_time);
      let tempCat;
      if (addYM===curYM) tempCat='cur';
      else if (addYM===prevYM) tempCat='prev';
      else if (addYM===prev2YM) tempCat='prev2';
      else tempCat='antes';
      if (_ym===curYM) {
        const _d=toYMD(deal.lost_time);
        const motivo=deal.lost_reason?.trim()||'Não informado';
        const timeNome=classifyTime(deal.pipeline_id);
        dp.mes.t++;
        dp.mes.dia[_d]=(dp.mes.dia[_d]||0)+1;
        dp.mes.motivos[motivo]=(dp.mes.motivos[motivo]||0)+1;
        dp.mes.motivosTimes[timeNome][motivo]=(dp.mes.motivosTimes[timeNome][motivo]||0)+1;
        dp.mes.origTemporal[tempCat]=(dp.mes.origTemporal[tempCat]||0)+1;
        // Perdidos na etapa NEGOCIAÇÃO
        const stageIdP=String(deal.stage_id||'');
        const stageInfoP=stageMap[stageIdP];
        if (stageInfoP&&/negoci/i.test(stageInfoP.name)) {
          dp.mes.negociacao.push({
            id:    deal.id,
            title: deal.title||'—',
            owner: deal.owner_name||(deal.user_id&&deal.user_id.name)||'—',
            motivo,
            dataPerda: _d,
          });
        }
        // Score dos perdidos
        const score=calcularScore(deal,regrasScore);
        const faixa=faixaScore(score);
        if (faixa) dp.mes.scoreFaixas[faixa]=(dp.mes.scoreFaixas[faixa]||0)+1;
        // Analítica: só para Sem perfil e Sem interesse
        const motivosAnalitica=['Sem perfil','Sem interesse'];
        if (motivosAnalitica.includes(motivo)) {
          const an=dp.mes.analitica[motivo];
          const fieldMap={renda:FIELD_RENDA,cargo:FIELD_CARGO,idade:FIELD_IDADE,escolaridade:FIELD_ESCOLARIDADE};
          ['renda','cargo','idade','escolaridade'].forEach(tipo=>{
            const {legenda,raw}=legendaDoTipo(tipo,deal[fieldMap[tipo]],regrasScore);
            an[tipo][legenda]=(an[tipo][legenda]||0)+1;
            // Guarda raw para TODOS os itens (não só Outros)
            const rawKey=String(deal[fieldMap[tipo]]||'').trim().slice(0,80)||'(vazio)';
            const rawNorm=rawKey.toLowerCase();
            if (!an.outrosRaw[tipo][legenda]) an.outrosRaw[tipo][legenda]={};
            an.outrosRaw[tipo][legenda][rawNorm]=(an.outrosRaw[tipo][legenda][rawNorm]||0)+1;
          });
        }
      }
      if (wSet.has(_w)) dp.sem[_w]=(dp.sem[_w]||0)+1;
    }

    // ── Serialização ──────────────────────────────────────────
    const MES_NOMES=['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    const ymLabel=ym=>{const[y,m]=ym.split('-');return MES_NOMES[+m-1]+'/'+y.slice(2);};
    const origTemporalSer=(ot,total)=>[
      {label:`Mês atual (${ymLabel(curYM)})`,v:ot.cur||0, pct:total>0?Math.round((ot.cur||0)/total*100):0},
      {label:ymLabel(prevYM),                v:ot.prev||0,pct:total>0?Math.round((ot.prev||0)/total*100):0},
      {label:ymLabel(prev2YM),               v:ot.prev2||0,pct:total>0?Math.round((ot.prev2||0)/total*100):0},
      {label:`Antes de ${ymLabel(prev2YM)}`, v:ot.antes||0,pct:total>0?Math.round((ot.antes||0)/total*100):0},
    ];
    const serFaixas=(sf,total)=>SCORE_FAIXAS.map(f=>{
      const v=sf[f.label]||0;
      return {label:f.label,v,pct:total>0?+((v/total)*100).toFixed(1):0};
    });

    const ser = p => ({
      criados: {
        total:   p.criados.mes.t,
        mediaDia:allDays.length?+(p.criados.mes.t/allDays.length).toFixed(1):0,
        status:  p.criados.mes.st,
        taxaConv:p.criados.mes.t>0?+((p.criados.mes.st.g/p.criados.mes.t)*100).toFixed(1):0,
        porDia:  allDays.map(d=>({d,v:p.criados.mes.dia[d]||0,a:p.criados.mes.diaA[d]||0,g:p.criados.mes.diaG[d]||0,p:p.criados.mes.diaP[d]||0})),
        porSemana:weeks.map(w=>({w,v:p.criados.sem[w]||0})),
        produtosVendidos:Object.entries(p.criados.mes.produtosVendidos).sort((a,b)=>b[1].rev-a[1].rev).map(([nome,x])=>({nome,t:x.t,rev:x.rev,ticket:x.t?x.rev/x.t:0,deals:x.deals})),
        scoreFaixas:serFaixas(p.criados.mes.scoreFaixas,p.criados.mes.t),
        etapas: Object.fromEntries(
          Object.entries(p.criados.mes.etapas).map(([funil,etapas])=>[funil,
            Object.entries(etapas)
              .sort((a,b)=>a[1].order-b[1].order)
              .map(([nome,x])=>({nome,t:x.t}))
          ])
        ),
        funis: Object.entries(p.criados.mes.funis)
          .sort((a,b)=>b[1].t-a[1].t)
          .map(([nome,f])=>({
            nome,
            t: f.t,
            pct: p.criados.mes.t>0?Math.round(f.t/p.criados.mes.t*100):0,
            scoreFaixas: serFaixas(f.scoreFaixas, f.t),
          })),
      },
      ganhos: {
        porProduto: {
          total:  p.ganhos.mes.t,receita:p.ganhos.mes.rev,
          ticket: p.ganhos.mes.t?p.ganhos.mes.rev/p.ganhos.mes.t:0,
          porDia: allDays.map(d=>({d,v:p.ganhos.mes.dia[d]?.t||0,r:p.ganhos.mes.dia[d]?.r||0})),
          porSemana:weeks.map(w=>({w,v:p.ganhos.sem[w]?.t||0,r:p.ganhos.sem[w]?.r||0})),
          origens:Object.entries(p.ganhos.mes.origens).sort((a,b)=>b[1].rev-a[1].rev).map(([nome,x])=>({nome,t:x.t,rev:x.rev,ticket:x.t?x.rev/x.t:0,deals:x.deals})),
          origemTemporal:origTemporalSer(p.ganhos.mes.origTemporal,p.ganhos.mes.t),
        },
        porCampanha: {
          total:  p.camp.mes.t,receita:p.camp.mes.rev,
          ticket: p.camp.mes.t?p.camp.mes.rev/p.camp.mes.t:0,
          porDia: allDays.map(d=>({d,v:p.camp.mes.dia[d]?.t||0,r:p.camp.mes.dia[d]?.r||0})),
          porSemana:weeks.map(w=>({w,v:p.camp.sem[w]?.t||0,r:p.camp.sem[w]?.r||0})),
          origemTemporal:origTemporalSer(p.ganhos.mes.origTemporal,p.camp.mes.t),
          deals:p.camp.mes.deals,
          produtos:Object.entries(p.camp.mes.produtos)
            .sort((a,b)=>b[1].rev-a[1].rev)
            .map(([nome,x])=>({nome,t:x.t,rev:x.rev,ticket:x.t?x.rev/x.t:0})),
        },
      },
      perdidos: {
        total:    p.perdidos.mes.t,
        mediaDia: allDays.length?+(p.perdidos.mes.t/allDays.length).toFixed(1):0,
        porDia:   allDays.map(d=>({d,v:p.perdidos.mes.dia[d]||0})),
        porSemana:weeks.map(w=>({w,v:p.perdidos.sem[w]||0})),
        topMotivos:Object.entries(p.perdidos.mes.motivos).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([m,c])=>({m,c,pct:p.perdidos.mes.t?Math.round(c/p.perdidos.mes.t*100):0})),
        motivosTimes: Object.fromEntries(
          Object.entries(p.perdidos.mes.motivosTimes).map(([time,motivos])=>{
            const tot=Object.values(motivos).reduce((s,v)=>s+v,0);
            return [time, {
              total: tot,
              top: Object.entries(motivos).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([m,c])=>({m,c,pct:tot?Math.round(c/tot*100):0}))
            }];
          })
        ),
        origemTemporal:origTemporalSer(p.perdidos.mes.origTemporal,p.perdidos.mes.t),
        negociacao: p.perdidos.mes.negociacao.sort((a,b)=>b.dataPerda.localeCompare(a.dataPerda)),
        scoreFaixas:serFaixas(p.perdidos.mes.scoreFaixas,p.perdidos.mes.t),
        analitica: Object.fromEntries(
          Object.entries(p.perdidos.mes.analitica).map(([motivo,tipos])=>{
            const {outrosRaw,...tiposSemRaw}=tipos;
            const serialized=Object.fromEntries(Object.entries(tiposSemRaw).map(([tipo,legs])=>{
              const total=Object.values(legs).reduce((s,v)=>s+v,0);
              const itens=Object.entries(legs).sort((a,b)=>b[1]-a[1]).map(([leg,v])=>{
                // Raw values para esta legenda específica
                const rawMap=outrosRaw[tipo]?.[leg]||{};
                const rawItems=Object.entries(rawMap).sort((a,b)=>b[1]-a[1]).slice(0,30).map(([raw,v])=>({raw,v}));
                return {leg,v,pct:total>0?Math.round(v/total*100):0,rawItems};
              });
              return [tipo, {itens}];
            }));
            return [motivo, serialized];
          })
        ),
      },
    });

    res.json({
      ok:true, mes:curYM, updatedAt:new Date().toISOString(),
      lean:ser(D.LEAN), ces:ser(D.CES),
      turmas:{ lean:turmasRaw.filter(t=>t.produto==='LEAN'), ces:turmasRaw.filter(t=>t.produto==='CES') }
    });
  } catch(e) {
    console.error('[/api/report]',e);
    res.status(500).json({ok:false,error:e.message});
  }
});


// ── DEBUG ganhos criados ─────────────────────────────────────
app.get('/api/debug-ganhos-criados', async (req,res) => {
  if (!API_TOKEN) return res.status(500).json({ok:false});
  try {
    const paramMes = req.query.mes || new Date().toISOString().substring(0,7);
    const [dealsCriados, dealsGanhos] = await Promise.all([
      fetchByFilter(FILTER_CRIADOS),
      fetchByFilter(FILTER_GANHOS),
    ]);

    // Monta set de ganhos válidos
    const ganhoValidoIds = new Set();
    for (const deal of dealsGanhos) {
      if (deal.status!=='won'||!deal.won_time) continue;
      const val=parseFloat(deal.value||0)||0;
      if (val<=0||!isFinite(val)) continue;
      const owner=(deal.owner_name||(deal.user_id&&deal.user_id.name)||'').toLowerCase();
      if (owner.includes('matheus paz')) continue;
      ganhoValidoIds.add(deal.id);
    }

    const CAMP_FIELD = 'ae03fa460a108b8cdfa87e97ebca24379d2779d6';
    const LEAN_IDS = new Set(['22395618474','22402104677','22406191339']);
    const CES_IDS  = new Set(['22734871401','23367012467']);

    const resultado = dealsCriados.filter(d=>{
      if (d.status!=='won') return false;
      if (!ganhoValidoIds.has(d.id)) return false;
      const addYM = d.add_time?.substring(0,7);
      if (addYM !== paramMes) return false;
      // Só campanha CES
      const s = String(d[CAMP_FIELD]||'').trim();
      return CES_IDS.has(s) || (/ces/i.test(s) && !/ascesso/i.test(s));
    }).map(d=>({
      id: d.id,
      titulo: d.title,
      add_time: d.add_time?.substring(0,10),
      won_time: d.won_time?.substring(0,10),
      campanha: String(d[CAMP_FIELD]||'—'),
      owner: d.owner_name||(d.user_id&&d.user_id.name)||'—',
      valor: parseFloat(d.value||0),
      emGanhoValido: ganhoValidoIds.has(d.id),
    }));

    res.json({ok:true, total:resultado.length, mes:paramMes, resultado});
  } catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

// ── DEBUG funis ──────────────────────────────────────────────
app.get('/api/debug-funis', async (req,res) => {
  if (!API_TOKEN) return res.status(500).json({ok:false});
  try {
    const [deals, pipelinesRaw] = await Promise.all([
      fetchByFilter(FILTER_CRIADOS),
      pipeGet('/pipelines').catch(()=>({data:[]})),
    ]);
    const pipelineMap = Object.fromEntries((pipelinesRaw.data||[]).map(p=>[String(p.id),p.name]));
    const counts = {};
    for (const d of deals.slice(0,200)) {
      const id = String(d.pipeline_id||'null');
      const name = pipelineMap[id]||'(sem nome)';
      const key = `${id} → ${name}`;
      counts[key] = (counts[key]||0)+1;
    }
    res.json({ok:true, pipelines: pipelinesRaw.data?.map(p=>({id:p.id,name:p.name})), counts});
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// ── DEBUG temporário ─────────────────────────────────────────
app.get('/api/debug-ganhos', async (req,res) => {
  if (!API_TOKEN) return res.status(500).json({ok:false,error:'sem token'});
  try {
    const deals = await fetchByFilter(FILTER_GANHOS);
    const now   = new Date();
    const curYM = now.toISOString().substring(0,7);

    const resultado = deals
      .filter(d => d.status === 'won')
      .map(d => ({
        id:         d.id,
        titulo:     d.title,
        valor:      parseFloat(d.value||0),
        add_time:   d.add_time?.substring(0,10),
        won_time:   d.won_time?.substring(0,10),
        won_ym:     d.won_time?.substring(0,7),
        produto:    String(d[PRODUCT_FIELD]||'—'),
        campanha:   String(d[CAMPAIGN_FIELD]||'—'),
        camp_class: classifyCampaign(d[CAMPAIGN_FIELD]),
        no_mes:     d.won_time?.substring(0,7) === curYM,
      }))
      .sort((a,b) => (b.won_time||'').localeCompare(a.won_time||''));

    res.json({ ok:true, total: resultado.length, curYM, resultado: resultado.slice(0,50) });
  } catch(e) {
    res.status(500).json({ok:false,error:e.message});
  }
});

if (process.env.NODE_ENV!=='production') app.listen(PORT,()=>console.log(`✓ Porta ${PORT}`));
module.exports = app;
