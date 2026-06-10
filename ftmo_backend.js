require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const cron       = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const Anthropic  = require('@anthropic-ai/sdk');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

function autenticarRobot(req, res, next) {
  const key = req.headers['x-robot-key'];
  if (key !== process.env.ROBOT_API_KEY) {
    return res.status(401).json({ erro: 'Nao autorizado' });
  }
  next();
}

// POST /trade/aberta
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
      nivel: 'INFO',
      evento: 'TRADE_ABERTA',
      ativo,
      detalhe: 'Ticket ' + ticket + ' | ' + direcao + ' ' + lote + ' @ ' + preco_entrada,
      dados: { ticket, ativo, direcao, lote, preco_entrada }
    }]);

    res.json({ sucesso: true, id: data.id });
  } catch (err) {
    console.error('Erro /trade/aberta:', err);
    res.status(500).json({ erro: err.message });
  }
});

// POST /trade/fechada
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

    await supabase.from('logs_robot').insert([{
      nivel: 'INFO',
      evento: 'TRADE_FECHADA',
      ativo: tradeExistente ? tradeExistente.ativo : null,
      detalhe: 'Ticket ' + ticket + ' | ' + win_loss + ' | ' + resultado_pips + ' pips | $' + resultado_liq.toFixed(2),
      dados: { ticket, win_loss, resultado_pips, resultado_liq, motivo_saida }
    }]);

    res.json({ sucesso: true });
  } catch (err) {
    console.error('Erro /trade/fechada:', err);
    res.status(500).json({ erro: err.message });
  }
});

