"""Painel CES & LEAN (ces-lean.vercel.app) — backend em Python ligado à CRN.

Rotas (iguais às do backend Node antigo): /api/report?mes=AAAA-MM, /api/debug-ganhos-criados,
/api/debug-funis, /api/debug-ganhos. Nova: /crn-versao (regra 11 do CLAUDE.md da CRN).

Regras usadas (todas da biblioteca crn, nada reimplementado aqui):
- Lead LEAN/CES pela campanha: LN-L / CS-L. Lead PFCC (origem dos ganhos): PF-L.
- Venda LEAN/CES pelo produto: LN-V / CS-V, produto pela G2.
- Ganho válido: M1 (separar_ganhos) = sem ganho automático (G1), sem cortesia (R4), só BRL (R3).
- Universo de leads: LD1 (filtro de leads), eixo = data da última aplicação (P10, escolhido pelo Rodrigo).
- Tipo de lead (reaplicado): LD2. Perdidos: M8 (eixo perda). Motivo: P1. Negociação: EN1.
- Score exibido: SC4. Score de conferência e legendas da analítica: SC3. Workshop/Sala: WS1.
- Datas: crn.base.fuso (Brasília).
Escolhas do painel (não são regra): faixas de score 2–10, semana de segunda a domingo, média por dia
corrido, origem temporal em mês atual / -1 / -2 / antes, analítica só de “Sem perfil” e “Sem interesse”.
"""
import io
import os

# ── CRN: baixada do GitHub quando o painel liga ───────────────
# A Vercel não repassa o token para o instalador do build, então a CRN não entra pelo
# requirements.txt. O painel baixa a versão atual da main (com o token, que em tempo de
# execução funciona) e carrega. Cada vez que o painel liga, pega as regras mais recentes.
# No computador, se a crn já estiver instalada (instalar.bat), usa a instalada.
def _carregar_crn():
    import importlib.util
    import shutil
    import sys
    import tarfile
    import tempfile
    if importlib.util.find_spec("crn") is not None:
        return None
    import requests
    token = (os.environ.get("CRN_GITHUB_TOKEN") or os.environ.get("GITHUB_TOKEN") or "").strip()
    if not token:
        raise RuntimeError("CRN_GITHUB_TOKEN não está nas Environment Variables da Vercel.")
    r = requests.get("https://api.github.com/repos/negocios87-sketch/CRN/tarball/main",
                     headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"},
                     timeout=30)
    if r.status_code != 200:
        raise RuntimeError(f"Não consegui baixar a CRN do GitHub (HTTP {r.status_code}). Confira o CRN_GITHUB_TOKEN.")
    base = tempfile.mkdtemp(prefix="crn_")
    with tarfile.open(fileobj=io.BytesIO(r.content), mode="r:gz") as tar:
        tar.extractall(base, filter="data")
    raiz = os.path.join(base, os.listdir(base)[0])          # negocios87-sketch-CRN-<commit>
    destino = os.path.join(base, "pacote", "crn")
    shutil.copytree(os.path.join(raiz, "lib"), destino)     # mesmo mapa do pyproject da CRN
    shutil.copytree(os.path.join(raiz, "config"), os.path.join(destino, "config"))
    sys.path.insert(0, os.path.join(base, "pacote"))
    return os.path.basename(raiz).rsplit("-", 1)[-1][:7]   # commit que entrou

# Se a CRN não carregar, o painel não cai: toda rota responde o motivo em JSON (aparece na tela).
_ERRO_CRN = None
try:
    _COMMIT_CRN = _carregar_crn()
    import crn
    if _COMMIT_CRN:
        crn.versao = lambda: _COMMIT_CRN                    # carimbo mostra o commit carregado
except Exception as _e:
    import re
    # Nunca mostrar token na tela: tira qualquer coisa com cara de token do GitHub.
    _ERRO_CRN = re.sub(r"(github_pat_|ghp_|gho_|ghs_)[A-Za-z0-9_]+", "[token oculto]",
                       f"{type(_e).__name__}: {_e}")
    if "header" in _ERRO_CRN.lower():
        _ERRO_CRN = ("CRN_GITHUB_TOKEN com formato inválido (espaço, quebra de linha ou token colado mais de "
                     "uma vez). Deixe só um token, numa linha, e faça Redeploy.")

from flask import Flask, jsonify, request

app = Flask(__name__)


@app.before_request
def _crn_indisponivel():
    if _ERRO_CRN:
        return jsonify({"ok": False, "error": f"CRN não carregou: {_ERRO_CRN}"}), 500


# ── Imports do painel ─────────────────────────────────────────
import csv
import calendar
import re
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone

import requests

if not _ERRO_CRN:
    from crn.base import pipedrive
    from crn.base.config import campo, filtro
    from crn.base.fuso import TZ_BR, agora_brasil, data_brasil, hoje_brasil
    from crn.base.texto import cf, numero
    from crn.regras import (cs_l_lead_ces, cs_v_venda_ces, en1_etapa_negociacao, g1_ganho_automatico, g2_produto,
                            ld1_universo_leads, ld2_tipo_lead, ln_l_lead_lean, ln_v_venda_lean, m1_ganho_closer,
                            m8_deal_perdido, p1_motivo_perda, pf_l_lead_pfcc, r3_moeda, r4_cortesia,
                            sc3_score_dados, sc4_score_painel, ws1_workshop)

