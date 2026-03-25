require('dotenv').config();
const express    = require('express');
let webpush; try { webpush = require('web-push'); } catch(e) { webpush = null; }
const { Database: _WasmDB } = require('node-sqlite3-wasm');
// Shim: aceita args variádicos como better-sqlite3
function Database(path) {
  const db = new _WasmDB(path);
  const _prep = db.prepare.bind(db);
  db.prepare = (sql) => {
    const s = _prep(sql);
    const patch = (fn) => (...a) => fn(a.length > 1 ? a : a[0]);
    s.run = patch(s.run.bind(s));
    s.get = patch(s.get.bind(s));
    s.all = patch(s.all.bind(s));
    return s;
  };
  return db;
}
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const fs         = require('fs');

const app  = express();
app.set('trust proxy', 1); // Railway usa proxy — necessário para rate-limit e IPs corretos
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'alliance_crm_secret_2024_troque_isto';

// ── Web Push (VAPID) ──────────────────────────────────────────────────────────
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || 'BP_rJ02L19z2zzg7SmsoQa0gLh8WnH1N1KZapjBxa17mtOGh88jQ5NAJ0k4m20KpCs5ouVuxj-0OMMEihwp63No';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || 'wV8WTNS7bXjDjnwEf9nDl0-unfXlFoAbW0KTk8opCQU';
if (webpush) webpush.setVapidDetails('mailto:admin@gruporm.com', VAPID_PUBLIC, VAPID_PRIVATE);
const DB_PATH    = process.env.DB_PATH || (process.platform === 'win32' ? path.join(__dirname, 'alliance.db') : '/data/alliance.db');

// ── Garantir diretório do banco ───────────────────────────────────────────────
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

// ── Banco de dados ────────────────────────────────────────────────────────────
// Remove lock file órfão (qualquer plataforma) — evita "database is locked" no redeploy
try { fs.rmSync(DB_PATH + '.lock', { recursive: true, force: true }); } catch(e) {}
try { fs.rmSync(DB_PATH + '-wal', { force: true }); } catch(e) {}
try { fs.rmSync(DB_PATH + '-shm', { force: true }); } catch(e) {}

// Tentar abrir o banco com retry (Railway pode ter dois containers brevemente)
let db;
for (let _try = 0; _try < 10; _try++) {
  try {
    db = new Database(DB_PATH);
    break;
  } catch(e) {
    if (_try >= 9) throw e;
    // Espera síncrona de 1s (Atomics trick compatível com Node)
    const shared = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(shared, 0, 0, 1000);
  }
}
try { db.exec('PRAGMA journal_mode=WAL'); } catch(e) {}
try { db.exec('PRAGMA busy_timeout=5000'); } catch(e) {}
try { db.exec('PRAGMA foreign_keys = ON'); } catch(e) {}

// Separado em chamadas individuais — node-sqlite3-wasm não suporta multi-statement exec
db.exec(`CREATE TABLE IF NOT EXISTS usuarios (
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
)`);
db.exec(`CREATE TABLE IF NOT EXISTS leads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  nome            TEXT NOT NULL,
  telefone        TEXT,
  origem          TEXT DEFAULT 'Manual',
  status          TEXT DEFAULT 'LEAD',
  motivo          TEXT,
  oculos          TEXT DEFAULT 'Sim',
  valor           REAL DEFAULT 20,
  os              TEXT,
  unidade         TEXT DEFAULT 'Conquista',
  criado_em       TEXT DEFAULT (datetime('now','localtime')),
  atualizado_em   TEXT DEFAULT (datetime('now','localtime'))
)`);
db.exec(`CREATE TABLE IF NOT EXISTS vendas (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id         INTEGER,
  cliente_nome    TEXT,
  valor           REAL NOT NULL,
  pagamento       TEXT DEFAULT 'PIX',
  servico         TEXT,
  tipo            TEXT DEFAULT 'Venda',
  criado_por      INTEGER,
  criado_em       TEXT DEFAULT (datetime('now','localtime'))
)`);
db.exec(`CREATE TABLE IF NOT EXISTS agendamentos (
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
)`);
db.exec(`CREATE TABLE IF NOT EXISTS chat_msgs (
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
)`);
db.exec(`CREATE TABLE IF NOT EXISTS config (
  chave TEXT PRIMARY KEY,
  valor TEXT
)`);

