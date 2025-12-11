const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = process.env.PORT || 3000;

// CLAVE SECRETA PARA FIRMAR JWT (CAMBIA ESTO!)
const JWT_SECRET = process.env.JWT_SECRET || "CAMBIA-ESTA-CLAVE-POR-UNA-LARGA-Y-SEGURA";

// Middleware
app.use(cors());
app.use(express.json());

// ====== "BASE DE DATOS" EN MEMORIA ======
const usuarios = [
  {
    id: "USR-001",
    nombre: "Administrador GRULODE",
    email: "admin@grulode.com",
    password: "123456"
  }
];

const billeteras = {
  "USR-001": {
    balance: 0,
    moneda: "DOP",
    movimientos: []
  }
};

// ====== FUNCIONES AUXILIARES ======

function crearToken(usuario) {
  return jwt.sign(
    {
      sub: usuario.id,
      email: usuario.email,
      nombre: usuario.nombre
    },
    JWT_SECRET,
    { expiresIn: "1d" }
  );
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({ status: "error", message: "Token inválido" });
  }

  try {
    const token = auth.substring(7);
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ status: "error", message: "Token expirado" });
  }
}

// ====== RUTAS ======

app.get("/", (req, res) => {
  res.json({ status: "ok", mensaje: "Backend GRULODE activo" });
});

// LOGIN
app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};

  const u = usuarios.find(
    (x) =>
      x.email.toLowerCase() === String(email).toLowerCase() &&
      x.password === String(password)
  );

  if (!u) {
    return res.status(401).json({
      status: "error",
      message: "Credenciales incorrectas"
    });
  }

  const token = crearToken(u);

  return res.json({
    status: "ok",
    token,
    usuario: {
      id: u.id,
      nombre: u.nombre,
      email: u.email
    }
  });
});

// BILLETERA
app.get("/api/billetera", authMiddleware, (req, res) => {
  const id = req.user.sub;
  const w = billeteras[id];

  res.json({
    status: "ok",
    balance: w.balance,
    moneda: w.moneda,
    movimientos: w.movimientos
  });
});

// HISTORIAL
app.get("/api/historial", authMiddleware, (req, res) => {
  const id = req.user.sub;
  res.json({
    status: "ok",
    movimientos: billeteras[id].movimientos
  });
});

// JUGADA
app.post("/api/jugadas", authMiddleware, (req, res) => {
  const id = req.user.sub;
  const { total, loteria_nombre, moneda } = req.body || {};

  if (!total || !loteria_nombre || !moneda) {
    return res.status(400).json({
      status: "error",
      message: "Datos incompletos"
    });
  }

  const w = billeteras[id];

  if (w.balance < total) {
    return res.status(400).json({
      status: "error",
      message: "Balance insuficiente"
    });
  }

  w.balance -= total;
  w.movimientos.push({
    id: "MOV-" + Date.now(),
    tipo: "apuesta",
    monto: -total,
    descripcion: "Apuesta – " + loteria_nombre,
    fecha: new Date().toISOString()
  });

  res.json({ status: "ok", message: "Jugada registrada" });
});

// RECARGA
app.post("/api/recarga", authMiddleware, (req, res) => {
  const id = req.user.sub;
  const { monto, metodo } = req.body || {};

  if (!monto || !metodo) {
    return res.status(400).json({
      status: "error",
      message: "Datos incompletos"
    });
  }

  const w = billeteras[id];
  w.balance += Number(monto);
  w.movimientos.push({
    id: "MOV-" + Date.now(),
    tipo: "entrada",
    monto: Number(monto),
    descripcion: "Recarga – " + metodo,
    fecha: new Date().toISOString()
  });

  res.json({ status: "ok", message: "Recarga registrada" });
});

// RETIRO
app.post("/api/retiro", authMiddleware, (req, res) => {
  const id = req.user.sub;
  const { monto } = req.body || {};

  if (!monto) {
    return res.status(400).json({
      status: "error",
      message: "Monto requerido"
    });
  }

  const w = billeteras[id];

  if (w.balance < monto) {
    return res.status(400).json({
      status: "error",
      message: "Balance insuficiente"
    });
  }

  w.balance -= Number(monto);
  w.movimientos.push({
    id: "MOV-" + Date.now(),
    tipo: "salida",
    monto: -Number(monto),
    descripcion: "Retiro solicitado",
    fecha: new Date().toISOString()
  });

  res.json({ status: "ok", message: "Retiro registrado" });
});

// COMPROBANTE
app.post("/api/comprobante", authMiddleware, (req, res) => {
  res.json({
    status: "ok",
    message: "Comprobante recibido (backend temporal)"
  });
});

// INICIAR SERVIDOR
app.listen(PORT, () => {
  console.log("Backend GRULODE activo en puerto " + PORT);
});