# Token: mesmo nome de sempre (PIPEDRIVE_TOKEN). A crn lê sozinha.
API_TOKEN = (os.environ.get("PIPEDRIVE_TOKEN") or "").strip()

# Planilha de Turmas: não é regra da CRN; mantida como estava (decisão do Rodrigo).
TURMAS_URL = os.environ.get("URL_TURMAS") or (
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vSvwO3Ag2f2cbkVgR1pJZp6fANQcbualGKlAG50fmOljuEGKZ1gJBbSAjRdO3SomXUEVQOWnTvlfHRd/pub?gid=715115296&single=true&output=csv")

# ── Escolhas do painel (vão no carimbo) ───────────────────────
SCORE_FAIXAS = [
    {"label": "De 2 a 2,9", "min": 2, "max": 3},
    {"label": "De 3 a 3,9", "min": 3, "max": 4},
    {"label": "De 4 a 4,9", "min": 4, "max": 5},
    {"label": "De 5 a 5,9", "min": 5, "max": 6},
    {"label": "De 6 a 6,9", "min": 6, "max": 7},
    {"label": "De 7 a 7,9", "min": 7, "max": 8},
    {"label": "De 8 a 8,9", "min": 8, "max": 9},
    {"label": "De 9 a 10", "min": 9, "max": 10.000001},
]
GRUPO_FUNIS = "Todos os funis"          # times por funil foram unificados (decisão do Rodrigo)
N_SEMANAS = 8
MOTIVOS_ANALITICA = ["Sem perfil", "Sem interesse"]
# chave do front → nome do campo na CRN (SC3)
CAMPOS_ANALITICA = {"renda": "renda", "cargo": "cargo", "idade": "idade", "escolaridade": "formacao"}
MES_NOMES = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"]


def carimbo() -> str:
    return (f"CRN {crn.versao()} · Leads: data da última aplicação · Ganhos: data de ganho · "
            f"Perdidos: data de perda · Valor: bruto · Score: Pontuação do Pipedrive (SC4), faixas de 2 a 10 · "
            f"Semana: segunda a domingo · Média por dia corrido · "
            f"SLA Ganhos: score (SC4) dos ganhos do ano, por produto vendido")


# ── Utilidades de data (sempre sobre datas já em Brasília) ────
def ym(d: date | None) -> str | None:
    return f"{d.year}-{d.month:02d}" if d else None


def add_months(ym_str: str, n: int) -> str:
    y, m = map(int, ym_str.split("-"))
    t = y * 12 + (m - 1) + n
    return f"{t // 12}-{t % 12 + 1:02d}"


def ym_label(ym_str: str) -> str:
    y, m = ym_str.split("-")
    return f"{MES_NOMES[int(m) - 1]}/{y[2:]}"


def inicio_semana(d: date | None) -> str | None:
    """Semana de segunda a domingo (P4)."""
    return (d - timedelta(days=d.weekday())).isoformat() if d else None


def semanas(n: int = N_SEMANAS) -> list[str]:
    """As n semanas fechadas antes da semana atual (mesmo comportamento do painel antigo)."""
    seg_atual = hoje_brasil() - timedelta(days=hoje_brasil().weekday())
    base = seg_atual - timedelta(days=7)
    return [(base - timedelta(days=7 * i)).isoformat() for i in range(n - 1, -1, -1)]


def janelas(mes_ini: date, mes_fim: date, weeks: list[str]) -> list[tuple[date, date]]:
    """Períodos a buscar: o mês e as semanas. Se não se encostam, duas buscas em vez de uma enorme."""
    s_ini = date.fromisoformat(weeks[0])
    s_fim = date.fromisoformat(weeks[-1]) + timedelta(days=6)
    if s_ini <= mes_fim + timedelta(days=1) and mes_ini <= s_fim + timedelta(days=1):
        return [(min(mes_ini, s_ini), max(mes_fim, s_fim))]
    return [(mes_ini, mes_fim), (s_ini, s_fim)]


def buscar(fn, periodos) -> list[dict]:
    vistos, out = set(), []
    for ini, fim in periodos:
        for d in fn(ini, fim):
            if d.get("id") not in vistos:
                vistos.add(d.get("id"))
                out.append(d)
    return out


# ── Leitura de campos ─────────────────────────────────────────
def utm(deal: dict) -> str:
    return str(cf(deal, campo("utm_campaign")) or "").strip()


def nome_dono(deal: dict, usuarios: dict) -> str:
    return m1_ganho_closer.nome_dono(deal, usuarios) or "—"


def produtos_venda(deal: dict, opcoes_np: dict) -> list[str]:
    """Venda LEAN / CES pelo produto (LN-V, CS-V). Combo conta nas duas."""
    p = g2_produto.produto(deal, opcoes_np)
    out = []
    if ln_v_venda_lean.eh_venda_lean(p):
        out.append("LEAN")
    if cs_v_venda_ces.eh_venda_ces(p):
        out.append("CES")
    return out


def leads_de(deal: dict) -> list[str]:
    """Lead LEAN / CES pela campanha (LN-L, CS-L). Pode ser os dois."""
    out = []
    if ln_l_lead_lean.eh_lead_lean(deal):
        out.append("LEAN")
    if cs_l_lead_ces.eh_lead_ces(deal):
        out.append("CES")
    return out


def origem(deal: dict) -> str:
    """Agrupamento do painel para a origem do ganho, usando as regras de lead."""
    if pf_l_lead_pfcc.eh_lead_pfcc(deal):
        return "PFCC"
    if ln_l_lead_lean.eh_lead_lean(deal):
        return "LEAN"
    if cs_l_lead_ces.eh_lead_ces(deal):
        return "CES"
    return "Outras Origens"


def ganho_valido(deal: dict, usuarios: dict) -> bool:
    """Mesmo critério de M1 para um deal ganho, sem recorte de data (G1, R4, R3)."""
    return (deal.get("status") == "won" and not g1_ganho_automatico.eh_automatico(deal, usuarios)
            and not r4_cortesia.eh_cortesia(deal) and r3_moeda.em_brl(deal))


def data_aplicacao(deal: dict) -> date | None:
    return ld1_universo_leads.data_do_lead(deal, "aplicacao")


def faixa_score(score) -> str | None:
    if score is None:
        return None
    for f in SCORE_FAIXAS:
        if f["min"] <= score < f["max"]:
            return f["label"]
    return None


def empty_faixas() -> dict:
    return {f["label"]: 0 for f in SCORE_FAIXAS}


def texto_campo(deal: dict, nome: str) -> str | None:
    v = cf(deal, campo(nome))
    t = str(v).strip() if v is not None else ""
    return t or None


# ── Turmas (planilha fora da CRN) ─────────────────────────────
def _norm_header(h: str) -> str:
    h = unicodedata.normalize("NFD", h.lower().strip()).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z]", "", h)


