// ============================================================
// FTMO ROBOT — Backend Node.js (Railway)
// ============================================================
// Instalar dependências:
// npm install express @supabase/supabase-js @anthropic-ai/sdk dotenv cors node-cron axios
// ============================================================

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

// ─────────────────────────────────────────────────────────────
// CLIENTES
// ─────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// ─────────────────────────────────────────────────────────────
// MIDDLEWARE: validar API Key do robô MT5
// ─────────────────────────────────────────────────────────────
function autenticarRobot(req, res, next) {
  const key = req.headers['x-robot-key'];
  if (key !== process.env.ROBOT_API_KEY) {
    return res.status(401).json({ erro: 'Não autorizado' });
  }
  next();
}

// ═════════════════════════════════════════════════════════════
// ROTAS DO ROBÔ MT5
// ═════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// POST /trade/aberta — Robô avisa que abriu uma trade
// ─────────────────────────────────────────────────────────────
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

    // Log
    await supabase.from('logs_robot').insert([{
      nivel: 'INFO',
      evento: 'TRADE_ABERTA',
      ativo,
      detalhe: `Ticket ${ticket} | ${direcao} ${lote} lotes @ ${preco_entrada}`,
      dados: { ticket, ativo, direcao, lote, preco_entrada }
    }]);

    res.json({ sucesso: true, id: data.id });

  } catch (err) {
    console.error('Erro em /trade/aberta:', err);
    res.status(500).json({ erro: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /trade/fechada — Robô avisa que fechou uma trade
// ─────────────────────────────────────────────────────────────
app.post('/trade/fechada', autenticarRobot, async (req, res) => {
  try {
    const {
      ticket, preco_saida, hora_saida,
      resultado_pips, resultado_usd, comissao_usd, swap_usd,
      win_loss, motivo_saida
    } = req.body;

    const hora_entrada_row = await supabase
      .from('trades')
      .select('hora_entrada, ativo')
      .eq('ticket', ticket)
      .single();

    let duracao_min = null;
    if (hora_entrada_row.data?.hora_entrada) {
      const diff = new Date(hora_saida) - new Date(hora_entrada_row.data.hora_entrada);
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

    const emoji = win_loss === 'WIN' ? '✅' : win_loss === 'LOSS' ? '❌' : '⚖️';

    await supabase.from('logs_robot').insert([{
      nivel: 'INFO',
      evento: 'TRADE_FECHADA',
      ativo: hora_entrada_row.data?.ativo,
      detalhe: `${emoji} Ticket ${ticket} | ${win_loss} | ${resultado_pips} pips | $${resultado_liq?.toFixed(2)}`,
      dados: { ticket, win_loss, resultado_pips, resultado_liq, motivo_saida }
    }]);

    res.json({ sucesso: true });

  } catch (err) {
    console.error('Erro em /trade/fechada:', err);
    res.status(500).json({ erro: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /log — Robô envia log genérico
// ─────────────────────────────────────────────────────────────
app.post('/log', autenticarRobot, async (req, res) => {
  try {
    const { nivel, evento, detalhe, ativo, dados } = req.body;
    await supabase.from('logs_robot').insert([{ nivel, evento, detalhe, ativo, dados }]);
    res.json({ sucesso: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /parametros/:ativo — Robô busca parâmetros atuais
// ─────────────────────────────────────────────────────────────
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

// ═════════════════════════════════════════════════════════════
// ROTAS DO DASHBOARD
// ═════════════════════════════════════════════════════════════

// GET /dashboard/resumo — Resumo geral para o dashboard
app.get('/dashboard/resumo', async (req, res) => {
  try {
    const hoje = new Date().toISOString().split('T')[0];

    // Trades de hoje
    const { data: tradesHoje } = await supabase
      .from('trades')
      .select('*')
      .gte('hora_entrada', hoje + 'T00:00:00')
      .not('hora_saida', 'is', null);

    // Performance por ativo
    const { data: perfAtivo } = await supabase
      .from('vw_performance_ativo')
      .select('*');

    // Performance por horário
    const { data: perfHorario } = await supabase
      .from('vw_performance_horario')
      .select('*');

    // Último resumo diário com análise IA
    const { data: ultimoResumo } = await supabase
      .from('resumo_diario')
      .select('*')
      .order('data', { ascending: false })
      .limit(7);

    // Cálculo rápido do dia
    const wins   = tradesHoje?.filter(t => t.win_loss === 'WIN').length  || 0;
    const losses = tradesHoje?.filter(t => t.win_loss === 'LOSS').length || 0;
    const totalUsd = tradesHoje?.reduce((s, t) => s + (t.resultado_liq || 0), 0) || 0;
    const totalPips = tradesHoje?.reduce((s, t) => s + (t.resultado_pips || 0), 0) || 0;

    res.json({
      hoje: {
        data: hoje,
        total_trades: tradesHoje?.length || 0,
        wins, losses,
        assertividade: tradesHoje?.length ? Math.round(wins / tradesHoje.length * 100) : 0,
        total_usd: Math.round(totalUsd * 100) / 100,
        total_pips: Math.round(totalPips * 100) / 100,
        trades: tradesHoje
      },
      performance_ativo:   perfAtivo   || [],
      performance_horario: perfHorario || [],
      historico_diario:    ultimoResumo || []
    });

  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ═════════════════════════════════════════════════════════════
// ANÁLISE POR IA — Gerada automaticamente todo dia às 18h
// ═════════════════════════════════════════════════════════════
async function gerarAnaliseIA() {
  try {
    console.log('🤖 Iniciando análise IA...');

    const hoje = new Date().toISOString().split('T')[0];

    // Buscar trades do dia
    const { data: trades } = await supabase
      .from('trades')
      .select('*')
      .gte('hora_entrada', hoje + 'T00:00:00')
      .not('hora_saida', 'is', null);

    if (!trades || trades.length === 0) {
      console.log('Sem trades hoje para analisar.');
      return;
    }

    // Buscar parâmetros atuais
    const { data: params } = await supabase
      .from('parametros_robot')
      .select('*');

    // Estatísticas para a IA
    const wins   = trades.filter(t => t.win_loss === 'WIN').length;
    const losses = trades.filter(t => t.win_loss === 'LOSS').length;
    const totalUsd = trades.reduce((s, t) => s + (t.resultado_liq || 0), 0);
    const assertividade = Math.round(wins / trades.length * 100);

    const tradesPorAtivo = {};
    for (const t of trades) {
      if (!tradesPorAtivo[t.ativo]) tradesPorAtivo[t.ativo] = [];
      tradesPorAtivo[t.ativo].push(t);
    }

    const prompt = `Você é um analista especialista em trading algorítmico e prop trading.

Analise o desempenho do robô FTMO de hoje (${hoje}) e forneça insights e sugestões:

## Resumo do Dia
- Total de trades: ${trades.length}
- Wins: ${wins} | Losses: ${losses}
- Assertividade: ${assertividade}%
- Resultado líquido: $${totalUsd.toFixed(2)}

## Detalhes por Ativo
${Object.entries(tradesPorAtivo).map(([ativo, ts]) => {
  const w = ts.filter(t => t.win_loss === 'WIN').length;
  const usd = ts.reduce((s, t) => s + (t.resultado_liq || 0), 0);
  return `- ${ativo}: ${ts.length} trades | ${w}/${ts.length} wins | $${usd.toFixed(2)}`;
}).join('\n')}

## Parâmetros Atuais do Robô
${params?.map(p => `- ${p.ativo}: TP=${p.tp_pips}pips | SL=${p.sl_pips}pips | Spread máx=${p.spread_max}`).join('\n')}

## Trades Detalhadas
${trades.slice(0, 20).map(t =>
  `[${t.ativo}] ${t.direcao} | ${t.win_loss} | ${t.resultado_pips} pips | Sessão: ${t.sessao} | Saída: ${t.motivo_saida} | Spread: ${t.spread_entrada}`
).join('\n')}

Responda em JSON com esta estrutura exata:
{
  "resumo": "análise geral em 2-3 parágrafos",
  "pontos_positivos": ["ponto 1", "ponto 2"],
  "pontos_atencao": ["ponto 1", "ponto 2"],
  "sugestoes": [
    {
      "ativo": "EURUSD",
      "parametro": "tp_pips",
      "valor_atual": 5,
      "valor_sugerido": 6,
      "motivo": "explicação"
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
      analise = { resumo: texto, sugestoes: [] };
    }

    // Salvar resumo diário
    const { data: resumoExistente } = await supabase
      .from('resumo_diario')
      .select('id')
      .eq('data', hoje)
      .single();

    const resumoData = {
      data:             hoje,
      total_trades:     trades.length,
      total_wins:       wins,
      total_losses:     losses,
      assertividade:    assertividade,
      resultado_usd:    Math.round(totalUsd * 100) / 100,
      resultado_liq:    Math.round(totalUsd * 100) / 100,
      analise_ia:       analise.resumo || texto,
      sugestoes_ia:     analise,
      gerado_em:        new Date().toISOString()
    };

    if (resumoExistente) {
      await supabase.from('resumo_diario').update(resumoData).eq('id', resumoExistente.id);
    } else {
      await supabase.from('resumo_diario').insert([resumoData]);
    }

    // Aplicar sugestões automáticas se score >= 7
    if (analise.score_dia >= 7 && analise.sugestoes?.length > 0) {
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
      console.log(`✅ ${analise.sugestoes.length} parâmetro(s) ajustado(s) pela IA`);
    }

    console.log(`✅ Análise IA concluída — Score do dia: ${analise.score_dia}/10`);

  } catch (err) {
    console.error('Erro na análise IA:', err);
  }
}

// ─────────────────────────────────────────────────────────────
// CRON: Análise automática todo dia às 18h (horário de Brasília)
// ─────────────────────────────────────────────────────────────
cron.schedule('0 21 * * *', gerarAnaliseIA, {
  timezone: 'UTC' // 21h UTC = 18h Brasília
});

// Rota manual para forçar análise (útil para testes)
app.post('/analise/rodar', async (req, res) => {
  res.json({ mensagem: 'Análise iniciada em background' });
  gerarAnaliseIA();
});

// ─────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status:  'online',
    projeto: 'FTMO Robot Backend',
    versao:  '1.0.0',
    hora:    new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`🚀 FTMO Backend rodando na porta ${PORT}`);
});
