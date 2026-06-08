require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const cron       = require('node-cron');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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
      detalhe: 'Ticket ' + ticket + ' | ' + direcao + ' ' + lote + ' lotes @ ' + preco_entrada,
      dados: { ticket, ativo, direcao, lote, preco_entrada }
    }]);

    res.json({ sucesso: true, id: data.id });
  } catch (err) {
    console.error('Erro em /trade/aberta:', err);
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

    const hora_entrada_row = await supabase
      .from('trades')
      .select('hora_entrada, ativo')
      .eq('ticket', ticket)
      .single();

    let duracao_min = null;
    if (hora_entrada_row.data && hora_entrada_row.data.hora_entrada) {
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

    await supabase.from('logs_robot').insert([{
      nivel: 'INFO',
      evento: 'TRADE_FECHADA',
      ativo: hora_entrada_row.data ? hora_entrada_row.data.ativo : null,
      detalhe: 'Ticket ' + ticket + ' | ' + win_loss + ' | ' + resultado_pips + ' pips',
      dados: { ticket, win_loss, resultado_pips, resultado_liq, motivo_saida }
    }]);

    res.json({ sucesso: true });
  } catch (err) {
    console.error('Erro em /trade/fechada:', err);
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

// POST /analise/rodar — placeholder para quando tiver IA
app.post('/analise/rodar', async (req, res) => {
  res.json({ mensagem: 'Analise IA nao configurada ainda. Adicione ANTHROPIC_API_KEY para ativar.' });
});

// GET / health check
app.get('/', (req, res) => {
  res.json({
    status:  'online',
    projeto: 'FTMO Robot Backend',
    versao:  '1.0.0',
    hora:    new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log('FTMO Backend rodando na porta ' + PORT);
});