def carregar_turmas() -> list[dict]:
    try:
        r = requests.get(TURMAS_URL, timeout=20)
        if not r.ok:
            return []
        r.encoding = "utf-8"
        linhas = [l for l in r.text.splitlines() if l.strip()]
        if len(linhas) < 2:
            return []
        delim = "\t" if "\t" in linhas[0] else ","
        rows = list(csv.reader(io.StringIO("\n".join(linhas)), delimiter=delim))
        headers = [_norm_header(h) for h in rows[0]]
        num = lambda v: int(re.sub(r"[^\d]", "", str(v or "")) or 0)
        out = []
        for cols in rows[1:]:
            o = {h: (cols[i].strip() if i < len(cols) else "") for i, h in enumerate(headers)}
            t = {
                "produto": (o.get("produto") or "").upper().strip(),
                "dataInicio": o.get("datadeinicio") or o.get("datainicio") or o.get("data") or "",
                "turma": o.get("turma") or "",
                "volumeReal": num(o.get("volumereal") or o.get("volume") or "0"),
                "minimo": num(o.get("minimo") or o.get("mnimo") or "0"),
                "ideal": num(o.get("ideal") or "0"),
            }
            if t["produto"] and t["turma"]:
                out.append(t)
        return out
    except Exception as e:
        print("Turmas falhou:", e)
        return []


# ── Busca ─────────────────────────────────────────────────────
def leads_desde(ini: date) -> list[dict]:
    """Universo LD1 (filtro de leads), só os deals atualizados desde ini.
    Quem aplicou a partir de ini foi atualizado a partir de ini: o universo do período não muda,
    e a busca não traz o ano inteiro (que estourava a memória da função)."""
    desde = datetime.combine(ini, datetime.min.time(), tzinfo=TZ_BR).astimezone(timezone.utc)
    return pipedrive.deals(filter_id=filtro("leads"), updated_since=desde.strftime("%Y-%m-%dT%H:%M:%SZ"))


def carregar(cur_ym: str):
    y, m = map(int, cur_ym.split("-"))
    mes_ini = date(y, m, 1)
    mes_fim = date(y, m, calendar.monthrange(y, m)[1])
    weeks = semanas()
    per = janelas(mes_ini, mes_fim, weeks)
    with ThreadPoolExecutor(max_workers=8) as ex:
        f_leads = ex.submit(leads_desde, min(i for i, _ in per))           # LD1 (filtro de leads)
        f_ganhos = ex.submit(buscar, pipedrive.ganhos_do_periodo, per)
        f_perd = ex.submit(buscar, pipedrive.perdidos_do_periodo, per)
        f_usu = ex.submit(pipedrive.usuarios)
        f_etp = ex.submit(pipedrive.etapas)
        f_fun = ex.submit(pipedrive.funis)
        f_np = ex.submit(pipedrive.opcoes_campo, campo("nome_produto"))
        f_tur = ex.submit(carregar_turmas)
        return {
            "leads": f_leads.result(), "ganhos": f_ganhos.result(), "perdidos": f_perd.result(),
            "usuarios": f_usu.result(), "etapas": f_etp.result(), "funis": f_fun.result(),
            "opcoes_np": f_np.result(), "turmas": f_tur.result(),
            "mes_ini": mes_ini, "mes_fim": mes_fim, "weeks": weeks, "periodos": per,
        }


