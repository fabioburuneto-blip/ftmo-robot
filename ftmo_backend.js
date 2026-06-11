require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const cron       = require('node-cron');
const https      = require('https');
const { createClient } = require('@supabase/supabase-js');
const Anthropic  = require('@anthropic-ai/sdk');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─── CLIENTES ────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const TELEGRAM_TOKEN  = process.env.TELEGRAM_TOKEN  || '';
const TELEGRAM_CHAT   = process.env.TELEGRAM_CHAT_ID || '';

// ─── AUTENTICACAO ROBO ───────────────────────────────────────
function autenticarRobot(req, res, next) {
  const key = req.headers['x-robot-key'];
  if (key !== process.env.ROBOT_API_KEY) {
    return res.status(401).json({ erro: 'Nao autorizado' });
  }
  next();
}

// ─── TELEGRAM ────────────────────────────────────────────────
async function enviarTelegram(mensagem) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const body = JSON.stringify({
      chat_id: TELEGRAM_CHAT,
      text: mensagem,
      parse_mode: 'HTML'
    });

    await new Promise((resolve, reject) => {
      const req = https.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, res => {
        res.on('data', () => {});
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  } catch (err) {
    console.error('Erro Telegram:', err.message);
  }
}

// ─── CALENDARIO ECONOMICO (ForexFactory) ─────────────────────
let cacheNoticias = [];
let ultimaAtualizacaoNoticias = 0;

async function buscarNoticiasHoje() {
  const agora = Date.now();
  // Atualiza cache a cada 30 minutos
  if (agora - ultimaAtualizacaoNoticias < 30 * 60 * 1000) {
    return cacheNoticias;
  }

  try {
    const hoje = new Date().toISOString().split('T')[0];
    const url  = `https://nfs.faireconomy.media/ff_calendar_thisweek.json`;

    const data = await new Promise((resolve, reject) => {
      https.get(url, res => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch(e) { resolve([]); }
        });
      }).on('error', () => resolve([]));
    });

    // Filtrar apenas noticias de alto impacto de hoje
    cacheNoticias = data.filter(n => {
      const diaNoticia = n.date ? n.date.split('T')[0] : '';
      return diaNoticia === hoje && n.impact === 'High';
    });

    ultimaAtualizacaoNoticias = agora;
    console.log(`Noticias alto impacto hoje: ${cacheNoticias.length}`);
    return cacheNoticias;

  } catch (err) {
    console.error('Erro ao buscar noticias:', err.message);
    return [];
  }
}

// ─── VERIFICAR SE TEM NOTICIA PROXIMA ────────────────────────
app.get('/noticias/verificar', async (req, res) => {
  try {
    const minutesAntes  = 15;
    const minutesDepois = 15;
    const agora         = new Date();
    const noticias      = await buscarNoticiasHoje();

    for (const noticia of noticias) {
      if (!noticia.date) continue;
      const horaNoticia = new Date(noticia.date);
      const diffMin = (horaNoticia - agora) / 60000;

      // Dentro da janela de bloqueio
      if (diffMin >= -minutesDepois && diffMin <= minutesAntes) {
        console.log(`Noticia proxima: ${noticia.title} em ${diffMin.toFixed(0)} min`);
        return res.json({
          bloqueado: true,
          noticia:   noticia.title,
          minutos:   diffMin.toFixed(0)
        });
      }
    }

    res.json({ bloqueado: false });
  } catch (err) {
    res.json({ bloqueado: false });
  }
});

// ─── POST /trade/aberta ──────────────────────────────────────
app.post('/trade/aberta', autenticarRobot, async (req, res) => {
  try {
    const {
      ticket, ativo, direcao, estrategia,
      preco_entrada, stop_loss, take_profit, lote, spread_entrada,
      hora_entrada, tendencia_m5, volatilidade_atr, sessao,
      ema21_m1, ema50_m5, qualidade_sinal,
      saldo_antes, equity_antes, drawdown_dia_pct
    } = req.body;

    const { data, error } = await supabase
      .from('trades')
      .insert([{
        ticket, ativo, direcao, estrategia,
        preco_entrada, stop_loss, take_profit, lote, spread_entrada,
        hora_entrada, tendencia_m5, volatilidade_atr, sessao,
        ema21_m1, ema50_m5, qualidade_sinal,
        saldo_antes, equity_antes, drawdown_dia_pct
      }])
      .select()
      .single();

    if (error) throw error;

    await supabase.from('logs_robot').insert([{
      nivel: 'INFO', evento: 'TRADE_ABERTA', ativo,
      detalhe: `Ticket ${ticket} | ${direcao} ${lote} @ ${preco_entrada}`,
      dados: { ticket, ativo, direcao, lote, preco_entrada }
    }]);

    // Alerta Telegram
    const emoji = direcao === 'BUY' ? '📈' : '📉';
    await enviarTelegram(
      `${emoji} <b>TRADE ABERTA</b>\n` +
      `Ativo: <b>${ativo}</b> | ${direcao}\n` +
      `Entrada: ${preco_entrada}\n` +
      `TP: ${take_profit} | SL: ${stop_loss}\n` +
      `Lote: ${lote} | Sessao: ${sessao}`
    );

    res.json({ sucesso: true, id: data.id });
  } catch (err) {
    console.error('Erro /trade/aberta:', err);
    res.status(500).json({ erro: err.message });
  }
});