// POST /log
app.post('/log', autenticarRobot, async (req, res) => {
  try {
    const { nivel, evento, detalhe, ativo, dados } = req.body;
    await supabase.from('logs_robot').insert([{ nivel, evento, detalhe, ativo, dados }]);
    res.json({ sucesso: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// GET /parametros/:ativo
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

// GET /dashboard/resumo
app.get('/dashboard/resumo', async (req, res) => {
  try {
    const hoje = new Date().toISOString().split('T')[0];

    const { data: tradesHoje } = await supabase
      .from('trades')
      .select('*')
      .gte('hora_entrada', hoje + 'T00:00:00')
      .not('hora_saida', 'is', null);

    const { data: perfAtivo } = await supabase
      .from('vw_performance_ativo')
      .select('*');

    const { data: ultimoResumo } = await supabase
      .from('resumo_diario')
      .select('*')
      .order('data', { ascending: false })
      .limit(7);

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

// ═══════════════════════════════════════════════════
// ANÁLISE IA — Claude analisa as trades do dia
// ═══════════════════════════════════════════════════
async function gerarAnaliseIA() {
  if (!anthropic) {
    console.log('IA desativada — ANTHROPIC_API_KEY nao configurada.');
    return;
  }

  try {
    console.log('Iniciando analise IA...');
    const hoje = new Date().toISOString().split('T')[0];

    const { data: trades } = await supabase
      .from('trades')
      .select('*')
      .gte('hora_entrada', hoje + 'T00:00:00')
      .not('hora_saida', 'is', null);

    if (!trades || trades.length === 0) {
      console.log('Sem trades hoje para analisar.');
      return;
    }

    const { data: params } = await supabase
      .from('parametros_robot')
      .select('*');

    const wins         = trades.filter(t => t.win_loss === 'WIN').length;
    const losses       = trades.filter(t => t.win_loss === 'LOSS').length;
    const totalUsd     = trades.reduce((s, t) => s + (t.resultado_liq || 0), 0);
    const assertividade = Math.round(wins / trades.length * 100);

    const tradesPorAtivo = {};
    for (const t of trades) {
      if (!tradesPorAtivo[t.ativo]) tradesPorAtivo[t.ativo] = [];
      tradesPorAtivo[t.ativo].push(t);
    }

    const tradesPorHora = {};
    for (const t of trades) {
      const hora = new Date(t.hora_entrada).getUTCHours();
      if (!tradesPorHora[hora]) tradesPorHora[hora] = [];
      tradesPorHora[hora].push(t);
    }

    const prompt = `Voce e um analista especialista em trading algoritmico e prop trading (FTMO).

Analise o desempenho do robo scalper de hoje (${hoje}) e forneca insights precisos:

## Resumo Geral
- Total trades: ${trades.length}
- Wins: ${wins} | Losses: ${losses}
- Assertividade: ${assertividade}%
- Resultado liquido: $${totalUsd.toFixed(2)}

## Por Ativo
${Object.entries(tradesPorAtivo).map(([ativo, ts]) => {
  const w = ts.filter(t => t.win_loss === 'WIN').length;
  const usd = ts.reduce((s, t) => s + (t.resultado_liq || 0), 0);
  const spreadMedio = ts.reduce((s, t) => s + (t.spread_entrada || 0), 0) / ts.length;
  return `- ${ativo}: ${ts.length} trades | ${w}W/${ts.length-w}L | $${usd.toFixed(2)} | Spread medio: ${spreadMedio.toFixed(2)}`;
}).join('\n')}

## Por Horario GMT
${Object.entries(tradesPorHora).sort((a,b) => a[0]-b[0]).map(([hora, ts]) => {
  const w = ts.filter(t => t.win_loss === 'WIN').length;
  return `- ${hora}h: ${ts.length} trades | ${w}W/${ts.length-w}L | ${Math.round(w/ts.length*100)}%`;
}).join('\n')}

## Detalhes das Trades
${trades.slice(0, 30).map(t =>
  `[${t.ativo}] ${t.direcao} | ${t.win_loss} | ${t.resultado_pips || 0} pips | $${(t.resultado_liq||0).toFixed(2)} | Sessao:${t.sessao} | Saida:${t.motivo_saida} | Spread:${t.spread_entrada}`
).join('\n')}

## Parametros Atuais
${params ? params.map(p => `- ${p.ativo}: TP=${p.tp_pips}pts | SL=${p.sl_pips}pts | SpreadMax=${p.spread_max}`).join('\n') : 'nao disponivel'}

Responda APENAS em JSON valido sem markdown, com esta estrutura:
{
  "resumo": "analise geral em 2-3 paragrafos objetivos",
  "pontos_positivos": ["ponto 1", "ponto 2"],
  "pontos_atencao": ["ponto 1", "ponto 2"],
  "melhor_horario": "ex: 9h-11h GMT no EURUSD",
  "pior_horario": "ex: 15h-17h no XAUUSD",
  "sugestoes": [
    {
      "ativo": "EURUSD",
      "parametro": "horario_fim",
      "valor_atual": 17,
      "valor_sugerido": 15,
      "motivo": "explicacao curta"
    }
  ],
  "score_dia": 7
}`;

    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages:   [{ role: 'user', content: prompt }]
    });

    const texto = response.content[0].text;
    let analise = {};
    try {
      const jsonMatch = texto.match(/\{[\s\S]*\}/);
      if (jsonMatch) analise = JSON.parse(jsonMatch[0]);
    } catch (e) {
      analise = { resumo: texto, sugestoes: [], score_dia: 5 };
    }

    // Salvar resumo diário
    const { data: resumoExistente } = await supabase
      .from('resumo_diario')
      .select('id')
      .eq('data', hoje)
      .single();

    const resumoData = {
      data:          hoje,
      total_trades:  trades.length,
      total_wins:    wins,
      total_losses:  losses,
      assertividade: assertividade,
      resultado_usd: Math.round(totalUsd * 100) / 100,
      resultado_liq: Math.round(totalUsd * 100) / 100,
      analise_ia:    analise.resumo || texto,
      sugestoes_ia:  analise,
      gerado_em:     new Date().toISOString()
    };

    if (resumoExistente) {
      await supabase.from('resumo_diario').update(resumoData).eq('id', resumoExistente.id);
    } else {
      await supabase.from('resumo_diario').insert([resumoData]);
    }

    // Aplicar sugestões se score >= 7
    if (analise.score_dia >= 7 && analise.sugestoes && analise.sugestoes.length > 0) {
      for (const sug of analise.sugestoes) {
        if (sug.ativo && sug.parametro && sug.valor_sugerido) {
          await supabase
            .from('parametros_robot')
            .update({
              [sug.parametro]: sug.valor_sugerido,
              motivo:          sug.motivo,
              alterado_por:    'IA',
              atualizado_em:   new Date().toISOString()
            })
            .eq('ativo', sug.ativo);
        }
      }
      console.log('Parametros ajustados pela IA: ' + analise.sugestoes.length);
    }

    console.log('Analise IA concluida. Score: ' + analise.score_dia + '/10');

  } catch (err) {
    console.error('Erro na analise IA:', err);
  }
}

// CRON: todo dia às 18h Brasília (21h UTC)
cron.schedule('0 21 * * *', gerarAnaliseIA, { timezone: 'UTC' });

// POST /analise/rodar — forcar analise manual
app.post('/analise/rodar', async (req, res) => {
  res.json({ mensagem: 'Analise iniciada!' });
  gerarAnaliseIA();
});

// GET / health check
app.get('/', (req, res) => {
  res.json({
    status:  'online',
    projeto: 'FTMO Robot Backend',
    versao:  '2.0.0',
    ia:      anthropic ? 'ativa' : 'inativa',
    hora:    new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log('FTMO Backend v2 rodando na porta ' + PORT);
  console.log('IA: ' + (anthropic ? 'ATIVA' : 'INATIVA'));
});