def mes_pedido() -> str:
    p = request.args.get("mes") or ""
    return p if re.fullmatch(r"\d{4}-\d{2}", p) else ym(hoje_brasil())


def deal_resumo(deal: dict, usuarios: dict, opcoes_np: dict) -> dict:
    won = data_brasil(deal.get("won_time"))
    return {
        "campanha": utm(deal) or "—",
        "dataGanho": won.isoformat() if won else "—",
        "proprietario": nome_dono(deal, usuarios),
        "valor": numero(deal.get("value")),
        "produto": g2_produto.produto(deal, opcoes_np) or "—",
    }


# ── Report ────────────────────────────────────────────────────
def empty():
    return {
        "criados": {"mes": {"t": 0, "dia": {}, "diaA": {}, "diaG": {}, "diaP": {}, "st": {"a": 0, "g": 0, "p": 0},
                            "produtosVendidos": {}, "scoreFaixas": empty_faixas(), "scoreBase": 0, "funis": {},
                            "etapas": {}, "workshopCount": 0, "reaplicados": 0, "leads": []}, "sem": {}},
        "ganhos": {"mes": {"t": 0, "rev": 0.0, "dia": {}, "origens": {}, "origTemporal": {}}, "sem": {}},
        "camp": {"mes": {"t": 0, "rev": 0.0, "dia": {}, "deals": [], "produtos": {}, "origTemporal": {}}, "sem": {}},
        "perdidos": {"mes": {"t": 0, "dia": {}, "motivos": {}, "motivosTimes": {GRUPO_FUNIS: {}},
                             "motivosPorCategoria": {"cur": {}, "prev": {}, "prev2": {}, "antes": {}, "sem": {}},
                             "origTemporal": {}, "scoreFaixas": empty_faixas(), "scoreBase": 0, "negociacao": [],
                             "analitica": {mot: {**{k: {} for k in CAMPOS_ANALITICA},
                                                 "outrosRaw": {k: {} for k in CAMPOS_ANALITICA}}
                                           for mot in MOTIVOS_ANALITICA}},
                     "sem": {}},
    }