// ─── POST /trade/fechada ─────────────────────────────────────
app.post('/trade/fechada', autenticarRobot, async (req, res) => {
  try {
    const {
      ticket, preco_saida, hora_saida,
      resultado_pips, resultado_usd, comissao_usd, swap_usd,
      win_loss, motivo_saida
    } = req.body;

    const { data: tradeExistente } = await supabase
      .from('trades')
      .select('hora_entrada, ativo')
      .eq('ticket', ticket)
      .single();

    let duracao_min = null;
    if (tradeExistente && tradeExistente.hora_entrada) {
      const diff = new Date(hora_saida) - new Date(tradeExistente.hora_entrada);
      duracao_min = Math.round(diff / 60000 * 100) / 100;
    }

    const resultado_liq = (resultado_usd || 0) - (comissao_usd || 0) - (swap_usd || 0);

    const { error } = await supabase
      .from('trades')
      .update({
        preco_saida, hora_saida, duracao_min,
        resultado_pips, resultado_usd, comissao_usd, swap_usd,
        resultado_liq, win_loss, motivo_saida
      })
      .eq('ticket', ticket);

    if (error) throw error;

    // Buscar lucro do dia para o alerta
    const hoje = new Date().toISOString().split('T')[0];
    const { data: tradesHoje } = await supabase
      .from('trades')
      .select('resultado_liq')
      .gte('hora_entrada', hoje + 'T00:00:00')
      .not('hora_saida', 'is', null);

    const lucroDia = tradesHoje
      ? tradesHoje.reduce((s, t) => s + (t.resultado_liq || 0), 0)
      : 0;

    await supabase.from('logs_robot').insert([{
      nivel: 'INFO', evento: 'TRADE_FECHADA',
      ativo: tradeExistente ? tradeExistente.ativo : null,
      detalhe: `Ticket ${ticket} | ${win_loss} | ${resultado_pips} pips | $${resultado_liq.toFixed(2)}`,
      dados: { ticket, win_loss, resultado_pips, resultado_liq, motivo_saida }
    }]);

    // Alerta Telegram
    const emoji = win_loss === 'WIN' ? '✅' : win_loss === 'LOSS' ? '❌' : '⚖️';
    const ativo = tradeExistente ? tradeExistente.ativo : 'N/A';
    await enviarTelegram(
      `${emoji} <b>TRADE FECHADA — ${win_loss}</b>\n` +
      `Ativo: <b>${ativo}</b> | Motivo: ${motivo_saida}\n` +
      `Resultado: <b>$${resultado_liq.toFixed(2)}</b>\n` +
      `Lucro do dia: <b>$${lucroDia.toFixed(2)}</b>`
    );

    res.json({ sucesso: true });
  } catch (err) {
    console.error('Erro /trade/fechada:', err);
    res.status(500).json({ erro: err.message });
  }
});

