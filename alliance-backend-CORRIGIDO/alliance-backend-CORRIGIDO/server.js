require('dotenv').config();
const express    = require('express');
const Database   = require('better-sqlite3');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const fs         = require('fs');

const app  = express();
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'alliance_crm_secret_2024_troque_isto';
const DB_PATH    = process.env.DB_PATH || '/data/alliance.db';

// ── Garantir diretório do banco ───────────────────────────────────────────────
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

// ── Banco de dados ────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    nome         TEXT NOT NULL,
    usuario      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    senha_hash   TEXT NOT NULL,
    cargo        TEXT DEFAULT 'Atendente',
    role         TEXT DEFAULT 'atendente',
    setor        TEXT DEFAULT 'recepcao',
    ativo        INTEGER DEFAULT 1,
    criado_em    TEXT DEFAULT (datetime('now','localtime')),
    ultimo_acesso TEXT
  );

  CREATE TABLE IF NOT EXISTS leads (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    nome            TEXT NOT NULL,
    telefone        TEXT,
    origem          TEXT DEFAULT 'Manual',
    status          TEXT DEFAULT 'LEAD',
    motivo          TEXT,
    oculos          TEXT DEFAULT 'Sim',
    valor           REAL DEFAULT 20,
    os              TEXT,
    criado_em       TEXT DEFAULT (datetime('now','localtime')),
    atualizado_em   TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS vendas (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id         INTEGER,
    cliente_nome    TEXT,
    valor           REAL NOT NULL,
    pagamento       TEXT DEFAULT 'PIX',
    servico         TEXT,
    tipo            TEXT DEFAULT 'Venda',
    criado_por      INTEGER,
    criado_em       TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS agendamentos (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id         INTEGER,
    cliente_nome    TEXT,
    cliente_tel     TEXT,
    servico         TEXT,
    data            TEXT,
    hora            TEXT,
    status          TEXT DEFAULT 'scheduled',
    nota            TEXT,
    criado_em       TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS chat_msgs (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    canal    TEXT NOT NULL,
    autor    TEXT NOT NULL,
    setor    TEXT,
    texto    TEXT NOT NULL,
    tipo     TEXT DEFAULT 'msg',
    paciente TEXT,
    destino  TEXT,
    nota     TEXT,
    lido     INTEGER DEFAULT 0,
    criado_em TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS config (
    chave TEXT PRIMARY KEY,
    valor TEXT
  );
`);

// ── Usuários padrão ───────────────────────────────────────────────────────────
const DEFAULTS = [
  { nome:'Lary Soares',  usuario:'lary',      senha:'admin123',  cargo:'Administrador', role:'admin',        setor:'gestao'   },
  { nome:'Gestor',       usuario:'gestor',     senha:'gestor123', cargo:'Gestor',        role:'gestor',       setor:'gestao'   },
  { nome:'Atendente',    usuario:'atendente',  senha:'atend123',  cargo:'Atendente',     role:'atendente',    setor:'recepcao' },
  { nome:'Vendedor',     usuario:'vendedor',   senha:'vend123',   cargo:'Vendedor',      role:'vendedor',     setor:'vendas'   },
];
const stmtCheck = db.prepare('SELECT id FROM usuarios WHERE usuario=?');
const stmtInsert = db.prepare('INSERT INTO usuarios (nome,usuario,senha_hash,cargo,role,setor) VALUES (?,?,?,?,?,?)');
for (const u of DEFAULTS) {
  if (!stmtCheck.get(u.usuario)) {
    stmtInsert.run(u.nome, u.usuario, bcrypt.hashSync(u.senha, 12), u.cargo, u.role, u.setor);
  }
}

// ── Permissões ────────────────────────────────────────────────────────────────
const PERMISSOES = {
  admin:    ['dashboard','leads','agenda','faturamento','setores','servicos','chat','whatsapp','atendimentos','novo','config','usuarios'],
  gestor:   ['dashboard','leads','agenda','faturamento','setores','servicos','chat','whatsapp','atendimentos','novo','config','usuarios'],
  gerente:  ['dashboard','leads','agenda','setores','servicos','chat','whatsapp','atendimentos','novo','config'],
  atendente:['dashboard','leads','chat','atendimentos'],
  vendedor: ['dashboard','chat','atendimentos'],
  optometrista:['dashboard','agenda','chat','atendimentos'],
};

// ── Middlewares ───────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // CRM usa inline scripts
}));
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || true,
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Rate limiting
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Muitas tentativas. Tente novamente em 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: { error: 'Rate limit excedido.' },
});

app.use('/api/', apiLimiter);

// ── Auth middleware ───────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.cookies?.crm_token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.clearCookie('crm_token');
    return res.status(401).json({ error: 'Sessão expirada' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role))
      return res.status(403).json({ error: 'Sem permissão' });
    next();
  };
}

// ════════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ════════════════════════════════════════════════════════════════════════════════

app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { usuario, senha } = req.body || {};
  if (!usuario || !senha) return res.status(400).json({ error: 'Preencha usuário e senha' });

  const u = db.prepare('SELECT * FROM usuarios WHERE usuario=? AND ativo=1').get(usuario);
  if (!u || !bcrypt.compareSync(senha, u.senha_hash))
    return res.status(401).json({ error: 'Usuário ou senha incorretos' });

  db.prepare("UPDATE usuarios SET ultimo_acesso=datetime('now','localtime') WHERE id=?").run(u.id);

  const payload = { id: u.id, nome: u.nome, usuario: u.usuario, cargo: u.cargo, role: u.role, setor: u.setor };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });

  const isProduction = process.env.NODE_ENV === 'production';
  res.cookie('crm_token', token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: 8 * 3600 * 1000,
  });

  res.json({ ok: true, user: payload, permissoes: PERMISSOES[u.role] || [], token });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('crm_token');
  res.json({ ok: true });
});

app.get('/api/auth/me', auth, (req, res) => {
  res.json({ user: req.user, permissoes: PERMISSOES[req.user.role] || [] });
});

app.post('/api/auth/trocar-senha', auth, (req, res) => {
  const { senhaAtual, novaSenha } = req.body;
  if (!senhaAtual || !novaSenha) return res.status(400).json({ error: 'Campos obrigatórios' });
  if (novaSenha.length < 6) return res.status(400).json({ error: 'Mínimo 6 caracteres' });
  const u = db.prepare('SELECT * FROM usuarios WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(senhaAtual, u.senha_hash))
    return res.status(401).json({ error: 'Senha atual incorreta' });
  db.prepare('UPDATE usuarios SET senha_hash=? WHERE id=?').run(bcrypt.hashSync(novaSenha, 12), req.user.id);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════════
// USUÁRIOS
// ════════════════════════════════════════════════════════════════════════════════

app.get('/api/usuarios', auth, requireRole('admin'), (req, res) => {
  res.json(db.prepare('SELECT id,nome,usuario,cargo,role,setor,ativo,criado_em,ultimo_acesso FROM usuarios ORDER BY id').all());
});

app.post('/api/usuarios', auth, requireRole('admin'), (req, res) => {
  const { nome, usuario, senha, cargo, role, setor } = req.body;
  if (!nome || !usuario || !senha || !role) return res.status(400).json({ error: 'Campos obrigatórios' });
  if (senha.length < 6) return res.status(400).json({ error: 'Senha mínimo 6 caracteres' });
  if (db.prepare('SELECT id FROM usuarios WHERE usuario=?').get(usuario))
    return res.status(400).json({ error: 'Usuário já existe' });
  const r = db.prepare('INSERT INTO usuarios (nome,usuario,senha_hash,cargo,role,setor) VALUES (?,?,?,?,?,?)').run(
    nome, usuario, bcrypt.hashSync(senha, 12), cargo || role, role, setor || 'recepcao'
  );
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.put('/api/usuarios/:id', auth, requireRole('admin'), (req, res) => {
  const { nome, usuario, cargo, role, setor, ativo, novaSenha } = req.body;
  // Verificar unicidade do novo login se mudou
  if (usuario) {
    const existing = db.prepare('SELECT id FROM usuarios WHERE usuario=? AND id!=?').get(usuario, req.params.id);
    if (existing) return res.status(400).json({ error: 'Este login já está em uso por outro usuário' });
  }
  if (novaSenha) {
    if (novaSenha.length < 6) return res.status(400).json({ error: 'Senha mínimo 6 caracteres' });
    db.prepare('UPDATE usuarios SET senha_hash=? WHERE id=?').run(bcrypt.hashSync(novaSenha, 12), req.params.id);
  }
  db.prepare('UPDATE usuarios SET nome=COALESCE(?,nome),usuario=COALESCE(?,usuario),cargo=COALESCE(?,cargo),role=COALESCE(?,role),setor=COALESCE(?,setor),ativo=COALESCE(?,ativo) WHERE id=?')
    .run(nome||null, usuario||null, cargo||null, role||null, setor||null, ativo??null, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/usuarios/:id', auth, requireRole('admin'), (req, res) => {
  if (Number(req.params.id) === req.user.id)
    return res.status(400).json({ error: 'Não pode remover a si mesmo' });
  db.prepare('UPDATE usuarios SET ativo=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════════
// LEADS
// ════════════════════════════════════════════════════════════════════════════════

app.get('/api/leads', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM leads ORDER BY criado_em DESC').all());
});

// Rota pública para Landing Page
app.post('/api/leads/public', (req, res) => {
  const d = req.body;
  if (!d.nome) return res.status(400).json({ error: 'Nome obrigatório' });
  const count = db.prepare('SELECT COUNT(*) as c FROM leads').get().c;
  const r = db.prepare('INSERT INTO leads (nome,telefone,origem,status,motivo,oculos,valor,os) VALUES (?,?,?,?,?,?,?,?)')
    .run(d.nome, d.telefone||'', d.origem||'Landing Page', 'LEAD', d.motivo||'', d.oculos||'Sim', d.valor||20, String(1000+count+1));
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.post('/api/leads', auth, (req, res) => {
  const d = req.body;
  if (!d.nome) return res.status(400).json({ error: 'Nome obrigatório' });
  const count = db.prepare('SELECT COUNT(*) as c FROM leads').get().c;
  const r = db.prepare('INSERT INTO leads (nome,telefone,origem,status,motivo,oculos,valor,os) VALUES (?,?,?,?,?,?,?,?)')
    .run(d.nome, d.telefone||'', d.origem||'Manual', d.status||'LEAD', d.motivo||'', d.oculos||'Sim', d.valor||20, d.os||String(1000+count+1));
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.put('/api/leads/:id', auth, (req, res) => {
  const d = req.body;
  db.prepare("UPDATE leads SET nome=COALESCE(?,nome),telefone=COALESCE(?,telefone),status=COALESCE(?,status),origem=COALESCE(?,origem),motivo=COALESCE(?,motivo),valor=COALESCE(?,valor),atualizado_em=datetime('now','localtime') WHERE id=?")
    .run(d.nome||null, d.telefone||null, d.status||null, d.origem||null, d.motivo||null, d.valor??null, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/leads/:id', auth, requireRole('admin','gestor'), (req, res) => {
  db.prepare('DELETE FROM leads WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════════
// VENDAS
// ════════════════════════════════════════════════════════════════════════════════

app.get('/api/vendas', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM vendas ORDER BY criado_em DESC').all());
});

app.post('/api/vendas', auth, (req, res) => {
  const d = req.body;
  if (!d.valor || +d.valor <= 0) return res.status(400).json({ error: 'Valor inválido' });
  const r = db.prepare('INSERT INTO vendas (lead_id,cliente_nome,valor,pagamento,servico,tipo,criado_por) VALUES (?,?,?,?,?,?,?)')
    .run(d.lead_id||null, d.cliente_nome||'', +d.valor, d.pagamento||'PIX', d.servico||'', d.tipo||'Venda', req.user.id);
  if (d.tipo === 'Venda' && d.lead_id) {
    db.prepare("UPDATE leads SET status='CONVERTEU',atualizado_em=datetime('now','localtime') WHERE id=?").run(d.lead_id);
  }
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.put('/api/vendas/:id', auth, requireRole('admin','gestor'), (req, res) => {
  const d = req.body;
  db.prepare('UPDATE vendas SET cliente_nome=COALESCE(?,cliente_nome),valor=COALESCE(?,valor),pagamento=COALESCE(?,pagamento),servico=COALESCE(?,servico),tipo=COALESCE(?,tipo) WHERE id=?')
    .run(d.cliente_nome||null, d.valor??null, d.pagamento||null, d.servico||null, d.tipo||null, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/vendas/:id', auth, requireRole('admin','gestor'), (req, res) => {
  db.prepare('DELETE FROM vendas WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════════
// AGENDAMENTOS
// ════════════════════════════════════════════════════════════════════════════════

app.get('/api/agendamentos', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM agendamentos ORDER BY data ASC, hora ASC').all());
});

app.post('/api/agendamentos', auth, (req, res) => {
  const d = req.body;
  if (!d.cliente_nome || !d.data || !d.hora) return res.status(400).json({ error: 'Campos obrigatórios' });
  const r = db.prepare('INSERT INTO agendamentos (lead_id,cliente_nome,cliente_tel,servico,data,hora,nota) VALUES (?,?,?,?,?,?,?)')
    .run(d.lead_id||null, d.cliente_nome, d.cliente_tel||'', d.servico||'', d.data, d.hora, d.nota||'');
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.put('/api/agendamentos/:id', auth, (req, res) => {
  const d = req.body;
  db.prepare('UPDATE agendamentos SET status=COALESCE(?,status),data=COALESCE(?,data),hora=COALESCE(?,hora),nota=COALESCE(?,nota) WHERE id=?')
    .run(d.status||null, d.data||null, d.hora||null, d.nota||null, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/agendamentos/:id', auth, (req, res) => {
  db.prepare('DELETE FROM agendamentos WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════════
// CHAT MSGS
// ════════════════════════════════════════════════════════════════════════════════

app.get('/api/chat/:canal', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM chat_msgs WHERE canal=? ORDER BY criado_em ASC LIMIT 200').all(req.params.canal));
});

app.post('/api/chat/:canal', auth, (req, res) => {
  const d = req.body;
  if (!d.texto) return res.status(400).json({ error: 'Texto obrigatório' });
  const r = db.prepare('INSERT INTO chat_msgs (canal,autor,setor,texto,tipo,paciente,destino,nota) VALUES (?,?,?,?,?,?,?,?)')
    .run(req.params.canal, req.user.nome, req.user.setor||'', d.texto, d.tipo||'msg', d.paciente||'', d.destino||'', d.nota||'');
  res.json({ ok: true, id: r.lastInsertRowid });
});

// ════════════════════════════════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════════════════════════════════

app.get('/api/config', auth, (req, res) => {
  const rows = db.prepare('SELECT chave,valor FROM config').all();
  const obj = {};
  rows.forEach(r => { try { obj[r.chave] = JSON.parse(r.valor); } catch { obj[r.chave] = r.valor; } });
  res.json(obj);
});

app.put('/api/config', auth, requireRole('admin'), (req, res) => {
  const stmt = db.prepare('INSERT OR REPLACE INTO config (chave,valor) VALUES (?,?)');
  Object.entries(req.body).forEach(([k, v]) => stmt.run(k, JSON.stringify(v)));
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ════════════════════════════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: '2.0.0', empresa: 'Grupo RM Clínica', uptime: process.uptime() });
});

// ════════════════════════════════════════════════════════════════════════════════
// ESTATÍSTICAS RÁPIDAS (sem auth — para dashboard público)
// ════════════════════════════════════════════════════════════════════════════════
app.get('/api/stats', auth, (req, res) => {
  const total   = db.prepare('SELECT COUNT(*) as c FROM leads').get().c;
  const hoje    = db.prepare("SELECT COUNT(*) as c FROM leads WHERE date(criado_em)=date('now','localtime')").get().c;
  const conv    = db.prepare("SELECT COUNT(*) as c FROM leads WHERE status='CONVERTEU'").get().c;
  const agendHj = db.prepare("SELECT COUNT(*) as c FROM agendamentos WHERE data=date('now','localtime') AND status='scheduled'").get().c;
  const fat     = db.prepare("SELECT COALESCE(SUM(valor),0) as v FROM vendas WHERE tipo='Venda' AND date(criado_em)>=date('now','start of month')").get().v;
  res.json({ total, hoje, conv, agendHj, fatMes: fat, taxa: total>0?Math.round(conv/total*100):0 });
});

// ════════════════════════════════════════════════════════════════════════════════
// STATIC — serve o CRM
// ════════════════════════════════════════════════════════════════════════════════

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  etag: true,
}));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Iniciar servidor ──────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log('\n🚀 Grupo RM Clínica rodando em http://localhost:' + PORT);
  console.log('📊 Banco: ' + DB_PATH);
  console.log('\n👥 Credenciais padrão:');
  console.log('   lary      / admin123   (Admin)');
  console.log('   gestor    / gestor123  (Gestor)');
  console.log('   atendente / atend123   (Atendente)');
  console.log('   vendedor  / vend123    (Vendedor)');
  console.log('\n⚠️  Troque as senhas após o primeiro acesso!\n');
});