def gerar_report(cur_ym: str) -> dict:
    B = carregar(cur_ym)
    usuarios, opcoes_np, nomes_etapa = B["usuarios"], B["opcoes_np"], B["etapas"]
    mes_ini, mes_fim, weeks = B["mes_ini"], B["mes_fim"], B["weeks"]
    w_set = set(weeks)
    prev_ym, prev2_ym = add_months(cur_ym, -1), add_months(cur_ym, -2)
    all_days = [(mes_ini + timedelta(days=i)).isoformat() for i in range((mes_fim - mes_ini).days + 1)]

    def categoria(deal):
        """Origem temporal: mês da última aplicação do lead (mesmo eixo dos leads)."""
        a = ym(data_aplicacao(deal))
        if a is None:
            return "sem"
        return {cur_ym: "cur", prev_ym: "prev", prev2_ym: "prev2"}.get(a, "antes")

    D = {"LEAN": empty(), "CES": empty()}

    # ── LEADS (LD1, eixo data da última aplicação) ────────────
    for deal in B["leads"]:
        alvos = leads_de(deal)
        if not alvos:
            continue
        dia_ap = data_aplicacao(deal)
        if dia_ap is None:
            continue
        no_mes = ym(dia_ap) == cur_ym
        w = inicio_semana(dia_ap)
        if not no_mes and w not in w_set:
            continue
        status = deal.get("status")
        g_ok = ganho_valido(deal, usuarios)
        workshop = ws1_workshop.utm_eh_workshop(utm(deal))
        sc = sc4_score_painel.score(deal)
        fx = faixa_score(sc)
        reaplicado = ld2_tipo_lead.tipo_lead(deal) == "REAPLICADO"
        for camp in alvos:
            dc = D[camp]["criados"]
            if w in w_set:
                dc["sem"][w] = dc["sem"].get(w, 0) + 1
            if not no_mes:
                continue
            mc, d = dc["mes"], dia_ap.isoformat()
            mc["t"] += 1
            mc["dia"][d] = mc["dia"].get(d, 0) + 1
            if workshop:
                mc["workshopCount"] += 1
            if reaplicado:
                mc["reaplicados"] += 1
            if status == "open":
                mc["st"]["a"] += 1
                mc["diaA"][d] = mc["diaA"].get(d, 0) + 1
            if status == "won" and g_ok:
                mc["st"]["g"] += 1
                mc["diaG"][d] = mc["diaG"].get(d, 0) + 1
            if status == "lost":
                mc["st"]["p"] += 1
                mc["diaP"][d] = mc["diaP"].get(d, 0) + 1
            # Score (SC4): “sem score” não entra nas faixas nem na base
            fun = mc["funis"].setdefault(GRUPO_FUNIS, {"t": 0, "scoreFaixas": empty_faixas(), "scoreBase": 0})
            fun["t"] += 1
            if sc is not None:
                mc["scoreBase"] += 1
                fun["scoreBase"] += 1
                if fx:
                    mc["scoreFaixas"][fx] += 1
                    fun["scoreFaixas"][fx] += 1
            # Etapas dos abertos
            if status == "open":
                sid = deal.get("stage_id")
                nome = nomes_etapa.get(sid) or str(sid or "Desconhecida")
                et = mc["etapas"].setdefault(GRUPO_FUNIS, {}).setdefault(nome, {"t": 0, "order": sid or 999999})
                et["t"] += 1
                et["order"] = min(et["order"], sid or 999999)
            # Aba Leads
            mc["leads"].append({
                "id": deal.get("id"),
                "title": deal.get("title") or "Sem título",
                "status": status,
                "renda": sc4_score_painel.resposta(deal, "renda"),
                "cargo": sc4_score_painel.resposta(deal, "cargo"),
                "idade": sc4_score_painel.resposta(deal, "idade"),
                "escolaridade": sc4_score_painel.resposta(deal, "formacao"),
                "score_dash": sc3_score_dados.score(deal),      # SC3: conferência
                "score_pd": sc,                                  # SC4: score exibido
            })
            # Produtos vendidos dos leads (produto bruto, G2)
            if g_ok:
                nome_p = g2_produto.produto(deal, opcoes_np) or "Não informado"
                pv = mc["produtosVendidos"].setdefault(nome_p, {"t": 0, "rev": 0.0, "deals": []})
                pv["t"] += 1
                pv["rev"] += numero(deal.get("value"))
                pv["deals"].append(deal_resumo(deal, usuarios, opcoes_np))

    # ── GANHOS (M1 + LN-V/CS-V e LN-L/CS-L) ───────────────────
    validos = []
    for ini, fim in B["periodos"]:
        validos += m1_ganho_closer.separar_ganhos(B["ganhos"], usuarios=usuarios, ini=ini, fim=fim)["validos"]
    vistos = set()
    for deal in validos:
        if deal["id"] in vistos:
            continue
        vistos.add(deal["id"])
        dia = data_brasil(deal.get("won_time"))
        no_mes, w, d = ym(dia) == cur_ym, inicio_semana(dia), dia.isoformat()
        val = numero(deal.get("value"))
        cat = categoria(deal)
        resumo = deal_resumo(deal, usuarios, opcoes_np)

        for camp in leads_de(deal):                     # por campanha
            gc = D[camp]["camp"]
            if no_mes:
                mc = gc["mes"]
                mc["t"] += 1
                mc["rev"] += val
                x = mc["dia"].setdefault(d, {"t": 0, "r": 0.0})
                x["t"] += 1
                x["r"] += val
                mc["deals"].append(resumo)
                nome_p = g2_produto.produto(deal, opcoes_np) or "Não informado"
                p = mc["produtos"].setdefault(nome_p, {"t": 0, "rev": 0.0})
                p["t"] += 1
                p["rev"] += val
                mc["origTemporal"][cat] = mc["origTemporal"].get(cat, 0) + 1
            if w in w_set:
                x = gc["sem"].setdefault(w, {"t": 0, "r": 0.0})
                x["t"] += 1
                x["r"] += val

        orig = origem(deal)
        for prod in produtos_venda(deal, opcoes_np):    # por produto
            g = D[prod]["ganhos"]
            if no_mes:
                mg = g["mes"]
                mg["t"] += 1
                mg["rev"] += val
                x = mg["dia"].setdefault(d, {"t": 0, "r": 0.0})
                x["t"] += 1
                x["r"] += val
                o = mg["origens"].setdefault(orig, {"t": 0, "rev": 0.0, "deals": []})
                o["t"] += 1
                o["rev"] += val
                o["deals"].append(resumo)
                mg["origTemporal"][cat] = mg["origTemporal"].get(cat, 0) + 1
            if w in w_set:
                x = g["sem"].setdefault(w, {"t": 0, "r": 0.0})
                x["t"] += 1
                x["r"] += val

    # ── PERDIDOS (M8, eixo perda) ─────────────────────────────
    perdidos = []
    for ini, fim in B["periodos"]:
        perdidos += m8_deal_perdido.perdidos(B["perdidos"], ini, fim, eixo="perda")
    vistos = set()
    for deal in perdidos:
        if deal["id"] in vistos:
            continue
        vistos.add(deal["id"])
        alvos = leads_de(deal)
        if not alvos:
            continue
        dia = data_brasil(deal.get("lost_time"))
        no_mes, w, d = ym(dia) == cur_ym, inicio_semana(dia), dia.isoformat()
        motivo = p1_motivo_perda.motivo(deal)
        cat = categoria(deal)
        sc = sc4_score_painel.score(deal)
        fx = faixa_score(sc)
        negoc = en1_etapa_negociacao.eh_negociacao(deal)
        for camp in alvos:
            dp = D[camp]["perdidos"]
            if w in w_set:
                dp["sem"][w] = dp["sem"].get(w, 0) + 1
            if not no_mes:
                continue
            mp = dp["mes"]
            mp["t"] += 1
            mp["dia"][d] = mp["dia"].get(d, 0) + 1
            mp["motivos"][motivo] = mp["motivos"].get(motivo, 0) + 1
            mt = mp["motivosTimes"][GRUPO_FUNIS]
            mt[motivo] = mt.get(motivo, 0) + 1
            mc = mp["motivosPorCategoria"][cat]
            mc[motivo] = mc.get(motivo, 0) + 1
            mp["origTemporal"][cat] = mp["origTemporal"].get(cat, 0) + 1
            if negoc:
                mp["negociacao"].append({"id": deal.get("id"), "title": deal.get("title") or "—",
                                         "owner": nome_dono(deal, usuarios), "motivo": motivo, "dataPerda": d})
            if sc is not None:
                mp["scoreBase"] += 1
                if fx:
                    mp["scoreFaixas"][fx] += 1
            if motivo in MOTIVOS_ANALITICA:
                an = mp["analitica"][motivo]
                for chave, nome in CAMPOS_ANALITICA.items():
                    bruto = cf(deal, campo(nome))
                    leg = sc3_score_dados.classificar(nome, bruto)["faixa"] or "Não informado"
                    an[chave][leg] = an[chave].get(leg, 0) + 1
                    raw = (str(bruto).strip()[:80] if bruto not in (None, "") else "") or "(vazio)"
                    rr = an["outrosRaw"][chave].setdefault(leg, {})
                    rr[raw.lower()] = rr.get(raw.lower(), 0) + 1

    # ── Serialização (mesmo formato do backend antigo) ────────
    cat_labels = {
        "cur": f"Mês atual ({ym_label(cur_ym)})",
        "prev": ym_label(prev_ym),
        "prev2": ym_label(prev2_ym),
        "antes": f"Antes de {ym_label(prev2_ym)}",
        "sem": "Sem data de aplicação",
    }

    def pct(v, total, casas=0):
        if not total:
            return 0
        return round(v / total * 100) if casas == 0 else round(v / total * 100, casas)

    def orig_temporal(ot, total):
        out = [{"label": cat_labels[c], "v": ot.get(c, 0), "pct": pct(ot.get(c, 0), total)}
               for c in ("cur", "prev", "prev2", "antes")]
        if ot.get("sem"):
            out.append({"label": cat_labels["sem"], "v": ot["sem"], "pct": pct(ot["sem"], total)})
        return out

    def ser_faixas(sf, total):
        return [{"label": f["label"], "v": sf.get(f["label"], 0), "pct": pct(sf.get(f["label"], 0), total, 1)}
                for f in SCORE_FAIXAS]

    def top(motivos, total, n=10):
        return [{"m": m, "c": c, "pct": pct(c, total)}
                for m, c in sorted(motivos.items(), key=lambda x: -x[1])[:n]]

    def ser(p):
        c, g, gc, pd = p["criados"]["mes"], p["ganhos"]["mes"], p["camp"]["mes"], p["perdidos"]["mes"]
        n_dias = len(all_days)
        analitica = {}
        for mot, tipos in pd["analitica"].items():
            raw = tipos["outrosRaw"]
            analitica[mot] = {}
            for tipo in CAMPOS_ANALITICA:
                legs = tipos[tipo]
                total = sum(legs.values())
                itens = []
                for leg, v in sorted(legs.items(), key=lambda x: -x[1]):
                    rmap = raw.get(tipo, {}).get(leg, {})
                    itens.append({"leg": leg, "v": v, "pct": pct(v, total), "rawItems": [
                        {"raw": r, "v": rv} for r, rv in sorted(rmap.items(), key=lambda x: -x[1])[:30]]})
                analitica[mot][tipo] = {"itens": itens}
        motivos_cat = {}
        for cat, mot in pd["motivosPorCategoria"].items():
            if cat == "sem" and not mot:
                continue
            motivos_cat[cat_labels[cat]] = top(mot, sum(mot.values()))
        return {
            "criados": {
                "total": c["t"],
                "mediaDia": round(c["t"] / n_dias, 1) if n_dias else 0,
                "status": c["st"],
                "taxaConv": pct(c["st"]["g"], c["t"], 1),
                "reaplicados": {"n": c["reaplicados"], "pct": pct(c["reaplicados"], c["t"], 1)},
                "porDia": [{"d": d, "v": c["dia"].get(d, 0), "a": c["diaA"].get(d, 0), "g": c["diaG"].get(d, 0),
                            "p": c["diaP"].get(d, 0)} for d in all_days],
                "porSemana": [{"w": w, "v": p["criados"]["sem"].get(w, 0)} for w in weeks],
                "produtosVendidos": [{"nome": n, "t": x["t"], "rev": x["rev"], "ticket": x["rev"] / x["t"] if x["t"] else 0,
                                      "deals": x["deals"]}
                                     for n, x in sorted(c["produtosVendidos"].items(), key=lambda i: -i[1]["rev"])],
                "workshopCount": c["workshopCount"],
                "leads": c["leads"],
                "scoreBase": c["scoreBase"],
                "scoreFaixas": ser_faixas(c["scoreFaixas"], c["scoreBase"]),
                "etapas": {f: [{"nome": n, "t": x["t"]} for n, x in sorted(et.items(), key=lambda i: i[1]["order"])]
                           for f, et in c["etapas"].items()},
                "funis": [{"nome": n, "t": f["t"], "pct": pct(f["t"], c["t"]),
                           "scoreFaixas": ser_faixas(f["scoreFaixas"], f["scoreBase"])}
                          for n, f in sorted(c["funis"].items(), key=lambda i: -i[1]["t"])],
            },
            "ganhos": {
                "porProduto": {
                    "total": g["t"], "receita": g["rev"], "ticket": g["rev"] / g["t"] if g["t"] else 0,
                    "porDia": [{"d": d, "v": g["dia"].get(d, {}).get("t", 0), "r": g["dia"].get(d, {}).get("r", 0)}
                               for d in all_days],
                    "porSemana": [{"w": w, "v": p["ganhos"]["sem"].get(w, {}).get("t", 0),
                                   "r": p["ganhos"]["sem"].get(w, {}).get("r", 0)} for w in weeks],
                    "origens": [{"nome": n, "t": x["t"], "rev": x["rev"], "ticket": x["rev"] / x["t"] if x["t"] else 0,
                                 "deals": x["deals"]}
                                for n, x in sorted(g["origens"].items(), key=lambda i: -i[1]["rev"])],
                    "origemTemporal": orig_temporal(g["origTemporal"], g["t"]),
                },
                "porCampanha": {
                    "total": gc["t"], "receita": gc["rev"], "ticket": gc["rev"] / gc["t"] if gc["t"] else 0,
                    "porDia": [{"d": d, "v": gc["dia"].get(d, {}).get("t", 0), "r": gc["dia"].get(d, {}).get("r", 0)}
                               for d in all_days],
                    "porSemana": [{"w": w, "v": p["camp"]["sem"].get(w, {}).get("t", 0),
                                   "r": p["camp"]["sem"].get(w, {}).get("r", 0)} for w in weeks],
                    "origemTemporal": orig_temporal(gc["origTemporal"], gc["t"]),
                    "deals": gc["deals"],
                    "produtos": [{"nome": n, "t": x["t"], "rev": x["rev"], "ticket": x["rev"] / x["t"] if x["t"] else 0}
                                 for n, x in sorted(gc["produtos"].items(), key=lambda i: -i[1]["rev"])],
                },
            },
            "perdidos": {
                "total": pd["t"],
                "mediaDia": round(pd["t"] / n_dias, 1) if n_dias else 0,
                "porDia": [{"d": d, "v": pd["dia"].get(d, 0)} for d in all_days],
                "porSemana": [{"w": w, "v": p["perdidos"]["sem"].get(w, 0)} for w in weeks],
                "topMotivos": top(pd["motivos"], pd["t"]),
                "motivosPorCategoria": motivos_cat,
                "motivosTimes": {t: {"total": sum(m.values()), "top": top(m, sum(m.values()))}
                                 for t, m in pd["motivosTimes"].items()},
                "origemTemporal": orig_temporal(pd["origTemporal"], pd["t"]),
                "negociacao": sorted(pd["negociacao"], key=lambda x: x["dataPerda"], reverse=True),
                "scoreBase": pd["scoreBase"],
                "scoreFaixas": ser_faixas(pd["scoreFaixas"], pd["scoreBase"]),
                "analitica": analitica,
            },
        }

    turmas = B["turmas"]
    return {
        "ok": True, "mes": cur_ym, "updatedAt": agora_brasil().isoformat(),
        "crn": crn.versao(), "carimbo": carimbo(),
        "lean": ser(D["LEAN"]), "ces": ser(D["CES"]),
        "turmas": {"lean": [t for t in turmas if t["produto"] == "LEAN"],
                   "ces": [t for t in turmas if t["produto"] == "CES"]},
    }