// ─── POST /log ───────────────────────────────────────────────
app.post('/log', autenticarRobot, async (req, res) => {
  try {
    const { nivel, evento, detalhe, ativo, dados } = req.body;
    await supabase.from('logs_robot').insert([{ nivel, evento, detalhe, ativo, dados }]);

    // Alertas especiais no Telegram
    if (evento === 'STOP_DRAWDOWN') {
      await enviarTelegram(`🛑 <b>STOP DIÁRIO ATINGIDO</b>\n${detalhe}\nRobô pausado até amanhã.`);
    }
    if (evento === 'META_ATINGIDA') {
      await enviarTelegram(`🎯 <b>META DIÁRIA ATINGIDA!</b>\n${detalhe}\nRobô pausado até amanhã.`);
    }
    if (evento === 'TRAILING_ATIVADO') {
      await enviarTelegram(`🚀 <b>TRAILING ATIVADO</b>\n${ativo} — TP atingido, seguindo tendência!`);
    }

    res.json({ sucesso: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ─── GET /parametros/:ativo ──────────────────────────────────
app.get('/parametros/:ativo', autenticarRobot, async (req, res) => {
  try {
    const { ativo } = req.params;
    const { data, error } = await supabase
      .from('parametros_robot')
      .select('*')
      .eq('ativo', ativo)
      .order('atualizado_em', { ascending: false })
      .limit(1)
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ─── GET /dashboard/resumo ───────────────────────────────────
app.get('/dashboard/resumo', async (req, res) => {
  try {
    const hoje = new Date().toISOString().split('T')[0];

    const { data: tradesHoje } = await supabase
      .from('trades').select('*')
      .gte('hora_entrada', hoje + 'T00:00:00')
      .not('hora_saida', 'is', null);

    const { data: perfAtivo    } = await supabase.from('vw_performance_ativo').select('*');
    const { data: ultimoResumo } = await supabase.from('resumo_diario').select('*')
      .order('data', { ascending: false }).limit(7);

    const wins     = tradesHoje ? tradesHoje.filter(t => t.win_loss === 'WIN').length  : 0;
    const losses   = tradesHoje ? tradesHoje.filter(t => t.win_loss === 'LOSS').length : 0;
    const totalUsd = tradesHoje ? tradesHoje.reduce((s, t) => s + (t.resultado_liq || 0), 0) : 0;
    const totalPips= tradesHoje ? tradesHoje.reduce((s, t) => s + (t.resultado_pips || 0), 0) : 0;

    res.json({
      hoje: {
        data: hoje,
        total_trades: tradesHoje ? tradesHoje.length : 0,
        wins, losses,
        assertividade: tradesHoje && tradesHoje.length ? Math.round(wins / tradesHoje.length * 100) : 0,
        total_usd:  Math.round(totalUsd  * 100) / 100,
        total_pips: Math.round(totalPips * 100) / 100,
        trades: tradesHoje
      },
      performance_ativo: perfAtivo    || [],
      historico_diario:  ultimoResumo || []
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ─── ANALISE IA ──────────────────────────────────────────────
async function gerarAnaliseIA() {
  if (!anthropic) { console.log('IA inativa.'); return; }

  try {
    console.log('Iniciando analise IA...');
    const hoje = new Date().toISOString().split('T')[0];

    const { data: trades } = await supabase
      .from('trades').select('*')
      .gte('hora_entrada', hoje + 'T00:00:00')
      .not('hora_saida', 'is', null);

    if (!trades || trades.length === 0) {
      console.log('Sem trades para analisar.');
      return;
    }

    const wins          = trades.filter(t => t.win_loss === 'WIN').length;
    const losses        = trades.filter(t => t.win_loss === 'LOSS').length;
    const totalUsd      = trades.reduce((s, t) => s + (t.resultado_liq || 0), 0);
    const assertividade = Math.round(wins / trades.length * 100);

    const tradesPorAtivo = {};
    const tradesPorHora  = {};
    for (const t of trades) {
      if (!tradesPorAtivo[t.ativo]) tradesPorAtivo[t.ativo] = [];
      tradesPorAtivo[t.ativo].push(t);
      const hora = new Date(t.hora_entrada).getUTCHours();
      if (!tradesPorHora[hora]) tradesPorHora[hora] = [];
      tradesPorHora[hora].push(t);
    }

    const prompt = `Voce e um analista especialista em trading algoritmico e prop trading FTMO.

Analise o desempenho do robo scalper de hoje (${hoje}):

RESUMO: ${trades.length} trades | ${wins}W/${losses}L | ${assertividade}% assertividade | $${totalUsd.toFixed(2)}

POR ATIVO:
${Object.entries(tradesPorAtivo).map(([a, ts]) => {
  const w = ts.filter(t => t.win_loss === 'WIN').length;
  const usd = ts.reduce((s,t) => s+(t.resultado_liq||0), 0);
  return `${a}: ${ts.length}t ${w}W/${ts.length-w}L $${usd.toFixed(2)}`;
}).join(' | ')}

POR HORARIO GMT:
${Object.entries(tradesPorHora).sort((a,b)=>a[0]-b[0]).map(([h,ts]) => {
  const w = ts.filter(t => t.win_loss === 'WIN').length;
  return `${h}h: ${ts.length}t ${Math.round(w/ts.length*100)}%`;
}).join(' | ')}

TRADES:
${trades.slice(0,20).map(t =>
  `[${t.ativo}]${t.direcao} ${t.win_loss} $${(t.resultado_liq||0).toFixed(2)} ${t.sessao} ${t.motivo_saida}`
).join('\n')}

Responda APENAS JSON sem markdown:
{"resumo":"2-3 paragrafos","pontos_positivos":["p1","p2"],"pontos_atencao":["p1","p2"],"melhor_horario":"ex 9h-11h EURUSD","pior_horario":"ex 15h XAU","sugestoes":[{"ativo":"EURUSD","parametro":"horario_fim","valor_atual":17,"valor_sugerido":15,"motivo":"razao"}],"score_dia":7}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });

    const texto = response.content[0].text;
    let analise = {};
    try {
      const m = texto.match(/\{[\s\S]*\}/);
      if (m) analise = JSON.parse(m[0]);
    } catch(e) {
      analise = { resumo: texto, sugestoes: [], score_dia: 5 };
    }

    // Salvar no Supabase
    const { data: existe } = await supabase.from('resumo_diario')
      .select('id').eq('data', hoje).single();

    const resumoData = {
      data: hoje, total_trades: trades.length,
      total_wins: wins, total_losses: losses,
      assertividade, resultado_usd: Math.round(totalUsd*100)/100,
      resultado_liq: Math.round(totalUsd*100)/100,
      analise_ia: analise.resumo || texto,
      sugestoes_ia: analise, gerado_em: new Date().toISOString()
    };

    if (existe) {
      await supabase.from('resumo_diario').update(resumoData).eq('id', existe.id);
    } else {
      await supabase.from('resumo_diario').insert([resumoData]);
    }

    // Aplicar sugestoes se score >= 7
    if (analise.score_dia >= 7 && analise.sugestoes?.length > 0) {
      for (const sug of analise.sugestoes) {
        if (sug.ativo && sug.parametro && sug.valor_sugerido) {
          await supabase.from('parametros_robot')
            .update({ [sug.parametro]: sug.valor_sugerido, motivo: sug.motivo, alterado_por: 'IA', atualizado_em: new Date().toISOString() })
            .eq('ativo', sug.ativo);
        }
      }
    }

    // Enviar resumo no Telegram
    const scoreEmoji = analise.score_dia >= 7 ? '🟢' : analise.score_dia >= 5 ? '🟡' : '🔴';
    await enviarTelegram(
      `📊 <b>ANÁLISE DO DIA — ${hoje}</b>\n\n` +
      `${scoreEmoji} Score: <b>${analise.score_dia}/10</b>\n` +
      `Trades: ${trades.length} | ${wins}W/${losses}L | ${assertividade}%\n` +
      `Resultado: <b>$${totalUsd.toFixed(2)}</b>\n\n` +
      `✅ ${(analise.pontos_positivos || []).join('\n✅ ')}\n\n` +
      `⚠️ ${(analise.pontos_atencao || []).join('\n⚠️ ')}\n\n` +
      `🕐 Melhor horário: ${analise.melhor_horario || 'N/A'}`
    );

    console.log('Analise IA concluida. Score: ' + analise.score_dia + '/10');
  } catch (err) {
    console.error('Erro analise IA:', err);
  }
}

// CRON: 18h Brasilia = 21h UTC
cron.schedule('0 21 * * *', gerarAnaliseIA, { timezone: 'UTC' });

// POST /analise/rodar
app.post('/analise/rodar', async (req, res) => {
  res.json({ mensagem: 'Analise iniciada!' });
  gerarAnaliseIA();
});

// GET / health check
app.get('/', (req, res) => {
  res.json({
    status:   'online',
    projeto:  'FTMO Robot Backend',
    versao:   '3.0.0',
    ia:       anthropic ? 'ativa' : 'inativa',
    telegram: TELEGRAM_TOKEN ? 'ativo' : 'inativo',
    hora:     new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log('FTMO Backend v3 | Porta ' + PORT);
  console.log('IA: ' + (anthropic ? 'ATIVA' : 'INATIVA'));
  console.log('Telegram: ' + (TELEGRAM_TOKEN ? 'ATIVO' : 'INATIVO'));
});