// Tabela de contas WhatsApp Meta (múltiplas contas)
db.exec(`CREATE TABLE IF NOT EXISTS wpp_contas (
  id       TEXT PRIMARY KEY,
  nome     TEXT,
  token    TEXT,
  phone_id TEXT,
  biz_id   TEXT,
  numero   TEXT,
  ativo    INTEGER DEFAULT 1,
  criado_em TEXT DEFAULT (datetime('now','localtime'))
)`);

// Inserir conta padrão Alliance se não existir
try {
  const contaExiste = db.prepare("SELECT id FROM wpp_contas WHERE phone_id='1025821790609502'").get();
  if (!contaExiste) {
    db.prepare(`INSERT INTO wpp_contas (id,nome,phone_id,biz_id,numero,ativo) VALUES (?,?,?,?,?,1)`)
      .run('alliance-principal', 'Alliance Optometria BA', '1025821790609502', '789454576960299', '+55 77 81611475');
  }
} catch(e) {}

// Tabela de mensagens WhatsApp (Meta Cloud API)
db.exec(`CREATE TABLE IF NOT EXISTS wpp_mensagens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  wamid       TEXT UNIQUE,
  de          TEXT NOT NULL,
  nome        TEXT,
  para        TEXT,
  conta_id    TEXT,
  texto       TEXT,
  tipo        TEXT DEFAULT 'text',
  direcao     TEXT DEFAULT 'recebida',
  lido        INTEGER DEFAULT 0,
  criado_em   TEXT DEFAULT (datetime('now','localtime'))
)`);
try { db.exec("ALTER TABLE wpp_mensagens ADD COLUMN conta_id TEXT"); } catch(e) {}

// ── Migrações de schema ───────────────────────────────────────────────────────
try { db.exec("ALTER TABLE leads ADD COLUMN unidade TEXT DEFAULT 'Conquista'"); } catch(e) { /* já existe */ }

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
    sameSite: isProduction ? 'none' : 'none',
    maxAge: 8 * 3600 * 1000,
  });

  // Notificar admins/gestores sobre novo acesso (assíncrono, não bloqueia)
  setImmediate(() => { try { notificarNovoAcesso(u.nome, u.role); } catch(e) {} });
  res.json({ ok: true, user: payload, permissoes: PERMISSOES[u.role] || [], token });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('crm_token');
  res.json({ ok: true });
});