# ── SLA Ganhos (linha de referência dos gráficos de score) ────
# Distribuição por faixa do score (SC4) de todos os ganhos válidos (M1) do ano corrente, por produto vendido
# (LN-V / CS-V; combo conta nos dois). Ganho sem score (Workshop/Sala ou cadastro incompleto, SC4) fica fora da base.
# Busca grande (o ano todo): vai numa rota própria, com cache em memória, para não pesar no /api/report.
_SLA_CACHE = {"quando": None, "ano": None, "dados": None}
_SLA_TTL = timedelta(hours=6)


def calcular_sla() -> dict:
    hoje = hoje_brasil()
    ini = date(hoje.year, 1, 1)
    usuarios = pipedrive.usuarios()
    opcoes_np = pipedrive.opcoes_campo(campo("nome_produto"))
    validos = m1_ganho_closer.separar_ganhos(pipedrive.ganhos_do_periodo(ini, hoje), usuarios=usuarios,
                                             ini=ini, fim=hoje)["validos"]
    cont = {"LEAN": empty_faixas(), "CES": empty_faixas()}
    base = {"LEAN": 0, "CES": 0}
    ganhos = {"LEAN": 0, "CES": 0}
    for d in validos:
        prods = produtos_venda(d, opcoes_np)
        if not prods:
            continue
        sc = sc4_score_painel.score(d)
        fx = faixa_score(sc)
        for p in prods:
            ganhos[p] += 1
            if sc is None:
                continue
            base[p] += 1
            if fx:
                cont[p][fx] += 1
    pct = lambda p: [round(cont[p][f["label"]] / base[p] * 100, 1) if base[p] else 0 for f in SCORE_FAIXAS]
    return {"lean": pct("LEAN"), "ces": pct("CES"),
            "base": {"lean": base["LEAN"], "ces": base["CES"]},
            "ganhos": {"lean": ganhos["LEAN"], "ces": ganhos["CES"]},
            "periodo": f"{ini.isoformat()} a {hoje.isoformat()}"}


# ── Rotas ─────────────────────────────────────────────────────
@app.get("/api/sla")
def sla():
    if not API_TOKEN:
        return jsonify({"ok": False, "error": "PIPEDRIVE_TOKEN não configurado."}), 500
    try:
        agora = agora_brasil()
        c = _SLA_CACHE
        if not (c["dados"] and c["ano"] == agora.year and c["quando"] and agora - c["quando"] < _SLA_TTL):
            c.update(dados=calcular_sla(), ano=agora.year, quando=agora)
        return jsonify({"ok": True, **c["dados"]})
    except Exception as e:
        print("[/api/sla]", repr(e))
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/crn-versao")
def crn_versao():
    return jsonify({"versao": crn.versao()})


@app.get("/api/report")
def report():
    if not API_TOKEN:
        return jsonify({"ok": False, "error": "PIPEDRIVE_TOKEN não configurado."}), 500
    try:
        return jsonify(gerar_report(mes_pedido()))
    except Exception as e:
        print("[/api/report]", repr(e))
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/api/debug-ganhos-criados")
def debug_ganhos_criados():
    """Leads CES (CS-L) com última aplicação no mês e ganho válido."""
    if not API_TOKEN:
        return jsonify({"ok": False}), 500
    try:
        mes = mes_pedido()
        usuarios = pipedrive.usuarios()
        resultado = []
        y, m = map(int, mes.split("-"))
        for d in leads_desde(date(y, m, 1)):
            if not cs_l_lead_ces.eh_lead_ces(d) or ym(data_aplicacao(d)) != mes or not ganho_valido(d, usuarios):
                continue
            ad, wd = data_brasil(d.get("add_time")), data_brasil(d.get("won_time"))
            resultado.append({
                "id": d.get("id"), "titulo": d.get("title"),
                "add_time": ad.isoformat() if ad else None,
                "aplicacao": data_aplicacao(d).isoformat(),
                "won_time": wd.isoformat() if wd else None,
                "campanha": utm(d) or "—", "owner": nome_dono(d, usuarios),
                "valor": numero(d.get("value")), "emGanhoValido": True,
            })
        return jsonify({"ok": True, "total": len(resultado), "mes": mes, "resultado": resultado})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/api/debug-funis")