app.get('/api/auth/me', auth, (req, res) => {
  try { db.exec("ALTER TABLE usuarios ADD COLUMN email TEXT DEFAULT ''"); } catch(e) {}
  const u = db.prepare('SELECT email FROM usuarios WHERE id=?').get(req.user.id);
  res.json({ user: { ...req.user, email: (u && u.email) || '' }, permissoes: PERMISSOES[req.user.role] || [] });
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

// Editar próprio perfil (nome + email)
app.put('/api/auth/me', auth, (req, res) => {
  const { nome, email } = req.body;
  if (!nome || nome.trim().length < 2) return res.status(400).json({ error: 'Nome inválido' });
  // Adicionar coluna email se não existir
  try { db.exec("ALTER TABLE usuarios ADD COLUMN email TEXT DEFAULT ''"); } catch(e) {}
  db.prepare("UPDATE usuarios SET nome=?, email=? WHERE id=?").run(nome.trim(), email||'', req.user.id);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════════
// USUÁRIOS
// ════════════════════════════════════════════════════════════════════════════════

app.get('/api/usuarios', auth, requireRole('admin','gestor'), (req, res) => {
  res.json(db.prepare('SELECT id,nome,usuario,cargo,role,setor,ativo,criado_em,ultimo_acesso FROM usuarios ORDER BY id').all());
});

app.post('/api/usuarios', auth, requireRole('admin','gestor'), (req, res) => {
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

app.put('/api/usuarios/:id', auth, requireRole('admin','gestor'), (req, res) => {
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

app.delete('/api/usuarios/:id', auth, requireRole('admin','gestor'), (req, res) => {
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
// ── Envio automático via Evolution API ───────────────────────────────────────
async function enviarWhatsAppAutoLead(nome, telefone, unidade) {
  try {
    const cfgRow = db.prepare("SELECT valor FROM config WHERE chave='whatsapp_auto'").get();
    if (!cfgRow) return;
    const cfg = JSON.parse(cfgRow.valor);
    if (!cfg.evolUrl || !cfg.evolKey || !cfg.evolInstance || !cfg.ativo) return;
    // Normaliza telefone: remove não-dígitos, garante DDI 55
    let num = (telefone || '').replace(/\D/g, '');
    if (!num) return;
    if (!num.startsWith('55')) num = '55' + num;
    const msgTemplate = cfg.mensagem ||
      `Olá {nome}! 👋 Recebemos seu agendamento de Exame de Vista na Grupo RM Clínica - {unidade}.\n\n` +
      `Em breve nossa equipe entrará em contato para confirmar seu horário. 📅\n\n` +
      `Qualquer dúvida, estamos aqui! 😊`;
    const texto = msgTemplate.replace('{nome}', nome).replace('{unidade}', unidade);
    const url = `${cfg.evolUrl.replace(/\/$/, '')}/message/sendText/${cfg.evolInstance}`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': cfg.evolKey },
      body: JSON.stringify({ number: num, text: texto }),
    });
  } catch(e) { /* não bloqueia o lead */ }
}

app.post('/api/leads/public', async (req, res) => {
  const d = req.body;
  if (!d.nome) return res.status(400).json({ error: 'Nome obrigatório' });
  const count = db.prepare('SELECT COUNT(*) as c FROM leads').get().c;
  const unidade = d.unidade || d.localidade || 'Conquista';
  const r = db.prepare('INSERT INTO leads (nome,telefone,origem,status,motivo,oculos,valor,os,unidade) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(d.nome, d.telefone||'', d.origem||'Landing Page', 'LEAD', d.motivo||'', d.oculos||'Sim', d.valor||20, String(1000+count+1), unidade);
  // Dispara WhatsApp automático sem bloquear resposta
  enviarWhatsAppAutoLead(d.nome, d.telefone||'', unidade);
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

// Endpoint específico para config do WhatsApp automático (admin + gestor)
app.get('/api/config/whatsapp-auto', auth, requireRole('admin','gestor'), (req, res) => {
  const row = db.prepare("SELECT valor FROM config WHERE chave='whatsapp_auto'").get();
  if (!row) return res.json({});
  try { res.json(JSON.parse(row.valor)); } catch { res.json({}); }
});

app.put('/api/config/whatsapp-auto', auth, requireRole('admin','gestor'), (req, res) => {
  db.prepare('INSERT OR REPLACE INTO config (chave,valor) VALUES (?,?)').run('whatsapp_auto', JSON.stringify(req.body));
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════════
// WHATSAPP META — GERENCIAR CONTAS
// ════════════════════════════════════════════════════════════════════════════════

// Listar contas
app.get('/api/whatsapp/contas', auth, (req, res) => {
  const contas = db.prepare(`SELECT id,nome,phone_id,biz_id,numero,ativo,criado_em,
    CASE WHEN token IS NOT NULL AND token!='' THEN 1 ELSE 0 END as token_ok
    FROM wpp_contas ORDER BY criado_em`).all();
  res.json(contas);
});

// Adicionar/atualizar conta
app.post('/api/whatsapp/contas', auth, requireRole('admin','gestor'), (req, res) => {
  const { id, nome, token, phone_id, biz_id, numero } = req.body;
  if (!token || !phone_id) return res.status(400).json({ erro: 'Token e Phone ID obrigatórios' });
  const cid = id || ('conta-' + Date.now());
  db.prepare(`INSERT OR REPLACE INTO wpp_contas (id,nome,token,phone_id,biz_id,numero,ativo) VALUES (?,?,?,?,?,?,1)`)
    .run(cid, nome||phone_id, token, phone_id, biz_id||'', numero||'');
  // Sincronizar config principal também
  db.prepare('INSERT OR REPLACE INTO config (chave,valor) VALUES (?,?)').run('whatsapp_meta', JSON.stringify({ token, phoneId: phone_id, bizId: biz_id }));
  res.json({ ok: true, id: cid });
});

// Remover conta
app.delete('/api/whatsapp/contas/:id', auth, requireRole('admin','gestor'), (req, res) => {
  db.prepare('DELETE FROM wpp_contas WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Buscar token de uma conta pelo phone_id (usado pelo webhook)
function getTokenPorPhoneId(phoneId) {
  const conta = db.prepare('SELECT token FROM wpp_contas WHERE phone_id=? AND ativo=1').get(phoneId);
  if (conta?.token) return conta.token;
  // fallback: config global
  try {
    const cfg = db.prepare("SELECT valor FROM config WHERE chave='whatsapp_meta'").get();
    return cfg ? JSON.parse(cfg.valor).token : null;
  } catch(e) { return null; }
}

// ════════════════════════════════════════════════════════════════════════════════
// WHATSAPP META CLOUD API — WEBHOOK
// ════════════════════════════════════════════════════════════════════════════════

const WPP_VERIFY_TOKEN = process.env.WPP_VERIFY_TOKEN || 'alliance_wpp_2024';

// Verificação do webhook pela Meta (GET)
app.get('/api/whatsapp/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WPP_VERIFY_TOKEN) {
    console.log('✅ Webhook WhatsApp verificado pela Meta');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Receber mensagens da Meta (POST)
app.post('/api/whatsapp/webhook', (req, res) => {
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return res.sendStatus(200);
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    if (!value?.messages) return res.sendStatus(200);

    value.messages.forEach(msg => {
      const de    = msg.from;
      const wamid = msg.id;
      const tipo  = msg.type || 'text';
      const texto = tipo === 'text' ? msg.text?.body :
                    tipo === 'image' ? '[Imagem]' :
                    tipo === 'audio' ? '[Áudio]' :
                    tipo === 'document' ? '[Documento]' :
                    tipo === 'video' ? '[Vídeo]' : '[Mensagem]';

      // Pega nome do contato se disponível
      const contatos = value.contacts || [];
      const contato  = contatos.find(c => c.wa_id === de);
      const nome     = contato?.profile?.name || de;

      // Usa timestamp da Meta convertido para horário de Brasília (UTC-3)
      const tsMeta   = msg.timestamp ? parseInt(msg.timestamp) : Math.floor(Date.now()/1000);
      const dtBrasil = new Date(tsMeta * 1000);
      dtBrasil.setHours(dtBrasil.getHours() - 3);
      const criadoEm = dtBrasil.toISOString().replace('T',' ').slice(0,19);

      try {
        db.prepare(`INSERT OR IGNORE INTO wpp_mensagens (wamid, de, nome, texto, tipo, direcao, criado_em)
                    VALUES (?,?,?,?,?,'recebida',?)`).run(wamid, de, nome, texto, tipo, criadoEm);
        console.log(`📩 WPP recebido de ${nome} (${de}): ${texto}`);
      } catch(e) { console.error('Erro ao salvar msg wpp:', e.message); }
    });
  } catch(e) { console.error('Erro webhook wpp:', e.message); }
  res.sendStatus(200);
});

// Buscar conversas (lista de contatos)
app.get('/api/whatsapp/conversas', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT de, nome,
           MAX(criado_em) as ultima,
           COUNT(*) as total,
           SUM(CASE WHEN lido=0 AND direcao='recebida' THEN 1 ELSE 0 END) as nao_lidas,
           (SELECT texto FROM wpp_mensagens m2 WHERE m2.de=m.de ORDER BY m2.criado_em DESC LIMIT 1) as ultima_msg
    FROM wpp_mensagens m
    GROUP BY de
    ORDER BY ultima DESC
  `).all();
  res.json(rows);
});

// Buscar mensagens de um contato
app.get('/api/whatsapp/mensagens/:de', auth, (req, res) => {
  const msgs = db.prepare(`
    SELECT * FROM wpp_mensagens WHERE de=? ORDER BY criado_em ASC
  `).all(req.params.de);
  // Marcar como lido
  db.prepare(`UPDATE wpp_mensagens SET lido=1 WHERE de=? AND direcao='recebida'`).run(req.params.de);
  res.json(msgs);
});

// Enviar mensagem via Meta Cloud API
app.post('/api/whatsapp/enviar', auth, async (req, res) => {
  const { para, texto, contaId } = req.body;
  // Busca a conta correta (por contaId ou a primeira ativa)
  let conta = contaId
    ? db.prepare('SELECT * FROM wpp_contas WHERE id=? AND ativo=1').get(contaId)
    : db.prepare('SELECT * FROM wpp_contas WHERE ativo=1 ORDER BY criado_em LIMIT 1').get();
  // Fallback para config global
  if (!conta?.token) {
    const cfg = db.prepare("SELECT valor FROM config WHERE chave='whatsapp_meta'").get();
    if (!cfg) return res.status(400).json({ erro: 'Nenhuma conta WhatsApp configurada' });
    const c = JSON.parse(cfg.valor);
    conta = { token: c.token, phone_id: c.phoneId };
  }
  const { token, phone_id: phoneId } = conta;
  if (!token || !phoneId) return res.status(400).json({ erro: 'Token ou Phone ID faltando' });

  try {
    const r = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: para.replace(/\D/g, ''),
        type: 'text',
        text: { body: texto }
      })
    });
    const data = await r.json();
    if (data.messages?.[0]?.id) {
      db.prepare(`INSERT INTO wpp_mensagens (wamid, de, nome, texto, tipo, direcao)
                  VALUES (?,?,?,?,'text','enviada')`).run(
        data.messages[0].id, para.replace(/\D/g, ''), 'Você', texto
      );
      res.json({ ok: true });
    } else {
      res.status(400).json({ erro: data.error?.message || 'Erro ao enviar' });
    }
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Salvar config da Meta API
app.put('/api/config/whatsapp-meta', auth, requireRole('admin','gestor'), (req, res) => {
  db.prepare('INSERT OR REPLACE INTO config (chave,valor) VALUES (?,?)').run('whatsapp_meta', JSON.stringify(req.body));
  res.json({ ok: true });
});

app.get('/api/config/whatsapp-meta', auth, requireRole('admin','gestor'), (req, res) => {
  const row = db.prepare("SELECT valor FROM config WHERE chave='whatsapp_meta'").get();
  if (!row) return res.json({});
  try { res.json(JSON.parse(row.valor)); } catch { res.json({}); }
});

// Sincronizar histórico de conversas da Meta API
app.post('/api/whatsapp/sincronizar-historico', auth, requireRole('admin','gestor'), async (req, res) => {
  try {
    let { token, phoneId, bizId } = req.body;
    // Fallback: pega do banco se não veio no body
    if (!token || !phoneId) {
      const cfg = db.prepare("SELECT valor FROM config WHERE chave='whatsapp_meta'").get();
      if (cfg) { const c = JSON.parse(cfg.valor); token=c.token; phoneId=c.phoneId; bizId=c.bizId; }
    }
    if (!token || !phoneId) return res.status(400).json({ erro: 'Token ou Phone ID não configurado. Salve as credenciais na aba WhatsApp primeiro.' });

    // Salva token no banco para uso futuro (webhook, envio)
    db.prepare('INSERT OR REPLACE INTO config (chave,valor) VALUES (?,?)').run('whatsapp_meta', JSON.stringify({ token, phoneId, bizId }));

    let count = 0;

    // Tenta buscar via WABA (Business Account)
    if (bizId) {
      const url = `https://graph.facebook.com/v20.0/${bizId}/conversations?fields=id,messages{from,timestamp,type,text}&limit=50`;
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
      const data = await r.json();
      if (!data.error) {
        for (const conv of (data.data||[])) {
          for (const msg of (conv.messages?.data||[])) {
            const de    = msg.from?.phone || msg.from?.id || 'desconhecido';
            const nome  = msg.from?.name || de;
            const texto = msg.text?.body || `[${msg.type||'mensagem'}]`;
            const ts    = new Date((msg.timestamp||Date.now()/1000)*1000).toISOString().replace('T',' ').slice(0,19);
            try { db.prepare(`INSERT OR IGNORE INTO wpp_mensagens (wamid,de,nome,texto,tipo,direcao,criado_em) VALUES (?,?,?,?,'text','recebida',?)`).run(msg.id,de,nome,texto,ts); count++; } catch(e){}
          }
        }
      } else {
        console.log('Meta WABA conversations error:', data.error.message);
      }
    }

    res.json({ ok: true, mensagens: count, info: count===0 ? 'A API Meta só entrega mensagens novas via webhook. Envie uma mensagem para o número e ela aparecerá automaticamente.' : null });
  } catch(e) { res.status(500).json({ erro: e.message }); }
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

// Rota explícita para a Landing Page (garante servir mesmo sem cache Docker)
let _lpCache = null;
app.get(['/lp', '/lp.html'], async (req, res) => {
  const lpPath = path.join(__dirname, 'public', 'lp.html');
  if (fs.existsSync(lpPath)) return res.sendFile(lpPath);
  try {
    if (!_lpCache) {
      const r = await fetch('https://raw.githubusercontent.com/larysoares004-afk/alliance-crm/main/public/lp.html');
      _lpCache = await r.text();
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(_lpCache);
  } catch(e) {
    res.status(503).send('Landing page temporariamente indisponível');
  }
});

// Rota explícita para página de instalação do app (com fallback GitHub)
let _instalarCache = null;
app.get(['/instalar', '/instalar.html', '/baixar', '/app', '/download'], async (req, res) => {
  const p = path.join(__dirname, 'public', 'instalar.html');
  if (fs.existsSync(p)) return res.sendFile(p);
  try {
    if (!_instalarCache) {
      const r = await fetch('https://raw.githubusercontent.com/larysoares004-afk/alliance-crm/main/public/instalar.html');
      _instalarCache = await r.text();
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(_instalarCache);
  } catch(e) {
    res.status(503).send('Página de instalação temporariamente indisponível');
  }
});

app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ════════════════════════════════════════════════════════════════════════════════
// PUSH NOTIFICATIONS
// ════════════════════════════════════════════════════════════════════════════════

// Tabela de subscriptions
try {
  db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    endpoint   TEXT NOT NULL UNIQUE,
    keys_auth  TEXT NOT NULL,
    keys_p256dh TEXT NOT NULL,
    criado_em  TEXT DEFAULT (datetime('now','localtime'))
  )`);
} catch(e) {}

// Chave pública VAPID para o cliente
app.get('/api/push/vapid-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC });
});

// Salvar subscription
app.post('/api/push/subscribe', auth, (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys) return res.status(400).json({ error: 'Dados inválidos' });
  try {
    db.prepare(`INSERT OR REPLACE INTO push_subscriptions (user_id, endpoint, keys_auth, keys_p256dh)
      VALUES (?, ?, ?, ?)`).run(req.user.id, endpoint, keys.auth, keys.p256dh);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Remover subscription
app.post('/api/push/unsubscribe', auth, (req, res) => {
  const { endpoint } = req.body;
  db.prepare('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?').run(req.user.id, endpoint);
  res.json({ ok: true });
});

// Enviar push para usuários por role
function pushParaRoles(roles, titulo, corpo, url) {
  const subs = db.prepare('SELECT ps.* FROM push_subscriptions ps JOIN usuarios u ON u.id=ps.user_id WHERE u.role IN (' + roles.map(()=>'?').join(',') + ')').all(roles);
  subs.forEach(sub => {
    const payload = JSON.stringify({ title: titulo, body: corpo, url: url || '/' });
    if (!webpush) return;
    webpush.sendNotification({ endpoint: sub.endpoint, keys: { auth: sub.keys_auth, p256dh: sub.keys_p256dh } }, payload)
      .catch(e => {
        if (e.statusCode === 410 || e.statusCode === 404) {
          db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(sub.endpoint);
        }
      });
  });
}

// Notificar novo acesso (chamado no login)
function notificarNovoAcesso(nomeUsuario, role) {
  if (role === 'admin') return; // admin não notifica a si mesmo
  pushParaRoles(['admin', 'gestor'], '🔐 Novo acesso ao CRM', `${nomeUsuario} acabou de entrar no sistema`, '/');
}

// ── Cron jobs de notificação ──────────────────────────────────────────────────

// A cada 1 hora: verificar leads e mensagens sem resposta
setInterval(() => {
  const agora = new Date();

  // 1) Leads na última hora
  try {
    const leads = db.prepare(`SELECT COUNT(*) as c FROM leads WHERE criado_em >= datetime('now','-1 hour','localtime')`).get();
    if (leads && leads.c > 0) {
      pushParaRoles(['admin','gestor','gerente'],
        `📋 ${leads.c} novo${leads.c>1?'s':''} lead${leads.c>1?'s':''} na última hora`,
        `Você tem ${leads.c} lead${leads.c>1?'s':''} aguardando atendimento no CRM`,
        '/');
    }
  } catch(e) {}

  // 2) Mensagens sem resposta há mais de 1 hora (admin notifica)
  try {
    const semResposta = db.prepare(`
      SELECT COUNT(DISTINCT lead_id) as c FROM chat_messages
      WHERE remetente_role != 'admin' AND remetente_role != 'gestor'
        AND criado_em <= datetime('now','-1 hour','localtime')
        AND lead_id NOT IN (
          SELECT DISTINCT lead_id FROM chat_messages
          WHERE (remetente_role='admin' OR remetente_role='gestor')
            AND criado_em >= datetime('now','-1 hour','localtime')
        )
    `).get();
    if (semResposta && semResposta.c > 0) {
      pushParaRoles(['admin','gestor'],
        `⚠️ ${semResposta.c} lead${semResposta.c>1?'s':''} sem resposta`,
        `Há mensagem${semResposta.c>1?'ns':''} de cliente${semResposta.c>1?'s':''} sem resposta há mais de 1 hora`,
        '/');
    }
  } catch(e) {}

}, 60 * 60 * 1000); // 1 hora

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