def debug_funis():
    if not API_TOKEN:
        return jsonify({"ok": False}), 500
    try:
        funis = pipedrive.funis()
        counts = {}
        hoje = hoje_brasil()
        for d in leads_desde(date(hoje.year, hoje.month, 1))[:200]:
            pid = d.get("pipeline_id")
            k = f"{pid} → {funis.get(pid, '(sem nome)')}"
            counts[k] = counts.get(k, 0) + 1
        return jsonify({"ok": True, "pipelines": [{"id": i, "name": n} for i, n in funis.items()], "counts": counts})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/api/debug-ganhos")
def debug_ganhos():
    """Ganhos válidos (M1) do mês corrente, LEAN/CES por produto ou campanha, 50 mais recentes."""
    if not API_TOKEN:
        return jsonify({"ok": False, "error": "sem token"}), 500
    try:
        hoje = hoje_brasil()
        cur = ym(hoje)
        usuarios = pipedrive.usuarios()
        opcoes_np = pipedrive.opcoes_campo(campo("nome_produto"))
        ini = date(hoje.year, hoje.month, 1)
        validos = m1_ganho_closer.separar_ganhos(pipedrive.ganhos_do_periodo(ini, hoje), usuarios=usuarios,
                                                 ini=ini, fim=hoje)["validos"]
        resultado = []
        for d in validos:
            prods, camps = produtos_venda(d, opcoes_np), leads_de(d)
            if not prods and not camps:
                continue
            ad, wd = data_brasil(d.get("add_time")), data_brasil(d.get("won_time"))
            resultado.append({
                "id": d.get("id"), "titulo": d.get("title"), "valor": numero(d.get("value")),
                "add_time": ad.isoformat() if ad else None, "won_time": wd.isoformat() if wd else None,
                "won_ym": ym(wd), "produto": g2_produto.produto(d, opcoes_np) or "—",
                "campanha": utm(d) or "—", "camp_class": "+".join(camps) or None, "venda_class": "+".join(prods) or None,
                "no_mes": ym(wd) == cur,
            })
        resultado.sort(key=lambda x: x["won_time"] or "", reverse=True)
        return jsonify({"ok": True, "total": len(resultado), "curYM": cur, "resultado": resultado[:50]})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


if __name__ == "__main__":
    app.run(port=int(os.environ.get("PORT", 3000)), debug=True)
